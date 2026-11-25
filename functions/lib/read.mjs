import { AppError } from './errors.mjs';
import { one, rows, nowIso, sum } from './util.mjs';
import { maskPhone } from './auth.mjs';
import { walletFor, walletSummary, groupLedger, groupFundEntries, fundBalance } from './ledger.mjs';
import { contributionsFor, contributionAmount, latestCycle } from './funding.mjs';
import { RULES, bondBpsForTrust, minDiscountBpsFor, groupCadence, seatLadderBps, seatNetPreview } from './rules.mjs';
import { isAdmin } from './admin.mjs';
import { swapSummary } from './swaps.mjs';

export const WITHDRAWAL_BLOCKER = 'M-PESA withdrawals open once the provider confirms the exact payout fee before money moves. Your balance stays recorded in your wallet until then.';

export function rulesPayload() {
  return {
    platformBps: RULES.platformBps,
    fundBps: RULES.fundBps,
    minDiscountBps: RULES.minDiscountBps,
    maxDiscountBps: RULES.maxDiscountBps,
    minDiscountMinor: RULES.minDiscountMinor,
    maxOrganizerBps: RULES.maxOrganizerBps,
    lateFeeBps: RULES.lateFeeBps,
    lateCapBps: RULES.lateCapBps,
    graceHours: RULES.graceHours,
    firstPayoutHoldHours: RULES.firstPayoutHoldHours,
    bidWindowMinutes: RULES.bidWindowMinutes,
    contributionWindowHours: RULES.contributionWindowHours,
    cycleDays: RULES.cycleDays,
    minMembers: RULES.minMembers,
    maxMembers: RULES.maxMembers,
    minContributionMinor: RULES.minContributionMinor,
    maxContributionMinor: RULES.maxContributionMinor,
    currency: 'KES',
    timezone: 'Africa/Nairobi',
  };
}

export function userPayload(user) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    phoneMasked: maskPhone(user.phone),
    trustScore: Number(user.trust_score),
    identityStatus: ['verified', 'pending', 'rejected'].includes(user.identity_status) ? user.identity_status : 'unverified',
    identityLast4: user.identity_last4 || null,
    identityName: user.identity_name || null,
    identityNote: user.identity_note || null,
    identitySubmittedAt: user.identity_submitted_at || null,
    identityNameMismatch: Boolean(user.identity_name_mismatch),
    identityProvider: user.identity_provider || null,
    identityReference: user.identity_reference || null,
    identityCheckedAt: user.identity_checked_at || null,
    identityDobMatch: user.identity_dob_match ?? null,
    identityPhoneMatch: user.identity_phone_match ?? null,
    consentAt: user.verification_consent_at || null,
    dateOfBirth: user.date_of_birth || null,
    isAdmin: isAdmin(user),
    createdAt: user.created_at,
  };
}

export async function groupById(db, groupId) {
  return one(await db.from('groups').select('*').eq('id', groupId).limit(1));
}

export async function membershipFor(db, groupId, userId) {
  return one(await db.from('memberships').select('*').eq('group_id', groupId).eq('user_id', userId).limit(1));
}

export async function membersOf(db, groupId) {
  return rows(await db.from('memberships')
    .select('*').eq('group_id', groupId).order('seat_no', { ascending: true }).limit(24));
}

export async function guaranteesOf(db, groupId) {
  return rows(await db.from('guarantees')
    .select('id,group_id,member_membership_id,guarantor_membership_id,status,created_at')
    .eq('group_id', groupId).limit(48));
}

export async function currentCircle(db, groupId) {
  return one(await db.from('circles').select('*').eq('group_id', groupId).order('number', { ascending: false }).limit(1));
}

export async function settlementFor(db, cycleId) {
  return one(await db.from('settlements').select('*').eq('cycle_id', cycleId).limit(1));
}

export async function bidsFor(db, cycleId) {
  return rows(await db.from('bids')
    .select('id,cycle_id,membership_id,discount_bps,is_pass,status,created_at')
    .eq('cycle_id', cycleId).limit(24));
}

export function memberIndex(members, guarantees) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const guaranteeByMember = new Map();
  const counts = new Map();
  for (const guarantee of guarantees) {
    if (guarantee.status !== 'active') continue;
    guaranteeByMember.set(guarantee.member_membership_id, guarantee);
    counts.set(guarantee.guarantor_membership_id, (counts.get(guarantee.guarantor_membership_id) || 0) + 1);
  }
  return { byId, guaranteeByMember, counts };
}

