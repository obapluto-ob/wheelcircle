import {
  RULES, HOUR, firstPayoutHoldMs, settlementMath, seatDiscountBps,
} from './rules.mjs';

const NAMES = ['Amina', 'Brian', 'Chao', 'David', 'Esther', 'Farah'];
const LABEL = Object.freeze({
  contribution: 'Contribution (virtual)',
  pot: 'Funded pot (summary)',
  discount: 'Patience share credit',
  platform: 'Platform fee',
  organizer: 'Organizer fee credit',
  fund: 'Guarantee fund fee',
  waived: 'Organizer fee waived to fund',
  rounding: 'Discount rounding to fund',
  bond: 'Bond held',
  release: 'Bond released',
  pending: 'Winner net (pending)',
  claimed: 'Winner net claimed',
});

function memberAt(index) {
  return {
    id: `p${index + 1}`, name: NAMES[index], role: index === 0 ? 'organizer' : 'member',
    trustScore: 50, hasWon: false, wonTurn: null, paid: false, verified: false,
    balanceMinor: 0, bondMinor: 0, acceptedRound: 0,
  };
}

export function createPractice(now = Date.now()) {
  return {
    version: 3,
    clockStart: new Date(now).toISOString(),
    round: 1,
    group: {
      name: 'Practice circle', contributionMinor: 50000, maxMembers: 6,
      organizerFeeBps: 100, cadence: 'weekly', status: 'forming',
    },
    members: [memberAt(0)], activeMemberId: 'p1', cycle: null,
    receipts: [], ledger: [], virtualHours: 0,
  };
}

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function activeMember(state) {
  const member = state.members.find((entry) => entry.id === state.activeMemberId);
  requireThat(member, 'Choose a practice member first.');
  return member;
}

function requireOrganizer(member) {
  requireThat(member.role === 'organizer', 'Only the practice organizer can do that.');
}

function potMinor(state) {
  // Joining is forbidden after starting, so this roster is the locked turn count.
  return state.members.length * state.group.contributionMinor;
}

function openCycle(state, number, isFinal = false) {
  return { number, status: 'contributing', isFinal };
}

function record(state, memberId, label, amountMinor, turn = state.cycle.number) {
  state.ledger.push({ id: `l${state.ledger.length + 1}`, round: state.round, turn, memberId, label, amountMinor });
}

function payMember(state, member) {
  member.paid = true;
  // Practice contributions come from imaginary funds, not earned balances.
  // The ledger is an explanatory record, not a sum of wallet effects.
  record(state, member.id, LABEL.contribution, -state.group.contributionMinor);
  if (member.bondMinor > 0 && member.wonTurn < state.cycle.number) {
    const receipt = state.receipts.find((entry) => entry.round === state.round && entry.winnerId === member.id);
    const remainingTurns = state.members.length - member.wonTurn;
    // Match releaseBondOnPayment: fixed original-target instalments, then remainder.
    const amount = state.cycle.number === state.members.length
      ? member.bondMinor
      : Math.min(member.bondMinor, Math.floor(receipt.math.bondTargetMinor / remainingTurns));
    member.bondMinor -= amount;
    member.balanceMinor += amount;
    if (amount > 0) record(state, member.id, LABEL.release, amount);
  }
  if (state.members.every((entry) => entry.paid)) {
    state.cycle.status = 'funded';
    record(state, null, LABEL.pot, potMinor(state));
    return settle(state);
  }
  return null;
}

