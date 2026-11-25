import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqliteDb } from './sqlite-db.mjs';
import { application } from '../functions/routes.mjs';
import { randomToken, sha256Hex, nowIso, one, b64u, randomBytes } from '../functions/lib/util.mjs';
import { normalizePhone } from '../functions/lib/auth.mjs';
import { AppError } from '../functions/lib/errors.mjs';
import { RULES } from '../functions/lib/rules.mjs';
import {
  contributionForMember, markContributionPaid, fundCycleIfComplete, contributionsFor,
} from '../functions/lib/funding.mjs';
import { membersOf, currentCircle } from '../functions/lib/read.mjs';
import { settleCycle } from '../functions/lib/settle.mjs';
import { identityState, saveIdentity } from '../functions/lib/open-circles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(root, 'web');
const port = Number(process.env.PORT || 8099);
const origin = `http://localhost:${port}`;
// The server binds IPv4 only; calling "localhost" can resolve to ::1 and fail.
const apiOrigin = `http://127.0.0.1:${port}`;
process.env.PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || origin;
// Server-only provider credentials. The file is written by the operator and never
// served to the browser or bundled into the static build.
function loadLocalEnv(file) {
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!match || match[2] === '') continue;
      if (process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no local provider file */ }
}
loadLocalEnv(path.join(root, 'dev', 'paysasa.local.env'));
// Operator door PIN. Server-only; the browser never receives it.
loadLocalEnv(path.join(root, 'dev', 'panel.local.env'));

// Local reviewer account. Production sets WHEEL_ADMIN_PHONES explicitly.
process.env.WHEEL_ADMIN_PHONES = process.env.WHEEL_ADMIN_PHONES || '0700000001';
const dbFile = path.resolve(root, process.env.WHEEL_DB || 'dev/wheel.db');

// The simulator only steps aside when the provider key, the business id and a
// webhook secret are all present. Local browser walkthroughs stay simulated by
// default so a whole circle can settle without a phone; `npm run dev:live`
// sends the same code to the Paysasa sandbox.
const SIMULATED_PAYMENTS = !process.argv.includes('--live')
  || !process.env.PAYSASA_API_KEY
  || !process.env.PAYSASA_BUSINESS_ID;
const PAYSASA_WEBHOOK_SECRET = process.env.PAYSASA_WEBHOOK_SECRET || 'dev-simulated-webhook-secret';
if (SIMULATED_PAYMENTS) {
  process.env.PAYSASA_API_KEY = 'dev-simulated-key';
  process.env.PAYSASA_BUSINESS_ID = 'dev-simulated-business';
  process.env.PAYSASA_WEBHOOK_SECRET = PAYSASA_WEBHOOK_SECRET;
  process.env.PAYSASA_VIRTUAL_ACCOUNT_ID = 'va_dev_simulated';
  process.env.PAYSASA_SIMULATED = '1';
}
// Without a Kora key the dev server answers identity checks from a fixed
// sandbox register so onboarding can be walked end to end. A real key always
// wins, and every simulated response is labelled in the UI.
if (!process.env.KORA_SECRET_KEY && !process.env.KORA_SIMULATED) process.env.KORA_SIMULATED = '1';

