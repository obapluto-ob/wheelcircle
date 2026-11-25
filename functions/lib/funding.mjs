import { AppError, fail } from './errors.mjs';
import { addMs, clamp, nowIso, one, rows, sum } from './util.mjs';
import { insertFundEntry, insertLedger, fundBalance, walletFor } from './ledger.mjs';
import { RULES, bondBpsForTrust, lateFeeFor, MINUTE } from './rules.mjs';

export async function contributionsFor(db, cycleId) {
  return rows(await db.from('contributions')
    .select('id,cycle_id,group_id,membership_id,amount_minor,late_fee_minor,total_minor,status,method,provider_ref,checkout_url,checkout_expires_at,covered_by_membership_id,cover_source,paid_at,created_at')
    .eq('cycle_id', cycleId).limit(100));
}

export async function ensureContributionRows(db, cycle, memberships) {
  const existing = await contributionsFor(db, cycle.id);
  const present = new Set(existing.map((row) => row.membership_id));
  const active = memberships.filter((member) => member.status === 'active');
  for (const member of active) {
    if (present.has(member.id)) continue;
    rows(await db.from('contributions').insertIfAbsent({
      id: crypto.randomUUID(),
      cycle_id: cycle.id,
      group_id: cycle.group_id,
      membership_id: member.id,
      amount_minor: cycle.contribution_minor,
      late_fee_minor: 0,
      total_minor: cycle.contribution_minor,
      status: 'pending',
      created_at: nowIso(),
    }, { onConflict: 'cycle_id,membership_id' }).select('id'));
  }
  return contributionsFor(db, cycle.id);
}

export function contributionAmount(cycle, contribution, now = Date.now()) {
  if (!contribution) return { dueMinor: cycle.contribution_minor, lateFeeMinor: 0 };
  if (contribution.status === 'paid') {
    return { dueMinor: Number(contribution.total_minor || contribution.amount_minor), lateFeeMinor: Number(contribution.late_fee_minor || 0) };
  }
  const lateFeeMinor = lateFeeFor(cycle.contribution_minor, cycle.contribution_due_at, now);
  return { dueMinor: Number(cycle.contribution_minor) + lateFeeMinor, lateFeeMinor };
}

export async function getCycle(db, cycleId) {
  return one(await db.from('cycles').select('*').eq('id', cycleId).limit(1));
}

export async function latestCycle(db, groupId) {
  const circle = one(await db.from('circles').select('id').eq('group_id', groupId).order('number', { ascending: false }).limit(1));
  return circle ? one(await db.from('cycles').select('*').eq('circle_id', circle.id).order('number', { ascending: false }).limit(1)) : null;
}

export async function assertCurrentCycle(db, cycle) {
  const circle = one(await db.from('circles').select('id').eq('group_id', cycle.group_id).order('number', { ascending: false }).limit(1));
  if (!circle || circle.id !== cycle.circle_id) {
    throw new AppError('stale_turn', 409, 'That turn belongs to an earlier round.');
  }
}

async function setPot(db, cycle, nextPot) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const current = one(await db.from('cycles').select('id,pot_captured_minor,status').eq('id', cycle.id).limit(1));
    if (!current) throw new AppError('cycle_missing', 404);
    if (Number(current.pot_captured_minor) === nextPot) return current.pot_captured_minor;
    if (Number(current.pot_captured_minor) > nextPot) return Number(current.pot_captured_minor);
    const updated = rows(await db.from('cycles')
      .update({ pot_captured_minor: nextPot })
      .eq('id', cycle.id).eq('pot_captured_minor', current.pot_captured_minor)
      .select('id,pot_captured_minor'));
    if (updated.length) return updated[0].pot_captured_minor;
  }
  throw new AppError('write_conflict', 409, 'The pot changed while updating. Refresh and try again.');
}

export async function creditPot(db, cycle, deltaMinor) {
  const current = one(await db.from('cycles').select('pot_captured_minor').eq('id', cycle.id).limit(1));
  if (!current) throw new AppError('cycle_missing', 404);
  return setPot(db, cycle, Number(current.pot_captured_minor) + Math.max(0, Math.round(deltaMinor)));
}

