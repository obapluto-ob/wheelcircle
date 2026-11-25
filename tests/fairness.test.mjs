import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boot, addUser, signIn, client, postWebhook, contributionFor, installPaysasaStub, assertStatus,
} from './helpers.mjs';

const post = (body = {}) => ({ method: 'POST', body });
const close = (call, groupId, cycleId) => call(`/groups/${groupId}/cycles/${cycleId}/close`, post());
const SEAT_LADDER = [1000, 600, 500, 500, 0];

function assertError(result, status, code) {
  assertStatus(result, status, code);
  assert.equal(result.data.error, code);
}

async function circleFixture(t) {
  const { db, handle } = await boot();
  const stub = installPaysasaStub();
  t.after(() => stub.restore());
  const users = [];
  const calls = [];
  for (let index = 0; index < 5; index += 1) {
    const user = await addUser(db, { name: `Fairness member ${index + 1}`, phone: `+25471000000${index + 1}` });
    users.push(user);
    calls.push(client(handle, await signIn(db, user)));
  }
  const created = await calls[0]('/groups', post({
    name: 'Fairness circle', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100,
  }));
  assertStatus(created, 201);
  const groupId = created.data.group.id;
  for (const call of calls.slice(1)) {
    assertStatus(await call('/groups/join', post({ inviteCode: created.data.group.inviteCode })), 201);
  }
  const members = db.table('memberships').filter((row) => row.group_id === groupId);
  const memberIds = users.map((user) => members.find((row) => row.user_id === user.id).id);
  for (const call of calls) assertStatus(await call(`/groups/${groupId}/round/accept`, post({ roundNumber: 1 })), 200);
  const started = await calls[0](`/groups/${groupId}/start`, post());
  assertStatus(started, 200);

  async function pay(index, cycleId, checkSignature = false) {
    assertStatus(await calls[index](`/groups/${groupId}/contributions`, post({ cycleId })), 200);
    const contribution = contributionFor(db, cycleId, memberIds[index]);
    const event = {
      event: 'checkout.paid',
      created_at: new Date().toISOString(),
      data: {
        session_id: contribution.provider_ref,
        reference: `fairness_${contribution.id}`,
        amount: contribution.amount_minor,
        currency: 'KES',
        payment_method: 'm_pesa',
        metadata: { contribution_id: contribution.id, cycle_id: cycleId, group_id: groupId, user_id: users[index].id },
      },
    };
    if (checkSignature) {
      assertError(await postWebhook(handle, event, { signature: 'deadbeef' }), 401, 'invalid_signature');
      assert.equal(contributionFor(db, cycleId, memberIds[index]).status, 'pending');
    }
    assertStatus(await postWebhook(handle, event), 200);
    assert.equal(contributionFor(db, cycleId, memberIds[index]).status, 'paid');
  }

  return { db, handle, users, calls, groupId, memberIds, cycleId: started.data.cycleId, pay };
}