export function serializeMember(member, index, contributions, user) {
  const guarantee = index.guaranteeByMember.get(member.id);
  const guarantor = guarantee ? index.byId.get(guarantee.guarantor_membership_id) : null;
  const contribution = contributions.find((item) => item.membership_id === member.id);
  return {
    id: member.id,
    userId: member.user_id,
    name: member.display_name,
    seat: Number(member.seat_no),
    role: member.role,
    trustScore: Number(member.trust_score),
    bondBps: Number(member.bond_bps) || bondBpsForTrust(member.trust_score),
    kycStatus: member.kyc_status,
    joinedAt: member.joined_at,
    hasWon: Boolean(member.has_won),
    acceptedRound: Number(member.accepted_round || 0),
    seatStatus: member.seat_status || 'none',
    paidThisCycle: contribution?.status === 'paid',
    ontimeCycles: Number(member.ontime_cycles),
    lateCycles: Number(member.late_cycles),
    defaults: Number(member.defaults),
    guaranteeCount: index.counts.get(member.id) || 0,
    guarantor: guarantor ? { id: guarantor.id, name: guarantor.display_name } : null,
    phoneMasked: user ? maskPhone(user.phone) : null,
    isSelf: Boolean(user),
  };
}

export async function loadMembersWithPhones(db, members) {
  const phones = new Map();
  for (const member of members) {
    const user = one(await db.from('users').select('id,phone').eq('id', member.user_id).limit(1));
    if (user) phones.set(member.user_id, user);
  }
  return phones;
}

export function serializeSettlement(settlement, winner, me) {
  if (!settlement) return null;
  const iWon = me && settlement.winner_membership_id === me.id;
  const isFinal = Boolean(settlement.is_final);
  const wasWaiter = Boolean(me) && !iWon && !me.has_won;
  return {
    id: settlement.id,
    cycleId: settlement.cycle_id,
    winnerMembershipId: settlement.winner_membership_id,
    winnerName: winner?.name || 'Member',
    potMinor: Number(settlement.pot_minor),
    discountBps: Number(settlement.discount_bps),
    discountMinor: Number(settlement.discount_minor),
    platformFeeMinor: Number(settlement.platform_fee_minor),
    organizerFeeMinor: Number(settlement.organizer_fee_minor),
    organizerFeeWaivedMinor: Number(settlement.organizer_waived_minor),
    fundFeeMinor: Number(settlement.fund_fee_minor),
    bondTargetMinor: Number(settlement.bond_target_minor),
    bondHoldMinor: Number(settlement.bond_hold_minor),
    winnerNetMinor: Number(settlement.winner_net_minor),
    waiterCount: Number(settlement.waiter_count),
    waiterShareMinor: Number(settlement.waiter_share_minor),
    remainderMinor: Number(settlement.remainder_minor),
    isFinal,
    status: settlement.status,
    releaseAt: settlement.release_at,
    releasedAt: settlement.released_at,
    createdAt: settlement.created_at,
    myShareMinor: wasWaiter ? Number(settlement.waiter_share_minor) : 0,
    myBondMinor: iWon ? Number(settlement.bond_hold_minor) : 0,
    iWon: Boolean(iWon),
  };
}

export function myWaitShare(settlement, myMembership, winnerMembershipId) {
  if (!settlement || !myMembership) return 0;
  if (myMembership.id === winnerMembershipId) return 0;
  return Number(settlement.waiter_share_minor) || 0;
}

