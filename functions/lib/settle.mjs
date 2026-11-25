import { AppError } from './errors.mjs';
import { nowIso, one, rows } from './util.mjs';
import { insertFundEntry, insertLedger, fundBalance } from './ledger.mjs';
import { settlementMath, firstPayoutHoldMs, seatDiscountBps } from './rules.mjs';
import { assertCurrentCycle } from './funding.mjs';

export async function settleCycle(db, { group, circle, cycle, members, now = Date.now() }) {
  if (!group || !circle || !cycle) throw new AppError('cycle_not_found', 404);
  cycle = one(await db.from('cycles').select('*').eq('id', cycle.id).limit(1));
  if (!cycle || cycle.circle_id !== circle.id || cycle.group_id !== group.id) throw new AppError('cycle_not_found', 404);
  const existing = one(await db.from('settlements').select('*').eq('cycle_id', cycle.id).limit(1));
  // Terminal receipts are read-only, especially after a later round resets winners.
  if (existing && cycle.status === 'settled') return { settlement: existing, recovered: true };
  await assertCurrentCycle(db, cycle);
  if (existing) return finalizeSettlement(db, { group, circle, cycle, members, settlement: existing, now, recovered: true });
  if (cycle.status === 'settled') throw new AppError('cycle_settled', 409, 'That turn is already settled.');
  if (cycle.status !== 'funded' && cycle.status !== 'settling') {
    throw new AppError('cycle_not_funded', 409, 'The pot is not whole yet. The turn pays out the moment every member has funded it.');
  }
  if (Number(cycle.pot_captured_minor) < Number(cycle.pot_expected_minor)) {
    throw new AppError('pot_incomplete', 409, 'The captured pot is short of the expected pot.');
  }
  if (cycle.status === 'funded') {
    const claimed = rows(await db.from('cycles').update({ status: 'settling' })
      .eq('id', cycle.id).eq('status', 'funded').select('id'));
    if (!claimed.length) {
      const current = one(await db.from('cycles').select('*').eq('id', cycle.id).limit(1));
      if (!current || !['settling', 'settled'].includes(current.status)) {
        throw new AppError('cycle_not_funded', 409, 'The turn could not be claimed for settlement.');
      }
      if (current.status === 'settled') {
        const settled = one(await db.from('settlements').select('*').eq('cycle_id', cycle.id).limit(1));
        if (settled) return { settlement: settled, recovered: true };
      }
      cycle = current;
    }
  }
  const active = members.filter((member) => member.status === 'active');
  const eligible = active.filter((member) => !member.has_won);
  if (!eligible.length) throw new AppError('no_eligible_members', 409, 'Every member has already taken the pot.');
  const memberById = new Map(active.map((member) => [member.id, member]));
  let winner;
  let discountBps;
  let isFinal = Boolean(cycle.is_final);
  if (isFinal) {
    if (eligible.length > 1) {
      throw new AppError('invalid_state', 409, 'This final turn has more than one member waiting. The roster needs review.');
    }
    winner = eligible[0];
    discountBps = 0;
  } else if (eligible.length === 1) {
    winner = eligible[0];
    discountBps = 0;
    isFinal = true;
  } else {
    const pot = Number(cycle.pot_captured_minor);
    const seat = Number(cycle.number);
    winner = eligible.find((member) => Number(member.seat_no) === seat)
      || eligible.slice().sort((a, b) => Number(a.seat_no) - Number(b.seat_no))[0];
    discountBps = seatDiscountBps(Number(circle.turns_total) || eligible.length + 1, Number(winner.seat_no), pot);
  }
  if (!winner) throw new AppError('no_eligible_members', 409);
  const waiterCount = isFinal ? 0 : Math.max(0, eligible.length - 1);
  const math = settlementMath({
    potMinor: cycle.pot_captured_minor,
    discountBps,
    organizerWins: winner.role === 'organizer',
    organizerFeeBps: group.organizer_fee_bps,
    winnerTrust: winner.trust_score,
    waiterCount,
    isFinal,
  });
  const prior = one(await db.from('settlements').select('id').eq('group_id', group.id).limit(1));
  const createdAt = nowIso(now);
  const holdMs = firstPayoutHoldMs(!prior);
  const releaseAt = new Date(now + holdMs).toISOString();
  const row = {
    id: crypto.randomUUID(),
    cycle_id: cycle.id,
    group_id: group.id,
    winner_membership_id: winner.id,
    pot_minor: math.potMinor,
    discount_bps: math.discountBps,
    discount_minor: math.discountMinor,
    platform_fee_minor: math.platformFeeMinor,
    organizer_fee_minor: math.organizerFeeMinor,
    organizer_waived_minor: math.organizerWaivedMinor,
    fund_fee_minor: math.fundFeeMinor,
    bond_target_minor: math.bondTargetMinor,
    bond_hold_minor: math.bondHoldMinor,
    winner_net_minor: math.winnerNetMinor,
    waiter_count: math.waiterCount,
    waiter_share_minor: math.waiterShareMinor,
    remainder_minor: math.remainderMinor,
    is_final: math.isFinal,
    status: holdMs > 0 ? 'held' : 'released',
    release_at: releaseAt,
    released_at: null,
    created_at: createdAt,
  };
  const inserted = rows(await db.from('settlements').insertIfAbsent(row, { onConflict: 'cycle_id' }).select('*'));
  let settlement = inserted[0];
  if (!settlement) {
    settlement = one(await db.from('settlements').select('*').eq('cycle_id', cycle.id).limit(1));
    if (!settlement) throw new AppError('write_conflict', 409, 'The settlement could not be recorded. Try again.');
  }
  return finalizeSettlement(db, { group, circle, cycle, members: active, settlement, now, recovered: false });
}