function settle(state) {
  const cycle = state.cycle;
  requireThat(cycle?.status === 'funded', 'Only a fully funded turn can settle.');
  requireThat(state.members.every((member) => member.paid), 'The pot is not whole yet.');
  const eligible = state.members.filter((member) => !member.hasWon && member.paid);
  requireThat(eligible.length > 0, 'Every member has already won.');
  requireThat(!cycle.isFinal || eligible.length === 1, 'The final turn must have exactly one member waiting.');
  const isFinal = eligible.length === 1;
  const seat = cycle.number;
  const winner = isFinal
    ? eligible[0]
    : eligible.find((member) => state.members.indexOf(member) + 1 === seat) || eligible[0];
  const reason = isFinal ? 'final' : 'seat';
  const math = settlementMath({
    potMinor: potMinor(state), discountBps: isFinal ? 0 : seatDiscountBps(state.members.length, seat, potMinor(state)),
    organizerWins: winner.role === 'organizer', organizerFeeBps: state.group.organizerFeeBps,
    winnerTrust: winner.trustScore, waiterCount: eligible.length - 1, isFinal,
  });
  const receipt = {
    round: state.round, turn: cycle.number, winnerId: winner.id, winnerName: winner.name, reason, math,
    // As in settleCycle, the hold applies to the circle's first payout, not each seat.
    releaseAtHour: state.virtualHours + firstPayoutHoldMs(state.receipts.length === 0) / HOUR,
    claimed: false,
  };
  for (const waiter of eligible) {
    if (waiter.id !== winner.id && math.waiterShareMinor > 0) {
      waiter.balanceMinor += math.waiterShareMinor;
      record(state, waiter.id, LABEL.discount, math.waiterShareMinor);
    }
  }
  const organizer = state.members.find((member) => member.role === 'organizer');
  organizer.balanceMinor += math.organizerFeeMinor;
  for (const [label, amount, memberId] of [
    [LABEL.platform, math.platformFeeMinor, null],
    [LABEL.organizer, math.organizerFeeMinor, organizer.id],
    [LABEL.fund, math.fundFeeMinor, null],
    [LABEL.waived, math.organizerWaivedMinor, null],
    [LABEL.rounding, math.remainderMinor, null],
    [LABEL.bond, math.bondHoldMinor, winner.id],
    [LABEL.pending, math.winnerNetMinor, winner.id],
  ]) {
    if (amount > 0) record(state, memberId, label, amount);
  }
  winner.hasWon = true;
  winner.wonTurn = cycle.number;
  winner.bondMinor = math.bondHoldMinor;
  state.receipts.push(receipt);
  cycle.isFinal = isFinal;
  cycle.status = 'settled';
  if (isFinal) state.group.status = 'completed';
  return `${winner.name} took practice turn ${cycle.number} at ${(Number(math.discountBps) / 100).toFixed(2)}%. The contribution that made the pot whole paid the seat instantly. The receipt shows virtual money only; claim the net after verification and any hold.`;
}