export async function fundCycleIfComplete(db, cycle, memberships, bidWindowMinutes = RULES.bidWindowMinutes, now = Date.now()) {
  if (!cycle || cycle.status !== 'contributing') return cycle;
  await assertCurrentCycle(db, cycle);
  const contributions = await contributionsFor(db, cycle.id);
  const active = memberships.filter((member) => member.status === 'active');
  const paid = contributions.filter((item) => item.status === 'paid');
  const complete = active.length > 0 && active.every((member) => paid.some((item) => item.membership_id === member.id));
  if (!complete) return cycle;
  const paidSum = sum(paid.map((item) => item.amount_minor));
  if (paidSum < Number(cycle.pot_expected_minor)) return cycle;
  const final = Boolean(cycle.is_final);
  const opens = nowIso(now);
  const closes = new Date(now + (final ? 0 : Math.max(1, Number(bidWindowMinutes) || RULES.bidWindowMinutes) * MINUTE)).toISOString();
  const updated = rows(await db.from('cycles')
    .update({ status: 'funded', auction_opens_at: opens, auction_closes_at: closes })
    .eq('id', cycle.id).eq('status', 'contributing')
    .select('*'));
  if (updated.length) return updated[0];
  return (await getCycle(db, cycle.id)) || cycle;
}

export async function reconcileCycle(db, cycle, memberships, bidWindowMinutes) {
  if (!cycle) return cycle;
  await assertCurrentCycle(db, cycle);
  const contributions = await contributionsFor(db, cycle.id);
  const paidSum = sum(contributions.filter((item) => item.status === 'paid').map((item) => item.amount_minor));
  let current = cycle;
  if (Number(cycle.pot_captured_minor) < paidSum) {
    await setPot(db, cycle, paidSum);
    current = (await getCycle(db, cycle.id)) || cycle;
  }
  if (current.status === 'contributing') {
    current = await fundCycleIfComplete(db, current, memberships, bidWindowMinutes);
  }
  return current;
}

export async function applyTrust(db, membership, late) {
  let current = membership;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = one(await db.from('memberships').select('id,user_id,trust_score,ontime_cycles,late_cycles,bond_bps').eq('id', membership.id).limit(1));
    if (!row) return;
    current = row;
    const trust = clamp(Number(row.trust_score) + (late ? -2 : 1), RULES.trustMin, RULES.trustMax);
    const updated = rows(await db.from('memberships').update({
      trust_score: trust,
      bond_bps: bondBpsForTrust(trust),
      ontime_cycles: Number(row.ontime_cycles) + (late ? 0 : 1),
      late_cycles: Number(row.late_cycles) + (late ? 1 : 0),
    }).eq('id', row.id).eq('trust_score', row.trust_score).select('id'));
    if (updated.length) {
      for (let userAttempt = 0; userAttempt < 4; userAttempt += 1) {
        const user = one(await db.from('users').select('id,trust_score').eq('id', row.user_id).limit(1));
        if (!user) break;
        const bumped = rows(await db.from('users').update({ trust_score: trust, updated_at: nowIso() })
          .eq('id', user.id).eq('trust_score', user.trust_score).select('id'));
        if (bumped.length) break;
      }
      return;
    }
  }
}

export async function releaseBondOnPayment(db, membership, cycle, now = Date.now()) {
  const bond = one(await db.from('bonds')
    .select('id,group_id,membership_id,settlement_id,amount_minor,held_minor,release_cycles_total,release_cycles_done,status,created_at')
    .eq('membership_id', membership.id).eq('status', 'held').limit(1));
  if (!bond) return null;
  const settlement = one(await db.from('settlements').select('cycle_id').eq('id', bond.settlement_id).limit(1));
  const wonCycle = settlement ? await getCycle(db, settlement.cycle_id) : null;
  if (!wonCycle || wonCycle.circle_id !== cycle.circle_id || Number(wonCycle.number) >= Number(cycle.number)) return null;
  const total = Number(bond.release_cycles_total);
  const done = Number(bond.release_cycles_done);
  if (!Number.isFinite(total) || total <= 0 || done >= total) return null;
  const remaining = total - done;
  const held = Number(bond.held_minor);
  const releaseMinor = remaining === 1 ? held : Math.min(held, Math.floor(Number(bond.amount_minor) / total));
  if (releaseMinor <= 0) return null;
  const createdAt = nowIso(now);
  const release = rows(await db.from('bond_releases').insertIfAbsent({
    id: crypto.randomUUID(),
    bond_id: bond.id,
    cycle_id: cycle.id,
    amount_minor: releaseMinor,
    created_at: createdAt,
  }, { onConflict: 'bond_id,cycle_id' }).select('id'));
  if (!release.length) return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = one(await db.from('bonds').select('held_minor,release_cycles_done,release_cycles_total,status').eq('id', bond.id).limit(1));
    if (!current) return null;
    const nextDone = Number(current.release_cycles_done) + 1;
    const nextHeld = Math.max(0, Number(current.held_minor) - releaseMinor);
    const updated = rows(await db.from('bonds').update({
      held_minor: nextHeld,
      release_cycles_done: nextDone,
      status: nextDone >= Number(current.release_cycles_total) ? 'released' : 'held',
      released_at: nextDone >= Number(current.release_cycles_total) ? createdAt : null,
    }).eq('id', bond.id).eq('release_cycles_done', current.release_cycles_done).select('id'));
    if (updated.length) break;
  }
  await insertLedger(db, {
    ref: `bond_release:${bond.id}:${cycle.id}`,
    groupId: bond.group_id,
    cycleId: cycle.id,
    userId: membership.user_id,
    membershipId: membership.id,
    kind: 'bond_release',
    amountMinor: releaseMinor,
    walletEffect: releaseMinor,
    availableAt: createdAt,
    memo: `Bond released after turn ${cycle.number}`,
    createdAt,
  });
  return releaseMinor;
}

