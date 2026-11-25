import { one, nowIso, rows } from './util.mjs';
import { insertLedger } from './ledger.mjs';

export const TOPUP_MIN_MINOR = 5000;
export const TOPUP_MAX_MINOR = 2000000;
export const TOPUP_CHIPS_MINOR = [10000, 25000, 50000, 100000, 250000, 500000];

export async function recordWalletTopUp(db, { userId, amountMinor, sessionId, expiresAt = null }) {
  const row = {
    id: crypto.randomUUID(),
    user_id: userId,
    amount_minor: Math.round(Number(amountMinor) || 0),
    session_id: sessionId,
    provider: 'paysasa',
    status: 'pending',
    created_at: nowIso(),
    paid_at: null,
    expires_at: expiresAt,
  };
  const inserted = rows(await db.from('wallet_topups').insertIfAbsent(row, { onConflict: 'session_id' }).select('*'));
  return inserted[0] || row;
}

export async function creditWalletTopUp(db, { userId, amountMinor, sessionId, testApproved = false }) {
  const amount = Math.round(Number(amountMinor) || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { credited: false, amountMinor: 0 };
  const ledger = await insertLedger(db, {
    ref: `topup:${sessionId}`,
    userId,
    kind: 'topup',
    amountMinor: amount,
    walletEffect: amount,
    availableAt: nowIso(),
    memo: testApproved ? 'Stash top-up · sandbox test approval' : 'Stash top-up',
  });
  if (!ledger.inserted) return { credited: false, amountMinor: amount };
  const mark = { status: 'paid', paid_at: nowIso(), amount_minor: amount, ...(testApproved ? { test_approved: true } : {}) };
  const existing = one(await db.from('wallet_topups').select('*').eq('session_id', sessionId).limit(1));
  if (existing) {
    rows(await db.from('wallet_topups').update(mark).eq('id', existing.id).select('id'));
  } else {
    await recordWalletTopUp(db, { userId, amountMinor: amount, sessionId });
    const row = one(await db.from('wallet_topups').select('*').eq('session_id', sessionId).limit(1));
    if (row) {
      rows(await db.from('wallet_topups').update(mark).eq('id', row.id).select('id'));
    }
  }
  return { credited: true, amountMinor: amount };
}

export async function closeWalletTopUp(db, sessionId, status = 'expired') {
  rows(await db.from('wallet_topups').update({ status })
    .eq('session_id', sessionId).eq('status', 'pending').select('id'));
}

export async function walletTopUpHistory(db, userId, limit = 12) {
  return rows(await db.from('wallet_topups')
    .select('id,session_id,amount_minor,status,created_at,paid_at,test_approved')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(limit));
}
