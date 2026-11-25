import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, addUser, signIn, client, postWebhook, installPaysasaStub, assertStatus,
} from './helpers.mjs';
import { nowIso } from '../functions/lib/util.mjs';
import { markSeatPaid, sweepSeats, SEAT_STALL_MS } from '../functions/lib/open-circles.mjs';

const CONTRIBUTION = 20000;
process.env.WHEEL_ADMIN_PHONES = '+254700000101,+254700000401,+254700000501,+254700000601,+254700000701';

async function createOpenGroup(call, { maxMembers = 5, name = 'Open Circle' } = {}) {
  const created = await call('/groups', {
    method: 'POST',
    body: { name, contributionMinor: CONTRIBUTION, maxMembers, organizerFeeBps: 100, visibility: 'open' },
  });
  assertStatus(created, 201, 'create open group');
  assert.equal(created.data.group.visibility, 'open');
  return created.data.group;
}

async function verifyIdentity(call, idNumber, name = 'Test Member') {
  return call('/account/identity', {
    method: 'POST',
    body: { legalName: name, idNumber, dateOfBirth: '1995-04-02', verificationConsent: true },
  });
}

async function approveIdentity(adminCall, userId) {
  return adminCall(`/admin/identity/${userId}`, { method: 'POST', body: { action: 'approve' } });
}

async function checkoutSeat(call, gid) {
  return call(`/groups/${gid}/seat-checkout`, { method: 'POST', body: { acceptRules: true } });
}

async function paySeat(handle, { gid, userId, checkout, amount = CONTRIBUTION, sessionId }) {
  return postWebhook(handle, {
    event: 'checkout.paid',
    data: {
      session_id: sessionId || `cs_seat_${checkout.membershipId}`,
      reference: `ref_${checkout.membershipId.slice(0, 8)}`,
      amount,
      currency: 'KES',
      metadata: { seat_membership_id: checkout.membershipId, group_id: gid, user_id: userId },
    },
  });
}

