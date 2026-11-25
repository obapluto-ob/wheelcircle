import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, addUser, signIn, client, assertStatus } from './helpers.mjs';

const CONTRIBUTION = 25000;

async function formingCircle(handle, db, { name = 'Swap Circle' } = {}) {
  const organizer = await addUser(db, { name: 'Swap Organizer', phone: '+254711000101' });
  const organizerCall = client(handle, await signIn(db, organizer));
  const created = await organizerCall('/groups', {
    method: 'POST',
    body: { name, contributionMinor: CONTRIBUTION, maxMembers: 6, organizerFeeBps: 100 },
  });
  assertStatus(created, 201, 'create private circle');
  const group = created.data.group;

  const joiners = [];
  for (let index = 0; index < 2; index += 1) {
    const user = await addUser(db, { name: `Joiner ${index + 1}`, phone: `+2547110002${index}` });
    const call = client(handle, await signIn(db, user));
    assertStatus(await call('/groups/join', { method: 'POST', body: { inviteCode: group.inviteCode } }), 201, `join ${index}`);
    joiners.push({ user, call });
  }
  const members = db.table('memberships').filter((row) => row.group_id === group.id && row.status === 'active');
  const byUser = (user) => members.find((row) => row.user_id === user.id);
  return { organizer, organizerCall, group, joiners, byUser };
}

test('a swap offer needs both members and moves only the seat numbers', async () => {
  const { db, handle } = await boot();
  const { organizer, organizerCall, group, joiners, byUser } = await formingCircle(handle, db);
  const walletBefore = (await organizerCall('/auth/me')).data.wallet.availableMinor;
  const ledgerBefore = db.table('ledger').length;

  assertStatus(await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(organizer).id },
  }), 400, 'no swapping with yourself');
  assertStatus(await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[0].user).id },
  }), 201, 'organizer offers a swap');

  const offered = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[0].user).id, note: 'Can we trade?' },
  });
  assertStatus(offered, 409, 'one live offer per member');
  assert.equal(offered.data.error, 'swap_pending');

  let targetView = (await joiners[0].call(`/groups/${group.id}`)).data;
  assert.equal(targetView.swaps.open, true);
  assert.equal(targetView.swaps.incoming.length, 1);
  assert.equal(targetView.swaps.incoming[0].fromSeat, 1);
  assert.equal(targetView.swaps.incoming[0].toSeat, 2);
  assert.equal(targetView.swaps.incoming[0].fromName, 'Swap Organizer');

  const organizerView = (await organizerCall(`/groups/${group.id}`)).data;
  assert.equal(organizerView.swaps.outgoing.length, 1);
  assert.equal(organizerView.swaps.incoming.length, 0);
  const untouched = (await joiners[1].call(`/groups/${group.id}`)).data;
  assert.equal(untouched.swaps.incoming.length, 0, 'other members do not see the offer');

  const swapId = targetView.swaps.incoming[0].id;
  assertStatus(await organizerCall(`/groups/${group.id}/seat-swaps/${swapId}`, {
    method: 'POST', body: { action: 'accept' },
  }), 403, 'the sender cannot accept their own offer');
  assertStatus(await joiners[1].call(`/groups/${group.id}/seat-swaps/${swapId}`, {
    method: 'POST', body: { action: 'accept' },
  }), 403, 'only the member asked can accept');

  const accepted = await joiners[0].call(`/groups/${group.id}/seat-swaps/${swapId}`, {
    method: 'POST', body: { action: 'accept' },
  });
  assertStatus(accepted, 200, 'the target accepts');
  assert.equal(accepted.data.status, 'accepted');
  assert.equal(byUser(organizer).seat_no, 2, 'organizer walks from seat 1 to seat 2');
  assert.equal(byUser(joiners[0].user).seat_no, 1, 'joiner takes seat 1');

  const detail = (await organizerCall(`/groups/${group.id}`)).data;
  assert.equal(detail.me.seat, 2);
  assert.equal(detail.swaps.incoming.length, 0);
  assert.equal(detail.swaps.outgoing.length, 0);
  const memberSeats = detail.members.map((member) => member.seat).sort();
  assert.deepEqual(memberSeats, [1, 2, 3], 'seats stay a clean ladder');
  const walletAfter = (await organizerCall('/auth/me')).data.wallet.availableMinor;
  assert.equal(walletAfter, walletBefore, 'a swap moves no money');
  assert.equal(db.table('ledger').length, ledgerBefore, 'no ledger rows are written');
  const audit = db.table('seat_swaps').find((row) => row.id === swapId);
  assert.equal(audit.status, 'accepted');
  assert.equal(audit.from_seat, 1);
  assert.equal(audit.to_seat, 2);
  assert.ok(audit.resolved_at, 'the deal is timestamped');

  assertStatus(await joiners[0].call(`/groups/${group.id}/seat-swaps/${swapId}`, {
    method: 'POST', body: { action: 'accept' },
  }), 409, 'the same offer cannot pay out twice');
});