const paysasaSessions = new Map();
let paysasaCounter = 0;
const simulatedSession = (entry) => ({
  session: {
    id: entry.id,
    reference: entry.reference,
    status: entry.status,
    amount: entry.amount,
    currency: 'KES',
    hosted_url: `${origin}/dev/checkout?id=${entry.id}`,
    expires_at: entry.expiresAt,
    metadata: entry.metadata,
  },
});
if (SIMULATED_PAYMENTS) {
  const serviceFetch = globalThis.fetch;
  const respond = (status, payload) => new Response(JSON.stringify(payload), {
    status, headers: { 'content-type': 'application/json' },
  });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : String(input?.url || input);
    if (!url.startsWith('https://api.paysasa.com/api/v1')) return serviceFetch(input, init);
    const method = String(init.method || 'GET').toUpperCase();
    const collection = url.match(/\/checkout\/sessions$/);
    if (collection && method === 'POST') {
      const body = JSON.parse(String(init.body || '{}'));
      paysasaCounter += 1;
      const id = `cs_dev_${paysasaCounter}`;
      const entry = {
        id,
        amount: Number(body.amount),
        currency: 'KES',
        metadata: body.metadata || {},
        reference: `ref_dev_${paysasaCounter}`,
        successUrl: body.success_url || `${origin}/#/app`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        status: 'pending',
        paid: false,
      };
      paysasaSessions.set(id, entry);
      return respond(200, simulatedSession(entry));
    }
    const single = url.match(/\/checkout\/sessions\/([^/?]+)(\/pay|\/cancel)?/);
    if (single) {
      const entry = paysasaSessions.get(single[1]);
      if (!entry) return respond(404, { error: { message: 'Unknown simulated checkout.' } });
      if (method === 'GET' && !single[2]) {
        return respond(200, simulatedSession(entry));
      }
      if (method === 'POST' && single[2] === '/pay') {
        const paid = await paySimulatedSession(entry.id);
        return paid.ok
          ? respond(200, { status: 'paid', checkout_request_id: `cr_dev_${paysasaCounter}` })
          : respond(409, { error: { message: paid.message } });
      }
      if (method === 'POST' && single[2] === '/cancel') {
        if (!entry.paid) entry.status = 'cancelled';
        return respond(200, { ok: true, status: entry.status, message: 'Checkout cancelled' });
      }
    }
    return respond(503, { error: { message: 'The local payment simulator does not support that call.' } });
  };
}

const db = createSqliteDb(dbFile);
const handle = application({ db });
const SESSION_TTL_SECONDS = 12 * 60 * 60;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