export function actPractice(state, action, payload = {}) {
  requireThat(payload !== null && typeof payload === 'object', 'Provide an action payload object.');
  const member = activeMember(state);
  switch (action) {
    case 'join': {
      requireThat(state.group.status === 'forming' && state.round === 1, 'The practice roster is locked after starting.');
      requireThat(state.members.length < state.group.maxMembers, 'All six practice seats are filled.');
      const added = memberAt(state.members.length);
      state.members.push(added);
      return `${added.name} joined the practice circle.`;
    }
    case 'switch': {
      const selected = state.members.find((entry) => entry.id === payload.memberId);
      requireThat(selected, 'That practice member does not exist.');
      state.activeMemberId = selected.id;
      return `You are viewing practice as ${selected.name}.`;
    }
    case 'cadence':
      requireOrganizer(member);
      requireThat(state.group.status === 'forming' && state.round === 1, 'The agreed period is locked after the first round starts.');
      requireThat(['weekly', 'fortnightly', 'monthly'].includes(payload.cadence), 'Choose a weekly, fortnightly or monthly period.');
      if (state.group.cadence !== payload.cadence) {
        state.group.cadence = payload.cadence;
        for (const entry of state.members) entry.acceptedRound = 0;
      }
      return 'Period selected. Each member must accept these terms before starting.';
    case 'accept':
      requireThat(state.group.status === 'forming', 'Terms can only be accepted before the round starts.');
      requireThat(member.acceptedRound !== state.round, 'You already accepted this round.');
      member.acceptedRound = state.round;
      return `${member.name} accepted round ${state.round}: ${state.group.cadence} turns and the fixed contribution.`;
    case 'accept-others': {
      requireThat(state.group.status === 'forming', 'This round has already started.');
      const others = state.members.filter((entry) => entry.id !== member.id && entry.acceptedRound !== state.round);
      requireThat(others.length > 0, 'Every other member already accepted.');
      for (const entry of others) entry.acceptedRound = state.round;
      return `Simulated ${others.length} other members accepting. In real circles each member must accept personally.`;
    }
    case 'renew':
      requireOrganizer(member);
      requireThat(state.group.status === 'completed', 'Complete every turn before proposing another round.');
      requireThat(state.members.every((entry) => entry.bondMinor === 0), 'Resolve held bonds before another round.');
      state.round += 1;
      state.group.status = 'forming';
      state.cycle = null;
      return `Round ${state.round} proposed with the same members and terms. All members must accept again; earlier receipts remain available.`;
    case 'start':
      requireOrganizer(member);
      requireThat(state.group.status === 'forming', 'This practice circle has already started.');
      requireThat(state.members.length >= RULES.minMembers, 'At least five members are needed to start.');
      requireThat(state.members.every((entry) => entry.acceptedRound === state.round), 'Every member must accept this round before it starts.');
      state.group.status = 'active';
      for (const entry of state.members) { entry.hasWon = false; entry.wonTurn = null; entry.paid = false; }
      state.cycle = openCycle(state, 1);
      return `Round ${state.round} started with ${state.members.length} locked seats and ${state.group.cadence} turns.`;
    case 'pay': {
      requireThat(state.cycle && !member.paid, 'You have already paid this turn, or no turn is open.');
      requireThat(state.cycle.status === 'contributing', 'This turn is not accepting contributions.');
      const settled = payMember(state, member);
      return settled || `${member.name}'s virtual contribution is recorded. No real money was charged.`;
    }
    case 'fund-others': {
      requireThat(state.cycle?.status === 'contributing', 'This turn is not accepting contributions.');
      const others = state.members.filter((entry) => entry.id !== member.id && !entry.paid);
      requireThat(others.length > 0, 'No other practice seats need funding.');
      let settled = null;
      for (const other of others) settled = payMember(state, other) || settled;
      return settled || `Simulated ${others.length} other practice contributions. Your own seat is not paid by this action.`;
    }
    case 'fund-one': {
      requireThat(state.cycle?.status === 'contributing', 'This turn is not accepting contributions.');
      const other = state.members.find((entry) => entry.id !== member.id && !entry.paid);
      requireThat(other, 'No other practice seats need funding.');
      const settled = payMember(state, other);
      return settled || `${other.name}'s virtual contribution is recorded. No real money was charged.`;
    }
    case 'settle':
      return settle(state);
    case 'next':
      requireOrganizer(member);
      requireThat(state.cycle?.status === 'settled', 'Settle the current turn first.');
      requireThat(state.group.status !== 'completed', 'The practice circle is already complete.');
      state.cycle = openCycle(state, state.cycle.number + 1, state.members.filter((entry) => !entry.hasWon).length === 1);
      for (const entry of state.members) entry.paid = false;
      return `Practice turn ${state.cycle.number} is ready for contributions.`;
    case 'verify': {
      requireOrganizer(member);
      const selected = state.members.find((entry) => entry.id === payload.memberId);
      requireThat(selected, 'That practice member does not exist.');
      requireThat(!selected.verified, 'This member is already practice-verified.');
      selected.verified = true;
      return `${selected.name} is practice-verified. No identity documents or real verification were used.`;
    }
    case 'hold':
      state.virtualHours += RULES.firstPayoutHoldHours;
      return 'Advanced the practice clock by 48 hours. No real time or money was involved.';
    case 'claim': {
      // An earlier winner may claim after later turns have opened or completed.
      const wins = state.receipts.filter((entry) => entry.winnerId === member.id);
      requireThat(wins.length > 0, 'This member has no winning practice payout to claim.');
      const receipt = wins.find((entry) => !entry.claimed);
      requireThat(receipt, 'This practice payout has already been claimed.');
      requireThat(member.verified, 'The organizer must simulate identity verification before you claim.');
      requireThat(state.virtualHours >= receipt.releaseAtHour, 'The first-payout 48-hour hold has not expired.');
      member.balanceMinor += receipt.math.winnerNetMinor;
      receipt.claimed = true;
      const row = state.ledger.find((entry) => entry.round === receipt.round && entry.turn === receipt.turn
        && entry.memberId === member.id && entry.label === LABEL.pending);
      if (row) row.label = LABEL.claimed;
      return `${member.name}'s net was credited once to the virtual balance. No external transfer was made.`;
    }
    default:
      throw new Error(`Unknown practice action: ${String(action)}`);
  }
}