export async function serializeCycle(db, {
  cycle, members, myMembership, organizerFeeBps = RULES.defaultOrganizerBps, now = Date.now(),
}) {
  if (!cycle) return null;
  const isOrganizer = myMembership?.role === 'organizer';
  const contributions = await contributionsFor(db, cycle.id);
  const myContribution = contributions.find((item) => item.membership_id === myMembership?.id) || null;
  const paidCount = contributions.filter((item) => item.status === 'paid').length;
  const activeMembers = members.filter((member) => member.status === 'active');
  const notWon = activeMembers.filter((member) => !member.has_won).length;
  const waitersCount = cycle.is_final ? 0 : Math.max(0, notWon - 1);
  const due = myContribution ? contributionAmount(cycle, myContribution, now) : { dueMinor: cycle.contribution_minor, lateFeeMinor: 0 };
  const turns = Math.max(2, Number(cycle.member_count) || activeMembers.length || 2);
  const potMinor = Number(cycle.pot_expected_minor) || Number(cycle.contribution_minor) * turns;
  const ladder = seatLadderBps(turns, potMinor);
  const seatNo = Number(cycle.number);
  const turnOwner = activeMembers.find((member) => Number(member.seat_no) === seatNo) || null;
  const canClose = cycle.status === 'funded' && Number(cycle.pot_captured_minor) >= Number(cycle.pot_expected_minor);
  return {
    id: cycle.id,
    number: Number(cycle.number),
    status: cycle.status,
    isFinal: Boolean(cycle.is_final),
    memberCount: Number(cycle.member_count),
    contributionMinor: Number(cycle.contribution_minor),
    potExpectedMinor: Number(cycle.pot_expected_minor),
    potCapturedMinor: Number(cycle.pot_captured_minor),
    paidCount,
    waitersCount,
    seatNo,
    turnOwner: turnOwner ? { membershipId: turnOwner.id, name: turnOwner.display_name, seatNo } : null,
    ladderMinor: ladder,
    payoutNow: seatNetPreview(turns, seatNo, potMinor, {
      trust: turnOwner ? turnOwner.trust_score : 60,
      organizerWins: turnOwner ? turnOwner.role === 'organizer' : false,
      organizerFeeBps,
    }).winnerNetMinor,
    contributionDueAt: cycle.contribution_due_at,
    auctionOpensAt: null,
    auctionClosesAt: null,
    settledAt: cycle.settled_at,
    scheduledSettleAt: null,
    settleAvailableAt: null,
    canClose: Boolean(canClose),
    minDiscountBps: minDiscountBpsFor(Number(cycle.pot_captured_minor)),
    maxDiscountBps: RULES.maxDiscountBps,
    amountDueMinor: due.dueMinor,
    lateFeeMinor: due.lateFeeMinor,
    myContribution: myContribution ? {
      id: myContribution.id,
      status: myContribution.status,
      amountMinor: Number(myContribution.amount_minor),
      lateFeeMinor: Number(myContribution.late_fee_minor),
      totalMinor: Number(myContribution.total_minor),
      method: myContribution.method,
      checkoutUrl: myContribution.checkout_url,
      checkoutSessionId: myContribution.provider_ref,
      checkoutExpiresAt: myContribution.checkout_expires_at,
      coverSource: myContribution.cover_source,
    } : null,
    isOrganizer: Boolean(isOrganizer),
  };
}

export function serializeGroup(group, memberCount, isOrganizer, circle) {
  return {
    id: group.id,
    name: group.name,
    inviteCode: group.invite_code,
    contributionMinor: Number(group.contribution_minor),
    maxMembers: Number(group.max_members),
    memberCount,
    organizerFeeBps: Number(group.organizer_fee_bps),
    bidWindowMinutes: Number(group.bid_window_minutes),
    contributionWindowHours: Number(group.contribution_window_hours),
    cycleDays: Number(group.cycle_days),
    cadence: groupCadence(group),
    visibility: group.visibility === 'open' ? 'open' : 'private',
    status: group.status,
    isOrganizer: Boolean(isOrganizer),
    createdAt: group.created_at,
    startedAt: group.started_at,
    completedAt: group.completed_at,
    circleNumber: circle ? Number(circle.number) : null,
    turnsTotal: circle ? Number(circle.turns_total) : memberCount,
    seatLadderBps: seatLadderBps(circle ? Number(circle.turns_total) : memberCount, Number(group.contribution_minor) * (circle ? Number(circle.turns_total) : memberCount)),
  };
}