test('seats take the pot in order, previous winners keep paying, and the final seat needs no bond', async (t) => {
  const f = await circleFixture(t);
  const { db, handle, calls, groupId, memberIds, pay } = f;
  let cycleId = f.cycleId;
  const outsiders = client(handle, await signIn(db, await addUser(db, {
    name: 'Not a member', phone: '+254711111111',
  })));
  assertError(await client(handle, null)(`/groups/${groupId}`), 401, 'invalid_credentials');
  assertError(await calls[1](`/groups/${groupId}/cycles`, post()), 403, 'forbidden');
  assertError(await calls[1](`/groups/${groupId}/members/${memberIds[2]}/verify`, post()), 403, 'forbidden');
  assertError(await calls[1]('/wallet/withdraw', post({ amountMinor: 1000, phone: f.users[1].phone })), 403, 'identity_required');
  db.table('users').find((row) => row.id === f.users[1].id).identity_status = 'verified';
  assertError(await calls[1]('/wallet/withdraw', post({ amountMinor: 1000, phone: f.users[1].phone })), 403, 'kyc_required');
  assertError(await close(outsiders, groupId, cycleId), 403, 'forbidden');
  assertError(await calls[1](`/groups/${groupId}/cycles/${cycleId}/bids`, post({
    discountBps: 800, isPass: false, idempotencyKey: crypto.randomUUID(),
  })), 404, 'not_found');

  const seen = [];
  for (let turn = 1; turn <= 5; turn += 1) {
    const cycle = () => db.table('cycles').find((row) => row.id === cycleId);
    const contributions = db.table('contributions').filter((row) => row.cycle_id === cycleId);
    assert.equal(contributions.length, 5, 'winning never removes a contribution obligation');
    assert.ok(contributions.every((row) => row.status === 'pending' && row.amount_minor === 20000));
    const winners = new Set(seen);
    assert.equal(cycle().status, 'contributing');

    // A turn never settles while a previous winner still owes their contribution.
    for (let index = 0; index < 5; index += 1) {
      if (winners.has(memberIds[index])) continue;
      await pay(index, cycleId, turn === 1 && index === 0);
    }
    if (winners.size) {
      assert.equal(cycle().status, 'contributing', 'unpaid previous winners keep the pot incomplete');
      assert.equal(cycle().pot_captured_minor, (5 - winners.size) * 20000);
      assertError(await close(calls[0], groupId, cycleId), 409, 'cycle_not_funded');
    }
    for (let index = 0; index < 5; index += 1) {
      if (!winners.has(memberIds[index])) continue;
      await pay(index, cycleId);
    }

    // The final contribution settles inline; nothing waits for a clock.
    assert.equal(cycle().status, 'settled');
    const settlement = db.table('settlements').find((row) => row.cycle_id === cycleId);
    assert.equal(settlement.winner_membership_id, memberIds[turn - 1], `turn ${turn} belongs to seat ${turn}`);
    assert.equal(settlement.discount_bps, SEAT_LADDER[turn - 1]);
    assert.equal(settlement.is_final, turn === 5);
    if (turn < 5) assert.ok(settlement.bond_hold_minor > 0, 'every seat except the last posts a bond');
    seen.push(settlement.winner_membership_id);
    assert.equal(db.table('memberships').filter((row) => row.group_id === groupId && row.has_won).length, turn);

    const ledgerCount = db.table('ledger').length;
    assertStatus(await close(calls[0], groupId, cycleId), 200, 'settlement retry is idempotent');
    assert.equal(db.table('settlements').length, turn);
    assert.equal(db.table('ledger').length, ledgerCount);

    if (turn < 5) {
      const next = await calls[0](`/groups/${groupId}/cycles`, post());
      assertStatus(next, 200);
      cycleId = next.data.cycleId;
    } else {
      assert.equal(settlement.discount_minor, 0);
      assert.equal(settlement.bond_target_minor, 0);
      assert.equal(settlement.bond_hold_minor, 0);
      assert.equal(settlement.waiter_count, 0);
      assert.equal(db.table('bonds').some((row) => row.settlement_id === settlement.id), false);
      assert.equal(db.table('ledger').some((row) => row.ref === `bond_hold:${settlement.id}`), false);
    }
  }
  assert.deepEqual(seen, memberIds, 'every membership took exactly one turn, in seat order');
  assert.equal(db.table('contributions').filter((row) => row.status === 'paid').length, 25);
  assert.equal(db.table('ledger').filter((row) => row.kind === 'contribution').length, 25);
  assert.ok(db.table('bonds').every((row) => row.status === 'released' && row.held_minor === 0));
  const detail = await calls[0](`/groups/${groupId}`);
  assert.equal(detail.data.group.status, 'completed');
  assert.equal(detail.data.circle.status, 'completed');
  assertError(await calls[0](`/groups/${groupId}/cycles`, post()), 409, 'group_completed');
  assertError(await calls[0](`/groups/${groupId}/contributions`, post({ cycleId })), 409, 'contributions_closed');
});

test('a funded turn waits for its window unless the organizer or the seat holder closes it', async (t) => {
  const f = await circleFixture(t);
  // Fund the pot by reconcile-style writes so the inline auto-settle stays out
  // of the way and the funded window stays open.
  const cycle = f.db.table('cycles').find((row) => row.id === f.cycleId);
  for (const row of f.db.table('contributions').filter((item) => item.cycle_id === f.cycleId)) {
    row.status = 'paid';
  }
  cycle.pot_captured_minor = cycle.pot_expected_minor;
  cycle.status = 'funded';
  cycle.auction_opens_at = new Date().toISOString();
  cycle.auction_closes_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Member 3 holds seat 3, not the turn on the ladder.
  assertError(await close(f.calls[2], f.groupId, f.cycleId), 409, 'turn_window_open');
  assert.equal(cycle.status, 'funded', 'nothing moved for a member outside the seat');

  const seatHolder = f.db.table('memberships').find((row) => row.id === f.memberIds[0]);
  assert.equal(Number(seatHolder.seat_no), 1);
  assertStatus(await close(f.calls[0], f.groupId, f.cycleId), 200, 'the seat holder may take the turn');
  assert.equal(cycle.status, 'settled');
});

