import test from 'node:test';
import assert from 'node:assert/strict';
import { createPractice, actPractice, practiceGuide, practiceRecap } from '../web/practice-model.mjs';
import { RULES, seatDiscountBps, seatLadderBps, seatNetPreview, settlementMath } from '../functions/lib/rules.mjs';

const root = new URL('../web/practice-model.mjs', import.meta.url);

test('browser and backend share identical pure rules', async () => {
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(new URL('../web/rules.mjs', import.meta.url), 'utf8'), await readFile(new URL('../functions/lib/rules.mjs', import.meta.url), 'utf8'));
});

function act(state, action, payload) {
  const message = actPractice(state, action, payload);
  assert.equal(typeof message, 'string');
  assert.ok(message.length > 0);
  return message;
}

function seat(state, memberId) {
  act(state, 'switch', { memberId });
}

function rejected(state, action, payload, pattern = /./) {
  const before = JSON.stringify(state);
  assert.throws(() => actPractice(state, action, payload), pattern);
  assert.equal(JSON.stringify(state), before, `Rejected ${action} must not mutate state`);
}

function acceptAll(state) {
  seat(state, 'p1');
  if (state.members[0].acceptedRound !== state.round) act(state, 'accept');
  if (state.members.some((member) => member.acceptedRound !== state.round)) act(state, 'accept-others');
}

function started(count = 6, now) {
  const state = createPractice(now);
  while (state.members.length < count) act(state, 'join');
  acceptAll(state);
  act(state, 'start');
  return state;
}

function fund(state) {
  seat(state, 'p1');
  if (!state.members[0].paid) act(state, 'pay');
  if (state.members.some((member) => !member.paid)) act(state, 'fund-others');
  assert.equal(state.cycle.status, 'settled', 'the pot pays its seat the moment it is whole');
  return state.receipts.at(-1);
}

function win(state, memberId) {
  const receipt = fund(state);
  assert.equal(receipt.winnerId, memberId);
  return receipt;
}

function next(state) {
  seat(state, 'p1');
  act(state, 'next');
}

function checkGuide(state, key) {
  const before = JSON.stringify(state);
  const result = practiceGuide(state);
  assert.deepEqual(Object.keys(result), ['key', 'title', 'body', 'action', 'label', 'page']);
  assert.equal(result.key, key);
  assert.ok(['circle', 'turn', 'ledger'].includes(result.page));
  assert.equal(JSON.stringify(state), before, 'Guide must not mutate practice state');
  return result;
}

