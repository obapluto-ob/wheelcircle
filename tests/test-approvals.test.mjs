import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, addUser, signIn, client, installPaysasaStub, postWebhook, assertStatus,
} from './helpers.mjs';

const ADMIN_PHONE = '+254700000901';

function asAdmin() {
  process.env.WHEEL_ADMIN_PHONES = ADMIN_PHONE;
  process.env.PAYSASA_SANDBOX = '1';
}

test('sandbox test approvals stay off until the operator turns them on', async () => {
  asAdmin();
  const { db, handle } = await boot();
  const member = await addUser(db, { name: 'Amina Wanjiku', phone: '+254700000902' });
  const admin = await addUser(db, { name: 'Operator', phone: ADMIN_PHONE });
  const call = client(handle, await signIn(db, member));
  const adminCall = client(handle, await signIn(db, admin));
  const stub = installPaysasaStub();
  try {
    const started = await call('/wallet/topups', { method: 'POST', body: { amountMinor: 100000 } });
    assertStatus(started, 201, 'top-up');
    const sessionId = started.data.sessionId;

    assertStatus(await call(`/payments/checkouts/${sessionId}/cancel`, { method: 'POST', body: {} }), 200, 'cancel');
    const cancelled = await call(`/payments/checkouts/${sessionId}/sync`, { method: 'POST', body: {} });
    assertStatus(cancelled, 200, 'sync while off');
    assert.equal(cancelled.data.paid, false, 'no approval while the switch is off');
    assert.equal(cancelled.data.closed, true, 'the dead checkout is closed out');
    assert.equal(cancelled.data.status, 'cancelled');
    assert.equal((await call('/wallet/topups')).data.savedMinor, 0, 'nothing credited while off');
    assert.equal((await call('/wallet/topups')).data.topUps[0].status, 'cancelled', 'the waiting row stops saying in flight');

    const state = await adminCall('/admin/payments/test-approvals');
    assertStatus(state, 200, 'read approvals');
    assert.equal(state.data.available, true, 'sandbox rail allows approvals');
    assert.equal(state.data.enabled, false, 'off by default');

    assertStatus(await call('/admin/payments/test-approvals', { method: 'POST', body: { enabled: true } }), 403, 'members cannot toggle');

    const enabled = await adminCall('/admin/payments/test-approvals', { method: 'POST', body: { enabled: true } });
    assertStatus(enabled, 200, 'enable approvals');
    assert.equal(enabled.data.enabled, true);

    const approved = await call(`/payments/checkouts/${sessionId}/sync`, { method: 'POST', body: {} });
    assertStatus(approved, 200, 'sync after cancel');
    assert.equal(approved.data.paid, true, 'cancelled checkout books as paid');
    assert.equal(approved.data.testApproved, true, 'marked as a test approval');

    const wallet = (await call('/wallet/topups')).data;
    assert.equal(wallet.savedMinor, 100000, 'stash credited');
    assert.equal(wallet.topUps[0].status, 'paid');
    assert.equal(wallet.topUps[0].test_approved, true, 'the row is marked');
    const ledger = db.table('ledger').filter((row) => row.kind === 'topup');
    assert.equal(ledger.length, 1);
    assert.match(ledger[0].memo, /sandbox test approval/i);

    // Repeating the sync never double-credits.
    const again = await call(`/payments/checkouts/${sessionId}/sync`, { method: 'POST', body: {} });
    assertStatus(again, 200);
    assert.equal((await call('/wallet/topups')).data.savedMinor, 100000, 'credited once');

    const config = await call('/config');
    assert.equal(config.data.testApprovals.enabled, true, 'config exposes the switch');
    assert.equal(stub.sessions.get(sessionId)?.status, 'cancelled', 'the provider was never charged');
  } finally {
    stub.restore();
  }
});

test('a cancelled checkout that was never paid can be booked by the closed webhook', async () => {
  asAdmin();
  const { db, handle } = await boot();
  const admin = await addUser(db, { name: 'Operator', phone: ADMIN_PHONE });
  const member = await addUser(db, { name: 'Brian Otieno', phone: '+254700000903' });
  const call = client(handle, await signIn(db, member));
  const adminCall = client(handle, await signIn(db, admin));
  const stub = installPaysasaStub();
  try {
    const started = await call('/wallet/topups', { method: 'POST', body: { amountMinor: 50000 } });
    assertStatus(started, 201);
    const sessionId = started.data.sessionId;
    assertStatus(await adminCall('/admin/payments/test-approvals', { method: 'POST', body: { enabled: true } }), 200);

    const event = {
      event: 'checkout.cancelled',
      data: { session_id: sessionId, amount: 50000, currency: 'KES', metadata: { wallet_topup: member.id } },
    };
    assertStatus(await postWebhook(handle, event), 200, 'cancel webhook');
    const wallet = (await call('/wallet/topups')).data;
    assert.equal(wallet.savedMinor, 50000, 'the cancel webhook books the top-up in sandbox');
    assert.equal(wallet.topUps[0].test_approved, true);
  } finally {
    stub.restore();
  }
});

test('live keys can never turn sandbox approvals on', async () => {
  asAdmin();
  const { db, handle } = await boot();
  const admin = await addUser(db, { name: 'Operator', phone: ADMIN_PHONE });
  const adminCall = client(handle, await signIn(db, admin));
  const original = process.env.PAYSASA_API_KEY;
  process.env.PAYSASA_API_KEY = 'apk_live_test_key';
  try {
    const state = await adminCall('/admin/payments/test-approvals');
    assertStatus(state, 200);
    assert.equal(state.data.available, false, 'live key closes the switch');
    const refused = await adminCall('/admin/payments/test-approvals', { method: 'POST', body: { enabled: true } });
    assertStatus(refused, 409, 'live key refuses the toggle');
    assert.equal(refused.data.error, 'test_approvals_unavailable');
  } finally {
    process.env.PAYSASA_API_KEY = original;
  }
});

test('a test key without the sandbox flag keeps approvals off', async () => {
  asAdmin();
  const saved = process.env.PAYSASA_SANDBOX;
  delete process.env.PAYSASA_SANDBOX;
  try {
    const { db, handle } = await boot();
    const admin = await addUser(db, { name: 'Operator', phone: ADMIN_PHONE });
    const adminCall = client(handle, await signIn(db, admin));
    const state = await adminCall('/admin/payments/test-approvals');
    assertStatus(state, 200);
    assert.equal(state.data.available, false, 'an undeclared rail is not sandbox');
    const refused = await adminCall('/admin/payments/test-approvals', { method: 'POST', body: { enabled: true } });
    assertStatus(refused, 409);
    assert.equal(refused.data.error, 'test_approvals_unavailable');
  } finally {
    if (saved === undefined) delete process.env.PAYSASA_SANDBOX;
    else process.env.PAYSASA_SANDBOX = saved;
  }
});