test('open seats need a verified ID, one account per ID, and a paid seat before start', async () => {
  const { db, handle } = await boot();
  const stub = installPaysasaStub();
  try {
    const organizer = await addUser(db, { name: 'Organizer', phone: '+254700000101' });
    const organizerCall = client(handle, await signIn(db, organizer));
    const group = await createOpenGroup(organizerCall);
    const gid = group.id;

    const joiners = [];
    for (let index = 0; index < 4; index += 1) {
      const user = await addUser(db, { name: `Joiner ${index + 1}`, phone: `+25470000020${index}` });
      joiners.push({ user, call: client(handle, await signIn(db, user)) });
    }

    assertStatus(await joiners[0].call('/groups/join', {
      method: 'POST', body: { inviteCode: group.inviteCode },
    }), 409, 'open circles cannot be joined by invite code');

    assertStatus(await checkoutSeat(joiners[0].call, gid), 403, 'identity required before a seat');
    assertStatus(await joiners[0].call('/account/identity', {
      method: 'POST',
      body: { legalName: 'Too Young', idNumber: '1234567', dateOfBirth: '2015-01-01', verificationConsent: true },
    }), 400, 'age checked');
    assertStatus(await verifyIdentity(joiners[0].call, '12ab', 'Bad ID'), 400, 'id format checked');

    const submitted = await verifyIdentity(joiners[1].call, '30111223', 'First Holder');
    assertStatus(submitted, 200, 'identity saved');
    assert.equal(submitted.data.identityStatus, 'pending', 'no provider connected, so typed IDs wait for review');
    assertStatus(await verifyIdentity(joiners[1].call, '30111223', 'Same ID'), 200, 'idempotent for the same account');
    assertStatus(await verifyIdentity(joiners[2].call, '30111223', 'Second Holder'), 409, 'one ID cannot hold two accounts');

    const checkouts = [];
    for (const [index, joiner] of joiners.entries()) {
      assertStatus(await verifyIdentity(joiner.call, `4011122${index}`, joiner.user.name), 200, `verify ${index}`);
      const waiting = await checkoutSeat(joiner.call, gid);
      assertStatus(waiting, 403, `a pending ID cannot take a seat ${index}`);
      assert.equal(waiting.data.error, 'identity_pending');
      const approved = await approveIdentity(organizerCall, joiner.user.id);
      assertStatus(approved, 200, `review desk approves ${index}`);
      assert.equal(approved.data.identityStatus, 'verified');
      const checkout = await checkoutSeat(joiner.call, gid);
      assertStatus(checkout, 201, `seat checkout ${index}`);
      assert.ok(checkout.data.checkoutUrl?.startsWith('https://'), 'checkout opens the provider');
      assert.equal(checkout.data.seatMinor, CONTRIBUTION);
      checkouts.push(checkout.data);
    }

    const resumed = await checkoutSeat(joiners[0].call, gid);
    assertStatus(resumed, 201, 'an unpaid seat can resume its checkout');
    assert.equal(resumed.data.membershipId, checkouts[0].membershipId, 'the same seat is reused, not duplicated');

    let detail = (await joiners[0].call(`/groups/${gid}`)).data;
    assert.equal(detail.me.seatStatus, 'pending');
    assert.equal(detail.round.seatsUnpaid, 4);

    for (const [index, joiner] of joiners.slice(0, 3).entries()) {
      assertStatus(await paySeat(handle, {
        gid, userId: joiner.user.id, checkout: checkouts[index],
      }), 200, `seat paid ${index}`);
    }

    assertStatus(await organizerCall(`/groups/${gid}/round/accept`, { method: 'POST', body: { roundNumber: 1 } }), 200, 'organizer accepts');
    const blocked = await organizerCall(`/groups/${gid}/start`, { method: 'POST', body: {} });
    assertStatus(blocked, 409, 'start waits for every open seat');
    assert.equal(blocked.data.error, 'seat_payment_required', 'paid seats already count as their acceptance');

    assertStatus(await paySeat(handle, {
      gid, userId: joiners[3].user.id, checkout: checkouts[3],
    }), 200, 'last seat paid');

    detail = (await joiners[3].call(`/groups/${gid}`)).data;
    assert.equal(detail.round.seatsUnpaid, 0);
    assert.equal(detail.round.acceptedCount, 5, 'the join pledge accepts round one for every paid seat');
    assert.equal(detail.me.seatStatus, 'paid');
    assert.equal(detail.me.seatPaidMinor, CONTRIBUTION);

    assertStatus(await organizerCall(`/groups/${gid}/start`, { method: 'POST', body: {} }), 200, 'start after seats paid');

    detail = (await organizerCall(`/groups/${gid}`)).data;
    assert.equal(detail.group.status, 'active');
    assert.equal(detail.cycle.paidCount, 4, 'every joining seat is turn one already paid');
    assert.equal(detail.cycle.potCapturedMinor, CONTRIBUTION * 4);
    assert.equal(detail.cycle.status, 'contributing', 'the organizer still funds their own seat');

    for (const joiner of joiners) {
      const membership = db.table('memberships')
        .find((member) => member.group_id === gid && member.user_id === joiner.user.id && member.status === 'active');
      const contribution = db.table('contributions')
        .find((row) => row.cycle_id === detail.cycle.id && row.membership_id === membership.id);
      assert.equal(contribution.status, 'paid');
      assert.equal(contribution.method, 'seat_prepay');
    }

    const outsider = await addUser(db, { name: 'Outsider', phone: '+254700000301' });
    const outsiderCall = client(handle, await signIn(db, outsider));
    const listed = await outsiderCall('/open-circles');
    assertStatus(listed, 200, 'open list');
    assert.equal(listed.data.circles.some((circle) => circle.id === gid), false, 'a started circle leaves the open list');
  } finally {
    stub.restore();
  }
});

test('a private circle never appears in the open list and seat prepay counts once', async () => {
  const { db, handle } = await boot();
  const organizer = await addUser(db, { name: 'Host', phone: '+254700000401' });
  const organizerCall = client(handle, await signIn(db, organizer));
  const open = await createOpenGroup(organizerCall, { name: 'Open Table' });
  const priv = await organizerCall('/groups', {
    method: 'POST',
    body: { name: 'Private Table', contributionMinor: CONTRIBUTION, maxMembers: 5, organizerFeeBps: 0 },
  });
  assertStatus(priv, 201, 'private group');

  const viewer = await addUser(db, { name: 'Viewer', phone: '+254700000402' });
  const viewerCall = client(handle, await signIn(db, viewer));
  const listed = await viewerCall('/open-circles');
  assertStatus(listed, 200, 'list');
  const ids = listed.data.circles.map((circle) => circle.id);
  assert.ok(ids.includes(open.id), 'open circle listed');
  assert.equal(ids.includes(priv.data.group.id), false, 'private circle hidden');
  const card = listed.data.circles.find((circle) => circle.id === open.id);
  assert.equal(card.seatsLeft, 4);
  assert.equal(card.seatMinor, CONTRIBUTION);
  assert.equal(card.expectToPayMinor, CONTRIBUTION * 5);
  assert.equal(card.organizerName, 'Host');
});

