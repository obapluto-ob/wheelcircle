import { AppError } from './errors.mjs';

export const JSON_LIMIT = 64 * 1024;
export const WEBHOOK_LIMIT = 256 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function rows(result) {
  if (result?.error) throw new AppError('database_unavailable', 503, 'The workspace is temporarily unavailable. Try again.');
  return Array.isArray(result?.data) ? result.data : [];
}

export function one(result) {
  const list = rows(result);
  return list.length ? list[0] : null;
}

export async function readBytes(request, max = JSON_LIMIT) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        throw new AppError('payload_too_large', 413, 'That request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readText(request, max = JSON_LIMIT) {
  return dec.decode(await readBytes(request, max));
}

export async function jsonBody(request, max = JSON_LIMIT) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new AppError('invalid_input', 415, 'Send JSON from the app.');
  }
  const text = await readText(request, max);
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object');
    return value;
  } catch {
    throw new AppError('invalid_input', 400, 'The request could not be read.');
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (extraHeaders instanceof Headers) extraHeaders.forEach((value, key) => headers.append(key, value));
  else for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value);
  return new Response(JSON.stringify(data), { status, headers });
}

export function noContent(status = 204, extraHeaders = {}) {
  const headers = new Headers({ 'cache-control': 'no-store' });
  if (extraHeaders instanceof Headers) extraHeaders.forEach((value, key) => headers.append(key, value));
  else for (const [key, value] of Object.entries(extraHeaders || {})) headers.set(key, value);
  return new Response(null, { status, headers });
}

export function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function b64u(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(value) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new AppError('invalid_input', 400, 'The credential is malformed.');
  const normalised = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new AppError('invalid_input', 400, 'The credential is malformed.');
  }
}

export function randomToken(bytes = 32) {
  return b64u(randomBytes(bytes));
}

export function randomInt(max) {
  if (!Number.isSafeInteger(max) || max <= 0) throw new AppError('invalid_input', 400);
  const limit = Math.floor(0x100000000 / max) * max;
  const view = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(view);
    const value = view[0];
    if (value < limit) return value % max;
  }
}

export async function sha256Bytes(value) {
  const bytes = typeof value === 'string' ? enc.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(value) {
  const digest = await sha256Bytes(value);
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function concatBytes(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

export function addMs(ms, from = Date.now()) {
  return new Date(from + ms).toISOString();
}

export function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function trimText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

// The address used for rate-limit keys. A socket peer that is not a local proxy is
// authoritative; only local proxies (the dev server, a tunnel agent) may speak for
// the client, and Cloudflare's edge header wins over a forwarded chain there.
export function clientIp(request) {
  const clamp = (value) => String(value).trim().slice(0, 64);
  const peer = clamp(request.headers.get('x-wheel-peer') || '');
  const viaLocalProxy = !peer || /^(127\.|::1$|::ffff:127\.)/.test(peer);
  if (!viaLocalProxy) return peer;
  const edge = request.headers.get('cf-connecting-ip');
  if (edge) return clamp(edge);
  const real = request.headers.get('x-real-ip');
  if (real) return clamp(real);
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').map((value) => value.trim()).filter(Boolean);
    if (hops.length) return clamp(hops[hops.length - 1]);
  }
  return peer || 'unknown';
}