test('decline, cancel, expiry, and stale seats close a swap safely', async () => {
  const { db, handle } = await boot();
  const { organizer, organizerCall, group, joiners, byUser } = await formingCircle(handle, db, { name: 'Swap Rules' });

  const first = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[0].user).id },
  });
  assertStatus(first, 201, 'offer one');
  assertStatus(await joiners[0].call(`/groups/${group.id}/seat-swaps/${first.data.swap.id}`, {
    method: 'POST', body: { action: 'cancel' },
  }), 403, 'the target cannot cancel on the sender');
  assertStatus(await joiners[0].call(`/groups/${group.id}/seat-swaps/${first.data.swap.id}`, {
    method: 'POST', body: { action: 'decline' },
  }), 200, 'the target declines');
  assert.equal(db.table('seat_swaps').find((row) => row.id === first.data.swap.id).status, 'declined');

  const second = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[1].user).id },
  });
  assertStatus(second, 201, 'offer two');
  assertStatus(await organizerCall(`/groups/${group.id}/seat-swaps/${second.data.swap.id}`, {
    method: 'POST', body: { action: 'cancel' },
  }), 200, 'the sender can withdraw');
  assert.equal(db.table('seat_swaps').find((row) => row.id === second.data.swap.id).status, 'cancelled');

  const third = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[0].user).id },
  });
  assertStatus(third, 201, 'offer three');
  db.table('seat_swaps').find((row) => row.id === third.data.swap.id).expires_at = new Date(Date.now() - 1000).toISOString();
  const expired = await joiners[0].call(`/groups/${group.id}/seat-swaps/${third.data.swap.id}`, {
    method: 'POST', body: { action: 'accept' },
  });
  assertStatus(expired, 409, 'an offer dies after 48 hours');
  assert.equal(expired.data.error, 'swap_expired');
  assert.equal(db.table('seat_swaps').find((row) => row.id === third.data.swap.id).status, 'expired');

  const fourth = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[0].user).id },
  });
  assertStatus(fourth, 201, 'offer four');
  byUser(joiners[0].user).seat_no = 5;
  const stale = await joiners[0].call(`/groups/${group.id}/seat-swaps/${fourth.data.swap.id}`, {
    method: 'POST', body: { action: 'accept' },
  });
  assertStatus(stale, 409, 'a seat that moved invalidates the deal');
  assert.equal(stale.data.error, 'stale_swap');
  assert.equal(byUser(organizer).seat_no, 1, 'the stale accept moved nothing');

  const fifth = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[1].user).id },
  });
  assertStatus(fifth, 201, 'offer five');
  db.table('groups').find((row) => row.id === group.id).status = 'active';
  const locked = await joiners[1].call(`/groups/${group.id}/seat-swaps/${fifth.data.swap.id}`, {
    method: 'POST', body: { action: 'accept' },
  });
  assertStatus(locked, 409, 'seats lock at the start');
  assert.equal(locked.data.error, 'seats_locked');
  assertStatus(await organizerCall(`/groups/${group.id}/seat-swaps/${fifth.data.swap.id}`, {
    method: 'POST', body: { action: 'cancel' },
  }), 200, 'the sender can still withdraw a dead offer');
  const afterStart = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[1].user).id },
  });
  assertStatus(afterStart, 409, 'new offers wait for the next forming round');
  assert.equal(afterStart.data.error, 'seats_locked');
  db.table('groups').find((row) => row.id === group.id).status = 'forming';
  const reopened = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[1].user).id },
  });
  assertStatus(reopened, 201, 'a forming circle takes offers again');
});

test('an accepted swap supersedes other offers touching the same seats', async () => {
  const { db, handle } = await boot();
  const { organizerCall, group, joiners, byUser } = await formingCircle(handle, db, { name: 'Swap Chain' });

  const a = await organizerCall(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[0].user).id },
  });
  const b = await joiners[0].call(`/groups/${group.id}/seat-swaps`, {
    method: 'POST', body: { targetMembershipId: byUser(joiners[1].user).id },
  });
  assertStatus(a, 201, 'offer A');
  assertStatus(b, 201, 'offer B');

  assertStatus(await joiners[0].call(`/groups/${group.id}/seat-swaps/${a.data.swap.id}`, {
    method: 'POST', body: { action: 'accept' },
  }), 200, 'A completes first');
  const superseded = db.table('seat_swaps').find((row) => row.id === b.data.swap.id);
  assert.equal(superseded.status, 'superseded', 'the joiner’s own offer is retired with the old seat');
  assert.equal(byUser(joiners[1].user).seat_no, 3, 'the third member never moved');
});