test('seat payments refund instead of trapping money', async () => {
  const { db, handle } = await boot();
  const stub = installPaysasaStub();
  try {
    const organizer = await addUser(db, { name: 'Refund Host', phone: '+254700000501' });
    const organizerCall = client(handle, await signIn(db, organizer));
    const group = await createOpenGroup(organizerCall, { maxMembers: 6, name: 'Refund Circle' });

    const users = [];
    for (let index = 0; index < 4; index += 1) {
      const user = await addUser(db, { name: `Refunder ${index + 1}`, phone: `+25470000051${index}` });
      const call = client(handle, await signIn(db, user));
      assertStatus(await verifyIdentity(call, `5011122${index}`, user.name), 200, `verify ${index}`);
      assertStatus(await approveIdentity(organizerCall, user.id), 200, `approve ${index}`);
      users.push({ user, call });
    }

    const left = await checkoutSeat(users[0].call, group.id);
    assertStatus(left, 201, 'reserve before leaving');
    const leavePending = await users[0].call(`/groups/${group.id}/leave`, { method: 'POST', body: {} });
    assertStatus(leavePending, 200, 'leaving an unpaid seat is free');
    assert.equal(leavePending.data.refundedMinor, 0);

    const paid = await checkoutSeat(users[1].call, group.id);
    assertStatus(paid, 201, 'reserve a paid seat');
    assertStatus(await paySeat(handle, { gid: group.id, userId: users[1].user.id, checkout: paid.data }), 200, 'seat paid');
    const leavePaid = await users[1].call(`/groups/${group.id}/leave`, { method: 'POST', body: {} });
    assertStatus(leavePaid, 200, 'leaving before the start refunds the seat');
    assert.equal(leavePaid.data.refundedMinor, CONTRIBUTION);
    const wallet = (await users[1].call('/auth/me')).data.wallet;
    assert.equal(wallet.availableMinor, CONTRIBUTION, 'refund is spendable in the wallet');
    const refundEntry = db.table('ledger').find((row) => row.kind === 'seat_refund' && row.user_id === users[1].user.id);
    assert.equal(refundEntry.wallet_effect, CONTRIBUTION);
    assert.equal(refundEntry.amount_minor, CONTRIBUTION);

    const wrong = await checkoutSeat(users[2].call, group.id);
    assertStatus(wrong, 201, 'reserve for a wrong amount');
    assertStatus(await paySeat(handle, {
      gid: group.id, userId: users[2].user.id, checkout: wrong.data, amount: 19000,
    }), 200, 'webhook acknowledges the refund path');
    const mismatchRefund = db.table('ledger').find((row) => row.kind === 'seat_refund' && row.user_id === users[2].user.id);
    assert.equal(mismatchRefund.wallet_effect, 19000, 'the actual amount paid comes back');
    const wrongMember = db.table('memberships').find((row) => row.id === wrong.data.membershipId);
    assert.equal(wrongMember.status, 'removed');

    const late = await checkoutSeat(users[3].call, group.id);
    assertStatus(late, 201, 'reserve before the start');
    const lateMember = db.table('memberships').find((row) => row.id === late.data.membershipId);
    db.table('groups').find((row) => row.id === group.id).status = 'active';
    const latePayment = await markSeatPaid(db, lateMember, { amountMinor: CONTRIBUTION, now: Date.now() });
    assert.equal(latePayment.refunded, true, 'a payment landing after the start is returned');
    const lateRefund = db.table('ledger').find((row) => row.kind === 'seat_refund' && row.user_id === users[3].user.id);
    assert.equal(lateRefund.wallet_effect, CONTRIBUTION);
  } finally {
    stub.restore();
  }
});

