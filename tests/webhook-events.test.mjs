import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, addUser, signIn, client, postWebhook, contributionFor, installPaysasaStub, assertStatus,
} from './helpers.mjs';

test('checkout.session.completed credits a stash top-up from the session id alone', async () => {
  const { db, handle } = await boot();
  const user = await addUser(db, { name: 'Event Shape', phone: '+254700000301' });
  const call = client(handle, await signIn(db, user));
  const stub = installPaysasaStub();
  try {
    const started = await call('/wallet/topups', { method: 'POST', body: { amountMinor: 10000 } });
    assertStatus(started, 201, 'start top-up');
    assertStatus(await postWebhook(handle, {
      event: 'checkout.session.completed',
      data: {
        session_id: started.data.sessionId,
        reference: 'ref_evt_flat',
        amount: 10000,
        currency: 'KES',
      },
    }), 200, 'paid checkout');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 10000, 'credited once');
    assertStatus(await postWebhook(handle, {
      event: 'checkout.session.completed',
      data: { session_id: started.data.sessionId, amount: 10000, currency: 'KES' },
    }), 200, 'replayed payment');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 10000, 'replay credits nothing');
  } finally {
    stub.restore();
  }
});

test('payment.completed reads nested session and payment objects', async () => {
  const { db, handle } = await boot();
  const user = await addUser(db, { name: 'Nested Shape', phone: '+254700000302' });
  const call = client(handle, await signIn(db, user));
  const stub = installPaysasaStub();
  try {
    const started = await call('/wallet/topups', { method: 'POST', body: { amountMinor: 20000 } });
    assertStatus(started, 201, 'start top-up');
    const paid = await postWebhook(handle, {
      type: 'payment.completed',
      data: {
        session: { id: started.data.sessionId },
        payment: {
          id: 'pm_evt_1',
          reference: 'ref_evt_nested',
          amount: 20000,
          currency: 'KES',
          metadata: { wallet_topup: user.id },
        },
      },
    });
    assertStatus(paid, 200, 'nested payment');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 20000, 'credited from nested payment');
  } finally {
    stub.restore();
  }
});

test('checkout.session.completed settles a contribution without metadata', async () => {
  const { db, handle } = await boot();
  const users = [];
  const calls = [];
  for (let index = 0; index < 5; index += 1) {
    const user = await addUser(db, { name: `Payer ${index + 1}`, phone: `+25470000032${index}` });
    users.push(user);
    calls.push(client(handle, await signIn(db, user)));
  }
  const created = await calls[0]('/groups', {
    method: 'POST',
    body: { name: 'Event Circle', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100 },
  });
  assertStatus(created, 201, 'create group');
  const gid = created.data.group.id;
  for (let index = 1; index < 5; index += 1) {
    assertStatus(await calls[index]('/groups/join', {
      method: 'POST', body: { inviteCode: created.data.group.inviteCode },
    }), 201, `join ${index}`);
  }
  for (const call of calls) {
    assertStatus(await call(`/groups/${gid}/round/accept`, {
      method: 'POST', body: { roundNumber: 1 },
    }), 200, 'accept');
  }
  assertStatus(await calls[0](`/groups/${gid}/start`, { method: 'POST', body: {} }), 200, 'start');
  const detail = (await calls[0](`/groups/${gid}`)).data;
  const me = detail.members.find((member) => member.userId === users[1].id);

  const stub = installPaysasaStub();
  try {
    const checkout = await calls[1](`/groups/${gid}/contributions`, {
      method: 'POST', body: { cycleId: detail.cycle.id },
    });
    assertStatus(checkout, 200, 'contribution checkout');
    const contribution = contributionFor(db, detail.cycle.id, me.id);
    assertStatus(await postWebhook(handle, {
      event: 'checkout.session.completed',
      data: {
        session_id: contribution.provider_ref,
        reference: 'ref_evt_contrib',
        amount: contribution.amount_minor,
        currency: 'KES',
      },
    }), 200, 'paid contribution');
    const fresh = contributionFor(db, detail.cycle.id, me.id);
    assert.equal(fresh.status, 'paid');
    assert.equal(fresh.method, 'paysasa');
    assert.equal(fresh.late_fee_minor, 0);
  } finally {
    stub.restore();
  }
});

test('events THE WHEEL does not use are acknowledged without touching money', async () => {
  const { db, handle } = await boot();
  const user = await addUser(db, { name: 'Observer', phone: '+254700000303' });
  const call = client(handle, await signIn(db, user));
  const events = ['lengo.goal.created', 'wallet.credited', 'payment.failed', 'waas.deposit.success', 'waas.withdrawal.success'];
  for (const event of events) {
    const result = await postWebhook(handle, { event, data: { id: `evt_${event}`, reference: `r_${event}` } });
    assertStatus(result, 200, event);
    assert.equal(result.data.received, true, `${event} acknowledged`);
  }
  assert.equal((await call('/wallet/topups')).data.savedMinor, 0, 'no money moved');
  assert.equal(db.table('ledger').length, 0, 'no ledger rows invented');
});