function guide(key, title, body, action, label, page) {
  return { key, title, body, action, label, page };
}

export function practiceGuide(state) {
  const member = activeMember(state);
  if (state.group.status === 'forming') {
    if (state.members.length < RULES.minMembers) {
      return guide('join', 'Fill the practice circle', 'Add at least five members. A sixth seat is optional before the roster locks.', 'join', 'Add practice member', 'circle');
    }
    if (member.acceptedRound !== state.round) return guide('accept', 'Review and accept this round', `Round ${state.round}: ${state.group.cadence} turns, KES ${state.group.contributionMinor / 100} per member per turn. Everyone contributes until all members have received once; fees and bonds reduce the amount available.`, 'accept', 'Accept round terms', 'circle');
    if (state.members.some((entry) => entry.acceptedRound !== state.round)) return guide('accept-others', 'Every member has a choice', 'Switch seats to accept personally, or explicitly simulate the other members accepting. Real organizers cannot accept for anyone else.', 'accept-others', 'Simulate other acceptances', 'circle');
    if (member.role !== 'organizer') {
      return guide('organizer-start', 'Choose the organizer seat', 'Switch to Amina using the seat selector to start. You can still add the sixth member before starting.', null, 'Choose Amina', 'circle');
    }
    return guide('start', 'Start your practice circle', state.members.length === 6 ? 'All six seats are filled. Starting locks the roster and opens the first round of contributions.' : 'Five members are enough; add the optional sixth first if wanted. Starting locks the roster and turn count.', 'start', 'Start practice', 'circle');
  }
  const cycle = state.cycle;
  if (cycle.status === 'contributing') {
    return member.paid
      ? guide('fund-others', 'Make the pot whole', `The contribution that closes the pot pays seat ${cycle.number} on the spot. Simulate the unpaid other seats to see it happen.`, 'fund-others', 'Fund other seats', 'turn')
      : guide('pay', 'Contribute virtual money', `Every seat contributes every turn, including previous winners. Turn ${cycle.number} belongs to seat ${cycle.number} at ${seatDiscountBps(state.members.length, cycle.number, potMinor(state)) / 100}%; it pays the instant the pot is whole.`, 'pay', 'Pay virtual contribution', 'turn');
  }
  if (state.group.status === 'completed' && cycle.status === 'settled') {
    if (member.role === 'organizer' && state.members.every((entry) => entry.bondMinor === 0)) {
      return guide('renew', 'Keep the group going', `Round ${state.round} is complete and every member received once. Propose round ${state.round + 1} with the same members; everyone accepts again before contributions restart.`, 'renew', 'Propose another round', 'circle');
    }
    return guide('complete', 'Practice circle complete', 'Every member has won once. Review the virtual ledger; unclaimed nets still require simulated verification and any first-payout hold. Nothing is transferred externally.', null, 'View virtual ledger', 'ledger');
  }
  if (member.role !== 'organizer') {
    return guide('organizer-next', 'Return to the organizer seat', 'Review the receipt and simulated claim controls, then switch to Amina to open the next turn.', null, 'Choose Amina', 'circle');
  }
  return guide('next', 'Continue to the next turn', 'Review verification, the first-payout hold, and virtual claiming in the ledger. Unclaimed payouts remain available after advancing.', 'next', 'Open next turn', 'turn');
}