test('protection maths show a missed turn is covered before anyone loses', async () => {
  const { db, handle } = await boot();
  const stub = installPaysasaStub();
  try {
    const organizer = await addUser(db, { name: 'Cover Host', phone: '+254700000701' });
    const organizerCall = client(handle, await signIn(db, organizer));
    const group = await createOpenGroup(organizerCall, { name: 'Cover Circle' });

    let detail = (await organizerCall(`/groups/${group.id}`)).data;
    assert.equal(detail.protection.coverMinor, 0, 'a forming circle starts with zero exposure');
    assert.equal(detail.protection.shortfallMinor, Math.ceil(CONTRIBUTION * 11 / 10), 'one missed turn plus the late fee');
    assert.equal(detail.protection.shortfallMinor % 100, 0, 'the cushion stays a whole shilling');
    assert.equal(detail.protection.coveragePct, 0);
    assert.equal(detail.protection.memberCount, 1);
    assert.equal(detail.protection.verifiedMembers, 1, 'the organizer is verified at creation');
    assert.equal(detail.protection.lateCapBps, 1000);
    assert.equal(detail.protection.graceHours, 24);

    const joiner = await addUser(db, { name: 'Cover Joiner', phone: '+254700000702' });
    const joinerCall = client(handle, await signIn(db, joiner));
    assertStatus(await verifyIdentity(joinerCall, '70111223', joiner.name), 200, 'joiner verified');
    assertStatus(await approveIdentity(organizerCall, joiner.id), 200, 'review desk approves the joiner');
    const seat = await checkoutSeat(joinerCall, group.id);
    assertStatus(seat, 201, 'joiner reserves a seat');
    assertStatus(await paySeat(handle, { gid: group.id, userId: joiner.id, checkout: seat.data }), 200, 'seat paid');

    db.table('bonds').push({
      id: 'bond_cover_1', group_id: group.id, membership_id: seat.data.membershipId,
      held_minor: 8000, status: 'held', created_at: nowIso(),
    });
    db.table('fund_entries').push({
      id: 'fund_cover_1', ref: 'fund_cover_1', group_id: group.id, cycle_id: null,
      kind: 'fund_contribution', amount_minor: 6000, memo: '', created_at: nowIso(),
    });

    detail = (await organizerCall(`/groups/${group.id}`)).data;
    assert.equal(detail.protection.bondPoolMinor, 8000, 'winner bonds are counted');
    assert.equal(detail.protection.fundBalanceMinor, 6000, 'the guarantee fund is counted');
    assert.equal(detail.protection.coverMinor, 14000);
    assert.equal(detail.protection.coveragePct, Math.round(14000 / 22000 * 100), 'cover is measured against the miss');
    assert.equal(detail.protection.verifiedMembers, 2, 'a paid open seat carries the ID check');
  } finally {
    stub.restore();
  }
});

test('stalled circles release unpaid holds and prepaid seats', async () => {
  const { db, handle } = await boot();
  const stub = installPaysasaStub();
  try {
    const organizer = await addUser(db, { name: 'Stall Host', phone: '+254700000601' });
    const organizerCall = client(handle, await signIn(db, organizer));
    const group = await createOpenGroup(organizerCall, { maxMembers: 6, name: 'Stalled Circle' });

    const holder = await addUser(db, { name: 'Holder', phone: '+254700000602' });
    const holderCall = client(handle, await signIn(db, holder));
    await verifyIdentity(holderCall, '60111223', holder.name);
    await approveIdentity(organizerCall, holder.id);
    const held = await checkoutSeat(holderCall, group.id);
    assertStatus(held, 201, 'hold a seat');
    const heldMember = db.table('memberships').find((row) => row.id === held.data.membershipId);
    heldMember.seat_expires_at = nowIso(Date.now() - 1000);
    const expired = await sweepSeats(db);
    assert.ok(expired >= 1, 'expired holds are released');
    assert.equal(db.table('memberships').find((row) => row.id === held.data.membershipId).status, 'removed');

    const payer = await addUser(db, { name: 'Payer', phone: '+254700000603' });
    const payerCall = client(handle, await signIn(db, payer));
    await verifyIdentity(payerCall, '60111224', payer.name);
    await approveIdentity(organizerCall, payer.id);
    const paid = await checkoutSeat(payerCall, group.id);
    assertStatus(paid, 201, 'paid seat');
    assertStatus(await paySeat(handle, { gid: group.id, userId: payer.id, checkout: paid.data }), 200, 'seat paid');
    const paidMember = db.table('memberships').find((row) => row.id === paid.data.membershipId);
    assert.equal(paidMember.seat_status, 'paid');
    paidMember.seat_paid_at = nowIso(Date.now() - SEAT_STALL_MS - 1000);
    const released = await sweepSeats(db);
    assert.ok(released >= 1, 'a stalled prepaid seat is returned');
    const releasedMember = db.table('memberships').find((row) => row.id === paid.data.membershipId);
    assert.equal(releasedMember.status, 'removed');
    assert.equal(releasedMember.seat_status, 'refunded');
    const refund = db.table('ledger').find((row) => row.ref === `seat_refund:${paid.data.membershipId}`);
    assert.ok(refund, 'refund is written to the ledger');
    assert.match(refund.memo, /14 days/);
  } finally {
    stub.restore();
  }
});
