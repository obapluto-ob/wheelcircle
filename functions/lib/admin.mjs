import { AppError } from './errors.mjs';
import { one, rows, nowIso, sha256Hex, sum } from './util.mjs';
import { normalizePhone, rateLimit } from './auth.mjs';
import { identityProviderConfigured } from './identity-provider.mjs';

export function adminPhones() {
  return String(process.env.WHEEL_ADMIN_PHONES || '')
    .split(',')
    .map((entry) => normalizePhone(entry.trim()))
    .filter(Boolean);
}

export function isAdmin(user) {
  if (!user?.phone) return false;
  const phone = normalizePhone(user.phone);
  return Boolean(phone) && adminPhones().includes(phone);
}

export function requireAdmin(user) {
  if (!isAdmin(user)) throw new AppError('admin_only', 403, 'The review desk is for ID reviewers only.');
}

const PANEL_PIN_MIN_LENGTH = 4;

export function adminPinConfigured() {
  return String(process.env.ADMIN_PANEL_PIN || '').trim().length >= PANEL_PIN_MIN_LENGTH;
}

function sameDigest(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

// The PIN never leaves the server. It is compared as a digest, and every attempt
// counts against a durable bucket so a stolen session still cannot grind digits.
export async function unlockAdminPanel(db, user, pin) {
  requireAdmin(user);
  const expected = String(process.env.ADMIN_PANEL_PIN || '').trim();
  if (!adminPinConfigured()) {
    throw new AppError('admin_pin_not_set', 503, 'The operator PIN is not set on this server yet.');
  }
  await rateLimit(db, `admin:unlock:${user.id}`, 5, 10 * 60 * 1000);
  const given = String(pin ?? '').trim();
  if (given.length < PANEL_PIN_MIN_LENGTH || given.length > 32) {
    throw new AppError('invalid_pin', 400, 'Enter the operator PIN.');
  }
  const matches = sameDigest(await sha256Hex(given), await sha256Hex(expected));
  if (!matches) throw new AppError('admin_pin_wrong', 403, 'That PIN does not open this door.');
  return {
    unlocked: true,
    pinConfigured: true,
    message: 'Door released. Hold the latch to enter.',
  };
}

export async function adminOverview(db) {
  const groups = rows(await db.from('groups').select('*').limit(64));
  const memberships = rows(await db.from('memberships')
    .select('id,group_id,user_id,display_name,seat_no,role,status').limit(4000));
  const circles = rows(await db.from('circles').select('id,group_id,number,status').limit(200));
  const cycles = rows(await db.from('cycles').select('*').limit(3000));
  const settlements = rows(await db.from('settlements').select('*').limit(3000));
  const funds = rows(await db.from('fund_entries').select('group_id,amount_minor').limit(8000));
  const bonds = rows(await db.from('bonds').select('group_id,held_minor,status').limit(4000));
  const wallets = rows(await db.from('wallets').select('balance_minor').limit(8000));
  const contributions = rows(await db.from('contributions').select('cycle_id,status').limit(8000));
  const paidByCycle = new Map();
  for (const row of contributions) {
    if (row.status !== 'paid') continue;
    paidByCycle.set(row.cycle_id, (paidByCycle.get(row.cycle_id) || 0) + 1);
  }

  const fundByGroup = new Map();
  for (const entry of funds) {
    fundByGroup.set(entry.group_id, (fundByGroup.get(entry.group_id) || 0) + (Number(entry.amount_minor) || 0));
  }
  const bondByGroup = new Map();
  for (const bond of bonds) {
    if (bond.status !== 'held') continue;
    bondByGroup.set(bond.group_id, (bondByGroup.get(bond.group_id) || 0) + (Number(bond.held_minor) || 0));
  }
  const memberCount = new Map();
  for (const member of memberships) {
    if (member.status !== 'active') continue;
    memberCount.set(member.group_id, (memberCount.get(member.group_id) || 0) + 1);
  }
  const circleByGroup = new Map();
  for (const circle of circles) {
    const current = circleByGroup.get(circle.group_id);
    if (!current || Number(circle.number) > Number(current.number)) circleByGroup.set(circle.group_id, circle);
  }
  const cycleByGroup = new Map();
  for (const cycle of cycles) {
    const current = cycleByGroup.get(cycle.group_id);
    if (!current || Number(cycle.number) > Number(current.number)) cycleByGroup.set(cycle.group_id, cycle);
  }
  const settledByGroup = new Map();
  const unbalanced = [];
  const totals = {
    potMinor: 0, winnerNetMinor: 0, discountMinor: 0,
    platformFeeMinor: 0, organizerFeeMinor: 0, organizerWaivedMinor: 0, fundFeeMinor: 0,
    bondHeldMinor: 0, balancedSettlements: 0, unbalancedSettlements: 0,
  };
  for (const settlement of settlements) {
    const pot = Number(settlement.pot_minor);
    const allocated = Number(settlement.discount_minor)
      + Number(settlement.platform_fee_minor)
      + Number(settlement.organizer_fee_minor)
      + Number(settlement.organizer_waived_minor)
      + Number(settlement.fund_fee_minor)
      + Number(settlement.bond_hold_minor)
      + Number(settlement.winner_net_minor);
    if (allocated === pot) totals.balancedSettlements += 1;
    else {
      totals.unbalancedSettlements += 1;
      if (unbalanced.length < 8) unbalanced.push({ groupId: settlement.group_id, cycleId: settlement.cycle_id, potMinor: pot, allocatedMinor: allocated });
    }
    settledByGroup.set(settlement.group_id, (settledByGroup.get(settlement.group_id) || 0) + 1);
    totals.potMinor += pot;
    totals.winnerNetMinor += Number(settlement.winner_net_minor) || 0;
    totals.discountMinor += Number(settlement.discount_minor) || 0;
    totals.platformFeeMinor += Number(settlement.platform_fee_minor) || 0;
    totals.organizerFeeMinor += Number(settlement.organizer_fee_minor) || 0;
    totals.organizerWaivedMinor += Number(settlement.organizer_waived_minor) || 0;
    totals.fundFeeMinor += Number(settlement.fund_fee_minor) || 0;
    totals.bondHeldMinor += Number(settlement.bond_hold_minor) || 0;
  }
  totals.feesMinor = totals.platformFeeMinor + totals.organizerFeeMinor
    + totals.organizerWaivedMinor + totals.fundFeeMinor;
  totals.fundBalanceMinor = sum(funds.map((entry) => Number(entry.amount_minor) || 0));
  totals.walletBalanceMinor = sum(wallets.map((wallet) => Number(wallet.balance_minor) || 0));
  totals.bondsHeldMinor = sum(bonds.filter((bond) => bond.status === 'held').map((bond) => Number(bond.held_minor) || 0));

  const live = groups
    .map((group) => {
      const currentCircle = circleByGroup.get(group.id) || null;
      const cycle = cycleByGroup.get(group.id) || null;
      const members = memberCount.get(group.id) || 0;
      const fundMinor = fundByGroup.get(group.id) || 0;
      return {
        id: group.id,
        name: group.name,
        status: group.status,
        contributionMinor: Number(group.contribution_minor),
        memberCount: members,
        maxMembers: Number(group.max_members),
        round: currentCircle ? Number(currentCircle.number) : null,
        turn: cycle ? Number(cycle.number) : null,
        turnStatus: cycle?.status || null,
        paidCount: cycle ? paidByCycle.get(cycle.id) || 0 : 0,
        potCapturedMinor: cycle ? Number(cycle.pot_captured_minor) : 0,
        potExpectedMinor: cycle ? Number(cycle.pot_expected_minor) : 0,
        settledTurns: settledByGroup.get(group.id) || 0,
        fundMinor,
        bondHeldMinor: bondByGroup.get(group.id) || 0,
        startedAt: group.started_at || null,
      };
    })
    .sort((left, right) => {
      const rank = { active: 0, forming: 1, completed: 2 };
      return (rank[left.status] ?? 3) - (rank[right.status] ?? 3) || String(left.name).localeCompare(String(right.name));
    });

  return {
    now: nowIso(),
    pinConfigured: adminPinConfigured(),
    totals: {
      ...totals,
      groups: groups.length,
      forming: groups.filter((group) => group.status === 'forming').length,
      active: groups.filter((group) => group.status === 'active').length,
      completed: groups.filter((group) => group.status === 'completed').length,
      members: memberships.filter((member) => member.status === 'active').length,
    },
    circles: live,
    unbalanced,
  };
}

export async function identityQueue(db, status = 'pending') {
  const filter = ['pending', 'reviewed', 'all'].includes(status) ? status : 'pending';
  const users = rows(await db.from('users')
    .select('id,name,phone,trust_score,created_at,date_of_birth,identity_status,identity_last4,identity_name,identity_name_mismatch,identity_source,identity_provider,identity_reference,identity_checked_at,identity_dob_match,identity_phone_match,identity_at,identity_submitted_at,identity_note')
    .limit(500));
  const submitted = users.filter((user) => ['pending', 'verified', 'rejected'].includes(user.identity_status));
  const scoped = filter === 'all' ? submitted
    : filter === 'reviewed' ? submitted.filter((user) => ['verified', 'rejected'].includes(user.identity_status))
      : submitted.filter((user) => user.identity_status === 'pending');
  scoped.sort((left, right) => String(right.identity_submitted_at || right.identity_at || '')
    .localeCompare(String(left.identity_submitted_at || left.identity_at || '')));
  const memberships = rows(await db.from('memberships').select('user_id,status').limit(4000));
  const circles = new Map();
  for (const member of memberships) {
    if (member.status !== 'active') continue;
    circles.set(member.user_id, (circles.get(member.user_id) || 0) + 1);
  }
  const actions = rows(await db.from('admin_actions').select('*').limit(400));
  actions.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
  return {
    providerConfigured: identityProviderConfigured(),
    pendingCount: submitted.filter((user) => user.identity_status === 'pending').length,
    queue: scoped.slice(0, 60).map((user) => ({
      id: user.id,
      name: user.name,
      phone: user.phone,
      trustScore: Number(user.trust_score ?? 50),
      memberSince: user.created_at,
      identityStatus: user.identity_status,
      identityName: user.identity_name || null,
      identityLast4: user.identity_last4 || null,
      identitySource: user.identity_source || 'typed',
      identityProvider: user.identity_provider || null,
      identityReference: user.identity_reference || null,
      identityCheckedAt: user.identity_checked_at || null,
      identityDobMatch: user.identity_dob_match ?? null,
      identityPhoneMatch: user.identity_phone_match ?? null,
      dateOfBirth: user.date_of_birth || null,
      age: user.date_of_birth ? Math.floor((Date.now() - Date.parse(`${user.date_of_birth}T00:00:00Z`)) / (365.25 * 24 * 3600000)) : null,
      nameMismatch: Boolean(user.identity_name_mismatch),
      submittedAt: user.identity_submitted_at || null,
      reviewedAt: user.identity_at || null,
      note: user.identity_note || null,
      activeCircles: circles.get(user.id) || 0,
    })),
    recent: actions.slice(0, 12).map((action) => ({
      action: action.action,
      adminName: action.admin_name,
      targetName: action.target_name,
      note: action.note || null,
      at: action.created_at,
    })),
  };
}

export async function decideIdentity(db, admin, targetId, body) {
  requireAdmin(admin);
  const action = String(body.action || '');
  if (!['approve', 'reject'].includes(action)) {
    throw new AppError('invalid_input', 400, 'Choose approve or reject.');
  }
  const note = String(body.note || '').trim().slice(0, 240);
  if (action === 'reject' && note.length < 4) {
    throw new AppError('invalid_input', 400, 'Add a short note so the member knows what to fix.');
  }
  const target = one(await db.from('users').select('*').eq('id', targetId).limit(1));
  if (!target) throw new AppError('not_found', 404, 'That account is not on the review desk.');
  if (target.identity_status !== 'pending') {
    throw new AppError('not_pending', 409, 'That ID is not waiting for review.');
  }
  const reviewedAt = nowIso();
  rows(await db.from('users').update({
    identity_status: action === 'approve' ? 'verified' : 'rejected',
    identity_note: note || null,
    identity_at: action === 'approve' ? reviewedAt : target.identity_at || null,
    identity_reviewed_by: admin.id,
    identity_reviewed_at: reviewedAt,
    updated_at: reviewedAt,
  }).eq('id', target.id).select('id'));
  rows(await db.from('admin_actions').insertIfAbsent({
    id: crypto.randomUUID(),
    admin_id: admin.id,
    admin_name: admin.name,
    target_user_id: target.id,
    target_name: target.name,
    action: action === 'approve' ? 'identity_approved' : 'identity_rejected',
    note: note || null,
    created_at: reviewedAt,
  }, { onConflict: 'id' }).select('id'));
  return {
    ok: true,
    identityStatus: action === 'approve' ? 'verified' : 'rejected',
    message: action === 'approve'
      ? `${target.name}'s ID is verified. Open seats and payouts unlock for them.`
      : `${target.name}'s submission was returned with your note.`,
  };
}