// Security headers for every response this dev server writes, static or API.
function applySecurityHeaders(req, res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('permissions-policy', 'camera=(), geolocation=(), microphone=(self), payment=(), usb=()');
  if (String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https') {
    res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

function trustedOriginList() {
  return String(process.env.TRUSTED_ORIGINS || '').split(',')
    .map((value) => value.trim().replace(/\/+$/, '')).filter(Boolean);
}

function pageCsp() {
  const connect = ["'self'", origin, apiOrigin, ...trustedOriginList()].join(' ');
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connect}; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none';`;
}

// Development-only routes are open on loopback. When the app is reached through a
// public tunnel they require DEV_TOKEN, exchanged once for a cookie by opening
// /dev/login?...&token=… (or any /dev/ page) on that device.
const DEV_TOKEN = String(process.env.DEV_TOKEN || '');
const DEV_COOKIE = 'wheel_dev';

function hostName(req) {
  return String(req.headers.host || '').split(':')[0].toLowerCase();
}

function isLoopbackHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function tokenMatches(value) {
  const given = String(value || '');
  if (!DEV_TOKEN || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(DEV_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function devAccess(req, url) {
  if (isLoopbackHost(hostName(req))) return { ok: true };
  if (tokenMatches(url.searchParams.get('token'))) return { ok: true, grant: true };
  const bearer = String(req.headers['x-dev-token'] || '');
  if (tokenMatches(bearer)) return { ok: true };
  const cookie = String(req.headers.cookie || '').split(';')
    .map((part) => part.trim()).find((part) => part.startsWith(`${DEV_COOKIE}=`));
  return { ok: tokenMatches(cookie ? cookie.slice(DEV_COOKIE.length + 1) : '') };
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'content-type': 'application/json; charset=utf-8' });
}

async function readBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function cookiesFor(token, csrf) {
  return [
    `wheel_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
    `wheel_csrf=${csrf}; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
  ];
}

async function devLogin(req, res, url) {
  let name = String(url.searchParams.get('name') || 'Dev Organizer').slice(0, 80);
  let phone = normalizePhone(url.searchParams.get('phone') || '0700000001') || '+254700000001';
  const memberId = url.searchParams.get('member');
  if (memberId) {
    const member = one(await db.from('memberships').select('*').eq('id', memberId).limit(1));
    const owner = member ? one(await db.from('users').select('*').eq('id', member.user_id).limit(1)) : null;
    if (owner) {
      name = owner.name;
      phone = owner.phone;
    }
  }
  let user = one(await db.from('users').select('*').eq('phone', phone).limit(1));
  const createdAt = nowIso();
  if (!user) {
    const id = crypto.randomUUID();
    user = {
      id,
      name,
      phone,
      webauthn_user_id: b64u(randomBytes(32)),
      trust_score: 50,
      created_at: createdAt,
      updated_at: createdAt,
    };
    await db.from('users').insertIfAbsent(user, { onConflict: 'phone' }).select('id');
    await db.from('wallets').insertIfAbsent({
      id: crypto.randomUUID(), user_id: id, balance_minor: 0, updated_at: createdAt,
    }, { onConflict: 'user_id' }).select('id');
    user = one(await db.from('users').select('*').eq('phone', phone).limit(1)) || user;
  }
  const token = randomToken(32);
  const csrf = randomToken(32);
  const now = Date.now();
  await db.from('sessions').insertIfAbsent({
    id: crypto.randomUUID(),
    user_id: user.id,
    token_hash: await sha256Hex(token),
    device_label: 'Dev browser',
    user_agent: String(req.headers['user-agent'] || 'Dev'),
    ip_hash: await sha256Hex('ip:dev'),
    created_at: nowIso(now),
    last_seen_at: nowIso(now),
    expires_at: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
    revoked_at: null,
  }, { onConflict: 'token_hash' }).select('id');
  res.writeHead(302, {
    location: '/',
    'cache-control': 'no-store',
    'set-cookie': cookiesFor(token, csrf),
  });
  res.end();
}

async function devPay(url, body) {
  let contribution = null;
  const contributionId = url.searchParams.get('contribution') || body.contributionId;
  if (contributionId) {
    contribution = one(await db.from('contributions').select('*').eq('id', contributionId).limit(1));
  } else {
    const cycleId = url.searchParams.get('cycle') || body.cycleId;
    const membershipId = url.searchParams.get('membership') || body.membershipId;
    if (cycleId && membershipId) contribution = await contributionForMember(db, cycleId, membershipId);
  }
  if (!contribution) return { ok: false, error: 'contribution_not_found' };
  if (contribution.status === 'paid') return { ok: true, alreadyPaid: true };
  const cycle = one(await db.from('cycles').select('*').eq('id', contribution.cycle_id).limit(1));
  const member = one(await db.from('memberships').select('*').eq('id', contribution.membership_id).limit(1));
  if (!cycle || !member) return { ok: false, error: 'cycle_or_member_missing' };
  await markContributionPaid(db, {
    contribution,
    cycle,
    membership: member,
    amountMinor: contribution.amount_minor,
    lateFeeMinor: 0,
    method: 'dev',
    providerRef: `dev_${contribution.id}`,
    paidAt: nowIso(),
    chargeTrust: true,
  });
  const members = await membersOf(db, cycle.group_id);
  const funded = await fundCycleIfComplete(db, cycle, members);
  return { ok: true, contributionId: contribution.id, cycleStatus: funded.status };
}

async function devPayAll(url) {
  const cycleId = url.searchParams.get('cycle');
  const cycle = cycleId
    ? one(await db.from('cycles').select('*').eq('id', cycleId).limit(1))
    : null;
  if (!cycle) return { ok: false, error: 'cycle_not_found' };
  const pending = (await contributionsFor(db, cycle.id)).filter((row) => row.status === 'pending');
  const results = [];
  for (const contribution of pending) {
    results.push(await devPay(new URL(`${origin}/dev/pay?contribution=${contribution.id}`), {}));
  }
  let fresh = one(await db.from('cycles').select('*').eq('id', cycle.id).limit(1));
  // Production settles inside the fee webhook; the dev shortcut settles through the same engine.
  if (fresh?.status === 'funded') {
    const group = one(await db.from('groups').select('*').eq('id', fresh.group_id).limit(1));
    const circle = one(await db.from('circles').select('*').eq('id', fresh.circle_id).limit(1));
    await settleCycle(db, { group, circle, cycle: fresh, members: await membersOf(db, fresh.group_id) });
    fresh = one(await db.from('cycles').select('*').eq('id', cycle.id).limit(1));
  }
  return { ok: true, paid: results.filter((entry) => entry.ok).length, cycleStatus: fresh?.status };
}

async function devSession(user) {
  const token = randomToken(32);
  const csrf = randomToken(32);
  const now = Date.now();
  await db.from('sessions').insertIfAbsent({
    id: crypto.randomUUID(),
    user_id: user.id,
    token_hash: await sha256Hex(token),
    device_label: 'Dev test tools',
    user_agent: 'Dev tools',
    ip_hash: await sha256Hex('ip:dev'),
    created_at: nowIso(now),
    last_seen_at: nowIso(now),
    expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    revoked_at: null,
  }, { onConflict: 'token_hash' }).select('id');
  return { token, csrf, user };
}

async function apiAs(session, path, { method = 'POST', body } = {}) {
  const headers = { cookie: `wheel_session=${session.token}; wheel_csrf=${session.csrf}` };
  if (method !== 'GET') {
    headers.origin = origin;
    headers['x-csrf-token'] = session.csrf;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${apiOrigin}/functions/v1/app${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AppError(data?.error || 'dev_api_error', response.status,
      data?.message || `${path} failed (${response.status})`);
  }
  return data;
}

async function signBody(body) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(PAYSASA_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function paySimulatedSession(id) {
  const entry = paysasaSessions.get(id);
  if (!entry) return { ok: false, status: 404, message: 'Unknown simulated checkout.' };
  if (!entry.paid) {
    const event = {
      event: 'checkout.session.completed',
      data: {
        session_id: id,
        reference: entry.reference,
        amount: entry.amount,
        currency: entry.currency,
        metadata: entry.metadata,
      },
    };
    const body = JSON.stringify(event);
    const request = new Request(`${apiOrigin}/functions/v1/app/payments/paysasa/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-paysasa-signature': `sha256=${await signBody(body)}`,
      },
      body,
    });
    const response = await handle({ request, requestId: crypto.randomUUID() });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error('dev_checkout_rejected', response.status, text);
      return { ok: false, status: response.status, message: text };
    }
    entry.paid = true;
    entry.status = 'paid';
  }
  return { ok: true, successUrl: entry.successUrl };
}

async function devCancel(url) {
  const entry = paysasaSessions.get(url.searchParams.get('id') || '');
  if (!entry) {
    return { ok: false, status: 404, message: 'Unknown simulated checkout. Cancelling works with the local payment simulator only.' };
  }
  if (!entry.paid) entry.status = 'cancelled';
  return { ok: true, status: entry.status };
}

async function devCheckout(res, url) {
  const result = await paySimulatedSession(url.searchParams.get('id') || '');
  if (!result.ok) {
    return send(res, result.status || 409, `The payment could not be recorded: ${result.message}`,
      { 'content-type': 'text/plain; charset=utf-8' });
  }
  res.writeHead(302, { location: result.successUrl, 'cache-control': 'no-store' });
  res.end();
}

async function devAdvance(url) {
  const groupId = url.searchParams.get('group');
  const step = url.searchParams.get('step');
  if (!['member', 'start', 'next', 'fund', 'settle', 'renew'].includes(step)) {
    throw new AppError('invalid_step', 400, 'Choose member, start, next, fund, settle, or renew.');
  }
  const group = groupId
    ? one(await db.from('groups').select('*').eq('id', groupId).limit(1))
    : null;
  if (!group) return { ok: false, message: 'That circle no longer exists.' };
  if (group.status === 'completed' && step !== 'renew' && step !== 'settle') {
    throw new AppError('group_completed', 409, 'This round is complete. Propose another round.');
  }
  const organizer = one(await db.from('users').select('*').eq('id', group.organizer_id).limit(1));
  if (!organizer) return { ok: false, message: 'The organizer account is missing.' };
  const admin = await devSession(organizer);

  if (step === 'renew') {
    const circle = await currentCircle(db, group.id);
    if (group.status !== 'completed' || !circle) return { ok: false, message: 'Finish every turn before proposing another round.' };
    const proposed = await apiAs(admin, `/groups/${group.id}/rounds`, { body: { previousCircleId: circle.id } });
    return { ok: true, message: `Round ${proposed.roundNumber} proposed. Every member must accept before it starts.` };
  }

  if (step === 'member') {
    if (group.status !== 'forming') return { ok: false, message: 'Seats lock once the circle starts.' };
    const members = await membersOf(db, group.id);
    if (members.length >= Math.min(Number(group.max_members), RULES.maxMembers)) {
      return { ok: false, message: 'Every seat is taken.' };
    }
    const seat = members.length + 1;
    const names = ['Grace Wambui', 'Peter Ouma', 'Naomi Chebet', 'Samuel Kiptoo', 'Lydia Atieno', 'Kevin Mutua', 'Joy Njoki'];
    const name = names[seat % names.length];
    const usedUsers = new Set([group.organizer_id, ...members.map((member) => member.user_id)]);
    let candidate = seat;
    let phone;
    let user;
    do {
      phone = normalizePhone(`0799${String(candidate++).padStart(6, '0')}`);
      user = one(await db.from('users').select('*').eq('phone', phone).limit(1));
    } while (user && usedUsers.has(user.id));
    if (!user) {
      const id = crypto.randomUUID();
      await db.from('users').insertIfAbsent({
        id, name, phone, webauthn_user_id: b64u(randomBytes(32)), trust_score: 50,
        created_at: nowIso(), updated_at: nowIso(),
      }, { onConflict: 'phone' }).select('id');
      user = one(await db.from('users').select('*').eq('phone', phone).limit(1));
      if (!user) throw new AppError('member_user_missing', 409, 'The member account could not be created.');
      await db.from('wallets').insertIfAbsent({
        id: crypto.randomUUID(), user_id: user.id, balance_minor: 0, updated_at: nowIso(),
      }, { onConflict: 'user_id' }).select('id');
    }
    if (usedUsers.has(user.id)) throw new AppError('seats_closed', 409, 'That account already has a seat.');
    const session = await devSession(user);
    if (group.visibility === 'open') {
      if (identityState(user) !== 'verified') {
        await saveIdentity(db, user, {
          legalName: `${user.name} (dev ID)`,
          idNumber: String(40000000 + seat),
          dateOfBirth: '1996-05-12',
        });
        // Dev seeding skips the review desk so scripted circles can start immediately.
        await db.from('users').update({ identity_status: 'verified', identity_name_mismatch: false, identity_at: nowIso() })
          .eq('id', user.id).select('id');
      }
      const checkout = await apiAs(session, `/groups/${group.id}/seat-checkout`, { body: { acceptRules: true } });
      const checkoutId = new URL(checkout.checkoutUrl).searchParams.get('id');
      const paid = await paySimulatedSession(checkoutId);
      if (!paid.ok) throw new AppError('dev_seat_payment_failed', 409, `The seat payment was refused: ${paid.message}`);
      return { ok: true, message: `${user.name} joined seat ${seat}, verified their ID, and prepaid turn 1.` };
    }
    await apiAs(session, '/groups/join', { body: { inviteCode: group.invite_code } });
    return { ok: true, message: `${user.name} joined seat ${seat}.` };
  }

  if (step === 'start') {
    if (group.status !== 'forming') return { ok: true, message: 'The circle is already started.' };
    const circle = await currentCircle(db, group.id);
    const roundNumber = Number(circle?.number || 1);
    for (const member of (await membersOf(db, group.id)).filter((row) => row.status === 'active')) {
      if (Number(member.accepted_round || 0) === roundNumber) continue;
      const user = one(await db.from('users').select('*').eq('id', member.user_id).limit(1));
      if (!user) throw new AppError('member_user_missing', 409, 'A member account is missing.');
      await apiAs(await devSession(user), `/groups/${group.id}/round/accept`, { body: { roundNumber } });
    }
    await apiAs(admin, `/groups/${group.id}/start`, { body: {} });
    return { ok: true, message: `Every member accepted round ${roundNumber}. Turn one opened and every seat owes the contribution.` };
  }

  const activeCircle = await currentCircle(db, group.id);
  const cycle = activeCircle ? one(await db.from('cycles').select('*').eq('circle_id', activeCircle.id).order('number', { ascending: false }).limit(1)) : null;

  if (step === 'next') {
    await apiAs(admin, `/groups/${group.id}/cycles`, { body: {} });
    return { ok: true, message: 'Next turn opened. Contributions can be funded again.' };
  }

  if (!cycle) return { ok: false, message: 'Open a turn first.' };

  if (step === 'fund') {
    if (cycle.status === 'funded' || cycle.status === 'settled') return { ok: true, message: 'The pot is already whole.' };
    if (cycle.status !== 'contributing') throw new AppError('contributions_closed', 409, 'This turn is closed. Open the next turn before funding.');
    const funded = await devPayAll(new URL(`http://localhost/dev/pay-all?cycle=${cycle.id}`));
    if (!funded.ok || !['funded', 'settled'].includes(funded.cycleStatus)) throw new AppError('pot_incomplete', 409, 'The pot is not whole yet. Check the contributions.');
    return { ok: true, message: funded.cycleStatus === 'settled'
      ? 'Every seat funded. The turn paid its seat the moment the pot closed; the receipt is on the wheel page.'
      : 'Every seat funded. The turn pays its seat now.' };
  }

  if (step === 'settle') {
    if (cycle.status === 'settled') return { ok: true, message: 'Turn already settled. The receipt is on the wheel page.' };
    if (cycle.status !== 'funded') return { ok: false, message: 'The pot must be whole first.' };
    await apiAs(admin, `/groups/${group.id}/cycles/${cycle.id}/close`, { body: {} });
    return { ok: true, message: 'Turn settled. The receipt is on the wheel page.' };
  }
}

async function devState(res) {
  const snapshot = db.snapshot();
  const pick = (name, limit = 200) => (snapshot[name] || []).slice(-limit);
  sendJson(res, 200, {
    users: pick('users', 50).map((user) => ({
      id: user.id,
      name: user.name,
      phone: user.phone,
      trust_score: user.trust_score,
      identity_status: user.identity_status || null,
      identity_last4: user.identity_last4 || null,
      terms_version: user.terms_version || null,
      terms_accepted_at: user.terms_accepted_at || null,
      terms_accepted_origin: user.terms_accepted_origin || null,
    })),
    pendingRegistrations: pick('pending_registrations', 20).map((row) => ({
      id: row.id, phone: row.phone, status: row.status, rawIdHeld: Boolean(row.id_number),
    })),
    groups: pick('groups', 20),
    memberships: pick('memberships', 80),
    cycles: pick('cycles', 40),
    contributions: pick('contributions', 120),
    bids: pick('bids', 80),
    settlements: pick('settlements', 40),
    payouts: pick('payouts', 40),
    ledger: pick('ledger'),
    payments: pick('payment_events', 40),
  });
}

async function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative === '/') relative = '/index.html';
  if (relative.endsWith('/')) relative += 'index.html';
  if (relative.split('/').some((part) => part.startsWith('.'))) return send(res, 404, 'Not found');
  if (!path.extname(relative)) relative = '/index.html';
  const file = path.resolve(webRoot, `.${relative}`);
  if (!file.startsWith(webRoot)) return send(res, 404, 'Not found');
  try {
    let body = await readFile(file);
    // The meta CSP in each page mirrors the one served in the header, with the
    // current host and any trusted tunnel origins listed for API calls.
    if (path.extname(file) === '.html') {
      body = Buffer.from(String(body).replace(/connect-src [^;]+;/, `connect-src 'self' ${[origin, apiOrigin, ...trustedOriginList()].join(' ')};`));
      res.setHeader('content-security-policy', pageCsp());
    }
    send(res, 200, body, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    applySecurityHeaders(req, res);
    const url = new URL(req.url, origin);
    if (url.pathname === '/dev' || url.pathname.startsWith('/dev/')) {
      const access = devAccess(req, url);
      if (!access.ok) return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
      if (access.grant) {
        const clean = new URL(url);
        clean.searchParams.delete('token');
        const secure = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' ? '; Secure' : '';
        res.writeHead(302, {
          location: `${clean.pathname}${clean.search}`,
          'cache-control': 'no-store',
          'set-cookie': `${DEV_COOKIE}=${DEV_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`,
        });
        return res.end();
      }
    }
    if (url.pathname === '/dev/login') return await devLogin(req, res, url);
    if (url.pathname === '/dev/checkout') return await devCheckout(res, url);
    if (url.pathname === '/dev/cancel' && req.method === 'POST') {
      const result = await devCancel(url);
      return sendJson(res, result.ok ? 200 : result.status || 409, result);
    }
    if (url.pathname === '/dev/state') return await devState(res);
    if (url.pathname === '/dev/reset' && req.method === 'POST') {
      db.reset();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/dev/pay' && req.method === 'POST') {
      const body = (await readBody(req)).toString('utf8');
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
      return sendJson(res, 200, await devPay(url, parsed));
    }
    if (url.pathname === '/dev/pay-all' && req.method === 'POST') {
      return sendJson(res, 200, await devPayAll(url));
    }
    if (url.pathname === '/dev/advance' && req.method === 'POST') {
      return sendJson(res, 200, await devAdvance(url));
    }
    if (url.pathname === '/dev/close-auction' && req.method === 'POST') {
      const cycleId = url.searchParams.get('cycle');
      const cycle = cycleId
        ? one(await db.from('cycles').select('id,status').eq('id', cycleId).limit(1))
        : null;
      if (!cycle) return sendJson(res, 404, { ok: false, error: 'cycle_not_found' });
      await db.from('cycles')
        .update({ auction_closes_at: new Date(Date.now() - 1000).toISOString(), scheduled_settle_at: new Date(Date.now() - 1000).toISOString() })
        .eq('id', cycleId).select('id');
      return sendJson(res, 200, { ok: true, cycleId });
    }

    if (url.pathname === '/functions/v1/app' || url.pathname.startsWith('/functions/v1/app/')) {
      const raw = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (['content-length', 'connection', 'transfer-encoding'].includes(key)) continue;
        if (Array.isArray(value)) headers.set(key, value.join(', '));
        else if (value !== undefined) headers.set(key, String(value));
      }
      // The real socket peer lets rate limiting decide whether proxy headers can
      // be trusted, instead of believing a client-supplied address.
      headers.set('x-wheel-peer', String(req.socket?.remoteAddress || ''));
      const request = new Request(url, { method: req.method, headers, body: raw });
      const response = await handle({ request, requestId: crypto.randomUUID() });
      const out = new Headers(response.headers);
      const setCookies = typeof out.getSetCookie === 'function' ? out.getSetCookie() : [];
      setCookies.forEach((value) => out.delete('set-cookie'));
      const buffer = Buffer.from(await response.arrayBuffer());
      const responseHeaders = {};
      out.forEach((value, key) => { responseHeaders[key] = value; });
      // Lets a stale preview tab on another local port probe this service and move here.
      const requestOrigin = String(req.headers.origin || '');
      if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(requestOrigin)) {
        responseHeaders['access-control-allow-origin'] = requestOrigin;
        responseHeaders.vary = responseHeaders.vary ? `${responseHeaders.vary}, origin` : 'origin';
      }
      if (setCookies.length) responseHeaders['set-cookie'] = setCookies;
      res.writeHead(response.status, responseHeaders);
      res.end(req.method === 'HEAD' ? undefined : buffer);
      return;
    }

    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    try {
      console.error('dev_server_error', error?.stack || error);
    } catch { /* best effort */ }
    if (!res.headersSent) sendJson(res, error instanceof AppError ? error.status : 500, {
      ok: false,
      error: error instanceof AppError ? error.code : 'dev_server_error',
      message: String(error?.message || error),
    });
    else res.end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`THE WHEEL dev server → ${origin}`);
  console.log(`Dev sign-in → ${origin}/dev/login`);
  if (process.env.TRUSTED_ORIGINS) {
    console.log(`Extra trusted origins → ${process.env.TRUSTED_ORIGINS}`);
    console.log(DEV_TOKEN
      ? 'Tunnel dev tools → locked behind DEV_TOKEN (open /dev/login?token=… once on the device).'
      : 'Tunnel dev tools → locked to loopback. Restart with DEV_TOKEN=<random> to use /dev/* through the tunnel.');
  }
  console.log(`SQLite ledger → ${dbFile}`);
  console.log(process.env.ADMIN_PANEL_PIN
    ? 'Operator door → admin phones + a server-side PIN.'
    : 'Operator door → admin phones only (set ADMIN_PANEL_PIN in dev/panel.local.env to add the PIN).');
  console.log(SIMULATED_PAYMENTS
    ? 'Payments → simulated locally (checkout, status, STK, cancel, signed webhook). Run `npm run dev:live` to use the Paysasa sandbox.'
    : `Payments → Paysasa sandbox/live (business ${process.env.PAYSASA_BUSINESS_ID}). Webhook secret is set server-side.`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    try { db.close(); } catch { /* closing twice is harmless */ }
    process.exit(0);
  });
}
