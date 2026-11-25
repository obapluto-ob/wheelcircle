import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, addUser, signIn, client, postWebhook, contributionFor, installPaysasaStub, assertStatus,
} from './helpers.mjs';
import { nowIso } from '../functions/lib/util.mjs';

const ADMIN_PHONE = '+254700000099';
process.env.ADMIN_PANEL_PIN = '2003';
process.env.WHEEL_ADMIN_PHONES = ADMIN_PHONE;

async function settleOneTurn(db, handle, calls, users, gid) {
  const detail = (await calls[0](`/groups/${gid}`)).data;
  const cycleId = detail.cycle.id;
  const members = Object.fromEntries(detail.members.map((member) => [member.userId, member.id]));
  for (const [index, call] of calls.entries()) {
    const checkout = await call(`/groups/${gid}/contributions`, { method: 'POST', body: { cycleId } });
    assertStatus(checkout, 200, `checkout ${index}`);
    const contribution = contributionFor(db, cycleId, members[users[index].id]);
    const event = {
      event: 'checkout.paid',
      created_at: nowIso(),
      data: {
        session_id: contribution.provider_ref,
        reference: `pay_${cycleId}_${index}`,
        amount: contribution.amount_minor,
        currency: 'KES',
        payment_method: 'm_pesa',
        metadata: { contribution_id: contribution.id, cycle_id: cycleId, group_id: gid, user_id: users[index].id },
      },
    };
    assertStatus(await postWebhook(handle, event), 200, `webhook ${index}`);
  }
  return cycleId;
}

async function freshCircle() {
  const { db, handle } = await boot();
  const users = [];
  const calls = [];
  for (let index = 0; index < 5; index += 1) {
    const user = await addUser(db, { name: `Seat ${index + 1}`, phone: `+25473300000${index + 1}` });
    users.push(user);
    calls.push(client(handle, await signIn(db, user)));
  }
  const created = await calls[0]('/groups', {
    method: 'POST',
    body: { name: 'Operator Test Circle', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100 },
  });
  assertStatus(created, 201, 'create');
  const gid = created.data.group.id;
  for (let index = 1; index < 5; index += 1) {
    assertStatus(await calls[index]('/groups/join', { method: 'POST', body: { inviteCode: created.data.group.inviteCode } }), 201);
  }
  for (const call of calls) {
    assertStatus(await call(`/groups/${gid}/round/accept`, { method: 'POST', body: { roundNumber: 1 } }), 200);
  }
  assertStatus(await calls[0](`/groups/${gid}/start`, { method: 'POST', body: {} }), 200, 'start');
  return { db, handle, users, calls, gid };
}

test('the operator door opens only for an admin with the server-side PIN', async () => {
  const { db, handle } = await boot();
  const admin = await addUser(db, { name: 'Operator', phone: ADMIN_PHONE });
  const adminCall = client(handle, await signIn(db, admin));
  const member = await addUser(db, { name: 'Member', phone: '+254733100001' });
  const memberCall = client(handle, await signIn(db, member));

  assertStatus(await memberCall('/admin/unlock', { method: 'POST', body: { pin: '2003' } }), 403, 'members never reach the door');
  assertStatus(await client(handle, null)('/admin/unlock', { method: 'POST', body: { pin: '2003' } }), 403, 'no session, no CSRF');
  assertStatus(await adminCall('/admin/unlock', { method: 'POST', body: { pin: '9999' } }), 403, 'wrong PIN');
  const opened = await adminCall('/admin/unlock', { method: 'POST', body: { pin: '2003' } });
  assertStatus(opened, 200, 'correct PIN');
  assert.equal(opened.data.unlocked, true);

  const overview = await adminCall('/admin/overview');
  assertStatus(overview, 200, 'overview');
  assert.equal(overview.data.totals.unbalancedSettlements, 0);
  assert.equal(overview.data.pinConfigured, true);
  assertStatus(await memberCall('/admin/overview'), 403, 'overview is admin only');
});

test('a stolen admin session still gets locked out after five PIN attempts', async () => {
  const { db, handle } = await boot();
  const admin = await addUser(db, { name: 'Operator', phone: ADMIN_PHONE });
  const call = client(handle, await signIn(db, admin));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assertStatus(await call('/admin/unlock', { method: 'POST', body: { pin: '0000' } }), 403, `attempt ${attempt}`);
  }
  assertStatus(await call('/admin/unlock', { method: 'POST', body: { pin: '2003' } }), 429, 'sixth attempt waits');
});

test('a circle recap replays every settled turn with per-seat payments', async () => {
  const stub = installPaysasaStub();
  try {
    const { db, handle, users, calls, gid } = await freshCircle();
    const cycleId = await settleOneTurn(db, handle, calls, users, gid);

    const detail = (await calls[0](`/groups/${gid}`)).data;
    assert.equal(detail.turns.length, 1, 'the engine rail sees the settled turn');
    assert.equal(detail.turns[0].winnerName, 'Seat 1');
    assert.equal(detail.turns[0].status, 'settled');
    assert.equal(detail.recap, null, 'the whole-round recap waits for the last turn');

    const recap = await calls[0](`/groups/${gid}/recap`);
    assertStatus(recap, 200, 'mid-round recap');
    assert.equal(recap.data.recap.turns.length, 1, 'one settled turn so far');
    const turn = recap.data.recap.turns[0];
    assert.equal(turn.payments.length, 5, 'every funded seat is named');
    assert.equal(turn.payments.filter((payment) => payment.amountMinor === 20000).length, 5);
    assert.equal(turn.shares.length, 4, 'each waiting seat got a share');
    assert.equal(turn.shares[0].shareMinor, 2500);
    assert.equal(recap.data.recap.balanced, true);
    assert.equal(recap.data.circle.status, 'active');

    const outsider = await addUser(db, { name: 'Outsider', phone: '+254733200001' });
    assertStatus(await client(handle, await signIn(db, outsider))(`/groups/${gid}/recap`), 403, 'members only');

    process.env.WHEEL_ADMIN_PHONES = `${ADMIN_PHONE},+254733200002`;
    const operator = await addUser(db, { name: 'Operator', phone: '+254733200002' });
    const operatorCall = client(handle, await signIn(db, operator));
    const overview = await operatorCall('/admin/overview');
    assertStatus(overview, 200, 'overview');
    assert.equal(overview.data.totals.balancedSettlements, 1);
    assert.equal(overview.data.totals.unbalancedSettlements, 0);
    assert.equal(overview.data.totals.platformFeeMinor, 1000);
    assert.equal(overview.data.totals.fundFeeMinor, 1000);
    assert.equal(overview.data.totals.organizerWaivedMinor, 1000);
    const circle = overview.data.circles.find((row) => row.id === gid);
    assert.equal(circle.paidCount, 5);
    assert.equal(circle.potCapturedMinor, 100000);
    assert.equal(circle.settledTurns, 1);
    assert.ok(circle.fundMinor >= 1000, 'the guarantee fund is credited');
    assert.equal(db.table('settlements').find((row) => row.cycle_id === cycleId).pot_minor, 100000);
  } finally {
    stub.restore();
  }
});
