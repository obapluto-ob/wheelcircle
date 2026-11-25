import { AppError } from './errors.mjs';
import { nowIso, one, rows, trimText } from './util.mjs';

export const SWAP_TTL_MS = 48 * 60 * 60 * 1000;
const LIVE = 'pending';

function swapShape(swap, { fromName, toName }) {
  return {
    id: swap.id,
    fromMembershipId: swap.from_membership_id,
    fromName: fromName || null,
    fromSeat: Number(swap.from_seat),
    toMembershipId: swap.to_membership_id,
    toName: toName || null,
    toSeat: Number(swap.to_seat),
    note: swap.note || '',
    createdAt: swap.created_at,
    expiresAt: swap.expires_at,
  };
}

export async function expireStaleSwaps(db, groupId, now = Date.now()) {
  const pending = rows(await db.from('seat_swaps').select('*')
    .eq('group_id', groupId).eq('status', LIVE).limit(200));
  let expired = 0;
  for (const swap of pending) {
    if (Date.parse(swap.expires_at) > now) continue;
    rows(await db.from('seat_swaps').update({ status: 'expired', resolved_at: nowIso(now) })
      .eq('id', swap.id).eq('status', LIVE).select('id'));
    expired += 1;
  }
  return expired;
}

export async function swapSummary(db, { group, membership, members, now = Date.now() }) {
  await expireStaleSwaps(db, group.id, now);
  const active = (members || []).filter((member) => member.status === 'active');
  const open = group.status === 'forming' && active.length >= 2;
  const reason = open ? null
    : group.status === 'forming'
      ? 'A swap needs at least two active seats.'
      : 'Seats lock when the round starts. Swaps open again when the next round forms.';
  const byId = new Map(active.map((member) => [member.id, member]));
  const offers = rows(await db.from('seat_swaps').select('*')
    .eq('group_id', group.id).eq('status', LIVE).limit(100));
  const incoming = [];
  const outgoing = [];
  for (const swap of offers) {
    const from = byId.get(swap.from_membership_id);
    const to = byId.get(swap.to_membership_id);
    if (!from || !to) continue;
    const shaped = swapShape(swap, { fromName: from.display_name, toName: to.display_name });
    if (to.id === membership.id) incoming.push(shaped);
    else if (from.id === membership.id) outgoing.push(shaped);
  }
  return { open, reason, incoming, outgoing };
}

export async function createSeatSwap(db, { group, membership, targetMembershipId, note = '', now = Date.now() }) {
  if (group.status !== 'forming') {
    throw new AppError('seats_locked', 409, 'Seats lock when the round starts. Swaps only work while the circle is forming.');
  }
  await expireStaleSwaps(db, group.id, now);
  const target = one(await db.from('memberships').select('*')
    .eq('id', targetMembershipId).eq('group_id', group.id).limit(1));
  if (!target || target.status !== 'active') {
    throw new AppError('member_not_found', 404, 'That member does not hold an active seat in this circle.');
  }
  if (target.id === membership.id) {
    throw new AppError('invalid_swap', 400, 'Pick another seat. A swap needs two different members.');
  }
  const offers = rows(await db.from('seat_swaps').select('*')
    .eq('group_id', group.id).eq('status', LIVE).limit(100));
  if (offers.some((swap) => swap.from_membership_id === membership.id)) {
    throw new AppError('swap_pending', 409, 'You already have a swap waiting on an answer. Cancel it before offering another.');
  }
  const activeSeats = rows(await db.from('memberships').select('id').eq('group_id', group.id).eq('status', 'active').limit(24));
  const limit = Math.max(3, activeSeats.length * 2);
  if (offers.length >= limit) {
    throw new AppError('swap_limit', 409, 'Too many swap offers are open in this circle. Let some resolve first.');
  }
  const swap = {
    id: crypto.randomUUID(),
    group_id: group.id,
    from_membership_id: membership.id,
    to_membership_id: target.id,
    from_seat: Number(membership.seat_no),
    to_seat: Number(target.seat_no),
    status: LIVE,
    note: trimText(note, 160),
    created_at: nowIso(now),
    expires_at: new Date(now + SWAP_TTL_MS).toISOString(),
    resolved_at: null,
    resolved_by_membership_id: null,
  };
  const inserted = rows(await db.from('seat_swaps').insertIfAbsent(swap, { onConflict: 'id' }).select('*'));
  return swapShape(inserted[0] || swap, { fromName: membership.display_name, toName: target.display_name });
}

