import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, addUser, signIn, client, postWebhook, installPaysasaStub, assertStatus, WEBHOOK_SECRET,
} from './helpers.mjs';
import { nowIso } from '../functions/lib/util.mjs';

test('savings top-ups credit once and checkout sessions can be polled, prompted and cancelled', async () => {
  const { db, handle } = await boot();
  const user = await addUser(db, { name: 'Amina Wanjiku', phone: '+254700000201' });
  const session = await signIn(db, user);
  const call = client(handle, session);
  const stranger = client(handle, await signIn(db, await addUser(db, { name: 'Stranger', phone: '+254700000202' })));
  const stub = installPaysasaStub();
  try {
    assertStatus(await call('/wallet/topups', { method: 'POST', body: { amountMinor: 1000 } }), 400, 'minimum top-up');
    assertStatus(await call('/wallet/topups', { method: 'POST', body: { amountMinor: 5000000 } }), 400, 'maximum top-up');

    const started = await call('/wallet/topups', { method: 'POST', body: { amountMinor: 50000 } });
    assertStatus(started, 201, 'start top-up');
    assert.match(started.data.checkoutUrl, /^https:\/\//);
    const sessionId = started.data.sessionId;
    assert.ok(sessionId, 'session id returned');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 0, 'nothing is saved before payment');

    // The session belongs to the payer only.
    assertStatus(await stranger(`/payments/checkouts/${sessionId}`), 404, 'status is private');
    assertStatus(await stranger(`/payments/checkouts/${sessionId}/pay`, { method: 'POST', body: {} }), 404, 'pay is private');

    const status = await call(`/payments/checkouts/${sessionId}`);
    assertStatus(status, 200, 'poll status');
    assert.equal(status.data.status, 'pending');
    assert.equal(status.data.paid, false);

    const prompted = await call(`/payments/checkouts/${sessionId}/pay`, { method: 'POST', body: {} });
    assertStatus(prompted, 200, 'stk prompt');
    assert.equal(prompted.data.status, 'processing');

    const event = {
      event: 'checkout.paid',
      created_at: nowIso(),
      data: {
        session_id: sessionId,
        reference: 'ref_test_1',
        amount: 50000,
        currency: 'KES',
        payment_method: 'm_pesa',
        metadata: { wallet_topup: user.id },
      },
    };
    assertStatus(await postWebhook(handle, event), 200, 'top-up webhook');
    const duplicate = await postWebhook(handle, event);
    assertStatus(duplicate, 200, 'duplicate webhook');
    assert.equal(duplicate.data.duplicate, true);

    const after = (await call('/wallet/topups')).data;
    assert.equal(after.savedMinor, 50000, 'credited exactly once');
    assert.equal(after.topUps.length, 1);
    assert.equal(after.topUps[0].status, 'paid');
    assert.equal(db.table('ledger').filter((row) => row.kind === 'topup').length, 1);

    const wrongAmount = await postWebhook(handle, {
      ...event,
      data: { ...event.data, session_id: 'cs_test_missing', amount: 90000 },
    });
    assertStatus(wrongAmount, 200, 'unmatched session is acknowledged');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 50000, 'no invented credit');

    const second = await call('/wallet/topups', { method: 'POST', body: { amountMinor: 25000 } });
    assertStatus(second, 201, 'second top-up');
    const cancelled = await call(`/payments/checkouts/${second.data.sessionId}/cancel`, { method: 'POST', body: {} });
    assertStatus(cancelled, 200, 'cancel session');
    assert.equal(cancelled.data.status, 'cancelled');
    assert.equal((await call('/wallet/topups')).data.topUps[0].status, 'cancelled');

    // Sync applies the same idempotent path the webhook uses.
    const third = await call('/wallet/topups', { method: 'POST', body: { amountMinor: 10000 } });
    stub.markPaid(third.data.sessionId);
    assertStatus(await call(`/payments/checkouts/${third.data.sessionId}/sync`, { method: 'POST', body: {} }), 200, 'sync');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 60000, 'synced credit');
    const again = await call(`/payments/checkouts/${third.data.sessionId}/sync`, { method: 'POST', body: {} });
    assertStatus(again, 200, 'sync repeat');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 60000, 'sync never double-credits');
  } finally {
    stub.restore();
  }
});

