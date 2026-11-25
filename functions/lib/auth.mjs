import { AppError } from './errors.mjs';
import { bytesEqual, clientIp, nowIso, one, randomInt, randomToken, rows, sha256Hex, sum } from './util.mjs';
import { publicOrigin, requestOrigin, trustedOrigins } from './env.mjs';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const CSRF_COOKIE = 'wheel_csrf';
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const MAX_COOKIE_HEADER = 8192;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function isSecure(request) {
  const forwarded = String(request.headers.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  return new URL(request.url).protocol === 'https:' || forwarded === 'https';
}

function sessionCookieName(request) {
  return isSecure(request) ? '__Host-wheel.session' : 'wheel_session';
}

function cookie(request, name, value, { maxAge = SESSION_TTL_SECONDS, httpOnly = true, clear = false } = {}) {
  const parts = [
    `${name}=${clear ? '' : value}`,
    'Path=/',
    'SameSite=Lax',
    httpOnly ? 'HttpOnly' : null,
    isSecure(request) ? 'Secure' : null,
    `Max-Age=${clear ? 0 : maxAge}`,
  ].filter(Boolean);
  return parts.join('; ');
}

export function cookieHeaders(request, { token, csrf, clear = false } = {}) {
  const headers = new Headers();
  if (clear) {
    headers.append('set-cookie', cookie(request, sessionCookieName(request), '', { clear: true }));
    headers.append('set-cookie', cookie(request, CSRF_COOKIE, '', { clear: true, httpOnly: false }));
    return headers;
  }
  if (token) headers.append('set-cookie', cookie(request, sessionCookieName(request), token));
  if (csrf) headers.append('set-cookie', cookie(request, CSRF_COOKIE, csrf, { httpOnly: false }));
  return headers;
}

export function parseCookieHeader(request, name) {
  const header = request.headers.get('cookie') ?? '';
  if (!header) return null;
  if (header.length > MAX_COOKIE_HEADER) throw new AppError('invalid_credentials', 400);
  const values = [];
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    if (trimmed.slice(0, at).trim() === name) values.push(trimmed.slice(at + 1));
  }
  if (!values.length) return null;
  if (values.length > 1) throw new AppError('invalid_credentials', 400);
  return values[0];
}

export function requireOrigin(request) {
  const expected = publicOrigin(request);
  // A tunnel or preview host is still same-origin when the Origin matches the
  // host the browser actually called. The browser sets both; a cross-site page
  // cannot forge the pair, so this is a same-origin check, not an open door.
  const allowed = [expected, ...trustedOrigins(), requestOrigin(request)];
  const origin = request.headers.get('origin');
  if (origin && !allowed.includes(origin)) throw new AppError('forbidden_origin', 403, 'This request came from an unexpected origin.');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new AppError('forbidden_origin', 403, 'This request came from an unexpected site.');
  }
}

export function requireCsrf(request) {
  const header = request.headers.get('x-csrf-token');
  const stored = parseCookieHeader(request, CSRF_COOKIE);
  if (!header || !stored || header.length !== stored.length) {
    throw new AppError('invalid_csrf', 403, 'Refresh the page and try again.');
  }
  const a = new TextEncoder().encode(header);
  const b = new TextEncoder().encode(stored);
  if (!bytesEqual(a, b)) throw new AppError('invalid_csrf', 403, 'Refresh the page and try again.');
}

export async function createSession(db, userId, request, deviceLabel) {
  const token = randomToken(32);
  const digest = await sha256Hex(token);
  const csrf = randomToken(32);
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  const inserted = rows(await db.from('sessions').insertIfAbsent({
    token_hash: digest,
    user_id: userId,
    device_label: String(deviceLabel || 'This device').slice(0, 90),
    user_agent: String(request.headers.get('user-agent') || 'Unknown browser').slice(0, 300),
    ip_hash: await sha256Hex(`wheel-ip:${clientIp(request)}`),
    created_at: nowIso(now),
    last_seen_at: nowIso(now),
    expires_at: expiresAt,
  }, { onConflict: 'token_hash' }).select('token_hash'));
  if (inserted.length !== 1) throw new AppError('session_unavailable', 503, 'Could not start a session. Try again.');
  return { token, digest, csrf, expiresAt };
}

