import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boot, addUser, signIn, client, postWebhook, contributionFor, installPaysasaStub, assertStatus,
} from './helpers.mjs';
import { nowIso } from '../functions/lib/util.mjs';

test('a five-seat circle pays each seat in order, settles the moment the pot is whole, and completes', async () => {
  const { db, handle } = await boot();
  const users = [];
  const sessions = [];
  for (let index = 0; index < 5; index += 1) {
    users.push(await addUser(db, { name: `Member ${index + 1}`, phone: `+25470000000${index + 1}` }));
    sessions.push(await signIn(db, users[index]));
  }
  const calls = sessions.map((session) => client(handle, session));
  const outsiderSession = await signIn(db, await addUser(db, { name: 'Outsider', phone: '+254711111111' }));
  const outsider = client(handle, outsiderSession);

  assertStatus(await calls[0]('/config'), 200, 'config');

  const created = await calls[0]('/groups', {
    method: 'POST',
    body: { name: 'Mwangaza Circle', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100 },
  });
  assertStatus(created, 201, 'create group');
  const gid = created.data.group.id;
  const inviteCode = created.data.group.inviteCode;

  assertStatus(await calls[0]('/groups', {
    method: 'POST',
    body: { name: 'X', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100 },
    includeCsrf: false,
  }), 403, 'csrf required');
  assertStatus(await calls[0]('/groups', {
    method: 'POST',
    body: { name: 'X', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100 },
    origin: 'https://evil.example',
  }), 403, 'origin required');

  for (let index = 1; index < 5; index += 1) {
    assertStatus(await calls[index]('/groups/join', { method: 'POST', body: { inviteCode } }), 201, `join ${index}`);
  }
  assertStatus(await outsider(`/groups/${gid}`), 403, 'outsider cannot see the circle');
  assertStatus(await calls[1](`/groups/${gid}/start`, { method: 'POST', body: {} }), 403, 'only organizer starts');
  assertStatus(await client(handle, null)(`/groups/${gid}`), 401, 'session required');

  assertStatus(await calls[0](`/groups/${gid}/start`, { method: 'POST', body: {} }), 409, 'start waits for every acceptance');
  for (const [index, call] of calls.entries()) {
    assertStatus(await call(`/groups/${gid}/round/accept`, { method: 'POST', body: { roundNumber: 1 } }), 200, `accept ${index}`);
  }
  assertStatus(await calls[0](`/groups/${gid}/start`, { method: 'POST', body: {} }), 200, 'start');
  let detail = (await calls[0](`/groups/${gid}`)).data;
  assert.equal(detail.group.status, 'active');
  assert.equal(detail.cycle.status, 'contributing');
  assert.equal(detail.cycle.potExpectedMinor, 100000);
  assert.equal(detail.cycle.turnOwner.name, 'Member 1', 'turn one belongs to seat one');
  assert.deepEqual(detail.group.seatLadderBps, [1000, 600, 500, 500, 0]);
  const members = Object.fromEntries(detail.members.map((member) => [member.userId, member.id]));
  let cycleId = detail.cycle.id;

  // The auction is retired: there is no bid endpoint to call.
  assertStatus(
    await calls[1](`/groups/${gid}/cycles/${cycleId}/bids`, {
      method: 'POST',
      body: { discountBps: 800, isPass: false, idempotencyKey: crypto.randomUUID() },
    }),
    404,
    'sealed bidding is gone',
  );

  const stub = installPaysasaStub();
  let firstPayment = true;
  try {
    async function payAll(cycle) {
      for (let index = 0; index < 5; index += 1) {
        const checkout = await calls[index](`/groups/${gid}/contributions`, {
          method: 'POST',
          body: { cycleId: cycle },
        });
        assertStatus(checkout, 200, `checkout ${index}`);
        assert.match(checkout.data.checkoutUrl, /^https:\/\//);
        const contribution = contributionFor(db, cycle, members[users[index].id]);
        assert.ok(contribution?.provider_ref, 'checkout reference saved');
        const event = {
          event: 'checkout.paid',
          created_at: nowIso(),
          data: {
            session_id: contribution.provider_ref,
            reference: `pay_${cycle}_${index}`,
            amount: contribution.amount_minor,
            currency: 'KES',
            payment_method: 'm_pesa',
            metadata: {
              contribution_id: contribution.id,
              cycle_id: cycle,
              group_id: gid,
              user_id: users[index].id,
            },
          },
        };
        if (firstPayment) {
          assertStatus(await postWebhook(handle, event, { signature: 'deadbeef' }), 401, 'bad webhook signature');
          assert.equal(contributionFor(db, cycle, members[users[index].id]).status, 'pending');
        }
        const accepted = await postWebhook(handle, event);
        assertStatus(accepted, 200, `webhook ${index}`);
        assert.equal(accepted.data.received, true);
        if (firstPayment) {
          const duplicate = await postWebhook(handle, event);
          assertStatus(duplicate, 200, 'duplicate webhook');
          assert.equal(duplicate.data.duplicate, true);
          firstPayment = false;
        }
      }
    }

    // The final contribution settles the turn inline: no clock, no settle button.
    await payAll(cycleId);
    detail = (await calls[0](`/groups/${gid}`)).data;
    assert.equal(detail.cycle.status, 'settled');
    assert.equal(detail.cycle.potCapturedMinor, 100000);
    assert.ok(detail.settlement, 'the receipt exists the moment the pot is whole');

    const settlement = db.table('settlements').find((row) => row.cycle_id === cycleId);
    assert.equal(settlement.winner_membership_id, members[users[0].id], 'seat one holds turn one');
    assert.equal(settlement.discount_bps, 1000);
    assert.equal(settlement.pot_minor, 100000);
    assert.equal(settlement.discount_minor, 10000);
    assert.equal(settlement.waiter_count, 4);
    assert.equal(settlement.waiter_share_minor, 2500);
    assert.equal(settlement.platform_fee_minor, 1000);
    assert.equal(settlement.organizer_fee_minor, 0);
    assert.equal(settlement.organizer_waived_minor, 1000);
    assert.equal(settlement.fund_fee_minor, 1000);
    assert.equal(settlement.bond_target_minor, 20000);
    assert.equal(settlement.bond_hold_minor, 20000);
    assert.equal(settlement.winner_net_minor, 67000);
    assert.equal(settlement.status, 'held');
    assert.ok(Date.parse(settlement.release_at) > Date.now() + 47 * 60 * 60 * 1000);

    const winnerEntry = db.table('ledger').find((row) => row.ref === `winner:${settlement.id}`);
    assert.equal(winnerEntry.wallet_effect, 67000);
    assert.equal(winnerEntry.user_id, users[0].id);
    const shares = db.table('ledger').filter((row) => row.ref.startsWith(`share:${settlement.id}:`));
    assert.equal(shares.length, 4);
    for (const share of shares) assert.equal(share.wallet_effect, 2500);
    assert.equal(db.table('ledger').find((row) => row.ref === `bond_hold:${settlement.id}`).wallet_effect, 0);
    const bond = db.table('bonds').find((row) => row.membership_id === members[users[0].id]);
    assert.equal(bond.held_minor, 20000);
    assert.equal(bond.release_cycles_total, 4);
    assert.equal(bond.status, 'held');

    const winnerView = (await calls[0](`/groups/${gid}`)).data;
    assert.equal(winnerView.wallet.availableMinor, 0);
    assert.equal(winnerView.wallet.pendingMinor, 67000);
    assert.equal(winnerView.settlement.iWon, true);
    const waiterView = (await calls[1](`/groups/${gid}`)).data;
    assert.equal(waiterView.wallet.availableMinor, 2500);
    assert.equal(waiterView.settlement.myShareMinor, 2500);
    assert.equal(waiterView.settlement.iWon, false);

    // A settled turn never waits for a schedule: the next seat opens immediately.
    const next = await calls[0](`/groups/${gid}/cycles`, { method: 'POST', body: {} });
    assertStatus(next, 200, 'open turn 2');
    cycleId = next.data.cycleId;
    assertStatus(await calls[0](`/groups/${gid}/cycles/${cycleId}/close`, { method: 'POST', body: {} }), 409, 'an unfunded pot never settles');

    await payAll(cycleId);
    assert.equal(db.table('bonds').find((row) => row.membership_id === members[users[0].id]).release_cycles_done, 1);
    assert.equal(db.table('bonds').find((row) => row.membership_id === members[users[0].id]).held_minor, 15000);
    const release = db.table('ledger').find((row) => row.kind === 'bond_release'
      && row.membership_id === members[users[0].id] && row.cycle_id === cycleId);
    assert.equal(release.wallet_effect, 5000);
    let turn = db.table('settlements').find((row) => row.cycle_id === cycleId);
    assert.equal(turn.winner_membership_id, members[users[1].id], 'seat two holds turn two');
    assert.equal(turn.discount_bps, 600);
    assert.equal(turn.waiter_share_minor, 2000);

    const kycMember = members[users[1].id];
    assertStatus(await calls[1]('/wallet/withdraw', {
      method: 'POST', body: { amountMinor: 1000, phone: users[1].phone },
    }), 403, 'identity before payout');
    db.table('users').find((row) => row.id === users[1].id).identity_status = 'verified';
    assertStatus(await calls[1]('/wallet/withdraw', {
      method: 'POST', body: { amountMinor: 1000, phone: users[1].phone },
    }), 403, 'kyc before payout');
    assertStatus(await calls[0](`/groups/${gid}/members/${kycMember}/verify`, { method: 'POST', body: {} }), 200, 'verify member');
    assert.equal(db.table('memberships').find((row) => row.id === kycMember).kyc_status, 'verified');
    assert.equal(db.table('memberships').find((row) => row.id === members[users[0].id]).kyc_status, 'verified', 'the organizer is verified at creation');
    const walletBefore = (await calls[1](`/groups/${gid}`)).data.wallet.availableMinor;
    const ledgerBefore = db.table('ledger').length;
    const withdrawal = await calls[1]('/wallet/withdraw', {
      method: 'POST', body: { amountMinor: 1000, phone: users[1].phone },
    });
    assertStatus(withdrawal, 503, 'unverified payout fees block withdrawal');
    assert.equal(withdrawal.data.error, 'payout_terms_unverified');
    assert.equal(db.table('payouts').length, 0, 'no payout row is reserved');
    assert.equal(db.table('ledger').length, ledgerBefore, 'no wallet debit is written');
    assert.equal((await calls[1](`/groups/${gid}`)).data.wallet.availableMinor, walletBefore);
    assert.equal((await calls[0]('/config')).data.withdrawalsConfigured, false);

    assertStatus(await calls[0](`/groups/${gid}/guarantees`, {
      method: 'POST', body: { membershipId: members[users[1].id], guarantorId: members[users[0].id] },
    }), 201, 'guarantee 1');
    assertStatus(await calls[0](`/groups/${gid}/guarantees`, {
      method: 'POST', body: { membershipId: members[users[2].id], guarantorId: members[users[0].id] },
    }), 201, 'guarantee 2');
    assertStatus(await calls[0](`/groups/${gid}/guarantees`, {
      method: 'POST', body: { membershipId: members[users[3].id], guarantorId: members[users[0].id] },
    }), 409, 'guarantor limit');
    assertStatus(await calls[0](`/groups/${gid}/guarantees`, {
      method: 'POST', body: { membershipId: members[users[0].id], guarantorId: members[users[1].id] },
    }), 409, 'guarantee cycle');
    assertStatus(await calls[1](`/groups/${gid}/disputes`, {
      method: 'POST', body: { reason: 'Turn two timing needs a review by the circle.', againstMembershipId: members[users[3].id], cycleId },
    }), 201, 'dispute');
    assert.equal(db.table('disputes').length, 1);

    for (let number = 3; number <= 5; number += 1) {
      const opened = await calls[0](`/groups/${gid}/cycles`, { method: 'POST', body: {} });
      assertStatus(opened, 200, `open turn ${number}`);
      cycleId = opened.data.cycleId;
      if (number === 5) {
        assertStatus(await calls[0](`/groups/${gid}/cycles/${cycleId}/close`, { method: 'POST', body: {} }), 409, 'an unfunded final pot never settles');
      }
      await payAll(cycleId);
    }

    const final = db.table('settlements').find((row) => row.cycle_id === cycleId);
    assert.equal(final.is_final, true);
    assert.equal(final.winner_membership_id, members[users[4].id]);
    assert.equal(final.discount_minor, 0);
    assert.equal(final.bond_hold_minor, 0);
    assert.equal(final.waiter_count, 0);
    assert.equal(final.organizer_fee_minor, 1000);
    assert.equal(final.organizer_waived_minor, 0);
    assert.equal(final.winner_net_minor, 97000);
    const completedView = (await calls[0](`/groups/${gid}`)).data;
    assert.equal(completedView.group.status, 'completed');
    assert.equal(completedView.circle.status, 'completed');
    assertStatus(await calls[0](`/groups/${gid}/cycles`, { method: 'POST', body: {} }), 409, 'circle closed');

    const split = db.table('ledger').filter((row) => row.kind === 'fund_split');
    assert.equal(split.length, 5);
    for (const entry of split) assert.equal(entry.wallet_effect, 1200);
    assert.equal(db.table('fund_entries').filter((row) => row.kind === 'fund_split').length, 1);
    assert.equal(db.table('bonds').find((row) => row.membership_id === members[users[3].id]).status, 'released');
    assert.equal(db.table('bonds').filter((row) => row.membership_id === members[users[4].id]).length, 0, 'the last seat posts no bond');
    assert.equal(db.table('settlements').length, 5);

    const recap = completedView.recap;
    assert.ok(recap, 'completed circles expose a recap');
    assert.equal(recap.turnsTotal, 5);
    assert.equal(recap.balanced, true, 'every pot allocates to the shilling');
    assert.deepEqual(recap.turns.map((turn) => turn.winnerName), [
      'Member 1', 'Member 2', 'Member 3', 'Member 4', 'Member 5',
    ]);
    assert.deepEqual(recap.turns.map((turn) => turn.discountBps), [1000, 600, 500, 500, 0]);
    assert.equal(recap.turns[0].waiterShareMinor, 2500);
    assert.equal(recap.turns[4].reason, 'final');
    assert.equal(recap.totals.potMinor, 500000);
    assert.equal(recap.totals.discountMinor, 26000);
    assert.equal(recap.totals.feesMinor, 15000);
    assert.equal(recap.totals.bondHeldMinor, 80000);
    assert.equal(recap.totals.bondReturnedMinor, 80000);
    assert.equal(recap.totals.winnerNetMinor, 379000);
    assert.equal(recap.members.length, 5);
    const recapWinner = recap.members.find((member) => member.id === members[users[0].id]);
    assert.equal(recapWinner.receivedTurn, 1);
    assert.equal(recapWinner.receivedMinor, 67000);
    assert.equal(recapWinner.bondReturnedMinor, 20000);
    assert.equal(recapWinner.fundSplitMinor, 1200);
    assert.equal(recap.me.receivedTurn, 1);
    assert.equal(recap.me.receivedMinor, 67000);
    assert.equal(recap.fundBalanceMinor, 0);

    const settlementsBefore = JSON.stringify(db.table('settlements'));
    assertStatus(await calls[0](`/groups/${gid}/rounds`, { method: 'POST', body: { previousCircleId: completedView.circle.id } }), 200, 'propose round 2');
    assertStatus(await calls[0](`/groups/${gid}/rounds`, { method: 'POST', body: { previousCircleId: completedView.circle.id } }), 200, 'propose retry is idempotent');
    assertStatus(await calls[1](`/groups/${gid}/rounds`, { method: 'POST', body: { previousCircleId: completedView.circle.id } }), 403, 'only organizer proposes');
    const lateUser = await addUser(db, { name: 'Late joiner', phone: '+254700000099' });
    const late = client(handle, await signIn(db, lateUser));
    assertStatus(await late('/groups/join', { method: 'POST', body: { inviteCode } }), 409, 'repeat rounds keep the roster');
    let round2 = (await calls[0](`/groups/${gid}`)).data;
    assert.equal(round2.round.number, 2);
    assert.equal(round2.round.forming, true);
    assert.equal(round2.round.acceptedCount, 0);
    assertStatus(await calls[0](`/groups/${gid}/start`, { method: 'POST', body: {} }), 409, 'round 2 needs fresh acceptance');
    assertStatus(await calls[2](`/groups/${gid}/round/accept`, { method: 'POST', body: { roundNumber: 1 } }), 409, 'stale round acceptance');
    for (const call of calls) assertStatus(await call(`/groups/${gid}/round/accept`, { method: 'POST', body: { roundNumber: 2 } }), 200, 'accept round 2');
    assertStatus(await calls[0](`/groups/${gid}/start`, { method: 'POST', body: {} }), 200, 'start round 2');
    round2 = (await calls[0](`/groups/${gid}`)).data;
    assert.equal(round2.circle.number, 2);
    assert.equal(round2.cycle.number, 1);
    assert.ok(round2.members.every((member) => member.hasWon === false), 'every member is eligible again');
    assert.equal(round2.cycle.turnOwner.name, 'Member 1', 'round two restarts at seat one');
    assertStatus(await calls[0](`/groups/${gid}/cycles/${cycleId}/close`, { method: 'POST', body: {} }), 200, 'old receipt replay');
    assert.equal(JSON.stringify(db.table('settlements')), settlementsBefore, 'old receipts are never rewritten');
  } finally {
    stub.restore();
  }
});