export async function bundleLedger(db, groupId) {
  const entries = await groupLedger(db, groupId, 220);
  const cycles = rows(await db.from('cycles').select('id,number,circle_id').eq('group_id', groupId).limit(240));
  const circles = rows(await db.from('circles').select('id,number').eq('group_id', groupId).limit(40));
  const roundNumbers = new Map(circles.map((circle) => [circle.id, Number(circle.number)]));
  const cycleNumbers = new Map(cycles.map((cycle) => [cycle.id, Number(cycle.number)]));
  const cycleRounds = new Map(cycles.map((cycle) => [cycle.id, roundNumbers.get(cycle.circle_id) || null]));
  const members = await membersOf(db, groupId);
  const names = new Map(members.map((member) => [member.id, member.display_name]));
  const mapped = entries.map((entry) => ({
    id: entry.id,
    ref: entry.ref,
    kind: entry.kind,
    amountMinor: Number(entry.amount_minor),
    walletEffect: Number(entry.wallet_effect),
    availableAt: entry.available_at,
    memo: entry.memo,
    createdAt: entry.created_at,
    cycleNumber: entry.cycle_id ? cycleNumbers.get(entry.cycle_id) || null : null,
    roundNumber: entry.cycle_id ? cycleRounds.get(entry.cycle_id) || null : null,
    actorName: entry.membership_id ? names.get(entry.membership_id) || null : null,
  }));
  const fund = await groupFundEntries(db, groupId, 60);
  return {
    entries: mapped,
    fund: {
      balanceMinor: sum(fund.map((entry) => entry.amount_minor)),
      entries: fund.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        amountMinor: Number(entry.amount_minor),
        memo: entry.memo,
        createdAt: entry.created_at,
      })),
    },
  };
}