export async function markContributionPaid(db, {
  contribution,
  cycle,
  membership,
  amountMinor,
  lateFeeMinor = 0,
  method,
  providerRef = null,
  paidAt = nowIso(),
  coveredByMembershipId = null,
  coverSource = null,
  chargeTrust = true,
}) {
  await assertCurrentCycle(db, cycle);
  const currentCycle = await getCycle(db, cycle.id);
  if (!currentCycle || currentCycle.status !== 'contributing') {
    throw new AppError('contributions_closed', 409, 'Contributions are closed for this turn.');
  }
  const claimed = rows(await db.from('contributions').update({
    status: 'paid',
    method,
    provider_ref: providerRef,
    late_fee_minor: lateFeeMinor,
    total_minor: Number(contribution.amount_minor) + Number(lateFeeMinor || 0),
    covered_by_membership_id: coveredByMembershipId,
    cover_source: coverSource,
    paid_at: paidAt,
    checkout_url: null,
    checkout_expires_at: null,
  }).eq('id', contribution.id).eq('status', 'pending').select('id'));
  if (!claimed.length) {
    const current = one(await db.from('contributions').select('*').eq('id', contribution.id).limit(1));
    return { alreadyPaid: current?.status === 'paid', contribution: current };
  }
  await creditPot(db, cycle, contribution.amount_minor);
  await insertLedger(db, {
    ref: `contrib:${contribution.id}`,
    groupId: cycle.group_id,
    cycleId: cycle.id,
    userId: membership.user_id,
    membershipId: membership.id,
    kind: 'contribution',
    amountMinor: contribution.amount_minor,
    walletEffect: 0,
    availableAt: paidAt,
    memo: `Turn ${cycle.number} contribution`,
    createdAt: paidAt,
  });
  if (Number(lateFeeMinor) > 0) {
    await insertFundEntry(db, {
      ref: `late:${contribution.id}`,
      groupId: cycle.group_id,
      cycleId: cycle.id,
      kind: 'late_fee',
      amountMinor: lateFeeMinor,
      memo: `Late fee · turn ${cycle.number}`,
      createdAt: paidAt,
    });
    await insertLedger(db, {
      ref: `late:${contribution.id}`,
      groupId: cycle.group_id,
      cycleId: cycle.id,
      userId: membership.user_id,
      membershipId: membership.id,
      kind: 'late_fee',
      amountMinor: lateFeeMinor,
      walletEffect: 0,
      availableAt: paidAt,
      memo: `Late fee paid to the guarantee fund · turn ${cycle.number}`,
      createdAt: paidAt,
    });
  }
  if (chargeTrust) await applyTrust(db, membership, Number(lateFeeMinor) > 0);
  if (!coverSource) await releaseBondOnPayment(db, membership, cycle, Date.parse(paidAt));
  return { alreadyPaid: false, contribution: { ...contribution, status: 'paid' } };
}