async function finalizeSettlement(db, { group, circle, cycle, members, settlement, now, recovered }) {
  const fresh = one(await db.from('cycles').select('status').eq('id', cycle.id).limit(1));
  if (fresh?.status === 'settled') return { settlement, recovered: true };
  await assertCurrentCycle(db, cycle);
  const active = members.filter((member) => member.status === 'active');
  const memberById = new Map(active.map((member) => [member.id, member]));
  const winner = memberById.get(settlement.winner_membership_id);
  if (!winner) throw new AppError('invalid_state', 409);
  const createdAt = settlement.created_at || nowIso(now);
  await insertLedger(db, {
    ref: `winner:${settlement.id}`,
    groupId: group.id,
    cycleId: cycle.id,
    userId: winner.user_id,
    membershipId: winner.id,
    kind: 'winner',
    amountMinor: settlement.winner_net_minor,
    walletEffect: settlement.winner_net_minor,
    availableAt: settlement.release_at,
    memo: `${winner.display_name} took turn ${cycle.number} at ${(Number(settlement.discount_bps) / 100).toFixed(2)}%`,
    createdAt,
  });
  if (!settlement.is_final && Number(settlement.waiter_share_minor) > 0) {
    for (const member of active) {
      if (member.id === winner.id || member.has_won) continue;
      await insertLedger(db, {
        ref: `share:${settlement.id}:${member.id}`,
        groupId: group.id,
        cycleId: cycle.id,
        userId: member.user_id,
        membershipId: member.id,
        kind: 'discount',
        amountMinor: settlement.waiter_share_minor,
        walletEffect: settlement.waiter_share_minor,
        availableAt: createdAt,
        memo: `Patience share · turn ${cycle.number}`,
        createdAt,
      });
    }
  }
  if (Number(settlement.platform_fee_minor) > 0) {
    await insertLedger(db, {
      ref: `platform:${settlement.id}`,
      groupId: group.id,
      cycleId: cycle.id,
      kind: 'platform_fee',
      amountMinor: settlement.platform_fee_minor,
      walletEffect: 0,
      availableAt: createdAt,
      memo: `Platform fee · turn ${cycle.number}`,
      createdAt,
    });
  }
  const organizer = active.find((member) => member.role === 'organizer');
  if (organizer && Number(settlement.organizer_fee_minor) > 0) {
    await insertLedger(db, {
      ref: `organizer:${settlement.id}`,
      groupId: group.id,
      cycleId: cycle.id,
      userId: organizer.user_id,
      membershipId: organizer.id,
      kind: 'organizer_fee',
      amountMinor: settlement.organizer_fee_minor,
      walletEffect: settlement.organizer_fee_minor,
      availableAt: createdAt,
      memo: `Organizer fee · turn ${cycle.number}`,
      createdAt,
    });
  }
  if (Number(settlement.fund_fee_minor) > 0) {
    await insertFundEntry(db, {
      ref: `fund:${settlement.id}`,
      groupId: group.id,
      cycleId: cycle.id,
      kind: 'fund_fee',
      amountMinor: settlement.fund_fee_minor,
      memo: `Guarantee fund · turn ${cycle.number}`,
      createdAt,
    });
  }
  if (Number(settlement.organizer_waived_minor) > 0) {
    await insertFundEntry(db, {
      ref: `waived:${settlement.id}`,
      groupId: group.id,
      cycleId: cycle.id,
      kind: 'organizer_waived',
      amountMinor: settlement.organizer_waived_minor,
      memo: `Organizer fee waived to fund · turn ${cycle.number}`,
      createdAt,
    });
  }
  if (Number(settlement.remainder_minor) > 0) {
    await insertFundEntry(db, {
      ref: `rounding:${settlement.id}`,
      groupId: group.id,
      cycleId: cycle.id,
      kind: 'rounding',
      amountMinor: settlement.remainder_minor,
      memo: `Discount rounding to fund · turn ${cycle.number}`,
      createdAt,
    });
  }
  if (Number(settlement.bond_hold_minor) > 0) {
    const remainingTurns = Math.max(1, Number(circle.turns_total) - Number(cycle.number));
    rows(await db.from('bonds').insertIfAbsent({
      id: crypto.randomUUID(),
      group_id: group.id,
      membership_id: winner.id,
      settlement_id: settlement.id,
      amount_minor: settlement.bond_target_minor,
      held_minor: settlement.bond_hold_minor,
      release_cycles_total: remainingTurns,
      release_cycles_done: 0,
      status: 'held',
      created_at: createdAt,
    }, { onConflict: 'settlement_id' }).select('id'));
    await insertLedger(db, {
      ref: `bond_hold:${settlement.id}`,
      groupId: group.id,
      cycleId: cycle.id,
      userId: winner.user_id,
      membershipId: winner.id,
      kind: 'bond_hold',
      amountMinor: settlement.bond_hold_minor,
      walletEffect: 0,
      availableAt: settlement.release_at,
      memo: `Bond held · turn ${cycle.number}`,
      createdAt,
    });
  }
  rows(await db.from('memberships').update({ has_won: true }).eq('id', winner.id).select('id'));
  // Mark the cycle terminal only after all effects, including round completion.
  // A partial write can then resume; a terminal receipt never needs replay.
  if (settlement.is_final) {
    await completeCircle(db, { group, circle, cycle, members: active, now });
  }
  rows(await db.from('cycles').update({
    status: 'settled',
    winner_membership_id: winner.id,
    winning_discount_bps: settlement.discount_bps,
    settled_at: createdAt,
    is_final: settlement.is_final,
  }).eq('id', cycle.id).select('id'));
  return { settlement, recovered: Boolean(recovered) };
}