export async function validateSession(db, request) {
  const token = parseCookieHeader(request, sessionCookieName(request));
  if (!token) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('invalid_credentials', 401, 'Sign in to continue.');
  const digest = await sha256Hex(token);
  const session = one(await db.from('sessions')
    .select('id,token_hash,user_id,device_label,user_agent,created_at,expires_at,revoked_at')
    .eq('token_hash', digest).limit(1));
  if (!session || session.revoked_at != null || Date.parse(session.expires_at) <= Date.now()) {
    throw new AppError('invalid_credentials', 401, 'Sign in to continue.');
  }
  const user = one(await db.from('users')
    .select('id,name,phone,webauthn_user_id,trust_score,created_at,identity_status,identity_last4,identity_name,identity_name_mismatch,identity_note,identity_submitted_at')
    .eq('id', session.user_id).limit(1));
  if (!user) throw new AppError('invalid_credentials', 401, 'Sign in to continue.');
  return { session, user, digest };
}

export async function requireSession(db, request) {
  const result = await validateSession(db, request);
  if (!result) throw new AppError('invalid_credentials', 401, 'Sign in to continue.');
  return result;
}

export async function revokeDigest(db, digest) {
  const revoked = rows(await db.from('sessions').update({ revoked_at: nowIso() })
    .eq('token_hash', digest).select('id'));
  return revoked.length === 1;
}

export async function revokeAllSessions(db, userId) {
  return rows(await db.from('sessions').update({ revoked_at: nowIso() })
    .eq('user_id', userId).select('id'));
}

export async function rateLimit(db, key, max, windowMs) {
  const bucket = `${key}:${Math.floor(Date.now() / windowMs)}`;
  const existing = rows(await db.from('rate_limits').select('id').eq('bucket', bucket).limit(max));
  if (existing.length >= max) throw new AppError('rate_limited', 429, 'Too many attempts. Wait a few minutes and try again.');
  rows(await db.from('rate_limits').insertIfAbsent({ id: crypto.randomUUID(), bucket }, { onConflict: 'id' }).select('id'));
}

export async function ipRateKey(request, scope) {
  return `${scope}:${(await sha256Hex(`ip:${clientIp(request)}`)).slice(0, 24)}`;
}

export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('254')) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith('0')) return `+254${digits.slice(1)}`;
  if (digits.length === 9 && (digits.startsWith('7') || digits.startsWith('1'))) return `+254${digits}`;
  return null;
}

export function phoneDigits(phone) {
  return String(phone ?? '').replace(/\D/g, '');
}

export function maskPhone(phone) {
  const digits = phoneDigits(phone);
  if (digits.length < 6) return 'Phone private';
  return `+${digits.slice(0, 3)} ${digits.slice(3, 4)}•• ••• ${digits.slice(-3)}`;
}

export function normalizeRecoveryCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z2-9]/g, '');
}

export function formatRecoveryCode(code) {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function generateRecoveryCodes(count = 10) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    let code = '';
    for (let j = 0; j < 10; j += 1) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    codes.push(formatRecoveryCode(code));
  }
  return codes;
}

export async function hashRecoveryCode(code, userId) {
  return sha256Hex(`wheel-recovery:${normalizeRecoveryCode(code)}:${userId}`);
}

export async function issueRecoveryCodes(db, userId) {
  const codes = generateRecoveryCodes(10);
  const now = nowIso();
  for (const code of codes) {
    rows(await db.from('recovery_codes').insertIfAbsent({
      id: crypto.randomUUID(),
      user_id: userId,
      code_hash: await hashRecoveryCode(code, userId),
      status: 'active',
      created_at: now,
    }, { onConflict: 'id' }).select('id'));
  }
  return codes;
}

export function authUser(user) {
  return {
    id: user.id,
    name: user.name,
    phoneMasked: maskPhone(user.phone),
    trustScore: Number(user.trust_score ?? 50),
    createdAt: user.created_at,
  };
}

export function sessionSummary(session, currentDigest) {
  return {
    id: session.id,
    deviceLabel: session.device_label,
    userAgent: session.user_agent,
    createdAt: session.created_at,
    expiresAt: session.expires_at,
    current: session.token_hash === currentDigest,
  };
}

export function availableHint(entries, now = Date.now()) {
  const available = sum(entries.filter((entry) => Date.parse(entry.available_at) <= now).map((entry) => entry.wallet_effect));
  const pending = sum(entries.filter((entry) => Date.parse(entry.available_at) > now).map((entry) => entry.wallet_effect));
  return { available: Math.max(0, available), pending: Math.max(0, pending) };
}