export async function circleRecap(db, {
  group, circle, members, membership = null, fundBalanceMinor = 0,
}) {
  if (!group || !circle) return null;
  const cycles = rows(await db.from('cycles')
    .select('id,number,status,is_final,pot_expected_minor,pot_captured_minor,settled_at,winner_membership_id')
    .eq('circle_id', circle.id).order('number', { ascending: true }).limit(24));
  if (!cycles.length) return null;
  const settlements = rows(await db.from('settlements').select('*').eq('group_id', group.id).limit(240));
  const settlementByCycle = new Map(settlements.map((row) => [row.cycle_id, row]));
  const ledgerRows = rows(await db.from('ledger')
    .select('kind,ref,membership_id,amount_minor,cycle_id')
    .eq('group_id', group.id).limit(1200));
  const memberRows = new Map(members.map((member) => [member.id, {
    id: member.id,
    name: member.name,
    seat: member.seat,
    role: member.role,
    hasWon: Boolean(member.hasWon),
    paidMinor: 0,
    lateFeesMinor: 0,
    discountsMinor: 0,
    receivedMinor: 0,
    receivedTurn: null,
    bondReturnedMinor: 0,
    fundSplitMinor: 0,
    netMinor: 0,
  }]));
  const wonTurn = new Map();
  for (const cycle of cycles) {
    const settlement = settlementByCycle.get(cycle.id);
    if (settlement) wonTurn.set(settlement.winner_membership_id, Number(cycle.number));
  }
  const turns = [];
  const totals = {
    contributionsMinor: 0,
    lateFeesMinor: 0,
    potMinor: 0,
    winnerNetMinor: 0,
    discountMinor: 0,
    platformFeeMinor: 0,
    organizerFeeMinor: 0,
    organizerWaivedMinor: 0,
    fundFeeMinor: 0,
    feesMinor: 0,
    bondHeldMinor: 0,
    bondReturnedMinor: 0,
    fundSplitMinor: 0,
    coveredCount: 0,
  };
  let balanced = true;
  for (const cycle of cycles) {
    const settlement = settlementByCycle.get(cycle.id);
    if (!settlement) continue;
    const number = Number(cycle.number);
    const isFinal = Boolean(settlement.is_final);
    const winnerId = settlement.winner_membership_id;
    const winner = memberRows.get(winnerId);
    const contributions = await contributionsFor(db, cycle.id);
    const paid = contributions.filter((item) => item.status === 'paid');
    const lateFees = sum(paid.map((item) => Number(item.late_fee_minor) || 0));
    const covered = paid.filter((item) => item.cover_source).length;
    let paidMinor = 0;
    for (const item of paid) {
      paidMinor += Number(item.amount_minor) || 0;
      const target = memberRows.get(item.membership_id);
      if (!target) continue;
      target.paidMinor += Number(item.amount_minor) || 0;
      target.lateFeesMinor += Number(item.late_fee_minor) || 0;
    }
    const share = Number(settlement.waiter_share_minor) || 0;
    const shares = [];
    if (!isFinal && share > 0) {
      for (const member of members) {
        if (member.id === winnerId) continue;
        const won = wonTurn.get(member.id);
        if (won != null && won < number) continue;
        const target = memberRows.get(member.id);
        if (!target) continue;
        target.discountsMinor += share;
        shares.push({ membershipId: member.id, name: target.name, seat: target.seat, shareMinor: share });
      }
    }
    const payments = paid.map((item) => {
      const target = memberRows.get(item.membership_id);
      return {
        membershipId: item.membership_id,
        name: target?.name || 'Member',
        seat: target?.seat ?? null,
        amountMinor: Number(item.amount_minor) || 0,
        lateFeeMinor: Number(item.late_fee_minor) || 0,
        covered: item.cover_source || null,
      };
    });
    if (winner) {
      winner.receivedMinor += Number(settlement.winner_net_minor);
      winner.receivedTurn = number;
    }
    const pot = Number(settlement.pot_minor);
    const allocated = Number(settlement.discount_minor)
      + Number(settlement.platform_fee_minor)
      + Number(settlement.organizer_fee_minor)
      + Number(settlement.organizer_waived_minor)
      + Number(settlement.fund_fee_minor)
      + Number(settlement.bond_hold_minor)
      + Number(settlement.winner_net_minor);
    if (allocated !== pot) balanced = false;
    turns.push({
      number,
      settledAt: settlement.created_at,
      isFinal,
      winnerMembershipId: winnerId,
      winnerName: winner?.name || 'Member',
      winnerSeat: winner?.seat ?? null,
      discountBps: Number(settlement.discount_bps),
      discountMinor: Number(settlement.discount_minor),
      potMinor: pot,
      winnerNetMinor: Number(settlement.winner_net_minor),
      waiterCount: isFinal ? 0 : Number(settlement.waiter_count),
      waiterShareMinor: share,
      platformFeeMinor: Number(settlement.platform_fee_minor),
      organizerFeeMinor: Number(settlement.organizer_fee_minor),
      organizerWaivedMinor: Number(settlement.organizer_waived_minor),
      fundFeeMinor: Number(settlement.fund_fee_minor),
      bondHeldMinor: Number(settlement.bond_hold_minor),
      lateFeesMinor: lateFees,
      paidCount: paid.length,
      coveredCount: covered,
      payments,
      shares,
      reason: isFinal ? 'final' : Number(settlement.discount_bps) > 0 ? 'auction' : 'random',
    });
    totals.contributionsMinor += paidMinor;
    totals.lateFeesMinor += lateFees;
    totals.potMinor += pot;
    totals.winnerNetMinor += Number(settlement.winner_net_minor);
    totals.discountMinor += Number(settlement.discount_minor);
    totals.platformFeeMinor += Number(settlement.platform_fee_minor);
    totals.organizerFeeMinor += Number(settlement.organizer_fee_minor);
    totals.organizerWaivedMinor += Number(settlement.organizer_waived_minor);
    totals.fundFeeMinor += Number(settlement.fund_fee_minor);
    totals.bondHeldMinor += Number(settlement.bond_hold_minor);
    totals.coveredCount += covered;
  }
  totals.feesMinor = totals.platformFeeMinor + totals.organizerFeeMinor
    + totals.organizerWaivedMinor + totals.fundFeeMinor;
  const cycleIds = new Set(cycles.map((cycle) => cycle.id));
  const splitPrefix = `fund_split:${circle.id}:`;
  for (const entry of ledgerRows) {
    const target = entry.membership_id ? memberRows.get(entry.membership_id) : null;
    if (!target) continue;
    if (entry.kind === 'bond_release' && cycleIds.has(entry.cycle_id)) {
      target.bondReturnedMinor += Number(entry.amount_minor) || 0;
      totals.bondReturnedMinor += Number(entry.amount_minor) || 0;
    }
    if (entry.kind === 'fund_split' && String(entry.ref || '').startsWith(splitPrefix)) {
      target.fundSplitMinor += Number(entry.amount_minor) || 0;
      totals.fundSplitMinor += Number(entry.amount_minor) || 0;
    }
  }
  const recapMembers = members.map((member) => memberRows.get(member.id)).filter(Boolean).map((row) => ({
    ...row,
    netMinor: row.receivedMinor + row.discountsMinor + row.bondReturnedMinor + row.fundSplitMinor
      - row.paidMinor - row.lateFeesMinor,
  }));
  const me = membership ? recapMembers.find((row) => row.id === membership.id) || null : null;
  return {
    circleId: circle.id,
    circleNumber: Number(circle.number),
    completedAt: circle.completed_at || null,
    turnsTotal: turns.length,
    turns,
    totals,
    members: recapMembers,
    balanced,
    fundBalanceMinor,
    me,
  };
}