test('practice starts with exactly the agreed serializable state and independent instances', () => {
  const state = createPractice(Date.parse('2026-11-17T09:00:00.000Z'));
  assert.deepEqual(state, {
    version: 3,
    clockStart: '2026-11-17T09:00:00.000Z',
    round: 1,
    group: { name: 'Practice circle', contributionMinor: 50000, maxMembers: 6, organizerFeeBps: 100, cadence: 'weekly', status: 'forming' },
    members: [{ id: 'p1', name: 'Amina', role: 'organizer', trustScore: 50, hasWon: false, wonTurn: null, paid: false, verified: false, balanceMinor: 0, bondMinor: 0, acceptedRound: 0 }],
    activeMemberId: 'p1', cycle: null, receipts: [], ledger: [], virtualHours: 0,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  act(state, 'join');
  assert.equal(createPractice().members.length, 1);
  assert.equal(createPractice().ledger.length, 0);
});

test('roster allows five or six seats, requires organizer start, and locks after start', () => {
  const state = createPractice();
  rejected(state, 'start', {}, /five/);
  rejected(state, 'switch', { memberId: 'real-user' }, /does not exist/);
  rejected(state, 'verify', { memberId: 'missing' }, /does not exist/);
  rejected(state, 'claim', {}, /no winning/);
  rejected(state, 'not-an-action', {}, /Unknown practice action/);
  rejected(state, 'join', null, /payload/);
  for (let i = 0; i < 5; i++) act(state, 'join');
  assert.deepEqual(state.members.map((member) => member.name), ['Amina', 'Brian', 'Chao', 'David', 'Esther', 'Farah']);
  rejected(state, 'join', {}, /six/);
  seat(state, 'p2');
  rejected(state, 'start', {}, /organizer/);
  rejected(state, 'verify', { memberId: 'p2' }, /organizer/);
  seat(state, 'p1');
  rejected(state, 'start', {}, /accept/);
  act(state, 'accept');
  rejected(state, 'accept', {}, /already accepted/);
  rejected(state, 'start', {}, /accept/);
  act(state, 'accept-others');
  act(state, 'start');
  assert.deepEqual(state.cycle, { number: 1, status: 'contributing', isFinal: false });
  assert.equal(state.group.status, 'active');
  rejected(state, 'join', {}, /locked/);
  rejected(state, 'start', {}, /already started/);
  rejected(state, 'next', {}, /Settle/);
  const five = started(5);
  assert.equal(five.members.length, 5);
  rejected(five, 'join', {}, /locked/);
});

test('the contribution that makes the pot whole pays the turn instantly', () => {
  const state = started();
  rejected(state, 'settle', {}, /fully funded/);
  assert.equal(state.cycle.status, 'contributing');
  seat(state, 'p2');
  act(state, 'fund-others');
  assert.equal(state.members[1].paid, false, 'Fund others must not pay the active seat');
  assert.equal(state.members.filter((member) => member.paid).length, 5);
  assert.equal(state.cycle.status, 'contributing', 'the last unpaid seat still owes its contribution');
  rejected(state, 'fund-others', {}, /No other/);
  act(state, 'hold');
  act(state, 'pay');

  const receipt = state.receipts.at(-1);
  assert.equal(state.cycle.status, 'settled');
  assert.equal(receipt.winnerId, 'p1', 'turn one belongs to seat one');
  assert.equal(receipt.reason, 'seat');
  assert.deepEqual(receipt.math, seatNetPreview(6, 1, 300000, { trust: 50, organizerWins: true, organizerFeeBps: 100 }));
  assert.equal(receipt.math.discountBps, 1000);
  assert.equal(receipt.math.waiterShareMinor, 6000);
  assert.equal(receipt.math.bondHoldMinor, 60000);
  assert.equal(state.members[0].balanceMinor, 0, 'the winner net stays pending, not credited');
  for (const member of state.members.slice(1)) assert.equal(member.balanceMinor, 6000);
  assert.equal(state.ledger.filter((entry) => entry.label === 'Contribution (virtual)').length, 6);
  assert.equal(state.ledger.filter((entry) => entry.label === 'Contribution (virtual)').reduce((sum, entry) => sum + entry.amountMinor, 0), -300000);
  assert.deepEqual(state.ledger.find((entry) => entry.label === 'Funded pot (summary)'), { id: 'l7', round: 1, turn: 1, memberId: null, label: 'Funded pot (summary)', amountMinor: 300000 });
  rejected(state, 'pay', {}, /already paid/);
  rejected(state, 'fund-others', {}, /not accepting/);
  rejected(state, 'settle', {}, /fully funded|unsettled/);
  seat(state, 'p2');
  rejected(state, 'next', {}, /organizer/);
  next(state);
  assert.equal(state.cycle.number, 2);
  assert.ok(state.members.every((member) => !member.paid));
});

test('turns follow seats: each posted price is paid in order with no bidding', () => {
  let state = started();
  const expected = seatLadderBps(6, 300000);
  assert.deepEqual(expected, [1000, 700, 400, 200, 167, 0]);
  for (let turn = 1; turn <= 6; turn++) {
    assert.equal(state.cycle.number, turn);
    assert.equal(state.cycle.isFinal, turn === 6);
    const receipt = win(state, `p${turn}`);
    assert.equal(receipt.math.discountBps, expected[turn - 1]);
    assert.equal(receipt.math.discountBps, seatDiscountBps(6, turn, 300000));
    assert.deepEqual(receipt.math, seatNetPreview(6, turn, 300000, {
      trust: 50, organizerWins: turn === 1, organizerFeeBps: 100,
    }));
    assert.equal(receipt.math.totalAllocated, 300000);
    assert.equal(state.members[turn - 1].wonTurn, turn);
    assert.equal(state.members[turn - 1].bondMinor, receipt.math.bondHoldMinor);
    if (turn === 6) {
      assert.equal(receipt.reason, 'final');
      assert.equal(receipt.math.discountMinor, 0);
      assert.equal(receipt.math.bondHoldMinor, 0);
      assert.equal(state.group.status, 'completed');
    } else {
      assert.equal(receipt.reason, 'seat');
      assert.ok(receipt.math.bondHoldMinor > 0);
      next(state);
    }
  }
  assert.equal(state.receipts.length, 6);
  assert.equal(new Set(state.receipts.map((receipt) => receipt.winnerId)).size, 6);
  assert.deepEqual(state.receipts.map((receipt) => receipt.winnerId), ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
});

test('previous winners keep paying and never share later discounts', () => {
  const state = started();
  win(state, 'p1');
  const balances = state.members.map((member) => member.balanceMinor);
  next(state);
  const receipt = win(state, 'p2');
  assert.equal(receipt.math.waiterCount, 4);
  assert.equal(receipt.math.waiterShareMinor, 5250);
  assert.equal(state.members[0].balanceMinor, balances[0] + 12000 + 3000, 'a previous winner receives no second share, only its bond instalment and organizer fee');
  for (const member of state.members.slice(2)) assert.equal(member.balanceMinor, balances[memberIndex(state, member)] + 5250);
  assert.ok(state.members.every((member) => member.paid), 'every seat keeps funding');
  const credits = state.ledger.filter((row) => row.turn === 2 && row.label === 'Patience share credit');
  assert.deepEqual(credits.map((row) => row.memberId), ['p3', 'p4', 'p5', 'p6']);
});

function memberIndex(state, member) {
  return state.members.indexOf(member);
}

test('KYC and the first-payout hold gate claims; later payouts have no new hold', () => {
  const state = started();
  win(state, 'p1');
  const first = state.receipts[0];
  assert.equal(first.releaseAtHour, state.virtualHours + 48);
  assert.equal(state.members[0].balanceMinor, 0, 'Winner net is pending, not credited at settlement');
  rejected(state, 'claim', {}, /verification/);
  seat(state, 'p3');
  rejected(state, 'claim', {}, /no winning/);
  seat(state, 'p1');
  act(state, 'verify', { memberId: 'p1' });
  rejected(state, 'verify', { memberId: 'p1' }, /already/);
  rejected(state, 'claim', {}, /48-hour hold/);
  next(state);
  win(state, 'p2');
  assert.equal(state.receipts[1].releaseAtHour, state.virtualHours, 'Later payouts have no new 48-hour hold');
  act(state, 'hold');
  seat(state, 'p1');
  act(state, 'verify', { memberId: 'p2' });
  seat(state, 'p2');
  const before = state.members[1].balanceMinor;
  const ledgerLength = state.ledger.length;
  act(state, 'claim');
  assert.equal(state.members[1].balanceMinor, before + state.receipts[1].math.winnerNetMinor);
  assert.equal(state.ledger.length, ledgerLength, 'Claim updates the pending net row instead of recording it twice');
  assert.equal(state.ledger.find((row) => row.turn === 2 && row.label === 'Winner net claimed').amountMinor, state.receipts[1].math.winnerNetMinor);
  rejected(state, 'claim', {}, /already been claimed/);
  seat(state, 'p1');
  act(state, 'claim');
  assert.equal(state.receipts[0].claimed, true);
});

test('six-turn lifecycle allocates every pot exactly and has distinct seat winners', () => {
  let state = started();
  for (let turn = 1; turn <= 6; turn++) {
    assert.equal(state.cycle.number, turn);
    assert.ok(state.members.every((member) => !member.paid));
    seat(state, 'p6');
    const balances = state.members.map((member) => member.balanceMinor);
    const bonds = state.members.map((member) => member.bondMinor);
    const heldOf = new Map(state.receipts.map((entry) => [entry.winnerId, entry.math.bondHoldMinor]));
    const previous = state.members.filter((member) => member.hasWon).map((member) => member.id);
    const receipt = win(state, `p${turn}`);
    // Resuming from plain JSON needs no closures, dates, maps, or external state.
    state = JSON.parse(JSON.stringify(state));
    assert.deepEqual(receipt.math, settlementMath({
      potMinor: 300000, discountBps: seatDiscountBps(6, turn, 300000),
      organizerWins: turn === 1, organizerFeeBps: 100, winnerTrust: 50,
      waiterCount: 6 - turn, isFinal: turn === 6,
    }));
    const allocations = state.ledger.filter((row) => row.turn === turn
      && !['Contribution (virtual)', 'Funded pot (summary)', 'Bond released'].includes(row.label));
    assert.equal(allocations.reduce((total, row) => total + row.amountMinor, 0), 300000);
    const waiterIds = state.members.filter((member) => !previous.includes(member.id) && member.id !== `p${turn}`).map((member) => member.id);
    for (const [index, member] of state.members.entries()) {
      const share = waiterIds.includes(member.id) ? receipt.math.waiterShareMinor : 0;
      const fee = member.role === 'organizer' ? receipt.math.organizerFeeMinor : 0;
      const release = previous.includes(member.id)
        ? (turn === 6 ? bonds[index] : Math.min(bonds[index], Math.floor(heldOf.get(member.id) / (6 - member.wonTurn))))
        : 0;
      assert.equal(member.balanceMinor, balances[index] + share + fee + release, `${member.name} turn ${turn} credits`);
    }
    const credits = state.ledger.filter((row) => row.turn === turn && row.label === 'Patience share credit');
    assert.deepEqual(credits.map((row) => row.memberId), waiterIds);
    if (turn === 1) {
      assert.equal(receipt.math.organizerFeeMinor, 0);
      assert.equal(receipt.math.organizerWaivedMinor, 3000);
      assert.equal(receipt.math.fundCreditMinor, 6000);
    }
    seat(state, 'p1');
    act(state, 'verify', { memberId: `p${turn}` });
    seat(state, `p${turn}`);
    if (turn === 1) {
      rejected(state, 'claim', {}, /hold/);
      act(state, 'hold');
    }
    act(state, 'claim');
    rejected(state, 'claim', {}, /already/);
    rejected(state, 'pay', {}, /already paid/);
    if (turn < 6) next(state);
  }
  assert.equal(state.group.status, 'completed');
  assert.equal(state.cycle.status, 'settled');
  assert.equal(state.receipts.length, 6);
  assert.ok(state.members.every((member) => member.hasWon && member.bondMinor === 0));
  assert.ok(state.receipts.every((receipt) => receipt.claimed));
  const balances = state.members.reduce((sum, member) => sum + member.balanceMinor, 0);
  const systemAllocations = state.receipts.reduce((sum, receipt) => sum + receipt.math.platformFeeMinor + receipt.math.fundCreditMinor, 0);
  assert.equal(balances + systemAllocations, 6 * 300000, 'No missing or double-credited virtual money');
  assert.equal(state.ledger.filter((row) => row.label === 'Contribution (virtual)').length, 36);
  assert.equal(new Set(state.ledger.map((row) => row.id)).size, state.ledger.length);
  for (const row of state.ledger) {
    assert.deepEqual(Object.keys(row), ['id', 'round', 'turn', 'memberId', 'label', 'amountMinor']);
    assert.ok(Number.isSafeInteger(row.amountMinor));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  checkGuide(state, 'complete');
  seat(state, 'p1');
  checkGuide(state, 'renew');
  rejected(state, 'next', {}, /complete/);
  rejected(state, 'join', {}, /locked/);
});

test('repeat rounds keep the roster and restart at seat one', () => {
  const state = started(5);
  rejected(state, 'renew', {}, /Complete every turn/);
  for (let turn = 1; turn <= 5; turn++) {
    if (turn > 1) next(state);
    win(state, `p${turn}`);
  }
  assert.equal(state.group.status, 'completed');
  seat(state, 'p2');
  rejected(state, 'renew', {}, /organizer/);
  seat(state, 'p1');
  act(state, 'renew');
  assert.equal(state.round, 2);
  assert.equal(state.group.status, 'forming');
  assert.equal(state.receipts.length, 5, 'Earlier receipts stay on record');
  rejected(state, 'join', {}, /locked/);
  rejected(state, 'cadence', { cadence: 'monthly' }, /locked/);
  rejected(state, 'start', {}, /accept/);
  acceptAll(state);
  act(state, 'start');
  assert.ok(state.members.every((member) => !member.hasWon && !member.paid), 'Everyone is eligible once in the new round');
  const receipt = win(state, 'p1');
  assert.equal(receipt.round, 2);
  assert.equal(receipt.turn, 1);
  assert.equal(receipt.math.discountBps, 1000);
  assert.ok(state.ledger.some((row) => row.round === 2));
  assert.equal(state.ledger.filter((row) => row.round === 1 && row.label === 'Contribution (virtual)').length, 25);
});

test('bond releases use original bond instalments with the final remainder, once per future payment', () => {
  const state = started();
  state.group.contributionMinor = 50001; // Exercise rounding using only this isolated fixture.
  win(state, 'p1');
  assert.equal(state.receipts[0].math.bondTargetMinor, 60001);
  assert.equal(state.members[0].bondMinor, 60001);
  const releases = [];
  for (let turn = 2; turn <= 6; turn++) {
    next(state);
    seat(state, 'p1');
    act(state, 'pay');
    rejected(state, 'pay', {}, /already paid/);
    const release = state.ledger.filter((row) => row.turn === turn && row.memberId === 'p1' && row.label === 'Bond released');
    assert.equal(release.length, 1);
    releases.push(release[0].amountMinor);
    act(state, 'fund-others');
    assert.equal(state.cycle.status, 'settled');
    assert.equal(state.receipts.at(-1).winnerId, `p${turn}`);
  }
  assert.deepEqual(releases, [12000, 12000, 12000, 12000, 12001]);
  assert.equal(state.members[0].bondMinor, 0);
  assert.equal(releases.reduce((sum, amount) => sum + amount, 0), 60001);
});

test('guide covers the lifecycle and the final contribution completes the circle', () => {
  const state = createPractice();
  checkGuide(state, 'join');
  while (state.members.length < 5) act(state, 'join');
  checkGuide(state, 'accept');
  act(state, 'accept');
  checkGuide(state, 'accept-others');
  act(state, 'accept-others');
  checkGuide(state, 'start');
  seat(state, 'p2');
  assert.equal(checkGuide(state, 'organizer-start').action, null);
  seat(state, 'p1');
  act(state, 'start');
  checkGuide(state, 'pay');
  assert.match(checkGuide(state, 'pay').body, /pays the instant the pot is whole/);
  act(state, 'pay');
  checkGuide(state, 'fund-others');
  act(state, 'fund-others');
  assert.equal(state.group.status, 'active');
  assert.equal(state.cycle.status, 'settled');
  checkGuide(state, 'next');
  seat(state, 'p2');
  checkGuide(state, 'organizer-next');
  seat(state, 'p1');
  for (let turn = 2; turn <= 4; turn++) {
    next(state);
    win(state, `p${turn}`);
  }
  assert.equal(state.members.filter((member) => !member.hasWon).length, 1);
  assert.notEqual(practiceGuide(state).key, 'complete');
  next(state);
  assert.equal(state.cycle.isFinal, true);
  checkGuide(state, 'pay');
  win(state, 'p5');
  assert.equal(state.group.status, 'completed', 'funding the final pot completes the circle in the same action');
  assert.equal(checkGuide(state, 'renew').page, 'circle');
  seat(state, 'p2');
  assert.equal(checkGuide(state, 'complete').page, 'ledger');
  seat(state, 'p1');
  // Completion does not falsely imply that held or unverified virtual nets were claimed.
  assert.ok(state.receipts.every((receipt) => !receipt.claimed));
  act(state, 'verify', { memberId: 'p5' });
  seat(state, 'p5');
  act(state, 'claim');
  assert.equal(state.receipts[4].claimed, true);
});

test('round recap replays every turn and reconciles each member to the shilling', () => {
  const state = started(5);
  for (let turn = 1; turn <= 5; turn++) {
    if (turn > 1) next(state);
    win(state, `p${turn}`);
  }
  assert.equal(state.group.status, 'completed');
  const before = JSON.stringify(state);
  const recap = practiceRecap(state);
  assert.equal(JSON.stringify(state), before, 'Recap must not mutate practice state');
  assert.ok(recap, 'A completed round exposes its recap');
  assert.equal(recap.round, 1);
  assert.equal(recap.turnsTotal, 5);
  assert.equal(recap.balanced, true);
  assert.deepEqual(recap.turns.map((turn) => [turn.number, turn.winnerName]), [
    [1, 'Amina'], [2, 'Brian'], [3, 'Chao'], [4, 'David'], [5, 'Esther'],
  ]);
  assert.deepEqual(recap.turns.map((turn) => turn.discountBps), seatLadderBps(5, 250000));
  assert.equal(recap.turns.at(-1).reason, 'final');
  assert.equal(recap.turns.at(-1).discountMinor, 0);
  assert.equal(recap.turns.at(-1).bondHeldMinor, 0);
  assert.ok(recap.turns.every((turn) => turn.reason === 'seat' || turn.number === 5));

  const receipts = state.receipts;
  const sum = (key) => receipts.reduce((total, receipt) => total + receipt.math[key], 0);
  assert.equal(recap.totals.potMinor, 1250000);
  assert.equal(recap.totals.discountMinor, sum('discountMinor'));
  assert.equal(recap.totals.winnerNetMinor, sum('winnerNetMinor'));
  assert.equal(recap.totals.platformFeeMinor, sum('platformFeeMinor'));
  assert.equal(recap.totals.organizerWaivedMinor, sum('organizerWaivedMinor'));
  assert.equal(recap.totals.fundFeeMinor, sum('fundFeeMinor'));
  assert.equal(recap.totals.bondHeldMinor, sum('bondHoldMinor'));
  assert.equal(recap.totals.bondReturnedMinor, recap.totals.bondHeldMinor, 'Every held bond comes back');
  assert.equal(recap.totals.feesMinor, sum('platformFeeMinor') + sum('organizerFeeMinor') + sum('organizerWaivedMinor') + sum('fundFeeMinor'));
  assert.equal(recap.totals.pendingMinor, recap.totals.winnerNetMinor, 'Nothing is claimed yet');

  for (const member of recap.members) {
    assert.equal(member.paidMinor, 250000, `${member.name} paid every turn`);
    assert.equal(member.receivedTurn, member.seat);
    assert.equal(member.receivedMinor, receipts[member.seat - 1].math.winnerNetMinor);
    assert.equal(member.netMinor, member.receivedMinor + member.discountsMinor + member.bondReturnedMinor - member.paidMinor);
  }
  assert.equal(recap.members.reduce((total, member) => total + member.discountsMinor, 0), recap.totals.discountMinor - sum('remainderMinor'), 'Discount rounding remainder stays in the guarantee fund');
  assert.equal(recap.members.reduce((total, member) => total + member.bondReturnedMinor, 0), recap.totals.bondReturnedMinor);

  seat(state, 'p1');
  act(state, 'verify', { memberId: 'p2' });
  seat(state, 'p2');
  act(state, 'claim');
  const claimed = practiceRecap(state);
  const p2 = claimed.members.find((member) => member.id === 'p2');
  assert.equal(p2.pendingMinor, 0, 'A claimed net leaves the pending column');
  assert.equal(claimed.totals.pendingMinor, recap.totals.pendingMinor - p2.receivedMinor);
  assert.equal(claimed.totals.winnerNetMinor, recap.totals.winnerNetMinor, 'Claiming never changes what was settled');

  seat(state, 'p1');
  act(state, 'renew');
  assert.equal(practiceRecap(state), null, 'A fresh round has nothing to recap until its first pot settles');
  assert.equal(state.receipts.length, 5, 'Earlier receipts stay on record');
});

test('practice model has no network, storage, DOM, backend, or authentication dependency', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(root, 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|document|window)\s*(?:\.|\[|\()/);
  const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
  assert.deepEqual(imports, ['./rules.mjs']);
  assert.equal(RULES.firstPayoutHoldHours, 48);
  assert.deepEqual(seatLadderBps(5, 250000), [1000, 600, 300, 200, 0]);
});