export async function coverContribution(db, {
  group, cycle, contribution, member, organizerMembership, source,
}) {
  await assertCurrentCycle(db, cycle);
  const currentCycle = await getCycle(db, cycle.id);
  if (!currentCycle || currentCycle.status !== 'contributing') throw new AppError('contributions_closed', 409, 'This turn is closed.');
  if (organizerMembership.role !== 'organizer') throw new AppError('forbidden', 403, 'Only the organizer can cover a shortfall.');
  if (contribution.status !== 'pending') throw new AppError('contribution_already_paid', 409, 'That contribution is already covered.');
  const amount = Number(contribution.amount_minor);
  let payer = null;
  let fundDebit = false;
  if (source === 'fund') {
    const balance = await fundBalance(db, cycle.group_id);
    if (balance < amount) throw new AppError('fund_short', 409, 'The guarantee fund does not have enough to cover this contribution.');
    fundDebit = true;
  } else if (source === 'wallet') {
    const wallet = await walletFor(db, organizerMembership.user_id);
    if (wallet.availableMinor < amount) throw new AppError('wallet_short', 409, 'Your available wallet does not have enough for this cover.');
    payer = organizerMembership;
  } else if (source === 'guarantor') {
    const guarantee = one(await db.from('guarantees')
      .select('id,guarantor_membership_id,status').eq('member_membership_id', member.id).eq('status', 'active').limit(1));
    if (!guarantee) throw new AppError('no_guarantor', 409, 'This member has no guarantor. Use the fund or your wallet.');
    payer = one(await db.from('memberships').select('*').eq('id', guarantee.guarantor_membership_id).limit(1));
    if (!payer) throw new AppError('no_guarantor', 409);
    const wallet = await walletFor(db, payer.user_id);
    if (wallet.availableMinor < amount) throw new AppError('wallet_short', 409, 'The guarantor does not have enough available balance.');
  } else {
    throw new AppError('invalid_input', 400, 'Choose the fund, your wallet, or the guarantor.');
  }
  const paidAt = nowIso();
  const claimed = rows(await db.from('contributions').update({
    status: 'paid',
    method: 'cover',
    late_fee_minor: 0,
    total_minor: amount,
    covered_by_membership_id: organizerMembership.id,
    cover_source: source,
    paid_at: paidAt,
    checkout_url: null,
    checkout_expires_at: null,
  }).eq('id', contribution.id).eq('status', 'pending').select('id'));
  if (!claimed.length) throw new AppError('contribution_already_paid', 409, 'That contribution is already covered.');
  if (fundDebit) {
    await insertFundEntry(db, {
      ref: `cover:${contribution.id}`,
      groupId: cycle.group_id,
      cycleId: cycle.id,
      kind: 'cover',
      amountMinor: -amount,
      memo: `Fund covered ${member.display_name}'s turn ${cycle.number} contribution`,
      createdAt: paidAt,
    });
  } else if (payer) {
    await insertLedger(db, {
      ref: `cover_debit:${contribution.id}`,
      groupId: cycle.group_id,
      cycleId: cycle.id,
      userId: payer.user_id,
      membershipId: payer.id,
      kind: 'cover',
      amountMinor: -amount,
      walletEffect: -amount,
      availableAt: paidAt,
      memo: `${payer.role === 'organizer' ? 'Organizer' : 'Guarantor'} covered ${member.display_name}'s turn ${cycle.number}`,
      createdAt: paidAt,
    });
  }
  await creditPot(db, cycle, amount);
  await insertLedger(db, {
    ref: `contrib:${contribution.id}`,
    groupId: cycle.group_id,
    cycleId: cycle.id,
    userId: member.user_id,
    membershipId: member.id,
    kind: 'contribution',
    amountMinor: amount,
    walletEffect: 0,
    availableAt: paidAt,
    memo: `Turn ${cycle.number} contribution · covered`,
    createdAt: paidAt,
  });
  await applyTrust(db, { ...member, trust_score: member.trust_score }, true);
  // A covered turn is still a funded turn; the winner's bond keeps unlocking.
  await releaseBondOnPayment(db, member, cycle, Date.parse(paidAt));
  return { source, amountMinor: amount };
}

export async function contributionForMember(db, cycleId, membershipId) {
  return one(await db.from('contributions')
    .select('*').eq('cycle_id', cycleId).eq('membership_id', membershipId).limit(1));
}

export async function recordCheckout(db, contribution, { providerRef, checkoutUrl, expiresAt }) {
  const updated = rows(await db.from('contributions').update({
    provider_ref: providerRef,
    checkout_url: checkoutUrl,
    checkout_expires_at: expiresAt,
    method: 'paysasa',
  }).eq('id', contribution.id).eq('status', 'pending').select('id'));
  return updated.length === 1;
}

export async function clearCheckout(db, contribution) {
  rows(await db.from('contributions').update({
    checkout_url: null,
    checkout_expires_at: null,
  }).eq('id', contribution.id).eq('status', 'pending').select('id'));
}

export { addMs };