export async function turnHistory(db, { group, circle, members }) {
  if (!circle) return [];
  const cycles = rows(await db.from('cycles')
    .select('id,number,status,is_final,pot_expected_minor,pot_captured_minor,winner_membership_id,settled_at')
    .eq('circle_id', circle.id).order('number', { ascending: true }).limit(24));
  if (!cycles.length) return [];
  const settlements = rows(await db.from('settlements')
    .select('cycle_id,winner_membership_id,winner_net_minor,discount_bps,pot_minor,waiter_share_minor,waiter_count')
    .eq('group_id', group.id).limit(240));
  const byCycle = new Map(settlements.map((row) => [row.cycle_id, row]));
  const byMember = new Map(members.map((member) => [member.id, member]));
  return cycles.map((cycle) => {
    const settled = byCycle.get(cycle.id) || null;
    const winner = settled ? byMember.get(settled.winner_membership_id) : null;
    return {
      number: Number(cycle.number),
      status: cycle.status,
      isFinal: Boolean(cycle.is_final),
      potExpectedMinor: Number(cycle.pot_expected_minor),
      potMinor: settled ? Number(settled.pot_minor) : Number(cycle.pot_captured_minor) || 0,
      winnerName: winner?.name || null,
      winnerSeat: winner?.seat ?? null,
      winnerNetMinor: settled ? Number(settled.winner_net_minor) : null,
      discountBps: settled ? Number(settled.discount_bps) : null,
      waiterShareMinor: settled ? Number(settled.waiter_share_minor) : 0,
      waiterCount: settled ? Number(settled.waiter_count) : 0,
      settledAt: cycle.settled_at || null,
    };
  });
}

export async function groupRecapPayload(db, { groupId, userId }) {
  const group = await groupById(db, groupId);
  if (!group) throw new AppError('group_not_found', 404, 'That circle does not exist.');
  const me = await membershipFor(db, groupId, userId);
  if (!me) throw new AppError('not_a_member', 403, 'You are not a member of this circle.');
  const circle = await currentCircle(db, groupId);
  if (!circle) {
    return {
      now: nowIso(),
      recap: null,
      group: { id: group.id, name: group.name, status: group.status, contributionMinor: Number(group.contribution_minor) },
      circle: null,
    };
  }
  const members = await membersOf(db, groupId);
  const recap = await circleRecap(db, {
    group,
    circle,
    members: members.map((member) => ({
      id: member.id,
      name: member.display_name,
      seat: Number(member.seat_no),
      role: member.role,
      hasWon: Boolean(member.has_won),
    })),
    membership: me,
    fundBalanceMinor: await fundBalance(db, groupId),
  });
  return {
    now: nowIso(),
    recap,
    circle: {
      id: circle.id,
      number: Number(circle.number),
      status: circle.status,
      memberCount: Number(circle.member_count),
      turnsTotal: Number(circle.turns_total),
      completedAt: circle.completed_at || null,
    },
    group: {
      id: group.id,
      name: group.name,
      status: group.status,
      contributionMinor: Number(group.contribution_minor),
    },
  };
}

export async function bondHeldFor(db, groupId, memberships) {
  if (!memberships.length) return 0;
  const ids = new Set(memberships.map((member) => member.id));
  const bonds = rows(await db.from('bonds')
    .select('id,membership_id,held_minor,status').eq('group_id', groupId).limit(64));
  return sum(bonds.filter((bond) => bond.status === 'held' && ids.has(bond.membership_id)).map((bond) => bond.held_minor));
}

export async function walletPayload(db, userId, groupId = null, memberships = []) {
  const wallet = await walletFor(db, userId);
  const bondHeldMinor = groupId ? await bondHeldFor(db, groupId, memberships) : 0;
  return { ...wallet, bondHeldMinor };
}