async function completeCircle(db, { group, circle, cycle, members, now }) {
  const splitRef = `split:${circle.id}`;
  const alreadySplit = one(await db.from('fund_entries').select('id').eq('ref', splitRef).limit(1));
  if (!alreadySplit) {
    const perfect = members.filter((member) => Number(member.defaults) === 0 && Number(member.late_cycles) === 0);
    if (perfect.length) {
      const balance = await fundBalance(db, group.id);
      const share = Math.floor(balance / perfect.length);
      if (share > 0) {
        const createdAt = nowIso(now);
        for (const member of perfect) {
          await insertLedger(db, {
            ref: `fund_split:${circle.id}:${member.id}`,
            groupId: group.id,
            cycleId: null,
            userId: member.user_id,
            membershipId: member.id,
            kind: 'fund_split',
            amountMinor: share,
            walletEffect: share,
            availableAt: createdAt,
            memo: `Unused guarantee fund · perfect record`,
            createdAt,
          });
        }
        await insertFundEntry(db, {
          ref: splitRef,
          groupId: group.id,
          cycleId: null,
          kind: 'fund_split',
          amountMinor: -share * perfect.length,
          memo: `Fund split to ${perfect.length} perfect-record members`,
          createdAt,
        });
      }
    }
  }
  const completedAt = nowIso(now);
  rows(await db.from('circles').update({ status: 'completed', completed_at: completedAt })
    .eq('id', circle.id).select('id'));
  rows(await db.from('groups').update({ status: 'completed', completed_at: completedAt })
    .eq('id', group.id).select('id'));
}