test('a member pays a turn from saved money with the same accounting', async () => {
  const { db, handle } = await boot();
  const users = [];
  const calls = [];
  for (let index = 0; index < 5; index += 1) {
    const user = await addUser(db, { name: `Saver ${index + 1}`, phone: `+25470000021${index}` });
    users.push(user);
    calls.push(client(handle, await signIn(db, user)));
  }
  const created = await calls[0]('/groups', {
    method: 'POST',
    body: { name: 'Savings Circle', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100 },
  });
  assertStatus(created, 201, 'create group');
  const gid = created.data.group.id;
  const inviteCode = created.data.group.inviteCode;
  for (let index = 1; index < 5; index += 1) {
    assertStatus(await calls[index]('/groups/join', { method: 'POST', body: { inviteCode } }), 201, `join ${index}`);
  }
  for (const [index, call] of calls.entries()) {
    assertStatus(await call(`/groups/${gid}/round/accept`, { method: 'POST', body: { roundNumber: 1 } }), 200, `accept ${index}`);
  }
  assertStatus(await calls[0](`/groups/${gid}/start`, { method: 'POST', body: {} }), 200, 'start');

  const detail = (await calls[0](`/groups/${gid}`)).data;
  const cycleId = detail.cycle.id;
  const me = detail.members.find((member) => member.name === 'Saver 2');

  assertStatus(await calls[1](`/groups/${gid}/contributions/savings`, {
    method: 'POST', body: { cycleId },
  }), 409, 'no savings yet');

  const stub = installPaysasaStub();
  try {
    const topUp = await calls[1]('/wallet/topups', { method: 'POST', body: { amountMinor: 30000 } });
    assertStatus(topUp, 201, 'fund savings');
    assertStatus(await postWebhook(handle, {
      event: 'checkout.paid',
      created_at: nowIso(),
      data: {
        session_id: topUp.data.sessionId,
        reference: 'ref_savings_1',
        amount: 30000,
        currency: 'KES',
        metadata: { wallet_topup: users[1].id },
      },
    }), 200, 'top-up paid');

    // Visitors cannot move someone else's savings.
    assertStatus(await calls[2](`/groups/${gid}/contributions/savings`, {
      method: 'POST', body: { cycleId },
    }), 409, 'other members with no balance cannot pay for them');

    const paid = await calls[1](`/groups/${gid}/contributions/savings`, { method: 'POST', body: { cycleId } });
    assertStatus(paid, 200, 'pay from savings');
    assert.equal(paid.data.amountMinor, 20000);

    const contribution = db.table('contributions').find((row) => row.cycle_id === cycleId && row.membership_id === me.id);
    assert.equal(contribution.status, 'paid');
    assert.equal(contribution.method, 'savings');
    assert.equal(contribution.late_fee_minor, 0);
    const debit = db.table('ledger').find((row) => row.ref === `savings_pay:${contribution.id}`);
    assert.equal(debit.wallet_effect, -20000);
    const pot = db.table('ledger').find((row) => row.ref === `contrib:${contribution.id}`);
    assert.equal(pot.wallet_effect, 0, 'the contribution still credits the pot, not the wallet');
    const wallet = (await calls[1](`/groups/${gid}`)).data.wallet;
    assert.equal(wallet.availableMinor, 10000, 'savings left over stay available');

    const fresh = (await calls[1](`/groups/${gid}`)).data;
    assert.equal(fresh.cycle.paidCount, 1);
    assert.equal(fresh.cycle.savedMinor, 10000);
    assert.equal(fresh.cycle.savedCoversMinor, false);

    assertStatus(await calls[1](`/groups/${gid}/contributions/savings`, {
      method: 'POST', body: { cycleId },
    }), 409, 'a paid contribution is never charged twice');
    assert.equal((await calls[1]('/wallet/topups')).data.savedMinor, 10000);
  } finally {
    stub.restore();
  }
});

test('the webhook secret is required for signed payment events', async () => {
  const { db, handle } = await boot();
  const user = await addUser(db, { name: 'Signature Check', phone: '+254700000231' });
  const call = client(handle, await signIn(db, user));
  const stub = installPaysasaStub();
  try {
    const started = await call('/wallet/topups', { method: 'POST', body: { amountMinor: 10000 } });
    assertStatus(started, 201);
    const event = {
      event: 'checkout.paid',
      created_at: nowIso(),
      data: {
        session_id: started.data.sessionId,
        reference: 'ref_sig_1',
        amount: 10000,
        currency: 'KES',
        metadata: { wallet_topup: user.id },
      },
    };
    assertStatus(await postWebhook(handle, event, { secret: 'wrong-secret' }), 401, 'wrong secret');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 0);
    assertStatus(await postWebhook(handle, event, { secret: WEBHOOK_SECRET }), 200, 'right secret');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 10000);
  } finally {
    stub.restore();
  }
});
