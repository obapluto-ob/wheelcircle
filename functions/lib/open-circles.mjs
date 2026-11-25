import { AppError } from './errors.mjs';
import { one, rows, nowIso, sha256Hex } from './util.mjs';
import { insertLedger } from './ledger.mjs';
import { membersOf, currentCircle } from './read.mjs';
import { markContributionPaid, contributionForMember } from './funding.mjs';
import { HOUR, RULES, bondBpsForTrust } from './rules.mjs';
import { verifyIdentityWithProvider } from './identity-provider.mjs';

export const SEAT_HOLD_MS = 15 * 60 * 1000;
export const SEAT_STALL_MS = 14 * 24 * HOUR;

const IDENTITY_STATES = ['verified', 'pending', 'rejected'];

export function identityState(user) {
  return IDENTITY_STATES.includes(user?.identity_status) ? user.identity_status : 'unverified';
}

export function identityGate(db, user) {
  const status = identityState(user);
  if (status === 'verified') return;
  if (status === 'pending') {
    throw new AppError('identity_pending', 403,
      'Your typed ID is with the review desk. Open seats unlock as soon as it is approved.');
  }
  if (status === 'rejected') {
    throw new AppError('identity_rejected', 403,
      'The review desk could not confirm those ID details. Read the note in Account and submit them again.');
  }
  throw new AppError('identity_required', 403,
    'Type your ID number, legal name and phone once to take a seat in an open circle. One ID, one account, one seat per circle.');
}

function phoneKey(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 9 ? digits.slice(-9) : '';
}

