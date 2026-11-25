import assert from 'node:assert/strict';
import { createMemoryDb } from '../dev/memory-db.mjs';
import { application } from '../functions/routes.mjs';
import { randomToken, sha256Hex, nowIso, randomBytes, b64u } from '../functions/lib/util.mjs';

export const ORIGIN = 'http://localhost:8099';
export const WEBHOOK_SECRET = 'test-webhook-secret';
process.env.PUBLIC_ORIGIN = ORIGIN;

export function configurePayments() {
  process.env.PAYSASA_API_KEY = 'test-api-key';
  process.env.PAYSASA_BUSINESS_ID = 'test-business';
  process.env.PAYSASA_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.PAYSASA_VIRTUAL_ACCOUNT_ID = 'va_test_account';
}

export async function boot() {
  configurePayments();
  const db = createMemoryDb();
  const handle = application({ db });
  return { db, handle };
}

export async function addUser(db, { name, phone, trust = 50 }) {
  const id = crypto.randomUUID();
  const row = {
    id,
    name,
    phone,
    webauthn_user_id: b64u(randomBytes(32)),
    trust_score: trust,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.table('users').push(row);
  db.table('wallets').push({
    id: crypto.randomUUID(), user_id: id, balance_minor: 0, updated_at: nowIso(),
  });
  return row;
}

export async function signIn(db, user) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const now = Date.now();
  db.table('sessions').push({
    id: crypto.randomUUID(),
    user_id: user.id,
    token_hash: await sha256Hex(token),
    device_label: 'Test device',
    user_agent: 'node-test',
    ip_hash: await sha256Hex('ip:test'),
    created_at: nowIso(now),
    last_seen_at: nowIso(now),
    expires_at: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
    revoked_at: null,
  });
  return { user, token, csrf, cookie: `wheel_session=${token}; wheel_csrf=${csrf}` };
}

export function client(handle, session) {
  return async function call(path, { method = 'GET', body, origin = ORIGIN, includeCsrf = true } = {}) {
    const headers = new Headers();
    if (session) headers.set('cookie', session.cookie);
    if (origin) headers.set('origin', origin);
    if (session && includeCsrf && method !== 'GET') headers.set('x-csrf-token', session.csrf);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const request = new Request(`${ORIGIN}/functions/v1/app${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await handle({ request, requestId: 'test' });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  };
}

export async function signatureFor(body, secret = WEBHOOK_SECRET) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function postWebhook(handle, event, { secret = WEBHOOK_SECRET, signature } = {}) {
  const body = JSON.stringify(event);
  const signed = signature === undefined ? `sha256=${await signatureFor(body, secret)}` : signature;
  const request = new Request(`${ORIGIN}/functions/v1/app/payments/paysasa/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paysasa-signature': signed },
    body,
  });
  const response = await handle({ request, requestId: 'test' });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, data };
}

export function contributionFor(db, cycleId, membershipId) {
  return db.table('contributions').find((row) => row.cycle_id === cycleId && row.membership_id === membershipId);
}

export function installPaysasaStub() {
  const original = globalThis.fetch;
  let counter = 0;
  const sessions = new Map();
  const payload = (entry) => new Response(JSON.stringify({
    session: {
      id: entry.id,
      reference: entry.reference,
      status: entry.status,
      amount: entry.amount,
      currency: 'KES',
      hosted_url: `https://pay.example.test/checkout/${entry.id}`,
      expires_at: entry.expiresAt,
      metadata: entry.metadata,
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    if (url.endsWith('/checkout/sessions') && method === 'POST') {
      counter += 1;
      const body = JSON.parse(init.body);
      const entry = {
        id: `cs_test_${counter}`,
        reference: `ref_test_${counter}`,
        status: 'pending',
        amount: body.amount,
        metadata: body.metadata || {},
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      };
      sessions.set(entry.id, entry);
      return payload(entry);
    }
    const single = url.match(/\/checkout\/sessions\/([^/?]+)(\/pay|\/cancel)?$/);
    if (single) {
      const entry = sessions.get(single[1]);
      if (!entry) {
        return new Response(JSON.stringify({ error: 'session_not_found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && single[2] === '/pay') {
        entry.status = 'processing';
        return new Response(JSON.stringify({ status: 'processing', checkout_request_id: 'cr_test_1' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && single[2] === '/cancel') {
        entry.status = 'cancelled';
        return new Response(JSON.stringify({ ok: true, status: 'cancelled' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return payload(entry);
    }
    if (url.includes('/waas/withdraw/status')) {
      return new Response(JSON.stringify({
        withdrawal: {
          transaction_id: 'tr_test_1', reference: 'ref_test_1', status: 'processing', amount: 10000,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/waas/withdraw')) {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        withdrawal: {
          transaction_id: 'tr_test_1', reference: 'ref_test_1', status: 'processing', amount: body.amount,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return original(input, init);
  };
  return {
    restore() { globalThis.fetch = original; },
    count() { return counter; },
    sessions,
    markPaid(sessionId) {
      const entry = sessions.get(sessionId);
      if (entry) entry.status = 'paid';
      return entry || null;
    },
  };
}

export function assertStatus(result, status, label = '') {
  assert.equal(result.status, status, `${label} expected ${status}, got ${result.status}: ${JSON.stringify(result.data)}`);
}