export function practiceRecap(state) {
  const receipts = state.receipts.filter((entry) => entry.round === state.round);
  if (!receipts.length) return null;
  const ledger = state.ledger.filter((row) => row.round === state.round);
  const members = state.members.map((member, index) => {
    const rows = ledger.filter((row) => row.memberId === member.id);
    const sumOf = (label) => rows
      .filter((row) => row.label === label)
      .reduce((total, row) => total + Number(row.amountMinor || 0), 0);
    const received = receipts.find((entry) => entry.winnerId === member.id) || null;
    const paidMinor = -sumOf(LABEL.contribution);
    const discountsMinor = Math.max(0, sumOf(LABEL.discount));
    const bondReturnedMinor = Math.max(0, sumOf(LABEL.release));
    const claimedMinor = Math.max(0, sumOf(LABEL.claimed));
    const receivedMinor = received ? Number(received.math.winnerNetMinor) : 0;
    return {
      id: member.id,
      name: member.name,
      role: member.role,
      seat: index + 1,
      hasWon: member.hasWon,
      wonTurn: member.wonTurn,
      paidMinor,
      discountsMinor,
      bondReturnedMinor,
      receivedMinor,
      receivedTurn: received ? received.turn : null,
      pendingMinor: Math.max(0, receivedMinor - claimedMinor),
      bondHeldMinor: Number(member.bondMinor) || 0,
      netMinor: receivedMinor + discountsMinor + bondReturnedMinor - paidMinor,
    };
  });
  const sumMath = (key) => receipts.reduce((total, entry) => total + Number(entry.math[key] || 0), 0);
  const totals = {
    potMinor: sumMath('potMinor'),
    winnerNetMinor: sumMath('winnerNetMinor'),
    discountMinor: sumMath('discountMinor'),
    platformFeeMinor: sumMath('platformFeeMinor'),
    organizerFeeMinor: sumMath('organizerFeeMinor'),
    organizerWaivedMinor: sumMath('organizerWaivedMinor'),
    fundFeeMinor: sumMath('fundFeeMinor'),
    bondHeldMinor: sumMath('bondHoldMinor'),
    pendingMinor: members.reduce((total, member) => total + member.pendingMinor, 0),
    bondReturnedMinor: members.reduce((total, member) => total + member.bondReturnedMinor, 0),
  };
  totals.feesMinor = totals.platformFeeMinor + totals.organizerFeeMinor
    + totals.organizerWaivedMinor + totals.fundFeeMinor;
  return {
    round: state.round,
    turnsTotal: receipts.length,
    turns: receipts.map((entry) => ({
      number: entry.turn,
      winnerId: entry.winnerId,
      winnerName: entry.winnerName,
      reason: entry.reason,
      discountBps: Number(entry.math.discountBps),
      potMinor: Number(entry.math.potMinor),
      winnerNetMinor: Number(entry.math.winnerNetMinor),
      discountMinor: Number(entry.math.discountMinor),
      waiterCount: Number(entry.math.waiterCount),
      waiterShareMinor: Number(entry.math.waiterShareMinor),
      platformFeeMinor: Number(entry.math.platformFeeMinor),
      organizerFeeMinor: Number(entry.math.organizerFeeMinor),
      organizerWaivedMinor: Number(entry.math.organizerWaivedMinor),
      fundFeeMinor: Number(entry.math.fundFeeMinor),
      bondHeldMinor: Number(entry.math.bondHoldMinor),
      claimed: Boolean(entry.claimed),
      releaseAtHour: entry.releaseAtHour,
    })),
    totals,
    members,
    balanced: receipts.every((entry) => Number(entry.math.totalAllocated) === Number(entry.math.potMinor)),
  };
}