export async function protectionPayload(db, { group, members, cycle }) {
  const active = members.filter((member) => member.status === 'active');
  const potMinor = cycle ? Number(cycle.pot_captured_minor) || Number(cycle.pot_expected_minor)
    : Number(group.contribution_minor) * active.length;
  const bonds = rows(await db.from('bonds').select('id,held_minor,status').eq('group_id', group.id).limit(64));
  const heldBonds = sum(bonds.filter((bond) => bond.status === 'held').map((bond) => bond.held_minor));
  const fund = await fundBalance(db, group.id);
  const cover = heldBonds + fund;
  // One missed turn plus its late-fee cushion, in exact integer minor units.
  const shortfall = Math.ceil(Number(group.contribution_minor) * 11 / 10);
  return {
    contributionMinor: Number(group.contribution_minor),
    potMinor,
    bondPoolMinor: heldBonds,
    fundBalanceMinor: fund,
    coverMinor: cover,
    shortfallMinor: shortfall,
    coveragePct: shortfall > 0 ? Math.min(100, Math.round(cover / shortfall * 100)) : 0,
    verifiedMembers: active.filter((member) => member.kyc_status === 'verified' || member.seat_status === 'paid').length,
    memberCount: active.length,
    bondBandLowBps: 1000,
    bondBandHighBps: 2500,
    lateFeeBps: RULES.lateFeeBps,
    lateCapBps: RULES.lateCapBps,
    graceHours: RULES.graceHours,
  };
}

export async function groupDetail(db, { groupId, userId, paymentsConfigured = false }) {
  const group = await groupById(db, groupId);
  if (!group) throw new AppError('group_not_found', 404, 'That circle does not exist.');
  const me = await membershipFor(db, groupId, userId);
  if (!me) throw new AppError('not_a_member', 403, 'You are not a member of this circle.');
  const members = await membersOf(db, groupId);
  if (!members.length) throw new AppError('group_not_found', 404);
  const guarantees = await guaranteesOf(db, groupId);
  const index = memberIndex(members, guarantees);
  const circle = await currentCircle(db, groupId);
  let cycle = circle ? one(await db.from('cycles').select('*').eq('circle_id', circle.id).order('number', { ascending: false }).limit(1)) : null;
  const now = Date.now();
  const contributions = cycle ? await contributionsFor(db, cycle.id) : [];
  const phones = await loadMembersWithPhones(db, members);
  const serializedMembers = members.map((member) => serializeMember(member, index, contributions, phones.get(member.user_id)));
  const settlement = cycle ? await settlementFor(db, cycle.id) : null;
  const winner = settlement
    ? serializedMembers.find((member) => member.id === settlement.winner_membership_id) || null
    : null;
  const wallet = await walletPayload(db, userId, groupId, members.filter((member) => member.user_id === userId));
  const ledger = await bundleLedger(db, groupId);
  const myMember = serializedMembers.find((member) => member.id === me.id) || null;
  const cyclePayload = cycle ? await serializeCycle(db, {
    cycle, members, myMembership: me, organizerFeeBps: group.organizer_fee_bps, now,
  }) : null;
  if (cyclePayload) {
    cyclePayload.savedMinor = wallet.availableMinor;
    cyclePayload.savedCoversMinor = Boolean(cyclePayload.myContribution
      && cyclePayload.myContribution.status !== 'paid'
      && wallet.availableMinor >= cyclePayload.amountDueMinor);
    cyclePayload.savedShortMinor = Math.max(0, cyclePayload.amountDueMinor - wallet.availableMinor);
  }
  const groupPayload = serializeGroup(group, members.length, me.role === 'organizer', circle);
  const recap = group.status === 'completed' && circle?.status === 'completed'
    ? await circleRecap(db, {
      group, circle, members: serializedMembers, membership: me, fundBalanceMinor: ledger.fund.balanceMinor,
    })
    : null;
  const turns = circle ? await turnHistory(db, { group, circle, members: serializedMembers }) : [];
  const activeMembers = members.filter((member) => member.status === 'active');
  const roundNumber = Number(circle?.number || 1);
  const forming = group.status === 'forming' && (!circle || circle.status === 'forming');
  const account = one(await db.from('users').select('id,identity_status,identity_last4').eq('id', userId).limit(1));
  return {
    now: nowIso(now),
    group: groupPayload,
    protection: await protectionPayload(db, { group, members, cycle }),
    circle: circle ? {
      id: circle.id,
      number: Number(circle.number),
      memberCount: Number(circle.member_count),
      turnsTotal: Number(circle.turns_total),
      status: circle.status,
      startedAt: circle.started_at,
      completedAt: circle.completed_at,
    } : null,
    round: {
      number: roundNumber,
      forming,
      acceptedCount: activeMembers.filter((member) => Number(member.accepted_round || 0) === roundNumber).length,
      memberCount: activeMembers.length,
      iAccepted: Number(me.accepted_round || 0) === roundNumber,
      seatsUnpaid: activeMembers.filter((member) => member.role !== 'organizer' && group.visibility === 'open' && (member.seat_status || 'none') !== 'paid').length,
      visibility: group.visibility === 'open' ? 'open' : 'private',
      canPropose: group.status === 'completed' && circle?.status === 'completed' && me.role === 'organizer',
      previousCircleId: group.status === 'completed' && circle ? circle.id : null,
    },
    cycle: cyclePayload,
    settlement: serializeSettlement(settlement, winner, me),
    recap,
    turns,
    members: serializedMembers,
    swaps: await swapSummary(db, { group, membership: me, members, now }),
    me: myMember ? {
      id: me.user_id,
      membershipId: me.id,
      name: me.display_name,
      seat: Number(me.seat_no),
      trustScore: Number(me.trust_score),
      bondBps: Number(me.bond_bps),
      ontimeCycles: Number(me.ontime_cycles),
      lateCycles: Number(me.late_cycles),
      defaults: Number(me.defaults),
      hasWon: Boolean(me.has_won),
      kycStatus: me.kyc_status,
      seatStatus: me.seat_status || 'none',
      seatPaidMinor: Number(me.seat_paid_minor || 0),
      seatDueMinor: Number(me.seat_due_minor || 0),
      seatExpiresAt: me.seat_expires_at || null,
      identityStatus: ['verified', 'pending', 'rejected'].includes(account?.identity_status) ? account.identity_status : 'unverified',
      identityLast4: account?.identity_last4 || null,
      guarantor: myMember.guarantor,
      role: me.role,
    } : null,
    wallet,
    fund: { balanceMinor: ledger.fund.balanceMinor, entries: ledger.fund.entries.slice(0, 8) },
    ledger: ledger.entries.slice(0, 8),
    rules: rulesPayload(),
    paymentsConfigured: Boolean(paymentsConfigured),
  };
}