async function moveSeats(db, from, to) {
  const fromSeat = Number(from.seat_no);
  const toSeat = Number(to.seat_no);
  const aside = rows(await db.from('memberships').update({ seat_no: 0 })
    .eq('id', from.id).eq('seat_no', fromSeat).eq('status', 'active').select('id'));
  if (!aside.length) throw new AppError('stale_swap', 409, 'A seat changed while the offer was open. Refresh and offer the swap again.');
  const moved = rows(await db.from('memberships').update({ seat_no: fromSeat })
    .eq('id', to.id).eq('seat_no', toSeat).eq('status', 'active').select('id'));
  if (!moved.length) {
    await db.from('memberships').update({ seat_no: fromSeat }).eq('id', from.id).eq('seat_no', 0);
    throw new AppError('stale_swap', 409, 'A seat changed while the offer was open. Refresh and offer the swap again.');
  }
  const placed = rows(await db.from('memberships').update({ seat_no: toSeat })
    .eq('id', from.id).eq('seat_no', 0).select('id'));
  if (!placed.length) {
    await db.from('memberships').update({ seat_no: toSeat }).eq('id', to.id).eq('seat_no', fromSeat);
    await db.from('memberships').update({ seat_no: fromSeat }).eq('id', from.id).eq('seat_no', 0);
    throw new AppError('stale_swap', 409, 'A seat changed while the offer was open. Refresh and offer the swap again.');
  }
  return { fromSeat, toSeat };
}

export async function respondSeatSwap(db, { group, membership, swapId, action, now = Date.now() }) {
  const swap = one(await db.from('seat_swaps').select('*')
    .eq('id', swapId).eq('group_id', group.id).limit(1));
  if (!swap) throw new AppError('swap_not_found', 404, 'That swap offer is not here. Refresh the circle.');
  if (swap.status !== LIVE) throw new AppError('swap_closed', 409, 'That swap is already settled.');
  if (Date.parse(swap.expires_at) <= now) {
    rows(await db.from('seat_swaps').update({ status: 'expired', resolved_at: nowIso(now) })
      .eq('id', swap.id).eq('status', LIVE).select('id'));
    throw new AppError('swap_expired', 409, 'That offer expired after 48 hours. Ask again with a fresh offer.');
  }
  const isTarget = swap.to_membership_id === membership.id;
  const isSender = swap.from_membership_id === membership.id;
  if ((action === 'accept' || action === 'decline') && !isTarget) {
    throw new AppError('forbidden', 403, 'Only the member who was asked can answer this swap.');
  }
  if (action === 'cancel' && !isSender) {
    throw new AppError('forbidden', 403, 'Only the member who offered the swap can cancel it.');
  }
  if (!['accept', 'decline', 'cancel'].includes(action)) {
    throw new AppError('invalid_input', 400, 'Answer the offer with accept, decline, or cancel.');
  }
  if (action !== 'accept') {
    const claimed = rows(await db.from('seat_swaps').update({
      status: action === 'decline' ? 'declined' : 'cancelled',
      resolved_at: nowIso(now),
      resolved_by_membership_id: membership.id,
    }).eq('id', swap.id).eq('status', LIVE).select('id'));
    if (!claimed.length) throw new AppError('swap_closed', 409, 'That swap was already settled.');
    return { ok: true, status: action === 'decline' ? 'declined' : 'cancelled' };
  }
  if (group.status !== 'forming') {
    throw new AppError('seats_locked', 409, 'The round started. Seats lock at the start and swaps reopen with the next round.');
  }
  const from = one(await db.from('memberships').select('*').eq('id', swap.from_membership_id).limit(1));
  const to = one(await db.from('memberships').select('*').eq('id', swap.to_membership_id).limit(1));
  if (!from || !to || from.status !== 'active' || to.status !== 'active') {
    throw new AppError('stale_swap', 409, 'One of the seats left the circle. This offer is closed.');
  }
  if (Number(from.seat_no) !== Number(swap.from_seat) || Number(to.seat_no) !== Number(swap.to_seat)) {
    rows(await db.from('seat_swaps').update({ status: 'stale', resolved_at: nowIso(now) })
      .eq('id', swap.id).eq('status', LIVE).select('id'));
    throw new AppError('stale_swap', 409, 'A seat changed while the offer was open. Refresh and offer the swap again.');
  }
  const seats = await moveSeats(db, from, to);
  const claimed = rows(await db.from('seat_swaps').update({
    status: 'accepted',
    resolved_at: nowIso(now),
    resolved_by_membership_id: membership.id,
  }).eq('id', swap.id).eq('status', LIVE).select('id'));
  if (!claimed.length) {
    await moveSeats(db, { ...from, seat_no: to.seat_no }, { ...to, seat_no: from.seat_no });
    throw new AppError('swap_closed', 409, 'That swap was already settled.');
  }
  // Any other live offer that touches these two seats no longer matches the board.
  const others = rows(await db.from('seat_swaps').select('id,from_membership_id,to_membership_id')
    .eq('group_id', group.id).eq('status', LIVE).limit(100));
  for (const other of others) {
    if (other.id === swap.id) continue;
    if (![from.id, to.id].includes(other.from_membership_id) && ![from.id, to.id].includes(other.to_membership_id)) continue;
    rows(await db.from('seat_swaps').update({ status: 'superseded', resolved_at: nowIso(now) })
      .eq('id', other.id).eq('status', LIVE).select('id'));
  }
  return {
    ok: true,
    status: 'accepted',
    mySeat: isSender ? seats.toSeat : seats.fromSeat,
    otherSeat: isSender ? seats.fromSeat : seats.toSeat,
  };
}