function nameTokens(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

function sameName(left, right) {
  const a = nameTokens(left);
  const b = nameTokens(right);
  return a.length > 0 && a.length === b.length && a.every((token, index) => token === b[index]);
}

export function validateDateOfBirth(raw, { required = false } = {}) {
  const dob = String(raw || '').trim();
  if (!dob) {
    if (required) throw new AppError('invalid_input', 400, 'Add your date of birth. Seats are for members aged 18 and over.');
    return null;
  }
  const born = Date.parse(`${dob}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || !Number.isFinite(born)) {
    throw new AppError('invalid_input', 400, 'Enter your date of birth as a calendar date.');
  }
  const age = (Date.now() - born) / (365.25 * 24 * HOUR);
  if (age < 18) throw new AppError('invalid_input', 400, 'Seats are for members aged 18 and over.');
  if (age > 110) throw new AppError('invalid_input', 400, 'Check that date of birth — it is earlier than this service supports.');
  return dob;
}

export function validateIdentityInput({ legalName, idNumber, dateOfBirth }) {
  const name = String(legalName || '').trim().replace(/\s+/g, ' ');
  const id = String(idNumber || '').replace(/\s/g, '');
  if (name.length < 3 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new AppError('invalid_input', 400, 'Enter your full legal name as it appears on your ID.');
  }
  if (!/^\d{7,8}$/.test(id)) {
    throw new AppError('invalid_input', 400, 'Enter the 7 or 8 digits of your national ID.');
  }
  return { legalName: name, idNumber: id, dateOfBirth: validateDateOfBirth(dateOfBirth) };
}

// Builds the stored identity fields. With no provider connected the result is
// 'pending' and an admin decides; a provider match verifies immediately.
export async function prepareIdentity(db, { userId = null, accountName, accountPhone, legalName, idNumber, dateOfBirth }) {
  const clean = validateIdentityInput({ legalName, idNumber, dateOfBirth });
  const hash = await sha256Hex(`identity:${clean.idNumber}`);
  const held = one(await db.from('users').select('id').eq('identity_hash', hash).limit(1));
  if (held && held.id !== userId) {
    throw new AppError('identity_in_use', 409, 'That ID is already attached to another account. One ID can hold only one account.');
  }
  const nameMismatch = !sameName(clean.legalName, accountName);
  const provider = await verifyIdentityWithProvider({
    idNumber: clean.idNumber,
    legalName: clean.legalName,
    phone: accountPhone,
    dateOfBirth: clean.dateOfBirth,
  });
  const status = provider.status === 'verified' && !nameMismatch ? 'verified' : 'pending';
  const note = status === 'verified' ? null
    : nameMismatch ? 'The legal name typed differs from the account name. A reviewer will compare both with the ID record.'
      : provider.reason === 'not_found' ? 'The national register returned no record for that ID number. A reviewer will check the details.'
        : provider.reason === 'provider_no_match' ? 'The ID record did not match the name or date of birth typed. A reviewer will check it.'
          : provider.reason === 'provider_error' || provider.reason === 'provider_unreachable'
            ? 'The national register could not be reached. A reviewer will check the typed details.'
            : 'The ID is with the review desk.';
  return {
    status,
    nameMismatch,
    reference: provider.reference || null,
    patch: {
      identity_status: status,
      identity_hash: hash,
      identity_last4: clean.idNumber.slice(-4),
      identity_name: clean.legalName,
      identity_name_mismatch: nameMismatch,
      identity_source: status === 'verified' ? 'provider' : 'typed',
      identity_provider: provider.provider || null,
      identity_reference: provider.reference || null,
      identity_checked_at: provider.reason && provider.provider ? nowIso() : null,
      identity_dob_match: provider.checks?.dateOfBirth?.match ?? null,
      identity_phone_match: provider.checks?.phone?.match ?? null,
      identity_note: note,
      identity_at: status === 'verified' ? nowIso() : null,
      identity_submitted_at: nowIso(),
      ...(clean.dateOfBirth ? { date_of_birth: clean.dateOfBirth } : {}),
      updated_at: nowIso(),
    },
  };
}

export async function saveIdentity(db, user, body) {
  const typedPhone = String(body.phone || '').trim();
  const account = one(await db.from('users').select('*').eq('id', user.id).limit(1));
  if (!account) throw new AppError('invalid_credentials', 401, 'Sign in to continue.');
  if (account.identity_status === 'verified') {
    return { ok: true, identityStatus: 'verified', already: true, review: false };
  }
  if (typedPhone && phoneKey(typedPhone) !== phoneKey(account.phone)) {
    throw new AppError('phone_mismatch', 400,
      'That phone does not match the number on this account. Use the number you signed up with, or update it with your organizer first.');
  }
  validateIdentityInput(body);
  const prepared = await prepareIdentity(db, {
    userId: account.id,
    accountName: account.name,
    accountPhone: account.phone,
    legalName: body.legalName,
    idNumber: body.idNumber,
    dateOfBirth: body.dateOfBirth,
  });
  rows(await db.from('users').update(prepared.patch).eq('id', account.id).select('id'));
  if (prepared.status === 'verified') {
    return { ok: true, identityStatus: 'verified', review: false, reference: prepared.reference };
  }
  return {
    ok: true,
    identityStatus: 'pending',
    review: true,
    nameMismatch: prepared.nameMismatch,
    note: prepared.patch.identity_note,
  };
}

async function refundSeat(db, { group, membership, memo, amountMinor = null, now = Date.now() }) {
  const amount = amountMinor === null ? Number(membership.seat_paid_minor || 0) : Math.max(0, Math.round(amountMinor));
  if (amount > 0) {
    await insertLedger(db, {
      ref: `seat_refund:${membership.id}`,
      groupId: group.id,
      userId: membership.user_id,
      membershipId: membership.id,
      kind: 'seat_refund',
      amountMinor: amount,
      walletEffect: amount,
      availableAt: nowIso(now),
      memo,
      createdAt: nowIso(now),
    });
  }
  rows(await db.from('memberships').update({
    status: 'removed',
    seat_status: amount > 0 ? 'refunded' : 'expired',
    seat_paid_minor: 0,
    removed_at: nowIso(now),
  }).eq('id', membership.id).select('id'));
  return amount;
}

/** Frees unpaid holds and returns prepaid seats when a circle stalls. Safe to call on every read. */
export async function sweepSeats(db, now = Date.now()) {
  const groups = rows(await db.from('groups').select('*').eq('status', 'forming').limit(200));
  let released = 0;
  for (const group of groups) {
    const members = (await membersOf(db, group.id)).filter((member) => member.status === 'active');
    for (const member of members) {
      if (member.role === 'organizer') continue;
      const seatStatus = member.seat_status || 'none';
      if (seatStatus === 'paid') {
        const paidAt = Date.parse(member.seat_paid_at || '');
        if (Number.isFinite(paidAt) && now - paidAt > SEAT_STALL_MS) {
          await refundSeat(db, {
            group,
            membership: member,
            memo: `Seat returned · ${group.name} did not start within 14 days`,
            now,
          });
          released += 1;
        }
        continue;
      }
      if (seatStatus === 'pending') {
        const expires = Date.parse(member.seat_expires_at || '');
        if (!Number.isFinite(expires) || now > expires) {
          rows(await db.from('memberships').update({
            status: 'removed', seat_status: 'expired', removed_at: nowIso(now),
          }).eq('id', member.id).select('id'));
          released += 1;
        }
      }
    }
  }
  return released;
}

function seatPending(member) {
  if (member.role === 'organizer') return false;
  return (member.seat_status || 'none') !== 'paid';
}

export async function openCircleList(db, userId, now = Date.now()) {
  await sweepSeats(db, now);
  const groups = rows(await db.from('groups').select('*')
    .eq('visibility', 'open').eq('status', 'forming').limit(80));
  const mine = new Set(rows(await db.from('memberships').select('group_id').eq('user_id', userId).limit(40))
    .map((row) => row.group_id));
  const circles = [];
  for (const group of groups) {
    if (mine.has(group.id)) continue;
    if (await currentCircle(db, group.id)) continue;
    const members = (await membersOf(db, group.id)).filter((member) => member.status === 'active');
    const seats = Math.min(RULES.maxMembers, Number(group.max_members));
    if (members.length >= seats) continue;
    const organizer = one(await db.from('users').select('name,trust_score').eq('id', group.organizer_id).limit(1));
    const trusted = members.filter((member) => Number(member.trust_score) >= 60).length;
    circles.push({
      id: group.id,
      name: group.name,
      contributionMinor: Number(group.contribution_minor),
      seatMinor: Number(group.contribution_minor),
      maxMembers: seats,
      memberCount: members.length,
      seatsLeft: seats - members.length,
      cadence: group.cadence === 'fortnightly' || group.cadence === 'monthly' ? group.cadence : 'weekly',
      organizerFeeBps: Number(group.organizer_fee_bps),
      organizerName: organizer?.name || 'Organizer',
      organizerTrust: Number(organizer?.trust_score ?? 50),
      trustedMembers: trusted,
      verifiedMembers: members.filter((member) => member.kyc_status === 'verified' || member.seat_status === 'paid').length,
      expectToPayMinor: Number(group.contribution_minor) * seats,
      createdAt: group.created_at,
    });
  }
  return circles.sort((a, b) => b.memberCount - a.memberCount || String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function reserveOpenSeat(db, group, user, { now = Date.now() } = {}) {
  const existing = one(await db.from('memberships').select('*').eq('group_id', group.id).eq('user_id', user.id).limit(1));
  if (existing) {
    if (existing.status === 'active') {
      throw new AppError('already_seated', 409, 'You already hold a seat in this circle.');
    }
    throw new AppError('seats_closed', 409, 'That account already used a seat in this circle.');
  }
  const before = (await membersOf(db, group.id)).filter((member) => member.status === 'active');
  const seats = Math.min(RULES.maxMembers, Number(group.max_members));
  if (before.length >= seats) throw new AppError('group_full', 409, 'This circle just filled. Choose another open circle.');
  const taken = new Set(before.map((member) => Number(member.seat_no)));
  for (let seat = 2; seat <= seats; seat += 1) {
    if (taken.has(seat)) continue;
    const inserted = rows(await db.from('memberships').insertIfAbsent({
      id: crypto.randomUUID(),
      group_id: group.id,
      user_id: user.id,
      seat_no: seat,
      display_name: user.name,
      role: 'member',
      status: 'active',
      bond_bps: bondBpsForTrust(user.trust_score),
      trust_score: Number(user.trust_score ?? 50),
      ontime_cycles: 0,
      late_cycles: 0,
      defaults: 0,
      has_won: false,
      accepted_round: 0,
      current_circle_id: null,
      kyc_status: 'pending',
      seat_status: 'pending',
      seat_due_minor: Number(group.contribution_minor),
      seat_paid_minor: 0,
      seat_expires_at: new Date(now + SEAT_HOLD_MS).toISOString(),
      joined_at: nowIso(now),
    }, { onConflict: 'group_id,seat_no' }).select('*'));
    if (inserted.length) return inserted[0];
  }
  throw new AppError('group_full', 409, 'This circle just filled. Choose another open circle.');
}

export async function markSeatPaid(db, membership, { amountMinor, providerRef = null, sessionId = null, now = Date.now() }) {
  const group = one(await db.from('groups').select('*').eq('id', membership.group_id).limit(1));
  if (!group) throw new AppError('group_not_found', 404);
  if (membership.seat_status === 'paid') return { alreadyPaid: true };
  const expected = Number(membership.seat_due_minor || group.contribution_minor);
  const paidAmount = Math.round(Number(amountMinor));
  if (!Number.isSafeInteger(paidAmount) || paidAmount !== Math.round(expected)) {
    const refunded = await refundSeat(db, {
      group,
      membership,
      memo: 'Seat payment returned · the amount did not match the seat',
      amountMinor: Number.isSafeInteger(paidAmount) ? paidAmount : 0,
      now,
    });
    return { refunded: true, reason: 'amount_mismatch', amountMinor: refunded };
  }
  if (group.status !== 'forming' || await currentCircle(db, group.id) || membership.status !== 'active') {
    const refunded = await refundSeat(db, {
      group,
      membership,
      memo: 'Seat payment returned · the circle filled before your payment landed',
      amountMinor: Math.round(expected),
      now,
    });
    return { refunded: true, amountMinor: refunded };
  }
  const paidAt = nowIso(now);
  const claimed = rows(await db.from('memberships').update({
    seat_status: 'paid',
    seat_paid_minor: expected,
    seat_paid_at: paidAt,
    seat_expires_at: null,
    seat_provider_ref: providerRef || sessionId || null,
    // The join pledge accepts the circle rules, so it counts as this round's acceptance.
    accepted_round: 1,
  }).eq('id', membership.id).eq('seat_status', 'pending').select('id'));
  if (!claimed.length) {
    const fresh = one(await db.from('memberships').select('seat_status').eq('id', membership.id).limit(1));
    return { alreadyPaid: fresh?.seat_status === 'paid' };
  }
  await insertLedger(db, {
    ref: `seat_prepay:${membership.id}`,
    groupId: group.id,
    userId: membership.user_id,
    membershipId: membership.id,
    kind: 'seat_prepay',
    amountMinor: expected,
    walletEffect: 0,
    availableAt: paidAt,
    memo: `Seat secured · ${group.name} · applies to turn 1`,
    createdAt: paidAt,
  });
  return { alreadyPaid: false, paidAt };
}

export async function leaveOpenGroup(db, { group, membership, now = Date.now() }) {
  if (membership.role === 'organizer') {
    throw new AppError('organizer_cannot_leave', 409, 'The organizer cannot leave a forming circle. Hand over the circle or complete it.');
  }
  if ((await currentCircle(db, group.id)) || group.status !== 'forming') {
    throw new AppError('seats_locked', 409, 'Seats lock once the round starts.');
  }
  const refunded = await refundSeat(db, {
    group,
    membership,
    memo: `Left ${group.name} before the start · seat payment returned`,
    now,
  });
  return { ok: true, refundedMinor: refunded };
}

/** Open circles require every joining seat to be prepaid before the organizer may start. */
export function unpaidSeats(members) {
  return members.filter((member) => member.status === 'active' && seatPending(member));
}

export async function applySeatCredits(db, { group, members, cycle, now = Date.now() }) {
  let applied = 0;
  for (const member of members) {
    if (Number(member.seat_paid_minor || 0) <= 0 || member.status !== 'active') continue;
    const contribution = await contributionForMember(db, cycle.id, member.id);
    if (!contribution || contribution.status === 'paid') continue;
    const result = await markContributionPaid(db, {
      contribution,
      cycle,
      membership: member,
      amountMinor: Number(contribution.amount_minor),
      method: 'seat_prepay',
      providerRef: member.seat_provider_ref || null,
      paidAt: nowIso(now),
      chargeTrust: false,
    });
    if (result?.alreadyPaid === false) applied += 1;
  }
  return applied;
}