export async function groupList(db, userId) {
  const memberships = rows(await db.from('memberships').select('*').eq('user_id', userId).limit(24));
  if (!memberships.length) return [];
  const result = [];
  for (const membership of memberships) {
    const group = await groupById(db, membership.group_id);
    if (!group) continue;
    const members = await membersOf(db, membership.group_id);
    const circle = await currentCircle(db, membership.group_id);
    result.push(serializeGroup(group, members.length, membership.role === 'organizer', circle));
  }
  return result.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function ledgerFor(db, groupId, userId) {
  const group = await groupById(db, groupId);
  if (!group) throw new AppError('group_not_found', 404, 'That circle does not exist.');
  const me = await membershipFor(db, groupId, userId);
  if (!me) throw new AppError('not_a_member', 403, 'You are not a member of this circle.');
  const bundle = await bundleLedger(db, groupId);
  const members = rows(await db.from('memberships').select('id,user_id').eq('group_id', groupId).limit(24));
  const myMemberships = members.filter((member) => member.user_id === userId);
  const wallet = await walletPayload(db, userId, groupId, myMemberships);
  return {
    entries: bundle.entries,
    fund: bundle.fund,
    wallet,
    rules: rulesPayload(),
    now: nowIso(),
  };
}

export async function accountPayload(db, userId, currentSessionId = null) {
  const user = one(await db.from('users').select('*').eq('id', userId).limit(1));
  if (!user) throw new AppError('invalid_credentials', 401, 'Sign in again.');
  const passkeys = rows(await db.from('passkeys')
    .select('id,label,rp_id,created_at,last_used_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(24));
  const sessions = rows(await db.from('sessions')
    .select('id,device_label,user_agent,created_at,last_seen_at,expires_at,revoked_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(32));
  const recovery = rows(await db.from('recovery_codes')
    .select('id,status').eq('user_id', userId).limit(40));
  const wallet = await walletFor(db, userId);
  return {
    user: userPayload(user),
    wallet,
    passkeys: passkeys.map((key) => ({
      id: key.id,
      label: key.label,
      rpId: key.rp_id,
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at,
    })),
    sessions: sessions
      .filter((session) => !session.revoked_at && Date.parse(session.expires_at) > Date.now())
      .map((session) => ({
        id: session.id,
        deviceLabel: session.device_label,
        userAgent: session.user_agent,
        createdAt: session.created_at,
        lastSeenAt: session.last_seen_at,
        current: currentSessionId ? session.id === currentSessionId : false,
      })),
    recoveryRemaining: recovery.filter((code) => code.status === 'active').length,
  };
}
