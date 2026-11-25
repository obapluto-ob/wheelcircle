import { one, nowIso, rows, sum } from './util.mjs';

export async function insertLedger(db, {
  ref,
  groupId,
  cycleId = null,
  userId = null,
  membershipId = null,
  kind,
  amountMinor,
  walletEffect = 0,
  availableAt = nowIso(),
  memo = '',
  createdAt = nowIso(),
}) {
  const row = {
    id: crypto.randomUUID(),
    ref,
    group_id: groupId,
    cycle_id: cycleId,
    user_id: userId,
    membership_id: membershipId,
    kind,
    amount_minor: Math.round(Number(amountMinor) || 0),
    wallet_effect: Math.round(Number(walletEffect) || 0),
    available_at: availableAt,
    memo,
    created_at: createdAt,
  };
  const inserted = rows(await db.from('ledger').insertIfAbsent(row, { onConflict: 'ref' }).select('id'));
  if (inserted.length) return { inserted: true, row };
  const existing = one(await db.from('ledger').select('id,ref,amount_minor,wallet_effect,available_at').eq('ref', ref).limit(1));
  return { inserted: false, row: existing || row };
}

export async function insertFundEntry(db, {
  ref,
  groupId,
  cycleId = null,
  kind,
  amountMinor,
  memo = '',
  createdAt = nowIso(),
}) {
  const row = {
    id: crypto.randomUUID(),
    ref,
    group_id: groupId,
    cycle_id: cycleId,
    kind,
    amount_minor: Math.round(Number(amountMinor) || 0),
    memo,
    created_at: createdAt,
  };
  const inserted = rows(await db.from('fund_entries').insertIfAbsent(row, { onConflict: 'ref' }).select('id'));
  if (inserted.length) return { inserted: true, row };
  const existing = one(await db.from('fund_entries').select('id,ref,amount_minor').eq('ref', ref).limit(1));
  return { inserted: false, row: existing || row };
}

export async function groupFundEntries(db, groupId, limit = 300) {
  return rows(await db.from('fund_entries')
    .select('id,ref,group_id,cycle_id,kind,amount_minor,memo,created_at')
    .eq('group_id', groupId).order('created_at', { ascending: false }).limit(limit));
}

export async function fundBalance(db, groupId) {
  const entries = await groupFundEntries(db, groupId, 500);
  return sum(entries.map((entry) => entry.amount_minor));
}

export async function groupLedger(db, groupId, limit = 220) {
  return rows(await db.from('ledger')
    .select('id,ref,group_id,cycle_id,user_id,membership_id,kind,amount_minor,wallet_effect,available_at,memo,created_at')
    .eq('group_id', groupId).order('created_at', { ascending: false }).limit(limit));
}

export async function userLedger(db, userId, limit = 1000) {
  return rows(await db.from('ledger')
    .select('id,ref,group_id,cycle_id,user_id,membership_id,kind,amount_minor,wallet_effect,available_at,memo,created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit));
}

export async function cycleLedger(db, cycleId, limit = 200) {
  return rows(await db.from('ledger')
    .select('id,ref,group_id,cycle_id,user_id,membership_id,kind,amount_minor,wallet_effect,available_at,memo,created_at')
    .eq('cycle_id', cycleId).order('created_at', { ascending: false }).limit(limit));
}

export function walletSummary(entries, now = Date.now()) {
  let available = 0;
  let pending = 0;
  let discounts = 0;
  let contributions = 0;
  for (const entry of entries) {
    const effect = Number(entry.wallet_effect || 0);
    if (Date.parse(entry.available_at) <= now) available += effect;
    else pending += effect;
    if (entry.kind === 'discount' && effect > 0) discounts += effect;
    if (entry.kind === 'contribution') contributions += Number(entry.amount_minor || 0);
  }
  return {
    availableMinor: Math.max(0, available),
    pendingMinor: Math.max(0, pending),
    totalMinor: Math.max(0, available + pending),
    discountEarnedMinor: discounts,
    contributionPaidMinor: contributions,
  };
}

export async function walletFor(db, userId, now = Date.now()) {
  return walletSummary(await userLedger(db, userId), now);
}