async function isolatedDevServer(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wheel-fairness-'));
  const portProbe = net.createServer();
  let child;
  t.after(async () => {
    if (portProbe.listening) await new Promise((resolve) => portProbe.close(resolve));
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true }); // Only this test's unique temporary directory.
  });
  const listening = once(portProbe, 'listening');
  portProbe.listen(0, '127.0.0.1');
  await listening;
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const origin = `http://localhost:${port}`;
  const base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [fileURLToPath(new URL('../dev/server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: String(port), PUBLIC_ORIGIN: origin, WHEEL_DB: path.join(directory, 'wheel.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Dev server did not start: ${output}`)), 15000);
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    child.on('error', finish);
    child.on('exit', (code) => finish(new Error(`Dev server exited (${code}): ${output}`)));
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes('SQLite ledger')) finish();
    });
  });

  async function request(route, { method = 'GET', body, session } = {}) {
    const headers = { origin };
    if (session) {
      headers.cookie = session.cookie;
      headers['x-csrf-token'] = session.csrf;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${base}${route}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
  }
  async function login(query) {
    const response = await request(`/dev/login?${new URLSearchParams(query)}`);
    assertStatus(response, 302);
    const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]);
    return { cookie: cookies.join('; '), csrf: cookies.find((value) => value.startsWith('wheel_csrf=')).slice('wheel_csrf='.length) };
  }
  const organizer = await login({ name: 'Fixture organizer', phone: '0799000002' });
  const api = (route, options = {}) => request(`/functions/v1/app${route}`, { session: organizer, ...options });
  const advance = (groupId, step) => request(`/dev/advance?${new URLSearchParams({ group: groupId, step })}`, post());
  const state = async () => (await request('/dev/state')).data;
  return { request, login, api, advance, state };
}

test('dev fixtures keep seats ordered and settle the moment the pot is whole', { timeout: 60000 }, async (t) => {
  const { request, login, api, advance, state } = await isolatedDevServer(t);
  async function create(maxMembers) {
    const created = await api('/groups', post({
      name: `Isolated ${maxMembers} seats`, contributionMinor: 20000, maxMembers, organizerFeeBps: 100,
    }));
    assertStatus(created, 201);
    return created.data.group.id;
  }
  async function advanceOk(groupId, step) {
    const result = await advance(groupId, step);
    assertStatus(result, 200, step);
    assert.equal(result.data.ok, true, JSON.stringify(result.data));
    return result.data;
  }

  const capacityGroup = await create(12);
  const organizerBefore = (await state()).users[0];
  for (let count = 2; count <= 12; count += 1) {
    const before = (await state()).memberships.filter((row) => row.group_id === capacityGroup);
    await advanceOk(capacityGroup, 'member');
    const after = (await state()).memberships.filter((row) => row.group_id === capacityGroup);
    assert.equal(after.length, count, 'each member action must actually add a seat');
    assert.equal(new Set(after.map((row) => row.user_id)).size, count);
    assert.ok(after.filter((row) => row.role !== 'organizer').every((row) => row.kyc_status === 'pending'));
    for (const member of before) assert.deepEqual(after.find((row) => row.id === member.id), member);
  }
  assert.equal((await advance(capacityGroup, 'member')).data.ok, false);
  const preserved = (await state()).memberships.filter((row) => row.group_id === capacityGroup);
  assert.deepEqual((await state()).users.find((row) => row.id === organizerBefore.id), organizerBefore);

  const groupId = await create(5);
  assertError(await advance(groupId, 'start'), 409, 'not_enough_members');
  assertError(await advance(groupId, 'unknown'), 400, 'invalid_step');
  for (let count = 2; count <= 5; count += 1) await advanceOk(groupId, 'member');
  await advanceOk(groupId, 'start');
  for (let turn = 1; turn <= 5; turn += 1) {
    if (turn > 1) await advanceOk(groupId, 'next');
    const funded = await advanceOk(groupId, 'fund');
    assert.match(funded.message, /paid its seat|final/i);
    let snapshot = await state();
    const cycle = snapshot.cycles.find((row) => row.group_id === groupId && row.number === turn);
    assert.equal(cycle.status, 'settled', 'funding a whole pot settles the turn immediately');
    const paid = snapshot.contributions.filter((row) => row.cycle_id === cycle.id && row.status === 'paid');
    assert.equal(paid.length, 5);
    assert.ok(paid.every((row) => row.amount_minor === 20000));
    const settlement = snapshot.settlements.find((row) => row.cycle_id === cycle.id);
    const owner = snapshot.memberships.find((row) => row.group_id === groupId && row.seat_no === turn);
    assert.equal(settlement.winner_membership_id, owner.id, `turn ${turn} pays seat ${turn}`);
    assert.equal(settlement.discount_bps, SEAT_LADDER[turn - 1]);
    if (turn === 5) {
      assert.equal(settlement.is_final, true);
      assert.equal(settlement.bond_hold_minor, 0);
      assert.equal(settlement.bond_target_minor, 0);
    }
    assert.equal(snapshot.bids.length, 0, 'no sealed bids exist anywhere');
    const replay = await advanceOk(groupId, 'settle');
    assert.match(replay.message, /already settled/i);
    snapshot = await state();
    assert.equal(snapshot.settlements.filter((row) => row.cycle_id === cycle.id).length, 1, 'a receipt is never rewritten');
    assert.equal(snapshot.groups.find((row) => row.id === groupId).status, turn === 5 ? 'completed' : 'active');
  }
  assertError(await advance(groupId, 'fund'), 409, 'group_completed');
  assertError(await advance(groupId, 'next'), 409, 'group_completed');
  assertError(await advance(groupId, 'start'), 409, 'group_completed');
  const snapshot = await state();
  assert.equal(snapshot.settlements.filter((row) => row.group_id === groupId).length, 5);
  assert.deepEqual(snapshot.memberships.filter((row) => row.group_id === capacityGroup), preserved, 'existing other-circle seats are untouched');
});
