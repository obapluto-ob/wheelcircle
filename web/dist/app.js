import { renderPractice, leavePractice } from './practice.js';
import { engineMarkup, mountEngines, speakEngineText, stopEngineVoice } from './engine.js';
import { seatNetPreview, scheduledTurnAt, groupCadence } from './rules.mjs';

let accountReady = false;
let accountLoading = false;
const isPracticeRoute = (route) => route === '/practice' || route?.startsWith('/practice/');
const API_BASE = '/functions/v1/app';
const TZ = 'Africa/Nairobi';
const CURRENCY = 'KES';
const MINOR = 100;
const DEV_SERVICE = 'http://localhost:8099/';

function devServiceTarget() {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return null;
  if (location.protocol === 'http:' && location.hostname === 'localhost' && location.port === '8099') return null;
  return DEV_SERVICE;
}

async function routeToDevService() {
  const target = devServiceTarget();
  if (!target) return false;
  try {
    const response = await fetch(new URL('functions/v1/app/config', target), {
      mode: 'cors', credentials: 'omit', cache: 'no-store',
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.currency) return false;
  } catch {
    return false;
  }
  location.replace(target + location.hash);
  return true;
}

const state = {
  config: { paymentsConfigured: false, currency: CURRENCY, timezone: TZ },
  me: null,
  groups: [],
  group: null,
  activeGroupId: null,
  wallet: { availableMinor: 0, pendingMinor: 0, totalMinor: 0 },
  account: null,
  ledger: null,
  route: '/',
  returnRoute: null,
  pendingJoin: null,
  afterAuth: null,
  authMode: 'start',
  recoveryCodes: null,
  ledgerFilter: 'all',
  adminFilter: 'pending',
  adminUnlocked: false,
  adminLatchOpen: false,
  adminView: 'overview',
  clockSkew: 0,
  renderSeq: 0,
  countdownTimer: null,
  pollTimer: null,
  toastTimer: null,
  sheetOnMount: null,
  sheetOnClose: null,
  wheelAnimatedCycleId: null,
  newMemberIds: null,
  recap: { key: null, index: 0, timer: null },
  reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  online: navigator.onLine,
  installEvent: null,
};

const dom = {};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const icon = (name, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

const kesFormat = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 });

function money(minor) {
  const value = Number(minor);
  if (!Number.isFinite(value)) return 'KES 0';
  const major = value / MINOR;
  const decimals = Number.isInteger(major) ? 0 : 2;
  return `${CURRENCY} ${major.toLocaleString('en-KE', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function parseKes(raw) {
  const cleaned = String(raw ?? '').replace(/[^0-9.]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * MINOR);
}

function pct(bps) {
  const value = Number(bps) / 100;
  if (!Number.isFinite(value)) return '0%';
  return `${value.toLocaleString('en-KE', { maximumFractionDigits: 2 })}%`;
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'W';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hour12: false });

function fmtDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFmt.format(date);
}
function fmtDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFmt.format(date);
}
function fmtDay(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dayFmt.format(date);
}
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00:00';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
  return [hours, minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}
function serverNow() { return Date.now() + state.clockSkew; }
function tierName(score) {
  const value = Number(score);
  if (value < 40) return 'Building';
  if (value < 60) return 'Steady';
  if (value < 80) return 'Trusted';
  return 'Veteran';
}
function greeting() {
  const hour = Number(hourFmt.format(new Date()));
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/* Diegetic cues: every interaction sound is synthesised and panned to the
   control that produced it. Sound is optional; silence is never an error. */
const sound = (name, opts = {}) => globalThis.WheelSound?.play?.(name, opts) || false;
function soundAt(name, element, opts = {}) {
  const pan = element ? globalThis.WheelSound?.panFor?.(element) || 0 : 0;
  return sound(name, { pan, ...opts });
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS'
      : /Linux/.test(ua) ? 'Linux' : 'device';
  return `${browser} on ${os}`.slice(0, 90);
}

function b64uEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(value) {
  const normalised = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readCookie(name) {
  const parts = document.cookie ? document.cookie.split('; ') : [];
  for (const part of parts) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at) === name) return decodeURIComponent(part.slice(at + 1));
  }
  return null;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout ?? 16000);
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  const headers = new Headers(options.headers || {});
  let body;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCookie('wheel_csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
  }
  try {
    const response = await fetch(API_BASE + path, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!response.ok) {
      const devHost = ['localhost', '127.0.0.1'].includes(location.hostname);
      const message = data?.message || (response.status === 503
        ? 'The settlement service is not available right now.'
        : response.status === 401
          ? 'Sign in to continue.'
          : response.status === 404
            ? (devHost
              ? 'The account service is not running at this address. Start it with “npm run dev” and open http://localhost:8099.'
              : 'The account service is unavailable. Try again in a moment.')
            : response.status === 429
              ? 'Too many attempts. Wait a few minutes and try again.'
              : 'The account service returned an unexpected response. Try again.');
      const error = new ApiError(message, response.status, data?.error || data?.code);
      if (response.status === 401 && state.me) {
        signedOut();
        const route = routeFromHash();
        if (route && needsAuth(route)) renderRoute();
      }
      throw error;
    }
    if (text && data === null) {
      throw new ApiError(location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'This page is not connected to the account service. Start it with “npm run dev” and open http://localhost:8099.'
        : 'The account service returned an unexpected response. Reload and try again.', 502, 'bad_response');
    }
    state.online = true;
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new ApiError('The request timed out. Check your connection and try again.', 0, 'timeout');
    if (error instanceof ApiError) throw error;
    throw new ApiError('You appear to be offline. Reconnect and try again.', 0, 'network');
  } finally {
    clearTimeout(timeout);
  }
}

function toast(message, kind = '') {
  if (!dom.toast) return;
  clearTimeout(state.toastTimer);
  dom.toast.textContent = message;
  dom.toast.className = `toast${kind ? ` is-${kind}` : ''}`;
  requestAnimationFrame(() => dom.toast.classList.add('is-visible'));
  state.toastTimer = setTimeout(() => dom.toast.classList.remove('is-visible'), 4200);
}

function apiToast(error) {
  const message = error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
  toast(message, 'error');
}

function showDialog(dialog) {
  if (!dialog) return;
  if (!dialog.open) {
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  }
}
function hideDialog(dialog) {
  if (dialog?.open) {
    try { dialog.close(); } catch { dialog.removeAttribute('open'); }
  }
}

function openSheet({ kicker = 'THE WHEEL', title, body, foot = '', onMount = null, onClose = null }) {
  if (!dom.sheet) return;
  hideDialog(dom.sheet);
  dom.sheetKicker.textContent = kicker;
  dom.sheetTitle.textContent = title;
  dom.sheetBody.innerHTML = body;
  dom.sheetFoot.innerHTML = foot;
  state.sheetOnMount = onMount;
  state.sheetOnClose = onClose;
  showDialog(dom.sheet);
  requestAnimationFrame(() => {
    const focusTarget = dom.sheetBody.querySelector('input:not([type="hidden"]), select, textarea, button');
    focusTarget?.focus({ preventScroll: true });
    if (state.sheetOnMount) state.sheetOnMount();
  });
}

function closeSheet() {
  hideDialog(dom.sheet);
}

function setBusy(button, busy, label = '') {
  if (!button) return;
  if (busy) {
    if (!button.dataset.original) button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${label ? `<span>${esc(label)}</span>` : ''}`;
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.original) {
      button.innerHTML = button.dataset.original;
      delete button.dataset.original;
    }
  }
}

function formError(form, message) {
  const slot = form?.querySelector('[data-form-error]');
  if (!slot) return;
  if (message) {
    slot.innerHTML = `${icon('alert')}<span>${esc(message)}</span>`;
    slot.hidden = false;
    soundAt('error', slot);
    slot.scrollIntoView({ block: 'nearest' });
    return;
  }
  slot.textContent = '';
  slot.hidden = true;
}

function closeAllViews() {
  hideDialog(dom.authDialog);
  hideDialog(dom.sheet);
}

/* ---------------- auth ---------------- */

function authServiceNotice() {
  if (state.online !== false) return '';
  const target = devServiceTarget();
  if (target) {
    return `<div class="notice notice--amber">${icon('alert')}<span>The account service answers on <b>${esc(target.replace(/\/$/, ''))}</b>, not this address. <a href="${esc(target + location.hash)}">Open the running app</a></span></div>`;
  }
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  return `<div class="notice notice--amber">${icon('alert')}<span>The account service is not reachable from this address.${local ? ' Start it with “npm run dev” and open http://localhost:8099.' : ' Check your connection and try again.'}</span></div>`;
}

function updateAuthAside(mode) {  const title = dom.authAsideTitle;
  const copy = dom.authAsideCopy;
  if (!title || !copy) return;
  if (mode === 'register') {
    title.textContent = 'Create your seat.';
    copy.textContent = 'Start with your national ID: the register fills your name and date of birth, so one real person holds one seat. A passkey is your key, and you keep ten recovery codes.';
  } else if (mode === 'recover') {
    title.textContent = 'One-time way back in.';
    copy.textContent = 'A recovery code signs you in once. Use it to add a fresh passkey on this device, then keep the rest offline.';
  } else {
    title.textContent = 'Your seat at the wheel.';
    copy.textContent = 'A passkey is your key. No password to leak, no SMS code to intercept. The circle stays yours.';
  }
}

async function openAuth(mode = 'start') {
  if (state.me) {
    if (mode === 'register' && !state.groups?.length) {
      openCreateSheet();
      return;
    }
    navigate(state.groups?.length ? '/app' : '/settings');
    return;
  }
  state.authMode = mode;
  updateAuthAside(mode);
  renderAuth(mode);
  showDialog(dom.authDialog);
  if (state.online === false) {
    try {
      await api('/config', { timeout: 5000 });
      const dirty = [...dom.authBody.querySelectorAll('input')].some((input) => input.value);
      if (!dirty && dom.authDialog.open && state.authMode === mode) renderAuth(mode);
    } catch { /* the offline notice stands */ }
  }
}

function cutoffDate(yearsBack) {
  const date = new Date();
  date.setFullYear(date.getFullYear() - yearsBack);
  return date.toISOString().slice(0, 10);
}
const adultCutoff = () => cutoffDate(18);
const oldestCutoff = () => cutoffDate(110);
function ageFromDob(value) {
  const born = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(born)) return null;
  return (Date.now() - born) / (365.25 * 24 * 3600000);
}

/* The auth console reads its own stage: which dial is driving, which lamp is
   lit, and what the operator is asked to do next. Stage 0 park · 1 identity ·
   2 passkey · 3 recovery. */
function setAuthStage(stage, readout) {
  const dialog = dom.authDialog;
  if (!dialog) return;
  const next = Math.max(0, Math.min(3, Number(stage) || 0));
  const previous = Number(dialog.dataset.stage || '0');
  dialog.dataset.stage = String(next);
  const out = document.getElementById('authReadout');
  if (out && readout) out.innerHTML = readout;
  if (next !== previous) {
    soundAt(next > previous ? 'servo' : 'ratchet', dialog, { dir: next > previous ? 1 : -1, dur: 0.32, gain: 0.75, steps: 3 });
  }
}

function renderAuth(mode) {
  state.authMode = mode;
  const body = dom.authBody;
  if (!body) return;
  const caps = globalThis.__wheelCaps || {};
  dom.authDialog.dataset.mode = mode;
  document.getElementById('authDeviceStatus').textContent = caps.webauthn ? 'PASSKEY-CAPABLE BROWSER' : 'RECOVERY ACCESS AVAILABLE';
  if (mode === 'register') {
    setAuthStage(1, '<b>STEP 01 · IDENTITY</b>Type the record, then turn the key');
    body.innerHTML = `
      <div class="auth__steps" aria-hidden="true">
        <span class="is-active"><b>01</b><em>Identity</em></span>
        <span><b>02</b><em>Passkey</em></span>
        <span><b>03</b><em>Recovery</em></span>
      </div>
      <div class="auth__step">
        <p class="eyebrow">NEW ACCOUNT</p>
        <h2 class="auth__title">Start with your ID.</h2>
        <p class="auth__copy">Enter your national ID and we read the registered name and date of birth from the national register. Your account is matched to a real person — one ID, one seat. Your phone settles through <span class="nowrap">M-PESA</span> and stays masked in the circle view.</p>
      </div>
      ${authServiceNotice()}
      ${caps.webauthn ? '' : `<div class="notice notice--amber">${icon('alert')}<span>This browser cannot create a passkey. Use a secure browser with WebAuthn support, or sign in with a recovery code.</span></div>`}
      <form class="auth__form" data-form="auth-register" novalidate>
        <label class="field"><span>National ID number</span><input class="input mono" name="idNumber" inputmode="numeric" maxlength="8" autocomplete="off" spellcheck="false" placeholder="7 or 8 digits" required></label>
        <label class="pledge">
          <input type="checkbox" name="consent" value="1">
          <span><b>Check my record.</b> I agree that THE WHEEL and its identity partner may check this ID, my name, date of birth and phone against Kenya's national register.</span>
        </label>
        <button class="btn btn--ghost btn--block" type="button" data-action="id-peek">${icon('shield')} Check the register</button>
        <p class="hint idpeek" data-id-peek hidden></p>
        <label class="field"><span>Full legal name <em class="idpeek__tag" data-name-tag hidden>from the register</em></span><input class="input" name="name" autocomplete="name" maxlength="80" placeholder="e.g. Amina Wanjiru" required></label>
        <label class="field"><span>Date of birth <em class="idpeek__tag" data-dob-tag hidden>from the register</em></span><input class="input" name="dateOfBirth" type="date" autocomplete="bday" min="${oldestCutoff()}" max="${adultCutoff()}" required></label>
        <label class="field"><span>Phone · M-PESA</span><input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="24" placeholder="07xx xxx xxx" required></label>
        <label class="pledge">
          <input type="checkbox" name="terms" value="1">
          <span><b>I accept the Terms.</b> I have read the <a href="terms.html" target="_blank" rel="noopener">Terms of Service</a> and the <a href="privacy.html" target="_blank" rel="noopener">Privacy Notice</a>, including how circle money and my identity details are handled.</span>
        </label>
        <div class="auth__facts">
          <span>${icon('lock')} No password is stored</span>
          <span>${icon('shield')} No ID photo</span>
          <span>${icon('users')} One ID, one account</span>
        </div>
        <p class="hint">${icon('key')} Your private key never leaves this device. When the register matches your name, date of birth and phone, your ID is verified straight away; otherwise a reviewer checks it before seats and payouts unlock.</p>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit" ${caps.webauthn ? '' : 'disabled'}>Create my passkey ${icon('arrow')}</button>
      </form>
      <div class="auth__alt">Already have a seat? <button type="button" data-action="auth-back">Sign in with a passkey</button></div>
    `;
    return;
  }
  if (mode === 'recover') {
    setAuthStage(3, '<b>STEP 03 · RECOVERY RAIL</b>One code, one entry');
    body.innerHTML = `
      <div class="auth__step">
        <p class="eyebrow">RECOVERY ACCESS</p>
        <h2 class="auth__title">Use a recovery code.</h2>
        <p class="auth__copy">Each code works once. After signing in, add a new passkey to this device from Account settings.</p>
      </div>
      ${authServiceNotice()}
      <form class="auth__form" data-form="auth-recover" novalidate>
        <label class="field"><span>Phone number</span><input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="07xx xxx xxx" required></label>
        <label class="field"><span>Recovery code</span><input class="input mono" name="code" autocomplete="one-time-code" spellcheck="false" placeholder="XXXXX-XXXXX" required></label>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">Sign in ${icon('arrow')}</button>
      </form>
      <div class="auth__alt"><button type="button" data-action="auth-back">Back to passkey sign-in</button></div>
      <p class="auth__note">Recovery codes are single-use. If you have lost all of them, ask your organizer to pause your payouts while the circle resolves access.</p>
    `;
    return;
  }
  setAuthStage(0, '<b>KEY READY</b>Press the reader to sign in');
  body.innerHTML = `
    <div class="auth__step">
      <p class="eyebrow">ACCOUNT ACCESS</p>
      <h2 class="auth__title">Sign in to your circle.</h2>
      <p class="auth__copy">Use the passkey you created for THE WHEEL. Sign-in happens on this device; the server only checks the signature.</p>
    </div>
    ${authServiceNotice()}
    ${caps.webauthn ? '' : `<div class="notice notice--amber">${icon('alert')}<span>Passkeys are unavailable in this browser. Use a supported browser, or sign in with a recovery code.</span></div>`}
    <div class="auth__form">
      <button class="choice" type="button" autofocus data-action="auth-passkey" ${caps.webauthn ? '' : 'disabled'}>
        <span class="choice__icon">${icon('key')}</span>
        <span class="choice__copy"><b>Use a passkey</b><span>Face, fingerprint, or device PIN</span></span>
        ${icon('chevron')}
      </button>
      <button class="choice" type="button" data-action="auth-register">
        <span class="choice__icon">${icon('user')}</span>
        <span class="choice__copy"><b>Create an account</b><span>New to THE WHEEL? Set up a passkey</span></span>
        ${icon('chevron')}
      </button>
      <button class="choice" type="button" data-action="auth-recover">
        <span class="choice__icon">${icon('shield')}</span>
        <span class="choice__copy"><b>Use a recovery code</b><span>One-time access if your device is gone</span></span>
        ${icon('chevron')}
      </button>
    </div>
    <p class="error" data-form-error hidden></p>
    <p class="auth__note">THE WHEEL never asks for your <span class="nowrap">M-PESA</span> PIN. Contributions and payouts happen through the organizer's connected payment account.</p>
  `;
}

async function signInWithPasskey(button) {
  if (!globalThis.__wheelCaps?.webauthn) {
    toast('Passkeys are unavailable in this browser.', 'error');
    return;
  }
  setBusy(button, true);
  setAuthStage(2, '<b>STEP 02 · PASSKEY</b>Sign at the reader on this device');
  try {
    const options = await api('/auth/login/options', { method: 'POST', body: {} });
    if (!options?.publicKey?.challenge) {
      throw new Error('The account service did not return a sign-in challenge. Reload the page and try again.');
    }
    const publicKey = {
      ...options.publicKey,
      challenge: b64uDecode(options.publicKey.challenge),
      allowCredentials: (options.publicKey.allowCredentials || []).map((item) => ({
        ...item, id: b64uDecode(item.id),
      })),
    };
    let credential;
    try {
      credential = await navigator.credentials.get({ publicKey });
    } catch (error) {
      if (error?.name === 'NotAllowedError') throw new Error('The passkey prompt was closed. Try again, or use a recovery code.');
      throw error;
    }
    if (!credential) throw new Error('No passkey was selected.');
    const response = credential.response;
    const payload = {
      challengeId: options.challengeId,
      credential: {
        id: credential.id,
        rawId: b64uEncode(credential.rawId),
        type: credential.type,
        response: {
          authenticatorData: b64uEncode(response.authenticatorData),
          clientDataJSON: b64uEncode(response.clientDataJSON),
          signature: b64uEncode(response.signature),
          userHandle: response.userHandle ? b64uEncode(response.userHandle) : null,
        },
        clientExtensionResults: credential.getClientExtensionResults?.() || {},
      },
      deviceLabel: deviceLabel(),
    };
    const data = await api('/auth/login/verify', { method: 'POST', body: payload });
    setAuthStage(0, '<b>VERIFIED</b>Key accepted — opening your circle');
    sound('confirm', { pan: 0 });
    await postAuth(data);
  } catch (error) {
    setBusy(button, false);
    const message = error?.code === 'passkey_unknown'
      ? 'That passkey is not registered on this server. Create an account below, or use a recovery code.'
      : error.message || 'Passkey sign-in did not complete.';
    formError(dom.authBody, message);
    toast(message, 'error');
  }
}

async function peekIdentity(button) {
  const form = button.closest('form');
  if (!form) return;
  const slot = form.querySelector('[data-id-peek]');
  const idNumber = String(form.idNumber?.value || '').replace(/\s/g, '');
  if (!/^\d{7,8}$/.test(idNumber)) { formError(form, 'Enter the 7 or 8 digits of your national ID.'); return; }
  if (form.consent?.checked !== true) {
    formError(form, 'Tick the consent box so we can check that ID against the national register.');
    return;
  }
  formError(form, '');
  setBusy(button, true, 'Checking');
  const show = (tone, html) => {
    if (!slot) return;
    slot.hidden = false;
    slot.className = `hint idpeek idpeek--${tone}`;
    slot.innerHTML = `${tone === 'ok' ? icon('check') : icon('alert')}<span>${html}</span>`;
  };
  try {
    const result = await api('/identity/peek', { method: 'POST', body: { idNumber, consent: true } });
    if (result.found) {
      const dob = String(result.dateOfBirth || '').slice(0, 10);
      form.name.value = result.name || form.name.value;
      if (dob) form.dateOfBirth.value = dob;
      form.querySelector('[data-name-tag]')?.removeAttribute('hidden');
      if (dob) form.querySelector('[data-dob-tag]')?.removeAttribute('hidden');
      show('ok', `Registered as <b>${esc(result.name)}</b>${dob ? ` · born ${esc(fmtDate(`${dob}T12:00:00`))}` : ''}. Details filled in below — change them only if the register is wrong.${result.simulated ? ' <em>Sandbox register.</em>' : ''}`);
      sound('confirm', { pan: 0 });
    } else if (result.available === false) {
      show('warn', 'The national register is not answering right now. Type your details — a reviewer checks them before seats and payouts unlock.');
    } else {
      show('warn', 'That ID is not in the register. Check the digits, or type your details and a reviewer will follow up.');
    }
  } catch (error) {
    show('warn', esc(error.message));
  } finally {
    setBusy(button, false);
  }
}

async function registerPasskey(form) {
  const button = form.querySelector('[type="submit"]');
  formError(form, '');
  if (!globalThis.__wheelCaps?.webauthn) {
    formError(form, 'This browser cannot create a passkey.');
    return;
  }
  const name = String(form.name.value || '').trim();
  const phone = String(form.phone.value || '').trim();
  const idNumber = String(form.idNumber?.value || '').replace(/\s/g, '');
  const dateOfBirth = String(form.dateOfBirth?.value || '');
  if (name.length < 2) { formError(form, 'Enter your full name.'); return; }
  if (phone.replace(/\D/g, '').length < 9) { formError(form, 'Enter a valid phone number.'); return; }
  if (!/^\d{7,8}$/.test(idNumber)) { formError(form, 'Enter the 7 or 8 digits of your national ID.'); return; }
  const age = ageFromDob(dateOfBirth);
  if (age === null) { formError(form, 'Add your date of birth.'); return; }
  if (age < 18) { formError(form, 'Seats are for members aged 18 and over.'); return; }
  if (age > 110) { formError(form, 'Check that date of birth and try again.'); return; }
  const verificationConsent = form.consent?.checked === true;
  if (!verificationConsent) { formError(form, 'Tick the consent box so we can check your ID, name and phone against the national register.'); return; }
  if (!form.terms?.checked) { formError(form, 'Accept the Terms and Privacy Notice to create an account.'); return; }
  setBusy(button, true);
  setAuthStage(2, '<b>STEP 02 · PASSKEY</b>Hold this device to the reader to mint your key');
  try {
    const options = await api('/auth/register/options', { method: 'POST', body: { name, phone, idNumber, dateOfBirth, verificationConsent } });
    if (!options?.publicKey?.challenge || !options.publicKey.user?.id) {
      throw new Error('The account service did not return a passkey challenge. Reload the page and try again.');
    }
    if (!options.termsVersion) {
      throw new Error('Reload the page to load the current Terms before creating an account.');
    }
    const publicKey = {
      ...options.publicKey,
      challenge: b64uDecode(options.publicKey.challenge),
      user: { ...options.publicKey.user, id: b64uDecode(options.publicKey.user.id) },
      excludeCredentials: (options.publicKey.excludeCredentials || []).map((item) => ({
        ...item, id: b64uDecode(item.id),
      })),
    };
    let credential;
    try {
      credential = await navigator.credentials.create({ publicKey });
    } catch (error) {
      if (error?.name === 'InvalidStateError') throw new Error('A passkey for this account already exists on this device. Sign in instead.');
      if (error?.name === 'NotAllowedError') throw new Error('The passkey prompt was closed. Try again.');
      throw error;
    }
    if (!credential) throw new Error('The passkey was not created.');
    const response = credential.response;
    const payload = {
      challengeId: options.challengeId,
      termsVersion: options.termsVersion,
      credential: {
        id: credential.id,
        rawId: b64uEncode(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: b64uEncode(response.clientDataJSON),
          attestationObject: b64uEncode(response.attestationObject),
          transports: response.getTransports?.() || [],
        },
        clientExtensionResults: credential.getClientExtensionResults?.() || {},
      },
      deviceLabel: deviceLabel(),
    };
    const data = await api('/auth/register/verify', { method: 'POST', body: payload });
    setAuthStage(3, '<b>STEP 03 · RECOVERY</b>Ten one-time codes — store them offline');
    sound('confirm', { pan: 0 });
    await postAuth(data, { codes: data.recoveryCodes });
  } catch (error) {
    setBusy(button, false);
    setAuthStage(1, '<b>STEP 01 · IDENTITY</b>Adjust the record and try again');
    formError(form, error.message);
  }
}

async function recoverAccount(form) {
  const button = form.querySelector('[type="submit"]');
  formError(form, '');
  const phone = String(form.phone.value || '').trim();
  const code = String(form.code.value || '').trim();
  if (!phone || !code) { formError(form, 'Enter your phone and recovery code.'); return; }
  setBusy(button, true);
  try {
    const data = await api('/auth/recovery', { method: 'POST', body: { phone, code, deviceLabel: deviceLabel() } });
    await postAuth(data);
    toast('Recovery code accepted. Add a new passkey in Account.', 'lime');
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function postAuth(data, options = {}) {
  state.me = data.user;
  state.groups = data.groups || [];
  state.wallet = data.wallet || state.wallet;
  if (!state.activeGroupId && state.groups.length) {
    const stored = localStorage.getItem('wheel.activeGroup');
    const found = state.groups.find((group) => group.id === stored) || state.groups[0];
    state.activeGroupId = found.id;
  }
  syncChrome();
  hideDialog(dom.authDialog);
  if (options.codes?.length) {
    state.recoveryCodes = options.codes;
    showRecoveryCodes(options.codes);
    return;
  }
  await finishAuth();
}

async function showRecoveryCodes(codes) {
  state.recoveryCodes = codes;
  const body = `
    <div class="notice notice--amber">${icon('alert')}<span><b>These ten codes are shown once.</b> Keep them offline. Each code signs in exactly once if your passkey is unavailable.</span></div>
    <div class="codegrid" style="margin-top:14px">
      ${codes.map((code) => `<div class="code"><span>${esc(code)}</span><button type="button" data-action="copy" data-copy="${esc(code)}" aria-label="Copy code">${icon('copy')}</button></div>`).join('')}
    </div>
    <p class="hint" style="margin-top:12px">${icon('phone')} Add a passkey on any other device from Account settings using your recovery code.</p>
  `;
  openSheet({
    kicker: 'ACCOUNT CREATED',
    title: 'Your recovery codes',
    body,
    foot: `<button class="btn btn--line" type="button" data-action="download-codes">${icon('download')} Download</button><button class="btn btn--lime" type="button" data-action="recovery-done">I saved them</button>`,
    onClose: () => { void finishAuth(); },
  });
}

async function finishAuth() {
  const pending = state.pendingJoin || sessionStorage.getItem('wheel.pendingJoin');
  state.pendingJoin = null;
  sessionStorage.removeItem('wheel.pendingJoin');
  if (pending) {
    try {
      await joinGroup(pending, { silent: true });
      return;
    } catch (error) {
      apiToast(error);
    }
  }
  if (state.afterAuth === 'create') {
    state.afterAuth = null;
    openCreateSheet();
    return;
  }
  if (state.returnRoute) {
    const route = state.returnRoute;
    state.returnRoute = null;
    navigate(route);
    return;
  }
  navigate('/app');
}

function signedOut() {
  state.me = null;
  state.groups = [];
  state.group = null;
  state.account = null;
  state.ledger = null;
  state.wallet = { availableMinor: 0, pendingMinor: 0, totalMinor: 0 };
  hideDialog(dom.sheet);
  syncChrome();
  stopTimers();
}

/* ---------------- chrome / routing ---------------- */

function syncChrome() {
  const user = state.me;
  const name = user?.name || 'Account';
  const group = state.group?.group || state.groups.find((item) => item.id === state.activeGroupId) || null;
  if (!user && document.body.classList.contains('jarvis-open')) closeJarvis();
  if (dom.railName) dom.railName.textContent = name;
  if (dom.railAvatar) dom.railAvatar.textContent = initials(name);
  if (dom.mobileAvatar) dom.mobileAvatar.textContent = initials(name);
  if (dom.mobileWallet) dom.mobileWallet.textContent = money(state.wallet?.availableMinor || 0);
  if (dom.railGroup) dom.railGroup.textContent = group ? group.name.toUpperCase() : 'NO CIRCLE YET';
  if (dom.navLive) {
    const live = ['funded', 'auction', 'settling'].includes(state.group?.cycle?.status);
    dom.navLive.hidden = !live;
  }
  if (dom.navOpen) dom.navOpen.hidden = !(state.openCircles?.length > 0);
  const navAdmin = document.getElementById('adminLatch');
  if (navAdmin) navAdmin.hidden = !state.me?.isAdmin;
  const actions = document.querySelector('.topactions');
  if (actions) {
    actions.innerHTML = user
      ? `<button class="btn btn--quiet" type="button" data-action="open-account">Account</button><button class="btn btn--lime" type="button" data-action="open-app">Open my wheel ${icon('arrow')}</button>`
      : `<button class="sound-toggle" type="button" data-action="toggle-sound" aria-pressed="false" aria-label="Turn machine sound on"><span class="sound-toggle__slot" aria-hidden="true"></span><svg class="i" data-sound-icon><use href="#i-sound-on"></use></svg><span data-sound-label>Sound on</span></button><button class="btn btn--quiet" type="button" data-action="open-auth" data-mode="start">Sign in</button><button class="btn btn--lime" type="button" data-action="open-auth" data-mode="register">Create account ${icon('arrow')}</button>`;
  }
}

function setActiveNav(kind) {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    link.classList.toggle('is-active', link.dataset.nav === kind);
  });
}

function routeFromHash() {
  const hash = location.hash;
  if (!hash || hash === '#' || hash === '#/') return '/';
  if (!hash.startsWith('#/')) return null;
  return hash.slice(1);
}

const GROUP_ROUTE = /^\/g\/([0-9a-f-]{36})(?:\/(auction|turn|ledger|members|recap))?(?:\/(\d+))?$/;

function groupRoute(route = state.route) {
  const match = typeof route === 'string' ? route.match(GROUP_ROUTE) : null;
  if (!match) return null;
  return {
    id: match[1],
    view: match[2] || '',
    turn: match[3] ? Number(match[3]) : null,
  };
}

function activeGroupPath(suffix = '') {
  return state.activeGroupId ? `/g/${state.activeGroupId}${suffix}` : '/app';
}

function navigate(path, options = {}) {
  const target = `#${path}`;
  if (location.hash === target) {
    renderRoute();
    return;
  }
  if (options.replace) {
    history.replaceState(null, '', target);
    // replaceState does not fire hashchange; render the replacement route now.
    renderRoute();
  } else location.hash = target;
}

function showLobby() {
  stopTimers();
  closeAllViews();
  if (!dom.lobbyView || !dom.appView) return;
  dom.lobbyView.hidden = false;
  dom.appView.hidden = true;
  setActiveNav('');
  syncChrome();
}

function showApp() {
  if (!dom.lobbyView || !dom.appView) return;
  dom.lobbyView.hidden = true;
  dom.appView.hidden = false;
  syncChrome();
}

function needsAuth(route) {
  return route === '/app' || route === '/open' || route === '/settings' || route.startsWith('/g') || route.startsWith('/join/');
}

function ensureRouteProgress() {
  if (document.getElementById('routeProgress')) return;
  const bar = document.createElement('div');
  bar.id = 'routeProgress';
  bar.className = 'route-progress';
  bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML = '<i></i>';
  document.body.append(bar);
}

function markRouteProgress() {
  const bar = document.getElementById('routeProgress');
  if (!bar) return;
  bar.classList.remove('is-running');
  void bar.offsetWidth;
  bar.classList.add('is-running');
}

function renderRoute() {
  const route = routeFromHash();
  state.route = route || location.hash;
  // The operator door seals itself when the route leaves the console.
  if (route !== '/admin' && document.body.dataset.admin === 'on') {
    document.body.dataset.admin = 'off';
    state.adminUnlocked = false;
    state.adminLatchOpen = false;
  }
  markRouteProgress();
  clearTimeout(state.pollTimer);
  clearInterval(state.countdownTimer);
  stopEngineVoice();
  stopRecapPlayback();
  const practice = document.getElementById('practiceView');
  if (isPracticeRoute(route)) {
    state.renderSeq += 1;
    closeAllViews();
    dom.lobbyView.hidden = true;
    dom.appView.hidden = true;
    practice.hidden = false;
    renderPractice(practice);
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  leavePractice();
  practice.hidden = true;
  if (!accountReady) { void initializeAccount(); return; }
  // A signed-in account never sees the marketing lobby or its sign-up buttons.
  if ((route === null || route === '/') && state.me) {
    navigate('/app', { replace: true });
    return;
  }
  if (route === null) {
    showLobby();
    const target = document.getElementById(location.hash.slice(1));
    if (target) requestAnimationFrame(() => target.scrollIntoView({ behavior: state.reducedMotion ? 'auto' : 'smooth' }));
    return;
  }
  if (route === '/') {
    showLobby();
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }
  if (!state.me) {
    state.returnRoute = route;
    if (!dom.authDialog.open) {
      showLobby();
      window.scrollTo({ top: 0, behavior: 'auto' });
      openAuth('start');
    }
    return;
  }
  if (route.startsWith('/join/')) {
    const code = decodeURIComponent(route.slice('/join/'.length)).toUpperCase();
    if (code) {
      void joinGroup(code, { fromLink: true });
    } else navigate('/app', { replace: true });
    return;
  }
  showApp();
  closeAllViews();
  window.scrollTo({ top: 0, behavior: 'auto' });
  dom.workspace?.focus({ preventScroll: true });
  if (route === '/app') { setActiveNav('dashboard'); void viewDashboard(); return; }
  if (route === '/open') { setActiveNav('open'); void viewOpenCircles(); return; }
  if (route === '/settings') { setActiveNav('settings'); void viewSettings(); return; }
  if (route === '/admin') { setActiveNav(''); void viewAdmin(); return; }
  const groupPath = groupRoute(route);
  if (groupPath) {
    if (state.activeGroupId !== groupPath.id) {
      state.activeGroupId = groupPath.id;
      localStorage.setItem('wheel.activeGroup', groupPath.id);
      state.group = null;
    }
    if (groupPath.view === 'recap') { setActiveNav('circle'); void viewRecap(groupPath.turn); return; }
    if (groupPath.view === 'ledger') { setActiveNav('ledger'); void viewLedger(); return; }
    if (groupPath.view === 'members') { setActiveNav('members'); void viewMembers(); return; }
    if (groupPath.view === 'auction' || groupPath.view === 'turn') { setActiveNav('auction'); void viewAuction(); return; }
    setActiveNav('circle'); void viewCircle(); return;
  }
  if (route === '/g' || route === '/g/auction' || route === '/g/ledger' || route === '/g/members') {
    if (!ensureActiveGroup()) {
      setWorkspace(emptyGroupPage('Your circle', 'Create a circle or take an open seat, then this room opens.'));
      return;
    }
    const suffix = route === '/g' ? '' : route.slice(3).replace('/auction', '/turn');
    navigate(`/g/${state.activeGroupId}${suffix}`, { replace: true });
    return;
  }
  navigate('/app', { replace: true });
}

function clearWorkspaceFocus() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function stopTimers() {
  clearTimeout(state.pollTimer);
  clearInterval(state.countdownTimer);
  state.countdownTimer = null;
  stopRecapPlayback();
}

function setWorkspace(html) {
  if (!dom.workspace) return;
  dom.workspace.innerHTML = html;
  dom.workspace.classList.remove('is-switching');
  void dom.workspace.offsetWidth;
  dom.workspace.classList.add('is-switching');
  armCountdown();
}

function renderLoading() {
  setWorkspace(`
    <div class="page">
      <div class="skeleton skeleton--line" style="width:24%"></div>
      <div class="skeleton skeleton--line" style="width:44%;height:26px"></div>
      <div class="dash-grid" style="margin-top:24px">
        <div class="card span-8"><div class="skeleton skeleton--block"></div></div>
        <div class="card span-4"><div class="skeleton skeleton--block"></div></div>
        <div class="card span-7"><div class="skeleton skeleton--block"></div></div>
        <div class="card span-5"><div class="skeleton skeleton--block"></div></div>
      </div>
    </div>
  `);
}

function renderError(message, retry = true) {
  setWorkspace(`
    <div class="page">
      <div class="empty">
        <span class="empty__art">${icon('alert')}</span>
        <h2>That did not load.</h2>
        <p>${esc(message || 'The workspace could not be loaded. Check your connection and try again.')}</p>
        <div class="empty__actions">
          ${retry ? `<button class="btn btn--lime" type="button" data-action="refresh">Try again ${icon('arrow')}</button>` : ''}
          <button class="btn btn--line" type="button" data-action="open-app">Overview</button>
        </div>
      </div>
    </div>
  `);
}

/* ---------------- group loading ---------------- */

function ensureActiveGroup() {
  if (state.activeGroupId && state.groups.some((group) => group.id === state.activeGroupId)) return true;
  const stored = localStorage.getItem('wheel.activeGroup');
  const found = state.groups.find((group) => group.id === stored) || state.groups[0];
  if (found) {
    state.activeGroupId = found.id;
    localStorage.setItem('wheel.activeGroup', found.id);
    return true;
  }
  state.activeGroupId = null;
  return false;
}

async function loadMe() {
  try {
    const data = await api('/auth/me', { timeout: 12000 });
    state.me = data.user;
    state.groups = data.groups || [];
    state.wallet = data.wallet || state.wallet;
    if (data.config) state.config = { ...state.config, ...data.config };
    ensureActiveGroup();
  } catch (error) {
    if (error?.status === 401) {
      state.me = null;
      state.groups = [];
    } else {
      state.online = false;
    }
  }
  syncChrome();
}

async function loadConfig() {
  try {
    const data = await api('/config', { timeout: 8000 });
    state.config = { ...state.config, ...data };
  } catch { /* the lobby still works without the config endpoint */ }
}

const syncedCheckouts = new Set();

function maybeSyncCheckout(detail) {
  const contribution = detail?.cycle?.myContribution;
  if (!contribution || contribution.status === 'paid') return;
  const sessionId = contribution.checkoutSessionId;
  if (!sessionId || syncedCheckouts.has(sessionId)) return;
  syncedCheckouts.add(sessionId);
  api(`/payments/checkouts/${encodeURIComponent(sessionId)}/sync`, { method: 'POST', body: {} })
    .then(async (result) => {
      if (!result?.paid) return;
      toast('Payment confirmed. Your turn is in.', 'lime');
      const fresh = await loadGroupDetail({ silent: true }).catch(() => null);
      if (fresh && state.route.startsWith('/g')) renderCircle(fresh);
    })
    .catch(() => {});
}

async function loadGroupDetail({ silent = false } = {}) {
  if (!ensureActiveGroup()) return null;
  if (!silent) renderLoading();
  const seq = ++state.renderSeq;
  try {
    const detail = await api(`/groups/${state.activeGroupId}`);
    if (seq !== state.renderSeq) return null;
    state.group = detail;
    state.wallet = detail.wallet || state.wallet;
    if (detail.paymentsConfigured !== undefined) state.config.paymentsConfigured = detail.paymentsConfigured;
    if (detail.now) state.clockSkew = Date.now() - Date.parse(detail.now);
    syncChrome();
    maybeSyncCheckout(detail);
    return detail;
  } catch (error) {
    if (seq !== state.renderSeq) return null;
    if (error?.status === 404) {
      state.activeGroupId = null;
      localStorage.removeItem('wheel.activeGroup');
      state.group = null;
      state.groups = state.groups.filter((group) => group.id !== state.activeGroupId);
      await loadMe();
      return null;
    }
    throw error;
  }
}

/* ---------------- wheel markup ---------------- */

function polarPoint(cx, cy, radius, degrees) {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
}

function seatArc(start, end) {
  const outer = 190;
  const inner = 118;
  const [x1, y1] = polarPoint(200, 200, outer, start);
  const [x2, y2] = polarPoint(200, 200, outer, end);
  const [x3, y3] = polarPoint(200, 200, inner, end);
  const [x4, y4] = polarPoint(200, 200, inner, start);
  const large = end - start > 180 ? 1 : 0;
  return `M${x1.toFixed(1)} ${y1.toFixed(1)}A${outer} ${outer} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)}L${x3.toFixed(1)} ${y3.toFixed(1)}A${inner} ${inner} 0 ${large} 0 ${x4.toFixed(1)} ${y4.toFixed(1)}Z`;
}

function seatState(member, detail) {
  const { cycle, settlement } = detail;
  if (settlement?.winnerMembershipId === member.id) {
    return { key: 'won', label: `Took the pot · ${money(settlement.winnerNetMinor)} net`, tone: 'won' };
  }
  if (cycle?.status === 'contributing') {
    return member.paidThisCycle
      ? { key: 'paid', label: 'Funded this turn', tone: 'paid' }
      : { key: 'due', label: 'Funding due', tone: 'due' };
  }
  if (['funded', 'auction', 'settling'].includes(cycle?.status)) {
    const ladder = cycle?.ladderMinor || detail.group?.seatLadderBps || [];
    const price = ladder[(Number(member.seat) || 1) - 1] ?? 0;
    if (cycle?.turnOwner?.membershipId === member.id) {
      return { key: 'won', label: `This turn pays seat ${member.seat} · ${pct(price)}`, tone: 'won' };
    }
    if (member.hasWon) return { key: 'wait', label: 'Already received · still contributes', tone: 'wait' };
    return { key: 'live', label: `Pays on turn ${member.seat} · ${pct(price)}`, tone: 'live' };
  }
  if (member.hasWon) return { key: 'wait', label: 'Already took a pot', tone: 'wait' };
  return member.paidThisCycle
    ? { key: 'paid', label: 'Funded', tone: 'paid' }
    : { key: 'idle', label: 'Waiting for turn one', tone: 'idle' };
}

function wheelMarkup(detail, options = {}) {
  const members = [...(detail.members || [])].sort((a, b) => (a.seat || 0) - (b.seat || 0));
  const count = Math.max(1, members.length);
  const step = 360 / count;
  const gap = count > 8 ? 1.4 : 2.6;
  const compact = Boolean(options.compact);
  const { cycle, settlement, group } = detail;
  const winnerId = settlement?.winnerMembershipId;
  const winnerIndex = winnerId ? members.findIndex((member) => member.id === winnerId) : -1;
  const winnerAngle = winnerIndex >= 0 ? winnerIndex * step + step / 2 : 0;
  const meId = state.me?.id;
  const seats = members.map((member, index) => {
    const start = index * step + gap / 2;
    const end = (index + 1) * step - gap / 2;
    const mid = index * step + step / 2;
    const [tx, ty] = polarPoint(200, 200, 154, mid);
    const [dx, dy] = polarPoint(200, 200, 183, mid);
    const seat = seatState(member, detail);
    const classes = ['seat', `seat--${seat.key}`, index % 2 ? 'seat--alt' : '', member.userId === meId ? 'is-me' : '', member.role === 'organizer' ? 'is-org' : ''].filter(Boolean).join(' ');
    const sub = [
      `Seat ${member.seat}`,
      member.role === 'organizer' ? 'Organizer' : '',
      member.guarantor ? `Guaranteed by ${member.guarantor.name}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <g class="${classes}" tabindex="0" role="listitem" style="--i:${index}" data-seat="${Number(member.seat) || index + 1}" data-name="${esc(member.name)}" data-tag="${esc(seat.label)}" data-tone="${seat.tone}" data-sub="${esc(sub)}">
        <title>${esc(member.name)} — ${esc(seat.label)}</title>
        <path class="seat__arc" d="${seatArc(start, end)}"/>
        <text class="seat__initials" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}">${esc(initials(member.name))}</text>
        <circle class="seat__dot" cx="${dx.toFixed(1)}" cy="${dy.toFixed(1)}" r="3.4"/>
      </g>
    `;
  }).join('');
  const paid = cycle?.paidCount || 0;
  const total = cycle?.memberCount || members.length || 0;
  const potMinor = Number(settlement?.potMinor ?? cycle?.potCapturedMinor ?? 0);
  const dial = compact ? '' : `
          <g class="seatwheel__ticks" aria-hidden="true">${Array.from({ length: 60 }, (_, index) => {
            const angle = index * 6;
            const [x1, y1] = polarPoint(200, 200, index % 5 ? 99 : 94, angle);
            const [x2, y2] = polarPoint(200, 200, 105, angle);
            return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"${index % 5 ? '' : ' class="is-major"'}/>`;
          }).join('')}</g>
          <g class="seatwheel__sat" aria-hidden="true"><circle cx="200" cy="92" r="2.6"/></g>`;
  let hubLabel = 'THE CIRCLE';
  let hubValue = `${members.length}`;
  let hubMeta = 'seats filled';
  if (cycle) {
    hubLabel = settlement ? 'SETTLED TURN' : `TURN ${cycle.number}`;
    hubValue = compact
      ? `${paid}/${total}`
      : settlement ? money(settlement.winnerNetMinor) : money(cycle.potCapturedMinor || 0);
    hubMeta = compact
      ? 'seats funded'
      : settlement ? `${settlement.winnerName.split(/\s+/)[0]} · ${pct(settlement.discountBps)}` : `${paid}/${total} funded`;
  }
  const timer = !compact && options.timer && cycle?.auctionClosesAt && !settlement
    ? `<span class="seatwheel__timer" data-countdown="${esc(cycle.auctionClosesAt)}" data-done="Closed">00:00:00</span>`
    : '';
  const hint = cycle
    ? `${paid}/${total} funded · ${compact ? 'hover a seat' : 'hover or tap a seat to inspect'}`
    : `${members.length} seats · ${compact ? 'hover a seat' : 'hover or tap a seat to inspect'}`;
  const seatRatio = total ? Math.min(1, paid / total) : 0;
  return `
    <figure class="seatwheel${compact ? ' seatwheel--compact' : ''}${settlement ? ' is-settled' : ''}" data-seatwheel>
      <div class="seatwheel__stage" style="--seat-p:${seatRatio.toFixed(3)}">
        <div class="seatwheel__plate" aria-hidden="true"></div>
        <svg class="seatwheel__svg" viewBox="0 0 400 400" role="list" aria-label="Seats in ${esc(group?.name || 'the circle')}">
          <circle class="seatwheel__orbit" cx="200" cy="200" r="190"/>
          <circle class="seatwheel__orbit seatwheel__orbit--inner" cx="200" cy="200" r="118"/>
          ${dial}
          <g class="seatwheel__needle${winnerId ? ' is-visible' : ''}" data-needle="${winnerAngle.toFixed(1)}" style="--needle:0deg" aria-hidden="true"><path d="M200 4 L212 30 L188 30 Z"/></g>
          ${seats}
        </svg>
        <div class="seatwheel__hub">
          <span class="seatwheel__label">${hubLabel}</span>
          <b class="seatwheel__value" data-pot-minor="${potMinor}">${hubValue}</b>
          <span class="seatwheel__meta">${esc(hubMeta)}</span>
          ${timer}
        </div>
      </div>
      <figcaption class="seatwheel__readout" data-seat-readout><span class="seatwheel__hint">${esc(hint)}</span></figcaption>
    </figure>
  `;
}

function seatHover(seat) {
  const wheel = seat.closest('[data-seatwheel]');
  if (!wheel) return;
  wheel.querySelectorAll('.seat.is-active').forEach((node) => { if (node !== seat) node.classList.remove('is-active'); });
  seat.classList.add('is-active');
  const readout = wheel.querySelector('[data-seat-readout]');
  if (!readout) return;
  const tone = seat.dataset.tone || 'idle';
  readout.innerHTML = `
    <span class="seatreadout__name">${esc(seat.dataset.name || 'Seat')}</span>
    <span class="seatreadout__sub">${esc(seat.dataset.sub || '')}</span>
    <span class="seatreadout__tag seatreadout__tag--${tone}">${esc(seat.dataset.tag || '')}</span>
  `;
}

function highlightSeat(seatNumber) {
  const seat = dom.workspace?.querySelector(`.seat[data-seat="${Number(seatNumber) || ''}"]`);
  if (seat) seatHover(seat);
}

function revealSeats(detail, animate) {
  const wheel = dom.workspace?.querySelector('[data-seatwheel]');
  if (!wheel) return;
  wheel.querySelectorAll('.seat--won').forEach((seat) => seat.classList.add('is-revealed'));
  const needle = wheel.querySelector('[data-needle]');
  if (!needle) return;
  const target = `${needle.dataset.needle}deg`;
  if (!animate || state.reducedMotion) {
    needle.style.setProperty('--needle', target);
    return;
  }
  needle.style.setProperty('--needle', '0deg');
  requestAnimationFrame(() => requestAnimationFrame(() => needle.style.setProperty('--needle', target)));
}

/* The wheel answers while it is looked at: the pot climbs to each new
   contribution, the dial turns, and a settled turn throws light outward. */
function countUpPot(node, fromMinor, toMinor) {
  const started = performance.now();
  const span = toMinor - fromMinor;
  const step = (now) => {
    const t = Math.min(1, (now - started) / 720);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = money(Math.round(fromMinor + span * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function burstWheel(stage) {
  if (!stage) return;
  const wheel = stage.closest('.seatwheel');
  wheel?.classList.add('is-celebrating');
  for (let index = 0; index < 18; index += 1) {
    const shard = document.createElement('i');
    shard.className = 'seatwheel__shard';
    shard.style.setProperty('--a', `${index * 20 + (index % 3) * 4}deg`);
    shard.style.setProperty('--d', `${110 + (index % 4) * 26}px`);
    shard.style.setProperty('--dl', `${(index % 5) * 45}ms`);
    stage.appendChild(shard);
    setTimeout(() => shard.remove(), 1400);
  }
  setTimeout(() => wheel?.classList.remove('is-celebrating'), 1700);
}

function armWheelFx(detail) {
  const wheel = dom.workspace?.querySelector('[data-seatwheel]');
  if (!wheel) return;
  const stage = wheel.querySelector('.seatwheel__stage');
  const value = wheel.querySelector('.seatwheel__value');
  const potMinor = Number(value?.dataset.potMinor || 0);
  const key = detail?.cycle?.id || 'none';
  const previous = state.wheelPot;
  if (value && previous && previous.key === key && previous.minor !== potMinor) {
    if (state.reducedMotion) value.textContent = money(potMinor);
    else countUpPot(value, previous.minor, potMinor);
    value.classList.add('is-bumped');
    setTimeout(() => value.classList.remove('is-bumped'), 900);
    const headline = dom.workspace?.querySelector('.auction__pot b');
    if (headline) {
      headline.classList.add('is-bumped');
      setTimeout(() => headline.classList.remove('is-bumped'), 900);
    }
  }
  state.wheelPot = { key, minor: potMinor };
  const settlementId = detail?.settlement?.id;
  if (settlementId && state.settledSeen !== settlementId) {
    state.settledSeen = settlementId;
    if (!state.reducedMotion) burstWheel(stage);
  }
  if (stage && !stage.dataset.fx) {
    stage.dataset.fx = '1';
    stage.addEventListener('pointermove', (event) => {
      const rect = stage.getBoundingClientRect();
      stage.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      stage.style.setProperty('--my', `${event.clientY - rect.top}px`);
      // The dial leans into the pointer; the light follows it.
      if (rect.width && state.reducedMotion === false) {
        const nx = Math.max(-0.5, Math.min(0.5, (event.clientX - rect.left) / rect.width - 0.5));
        const ny = Math.max(-0.5, Math.min(0.5, (event.clientY - rect.top) / rect.height - 0.5));
        stage.style.setProperty('--tilt-x', nx.toFixed(3));
        stage.style.setProperty('--tilt-y', ny.toFixed(3));
      }
      stage.classList.add('is-pointing');
    });
    const settle = () => {
      stage.classList.remove('is-pointing');
      stage.style.setProperty('--tilt-x', '0');
      stage.style.setProperty('--tilt-y', '0');
    };
    stage.addEventListener('pointerleave', settle);
    stage.addEventListener('pointercancel', settle);
  }
}

/* ---------------- countdown / polling ---------------- */

function armCountdown() {
  clearInterval(state.countdownTimer);
  const elements = [...(dom.workspace?.querySelectorAll('[data-countdown]') || [])];
  if (!elements.length) return;
  const update = () => {
    const now = serverNow();
    elements.forEach((el) => {
      const target = Date.parse(el.dataset.countdown);
      const diff = target - now;
      el.textContent = diff > 0 ? fmtDuration(diff) : (el.dataset.done || 'Closed');
      el.classList.toggle('is-urgent', diff > 0 && diff < 60 * 60 * 1000);
      el.classList.toggle('is-closed', diff <= 0);
      const wheel = el.closest('.seatwheel');
      if (wheel) wheel.classList.toggle('is-urgent', diff > 0 && diff < 60 * 60 * 1000);
    });
  };
  update();
  state.countdownTimer = setInterval(update, 1000);
}

function startAuctionPoll() {
  clearTimeout(state.pollTimer);
  const onTurn = () => ['turn', 'auction'].includes(groupRoute(state.route)?.view) || state.route === '/g/auction';
  const tick = async () => {
    if (!onTurn() || document.hidden || !state.activeGroupId) return;
    let rendered = false;
    try {
      const detail = await api(`/groups/${state.activeGroupId}`, { timeout: 10000 });
      const previous = state.group?.cycle;
      const previousSettlementId = state.group?.settlement?.id;
      let next = detail.cycle;
      state.group = detail;
      state.wallet = detail.wallet || state.wallet;
      if (detail.now) state.clockSkew = Date.now() - Date.parse(detail.now);
      syncChrome();
      // A whole pot pays out with no clock and no button: whoever is watching settles it.
      if (next?.canClose && !detail.settlement && state.autoSettleCycle !== next.id) {
        state.autoSettleCycle = next.id;
        try {
          await api(`/groups/${detail.group.id}/cycles/${next.id}/close`, { method: 'POST', body: {} });
          const fresh = await api(`/groups/${state.activeGroupId}`, { timeout: 10000 });
          state.group = fresh;
          next = fresh.cycle;
          renderAuction(fresh, { poll: true });
          rendered = true;
        } catch { state.autoSettleCycle = null; }
      }
      const changed = next && (
        next.status !== previous?.status
        || next.potCapturedMinor !== previous?.potCapturedMinor
        || next.canClose !== previous?.canClose
        || state.group?.settlement?.id !== previousSettlementId
      );
      if (!rendered && changed) {
        renderAuction(state.group, { poll: true });
        rendered = true;
      }
    } catch { /* polling is best effort */ }
    if (!rendered && onTurn()) state.pollTimer = setTimeout(tick, 4000);
  };
  state.pollTimer = setTimeout(tick, 4000);
}

function startFormingPoll() {
  clearTimeout(state.pollTimer);
  const watching = () => state.route === '/app' || Boolean(groupRoute(state.route));
  const tick = async () => {
    if (!watching() || document.hidden || !state.activeGroupId) return;
    if (dom.sheet?.open || dom.authDialog?.open) {
      state.pollTimer = setTimeout(tick, 5000);
      return;
    }
    let rendered = false;
    try {
      const detail = await api(`/groups/${state.activeGroupId}`, { timeout: 10000 });
      const previous = state.group;
      const previousIds = new Set((previous?.members || []).map((member) => member.id));
      const added = (detail.members || []).filter((member) => !previousIds.has(member.id)).map((member) => member.id);
      const countChanged = detail.group?.memberCount !== previous?.group?.memberCount;
      const stageMoved = detail.group?.status !== 'forming' || Boolean(detail.cycle);
      state.group = detail;
      state.wallet = detail.wallet || state.wallet;
      if (detail.now) state.clockSkew = Date.now() - Date.parse(detail.now);
      syncChrome();
      if (added.length) state.newMemberIds = added;
      if (!watching()) return;
      if (countChanged || stageMoved) {
        const view = groupRoute(state.route)?.view;
        if (state.route === '/app') renderDashboard(detail);
        else if (!view) renderCircle(detail);
        else if (view === 'turn' || view === 'auction') renderAuction(detail);
        rendered = true;
        if (countChanged && added.length) {
          toast(`${added.length === 1 ? 'A new member joined' : `${added.length} new members joined`} · ${detail.group.memberCount} of ${detail.group.maxMembers} seats`, 'lime');
        } else if (previous?.group?.status === 'forming' && detail.group.status !== 'forming') {
          toast('The organizer opened turn one. Fund your contribution.', 'lime');
        }
        if (added.length) setTimeout(() => { state.newMemberIds = null; }, 1500);
      }
    } catch { /* polling is best effort */ }
    if (!rendered && watching()) state.pollTimer = setTimeout(tick, 5000);
  };
  state.pollTimer = setTimeout(tick, 5000);
}

/* ---------------- shared fragments ---------------- */

function pill(text, variant = '') {
  return `<span class="pill${variant ? ` pill--${variant}` : ''}">${esc(text)}</span>`;
}

function statusPill(status) {
  const map = {
    forming: ['FORMING', ''],
    active: ['ACTIVE', 'lime'],
    completed: ['COMPLETE', ''],
    contributing: ['FUNDING', 'amber'],
    funded: ['LIVE', 'live'],
    auction: ['LIVE', 'live'],
    settling: ['SETTLING', 'amber'],
    settled: ['SETTLED', 'lime'],
    closed: ['CLOSED', ''],
  };
  const [label, variant] = map[status] || [String(status || '').toUpperCase(), ''];
  return `<span class="pill${variant ? ` pill--${variant}` : ''}">${variant === 'live' ? '<span class="live-dot"></span>' : ''}${label}</span>`;
}

function pageHead({ eyebrow = '', title, sub = '', actions = '' }) {
  return `
    <header class="page-head">
      <div>
        ${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}
        <h1 class="page-title">${title}</h1>
        ${sub ? `<p class="page-sub">${sub}</p>` : ''}
      </div>
      ${actions ? `<div class="page-head__actions">${actions}</div>` : ''}
    </header>
  `;
}

function stat(k, v, meta = '', variant = '') {
  return `<div class="stat"><span class="stat__k">${esc(k)}</span><b class="stat__v${variant ? ` stat__v--${variant}` : ''}">${v}</b>${meta ? `<span class="stat__meta">${meta}</span>` : ''}</div>`;
}

function progressBar(value, max) {
  const width = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return `<div class="next-turn__bar"><i style="--p:${width}%"></i></div>`;
}

function fundingRail(detail) {
  const { cycle, settlement } = detail;
  const members = [...(detail.members || [])].sort((a, b) => (a.seat || 0) - (b.seat || 0));
  if (!members.length) return '';
  const meId = state.me?.id;
  const winnerId = settlement?.winnerMembershipId;
  return `
    <div class="fundrail" role="group" aria-label="Seat funding this turn">
      <div class="fundrail__chips">
        ${members.map((member) => {
          const seatKey = winnerId === member.id ? 'won' : member.paidThisCycle ? 'paid' : 'due';
          const stateLabel = seatKey === 'won' ? 'took the pot' : seatKey === 'paid' ? 'funded this turn' : 'funding due';
          return `<button type="button" class="fundchip fundchip--${seatKey}${member.userId === meId ? ' is-me' : ''}" data-action="seat" data-seat="${Number(member.seat) || ''}" title="${esc(member.name)} · ${stateLabel}" aria-label="${esc(member.name)}: ${stateLabel}">
            <span>${esc(initials(member.name))}</span>
            ${seatKey === 'paid' ? icon('check') : seatKey === 'won' ? icon('star') : ''}
          </button>`;
        }).join('')}
      </div>
      <span class="fundrail__sum"><b>${cycle?.paidCount || 0}/${cycle?.memberCount || members.length}</b> funded</span>
    </div>
  `;
}

function lifecycleTrack(detail) {
  const { group, cycle, settlement } = detail;
  const stage = settlement || cycle?.status === 'settled' || cycle?.status === 'settling' ? 3
    : cycle?.status === 'funded' || cycle?.status === 'auction' ? 2
      : cycle?.status === 'contributing' ? 1 : 0;
  const steps = [
    { k: 'Seats', note: group.status === 'forming' ? `${group.memberCount} of ${group.maxMembers}` : `${cycle?.memberCount || group.memberCount} locked` },
    { k: 'Funding', note: cycle ? `${cycle.paidCount}/${cycle.memberCount} paid` : 'opens with turn one' },
    { k: 'Wheel turns', note: cycle?.isFinal ? 'final seat · 0%' : cycle?.turnOwner ? `seat ${cycle.turnOwner.seatNo} is paid` : 'no clock' },
    { k: 'Settlement', note: settlement ? `${money(settlement.winnerNetMinor)} net` : 'the moment the pot is whole' },
  ];
  return `
    <ol class="lifecycle" aria-label="Turn lifecycle">
      ${steps.map((step, index) => {
        const cls = index < stage ? ' is-done' : index === stage ? ' is-active' : '';
        return `<li class="lifecycle__step${cls}"><i class="lifecycle__node">${index < stage ? icon('check') : index + 1}</i><span class="lifecycle__k">${step.k}</span><span class="lifecycle__note">${step.note}</span></li>`;
      }).join('')}
    </ol>
  `;
}

function flowMarkup(settlement, detail) {
  const pot = Math.max(1, settlement.potMinor);
  const width = (amount) => Math.max(2, Math.min(100, Math.round((Math.abs(amount) / pot) * 100)));
  const row = (label, amount, tone) => `
    <div class="flow__row${tone ? ` flow__row--${tone}` : ''}">
      <span class="flow__k">${label}</span>
      <span class="flow__track"><i style="--w:${width(amount)}%"></i></span>
      <b>${amount < 0 ? '− ' : ''}${money(Math.abs(amount))}</b>
    </div>`;
  const orgAmount = settlement.organizerFeeMinor || settlement.organizerFeeWaivedMinor || 0;
  return `
    <div class="flow" aria-label="Settlement waterfall">
      ${row('Pot captured', settlement.potMinor, 'source')}
      ${settlement.discountMinor ? row(`Early-bird price ${pct(settlement.discountBps)} · ${settlement.waiterCount} patient seat${settlement.waiterCount === 1 ? '' : 's'}`, -settlement.discountMinor, 'discount') : ''}
      ${row(`Platform ${pct(detail.rules?.platformBps || 100)}`, -settlement.platformFeeMinor, 'fee')}
      ${row(`Organizer ${settlement.organizerFeeWaivedMinor && !settlement.organizerFeeMinor ? '· waived to fund' : `· ${pct(detail.group.organizerFeeBps)}`}`, -orgAmount, 'fee')}
      ${row(`Guarantee fund ${pct(detail.rules?.fundBps || 100)}`, -settlement.fundFeeMinor, 'fee')}
      ${settlement.bondHoldMinor ? row('Bond held', -settlement.bondHoldMinor, 'bond') : ''}
      <div class="flow__row flow__row--total">
        <span class="flow__k">Winner net</span>
        <span class="flow__track"><i style="--w:${width(settlement.winnerNetMinor)}%"></i></span>
        <b>${money(settlement.winnerNetMinor)}</b>
      </div>
    </div>
  `;
}

function moveCard(detail, next) {
  return `
    <section class="card span-12 move-card move-card--${next.tone || 'lime'}">
      <span class="move-card__icon">${icon(next.icon || 'bolt')}</span>
      <div class="move-card__copy">
        <span class="move-card__k">YOUR MOVE</span>
        <b>${esc(next.title || next.label)}</b>
        <span>${esc(next.copy || '')}</span>
      </div>
      ${next.meta ? `<div class="move-card__meta">${next.meta}</div>` : ''}
      <button class="btn btn--lime btn--sm" type="button" data-action="${next.action}" ${next.disabled ? 'disabled' : ''} data-path="${next.path || ''}">${next.label} ${icon('arrow')}</button>
    </section>
  `;
}

function trustRing(score) {
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(99, Number(score) || 0)) / 99;
  return `<svg class="trustring" viewBox="0 0 52 52" aria-hidden="true"><circle class="trustring__track" cx="26" cy="26" r="${radius}"/><circle class="trustring__fill" cx="26" cy="26" r="${radius}" stroke-dasharray="${circumference.toFixed(1)}" stroke-dashoffset="${(circumference * (1 - filled)).toFixed(1)}" transform="rotate(-90 26 26)"/></svg>`;
}

function bondLadder(bondBps) {
  const bands = [[80, 1000, 'Veteran'], [60, 1500, 'Trusted'], [40, 2000, 'Steady'], [0, 2500, 'Building']];
  return `
    <div class="bondladder">
      ${bands.map(([score, bps, name]) => `
        <div class="bondladder__row${Number(bondBps) === bps ? ' is-current' : ''}">
          <span>${name}<em>Trust ${score}+</em></span>
          <b>${pct(bps)}</b>
          ${Number(bondBps) === bps ? '<i>YOUR BAND</i>' : ''}
        </div>
      `).join('')}
    </div>
  `;
}


function kindMeta(kind) {
  const map = {
    contribution: ['Contribution', 'wallet'],
    discount: ['Patience share', 'trend'],
    winner: ['Winner payout', 'download'],
    bond_hold: ['Bond held', 'lock'],
    bond_release: ['Bond released', 'lock'],
    bond_forfeit: ['Bond forfeited', 'alert'],
    platform_fee: ['Platform fee', 'ledger'],
    organizer_fee: ['Organizer fee', 'ledger'],
    fund_fee: ['Guarantee fund', 'shield'],
    fund_split: ['Fund distribution', 'users'],
    withdrawal: ['Withdrawal', 'download'],
    withdrawal_refund: ['Withdrawal returned', 'trend'],
    cover: ['Contribution covered', 'shield'],
    deposit: ['Deposit', 'wallet'],
    adjustment: ['Adjustment', 'settings'],
  };
  return map[kind] || [String(kind || 'Entry').replace(/_/g, ' '), 'ledger'];
}

function ledgerRow(entry) {
  const [label, iconName] = kindMeta(entry.kind);
  const effect = Number(entry.walletEffect || 0);
  const amountClass = effect > 0 ? ' ledger__amt--in' : effect < 0 ? ' ledger__amt--out' : '';
  const amount = effect > 0 ? `+ ${money(effect)}` : effect < 0 ? `− ${money(Math.abs(effect))}` : money(entry.amountMinor);
  const iconClass = effect > 0 ? ' ledger__icon--in' : entry.kind === 'withdrawal' ? ' ledger__icon--risk' : entry.kind === 'winner' ? ' ledger__icon--live' : '';
  const meta = [label, `${entry.roundNumber ? `Round ${entry.roundNumber} · ` : ''}Turn ${entry.cycleNumber || '—'}`, fmtDateTime(entry.createdAt), entry.actorName].filter(Boolean).join(' · ');
  return `
    <div class="ledger__row">
      <span class="ledger__icon${iconClass}">${icon(iconName)}</span>
      <div class="ledger__main"><b>${esc(entry.memo || label)}</b><span>${esc(meta)}</span></div>
      <span class="ledger__amt${amountClass}">${amount}</span>
    </div>
  `;
}

function fundEntryRow(entry) {
  const positive = Number(entry.amountMinor) >= 0;
  return `
    <div class="ledger__row">
      <span class="ledger__icon${positive ? ' ledger__icon--in' : ' ledger__icon--risk'}">${icon('shield')}</span>
      <div class="ledger__main"><b>${esc(entry.memo || entry.kind.replace(/_/g, ' '))}</b><span>${esc(fmtDateTime(entry.createdAt))}</span></div>
      <span class="ledger__amt${positive ? ' ledger__amt--in' : ' ledger__amt--out'}">${positive ? '+' : '−'} ${money(Math.abs(entry.amountMinor))}</span>
    </div>
  `;
}

function trustCard(detail) {
  const me = detail.me;
  if (!me) return '';
  return `
    <section class="card span-5">
      <div class="card__head"><h2 class="card__title">Your standing</h2>${pill(tierName(me.trustScore), 'lime')}</div>
      <div class="trust-card">
        <div class="trust-score"><b>${me.trustScore}</b><span>/ 99 · ${tierName(me.trustScore)}</span></div>
        <div class="trustbar"><i style="width:${Math.min(100, me.trustScore)}%"></i></div>
        <div class="trust-facts">
          <span>Bond band <b>${pct(me.bondBps)}</b></span>
          <span>On-time turns <b>${me.ontimeCycles}</b></span>
          <span>Late turns <b>${me.lateCycles}</b></span>
          <span>Defaults <b>${me.defaults}</b></span>
          <span>Guarantor <b>${me.guarantor ? esc(me.guarantor.name) : 'None yet'}</b></span>
        </div>
        <p class="hint">${me.kycStatus === 'verified' ? `${icon('check')} Verified by the organizer. Payouts can settle.` : `${icon('phone')} Phone and identity are verified with the organizer before your first payout.`}</p>
      </div>
    </section>
  `;
}

function walletDue(detail) {
  const cycle = detail?.cycle;
  if (!cycle || cycle.status === 'settled') return null;
  if (cycle.myContribution?.status === 'paid') return null;
  return Number(cycle.amountDueMinor || detail?.group?.contributionMinor || 0) || null;
}

function walletCard(detail) {
  const wallet = detail.wallet || {};
  const due = walletDue(detail);
  const available = Number(wallet.availableMinor || 0);
  const turns = due ? Math.floor(available / due) : null;
  const coverPct = due ? Math.min(100, Math.round((available / due) * 100)) : 0;
  return `
    <section class="card span-4 wallet-card">
      <div class="card__head"><h2 class="card__title">Your stash</h2>${pill('KES', 'lime')}</div>
      <span class="stat__k">AVAILABLE NOW</span>
      <b class="wallet-card__v">${money(available)}</b>
      <span class="wallet-card__sub">${wallet.pendingMinor ? `${money(wallet.pendingMinor)} clearing until release` : 'Nothing on hold'}</span>
      ${due ? `<div class="wallet-cover">
        <div class="wallet-cover__line"><span>Turn ${detail.cycle.number} due ${money(due)}</span><b class="${turns > 0 ? 'is-ok' : 'is-short'}">${turns > 0 ? `covers ${turns} turn${turns === 1 ? '' : 's'}` : 'short of one turn'}</b></div>
        <div class="wallet-cover__bar" role="img" aria-label="${coverPct}% of the next contribution covered"><i style="width:${coverPct}%"></i></div>
      </div>` : '<div class="wallet-cover wallet-cover--clear">No contribution due right now.</div>'}
      <div class="wallet-card__break">
        <div class="wallet-card__row"><span>Discounts earned</span><b>${money(wallet.discountEarnedMinor || 0)}</b></div>
        <div class="wallet-card__row"><span>Bond held</span><b class="amber">${money(wallet.bondHeldMinor || 0)}</b></div>
        <div class="wallet-card__row"><span>Contributions paid</span><b>${money(wallet.contributionPaidMinor || 0)}</b></div>
      </div>
      <div class="wallet-card__actions">
        <button class="btn btn--line btn--sm" type="button" data-action="open-wallet">Wallet</button>
        ${state.config.paymentsConfigured ? '<button class="btn btn--line btn--sm" type="button" data-action="open-topup">Top up stash</button>' : ''}
        <button class="btn btn--lime btn--sm" type="button" data-action="open-withdraw" ${!state.config.withdrawalsConfigured || !wallet.availableMinor ? 'disabled' : ''}>Withdraw</button>
      </div>
    </section>
  `;
}

function activityCard(detail) {
  const entries = detail.ledger || [];
  return `
    <section class="card span-12 card--flush activity">
      <div class="activity__head">
        <h2 class="card__title">Activity</h2>
        <a class="card__link" href="#/g/${detail.group.id}/ledger">Full ledger ${icon('chevron')}</a>
      </div>
      ${entries.length ? `<div class="activity__list">${entries.slice(0, 6).map(ledgerRow).join('')}</div>` : `
        <div class="empty">
          <span class="empty__art">${icon('ledger')}</span>
          <h3>No movements yet.</h3>
          <p>Contributions, patience shares, fees, and payouts will appear here as the circle settles.</p>
        </div>
      `}
    </section>
  `;
}

/* ---------------- views ---------------- */

function emptyGroupPage(title, copy, route = '/app') {
  const rules = state.config?.rules || {};
  const seats = `${Number(rules.minMembers) || 5}–${Number(rules.maxMembers) || 12} seats`;
  const band = `${money(rules.minContributionMinor ?? 20000)}–${money(rules.maxContributionMinor ?? 500000).replace(/^KES\s/, '')}`;
  return `
    <div class="page">
      ${pageHead({ eyebrow: 'THE WHEEL', title: esc(title), sub: esc(copy) })}
      <section class="card emptyseat">
        <div class="empty">
          <span class="empty__art">${icon('wheel')}</span>
          <h2>No circle yet.</h2>
          <p>Start a circle with five to twelve people, join one with an invite code, or take an open seat and pay turn 1 today. Your seat is tied to your passkey.</p>
          <div class="empty__actions">
            <button class="btn btn--lime" type="button" data-action="start-circle">Create a circle ${icon('arrow')}</button>
            <a class="btn btn--line" href="#/open">Find an open circle ${icon('users')}</a>
            <button class="btn btn--quiet" type="button" data-action="open-join">Join with a code</button>
          </div>
        </div>
        <aside class="firstturn" aria-label="How your first turn works">
          <div class="firstturn__head">
            <p class="eyebrow">FIRST TURN</p>
            <span class="firstturn__now">Step 1 of 3</span>
          </div>
          <ol class="firstturn__steps">
            <li class="is-active"><b>01</b><span><strong>Set the table</strong><em>Name the circle, choose the contribution and the number of seats.</em></span><i>Now</i></li>
            <li><b>02</b><span><strong>Fill the seats</strong><em>Invite people, or open the circle so verified members can take seats by paying turn 1.</em></span></li>
            <li><b>03</b><span><strong>Fund the turn</strong><em>When every seat pays, the wheel turns and this turn's seat is paid.</em></span></li>
          </ol>
          <div class="firstturn__rules">
            <span>${esc(seats)}</span>
            <span>${esc(band)}</span>
            <span>Weekly turn</span>
            <span>Seat prices</span>
          </div>
        </aside>
      </section>
    </div>
  `;
}

async function viewDashboard() {
  if (!ensureActiveGroup()) {
    await viewOpenCircles();
    return;
  }
  try {
    const detail = await loadGroupDetail();
    if (!detail) { await viewOpenCircles(); return; }
    renderDashboard(detail);
  } catch (error) {
    renderError(error.message);
  }
}

function renderDashboard(detail) {
  const { group, cycle, me, settlement } = detail;
  const name = state.me?.name || 'there';
  const first = name.split(/\s+/)[0];
  const forming = group.status === 'forming';
  const live = ['funded', 'auction', 'settling'].includes(cycle?.status);
  const next = nextAction(detail);
  const paid = cycle?.paidCount || 0;
  const total = cycle?.memberCount || group.memberCount || 0;
  const seatsUnpaid = detail.round?.seatsUnpaid || 0;
  const canStart = group.memberCount >= 5 && seatsUnpaid === 0;
  const seat = seatStateOf(detail);
  const activityLabel = settlement ? 'Settled turn' : live ? 'Paying out' : forming ? 'Circle forming' : 'Funding turn';
  const completed = group.status === 'completed' && detail.recap?.turns?.length;
  const wallet = detail.wallet || {};
  const dueNow = cycle?.status === 'contributing' && cycle.myContribution?.status !== 'paid';
  const need = Math.max(0, 5 - group.memberCount);
  const fundTile = completed ? { action: 'go', path: '/g', label: 'Round recap', meta: 'see every seat' }
    : dueNow ? { action: 'open-contribute', path: '', label: `Fund turn ${cycle.number}`, meta: `${money(cycle.amountDueMinor || cycle.contributionMinor)} due` }
      : forming ? { action: 'open-invite', path: '', label: need ? `Fill ${need} seat${need === 1 ? '' : 's'}` : 'Start the circle', meta: `${group.memberCount} of ${group.maxMembers} in` }
        : { action: 'go', path: '/g', label: 'Circle room', meta: 'open the table' };
  const pulse = forming ? `
        <div class="dash-pulse">
          <div><span>SEATS</span><b>${group.memberCount} / ${group.maxMembers}</b><em>${need ? `${need} to go` : 'minimum met'}</em></div>
          <div><span>TURN ONE</span><b>${money(group.contributionMinor * Math.max(5, group.memberCount))}</b><em>pot to open</em></div>
          <div><span>EVERY TURN</span><b>${money(group.contributionMinor)}</b><em>${cadenceLabel(group.cadence)}</em></div>
          <div><span>YOUR SEAT</span><b>${me?.seat || '—'}</b><em>${seat?.key === 'pending' ? 'payment open' : seat?.key === 'paid' ? 'turn 1 paid' : 'held'}</em></div>
        </div>` : `
        <div class="dash-pulse">
          <div><span>TURN</span><b>${cycle ? `${cycle.number} / ${detail.circle?.turnsTotal || total}` : '—'}</b><em>${activityLabel.toLowerCase()}</em></div>
          <div><span>POT</span><b>${money(settlement?.potMinor ?? cycle?.potCapturedMinor ?? 0)}</b><em>of ${money(cycle?.potExpectedMinor || 0)}</em></div>
          <div><span>FUNDED</span><b>${paid} / ${total || group.memberCount}</b><em>${paid === (total || group.memberCount) && paid ? 'pot whole' : 'waiting on seats'}</em></div>
          <div><span>YOUR SEAT</span><b>${me?.seat || '—'}</b><em>${me?.hasWon ? 'pot taken' : me?.seat ? `pays on turn ${me.seat}` : 'waiting'}</em></div>
        </div>`;
  setWorkspace(`
    <div class="page dash-page">
      ${pageHead({
        eyebrow: `OVERVIEW · ${fmtDay(detail.now || new Date())} · EAT`,
        title: `${greeting()}, ${esc(first)}.`,
        sub: `${esc(group.name)} · ${forming ? 'gathering seats' : `turn ${cycle?.number || '—'} of ${detail.circle?.turnsTotal || total}`}${group.visibility === 'open' ? ' · open circle' : ''}`,
        actions: `<button class="btn btn--quiet btn--sm" type="button" data-action="refresh">${icon('spin')} Refresh</button>`,
      })}
      ${pulse}
      ${completed ? '' : `<div class="dash-quick" role="group" aria-label="Quick actions">
        <button class="dash-quick__tile" type="button" data-action="${fundTile.action}" data-path="${fundTile.path}">
          <span class="dash-quick__icon">${icon(dueNow ? 'wallet' : forming ? 'users' : 'bolt')}</span>
          <span class="dash-quick__copy"><b>${fundTile.label}</b><em>${fundTile.meta}</em></span>
        </button>
        <button class="dash-quick__tile" type="button" data-action="open-wallet">
          <span class="dash-quick__icon">${icon('wallet')}</span>
          <span class="dash-quick__copy"><b>${money(wallet.availableMinor || 0)}</b><em>in your stash</em></span>
        </button>
        <button class="dash-quick__tile" type="button" data-action="open-invite">
          <span class="dash-quick__icon">${icon('share')}</span>
          <span class="dash-quick__copy"><b>Invite</b><em>${esc(group.inviteCode)}</em></span>
        </button>
        <button class="dash-quick__tile" type="button" data-action="jarvis-open">
          <span class="dash-quick__icon">${icon('bolt')}</span>
          <span class="dash-quick__copy"><b>Ask NURU</b><em>balance, fees, next turn</em></span>
        </button>
      </div>`}
      <div class="dash-grid">
        ${completed ? celebrationMarkup(detail, { context: 'dashboard' }) : moveCard(detail, next)}
        <section class="card span-8">
          <div class="group-hero">
            <div class="group-hero__top">
              <div class="group-hero__id">
                <div>
                  <h2 class="group-hero__name">${esc(group.name)}</h2>
                  <div class="group-hero__meta">
                    <span>${money(group.contributionMinor)} / turn</span><i></i>
                    <span>${cadenceLabel(group.cadence)} payouts</span><i></i>
                    <span>${esc(activityLabel)}</span>
                  </div>
                </div>
              </div>
              ${statusPill(forming ? 'forming' : cycle?.status || group.status)}
            </div>
            <div class="hero-split">
              <div class="hero-split__main">
                <div class="pot-line">
                  <div class="pot-line__stack">
                    <span class="pot-line__k">${forming ? 'SEATS FILLED' : settlement ? 'SETTLED POT' : 'POT THIS TURN'}</span>
                    <b class="pot-line__v">${forming ? `${group.memberCount} / ${group.maxMembers}` : money(settlement?.potMinor ?? cycle?.potCapturedMinor ?? 0)}</b>
                    <span class="pot-line__meta">${forming
                      ? `five-seat minimum · first pot ${money(group.contributionMinor * 5)}`
                      : cycle ? `${paid}/${total} funded · ${cycle.turnOwner ? `seat ${cycle.turnOwner.seatNo} is paid` : 'waiting on the pot'}` : 'No turn open'}</span>
                  </div>
                  ${forming
                    ? `<span class="pill pill--lime">${group.memberCount >= 5 ? 'READY' : `${5 - group.memberCount} TO GO`}</span>`
                    : `<span class="pill pill--lime">${money(cycle?.potExpectedMinor || 0)} target</span>`}
                </div>
                ${forming
                  ? `${seatBoard(detail)}<div class="gather__bar" style="margin-top:12px">${progressBar(group.memberCount, 5)}<span class="hint">${group.memberCount >= 5 ? (canStart ? `${group.memberCount} seats in and every prepaid seat is settled. The organizer can open turn one.` : `${seatsUnpaid} joining seat${seatsUnpaid === 1 ? '' : 's'} still need${seatsUnpaid === 1 ? 's' : ''} the turn 1 payment before the start.`) : 'Members take seats with the invite code, or verified members take open seats by paying turn 1.'}</span></div>`
                  : cycle ? `${fundingRail(detail)}${progressBar(cycle.potCapturedMinor, cycle.potExpectedMinor)}` : ''}
                ${forming ? '' : `<div class="group-hero__pays">${icon('bolt')}<span>${cycle?.turnOwner ? `Turn ${cycle.number} pays ${esc(cycle.turnOwner.name.split(/\s+/)[0])} · seat ${cycle.turnOwner.seatNo}` : 'No seat is paid until the next turn opens'}</span></div>`}
              </div>
              ${forming ? '' : `<figure class="hero-wheel">${wheelMarkup(detail, { compact: true })}</figure>`}
            </div>
            <div class="group-hero__foot">
              ${forming
                ? `${group.visibility === 'open'
                  ? `<a class="btn btn--line btn--sm" href="#/open">${icon('users')} Open list</a>${seat?.key === 'pending' ? `<button class="btn btn--line btn--sm" type="button" data-action="pay-seat" data-group="${esc(group.id)}">Pay seat ${money(me?.seatDueMinor || group.contributionMinor)}</button>` : ''}`
                  : `<button class="btn btn--line btn--sm" type="button" data-action="open-invite">${icon('share')} Share invite</button>`}<button class="btn btn--lime btn--sm" type="button" data-action="open-start" ${canStart ? '' : 'disabled'}>${group.isOrganizer ? (canStart ? 'Review & start' : seatsUnpaid ? `Waiting on ${seatsUnpaid} seat${seatsUnpaid === 1 ? '' : 's'}` : 'Review & start') : (canStart ? 'Review & accept' : 'Waiting on seats')} ${icon('arrow')}</button>`
                : `<a class="btn btn--line btn--sm" href="#/g/${group.id}">Open circle ${icon('chevron')}</a><button class="btn btn--line btn--sm" type="button" data-action="go" data-path="/g/${group.id}/turn">${icon('spin')} Open the wheel</button>`}
            </div>
          </div>
        </section>
        ${walletCard(detail)}
        <section class="card span-7">
          <div class="card__head"><h2 class="card__title">${forming ? 'Turn one at a glance' : settlement ? 'Settlement' : 'This turn'}</h2>${cycle ? statusPill(cycle.status) : pill('FORMING')}</div>
          ${forming ? formingPanel(detail) : cycle ? turnPanel(detail) : emptyTurnPanel(detail)}
        </section>
        ${trustCard(detail)}
        ${activityCard(detail)}
      </div>
    </div>
  `);
  armCountdown();
  armWheelFx(detail);
  if (live) startAuctionPoll();
  else if (forming) startFormingPoll();
}

function formingPanel(detail) {
  const { group } = detail;
  const need = Math.max(0, 5 - group.memberCount);
  const seatsUnpaid = detail.round?.seatsUnpaid || 0;
  return `
    <div class="next-turn">
      <div class="receipt__rows">
        <div class="receipt__row"><span>Your contribution</span><b>${money(group.contributionMinor)} per turn</b></div>
        <div class="receipt__row"><span>Pot at five seats</span><b class="lime">${money(group.contributionMinor * 5)}</b></div>
        <div class="receipt__row"><span>Organizer fee</span><b>${pct(group.organizerFeeBps)} of each pot</b></div>
        <div class="receipt__row"><span>Payout</span><b>Instant, when the pot is whole</b></div>
      </div>
      <div class="seat-panel__next">
        <span>WHAT HAPPENS NEXT</span>
        <b>${need ? `${need} more ${need === 1 ? 'seat' : 'seats'} before turn one.` : seatsUnpaid ? `${seatsUnpaid} joining seat${seatsUnpaid === 1 ? ' is' : 's are'} still paying turn one.` : 'Enough seats. Turn one can start.'}</b>
        <span>${need
          ? `Everyone joins with the same ${money(group.contributionMinor)}. The amount is fixed and nobody can change it after the circle starts.`
          : seatsUnpaid
            ? 'Seat payments land in turn one. The organizer cannot open the wheel until every joining seat has paid.'
            : 'The organizer opens turn one. Every seat funds the same amount, then the turn’s seat is paid.'}</span>
      </div>
    </div>
  `;
}

function turnPanel(detail) {
  const { cycle, group, settlement } = detail;
  if (settlement) {
    return `
      <div class="receipt">
        <div class="receipt__head">${statusPill('settled')}<span class="mono">TURN ${cycle.number}</span></div>
        <div class="receipt__rows">
          <div class="receipt__row"><span>Winner</span><b>${esc(settlement.winnerName)}</b></div>
          <div class="receipt__row"><span>Seat price paid</span><b>${pct(settlement.discountBps)}</b></div>
          <div class="receipt__row"><span>Winner net ${settlement.status === 'held' ? '· held' : ''}</span><b class="lime">${money(settlement.winnerNetMinor)}</b></div>
          <div class="receipt__row"><span>Patience share${settlement.waiterCount === 1 ? '' : 's'}</span><b class="cyan">${money(settlement.waiterShareMinor)} each</b></div>
          <div class="receipt__row"><span>Bond held</span><b class="amber">${money(settlement.bondHoldMinor)}</b></div>
        </div>
        <p class="receipt__note">${settlement.status === 'held' ? `The first payout is held until ${fmtDateTime(settlement.releaseAt)}.` : 'This payout has been released to the winner’s wallet.'} ${settlement.isFinal ? 'This was the final turn; the circle is complete.' : 'The bond releases as the winner pays the remaining turns.'}</p>
        <div class="group-hero__foot" style="margin-top:14px">
          <a class="btn btn--line btn--sm" href="${group.status === 'completed' ? '#/g' : '#/g/auction'}">${group.status === 'completed' ? 'Round recap' : 'Full receipt'} ${icon('chevron')}</a>
          ${group.isOrganizer && !settlement.isFinal && group.status !== 'completed' ? `<button class="btn btn--lime btn--sm" type="button" data-action="open-next">Open next turn ${icon('arrow')}</button>` : ''}
        </div>
      </div>
    `;
  }
  if (cycle.status === 'contributing') {
    const paid = detail.cycle.myContribution?.status === 'paid';
    return `
      <div class="next-turn">
        <div class="count-row"><span>Contribution closes</span><b>${fmtDateTime(cycle.contributionDueAt)}</b></div>
        ${progressBar(cycle.potCapturedMinor, cycle.potExpectedMinor)}
        <div class="stat-grid">
          ${stat('YOUR CONTRIBUTION', paid ? 'PAID' : money(cycle.amountDueMinor || cycle.contributionMinor), paid ? 'cleared' : cycle.lateFeeMinor ? `includes ${money(cycle.lateFeeMinor)} late fee` : 'no late fee', paid ? 'lime' : '')}
          ${stat('POT FUNDED', `${paid ? cycle.paidCount : cycle.paidCount}/${cycle.memberCount}`, 'pays out at 100%')}
          ${stat('SEAT PRICE', pct(detail.cycle?.ladderMinor?.[(cycle.number || 1) - 1] ?? 0), 'posted, never bid')}
          ${stat('BOND BAND', pct(detail.me?.bondBps || 2500), 'if you win')}
        </div>
        ${paid
          ? `<div class="notice notice--cyan">${icon('check')}<span>Your contribution is in. The wheel opens automatically when every active member has funded this turn.</span></div>`
          : `<div class="notice notice--amber">${icon('clock')}<span>The turn cannot pay out until every active member has funded it. A late contribution adds ${pct(detail.rules?.lateFeeBps || 200)} after a ${detail.rules?.graceHours || 24}-hour grace, capped at ${pct(detail.rules?.lateCapBps || 1000)}.</span></div>`}
        <div class="group-hero__foot">
          <button class="btn btn--lime btn--sm" type="button" data-action="open-contribute" ${paid ? 'disabled' : ''}>${paid ? 'Contribution in' : 'Contribute now'} ${paid ? '' : icon('arrow')}</button>
          ${group.isOrganizer ? `<button class="btn btn--line btn--sm" type="button" data-action="open-cover" ${cycle.paidCount === cycle.memberCount ? 'disabled' : ''}>Cover a shortfall</button>` : ''}
        </div>
      </div>
    `;
  }
  if (cycle.status === 'funded') {
    return `
      <div class="next-turn">
        <div class="count-row"><span>Pays out</span><b>now · the pot is whole</b></div>
        <div class="stat-grid">
          ${stat('THIS TURN PAYS', cycle.turnOwner ? cycle.turnOwner.name : `Seat ${cycle.number}`, cycle.turnOwner ? `seat ${cycle.turnOwner.seatNo}` : 'next seat', 'lime')}
          ${stat('SEAT PRICE', pct((cycle.ladderMinor || [])[(cycle.number || 1) - 1] || 0), 'posted, never bid')}
          ${stat('TAKE-HOME', money(cycle.payoutNow || 0), 'after discount, fees and bond')}
          ${stat('PATIENT SEATS', String(cycle.waitersCount || 0), 'earn every early-bird price')}
        </div>
        <div class="notice notice--cyan">${icon('wheel')}<span>The wheel pays the seat whose turn it is. Nobody bids, nothing is hidden, and the pot moves the moment it is whole.</span></div>
        <div class="group-hero__foot">
          <button class="btn btn--lime btn--sm" type="button" data-action="go" data-path="/g/${detail.group.id}/turn">Open the wheel ${icon('arrow')}</button>
        </div>
      </div>
    `;
  }
  if (cycle.status === 'settling') {
    return `<div class="empty"><span class="empty__art">${icon('spin')}</span><h3>Settling the turn.</h3><p>The pot was captured. Refresh in a moment for the receipt.</p><button class="btn btn--line" type="button" data-action="refresh">Refresh</button></div>`;
  }
  return emptyTurnPanel(detail);
}

function emptyTurnPanel(detail) {
  return `
    <div class="empty">
      <span class="empty__art">${icon('calendar')}</span>
      <h3>${detail.group.status === 'completed' ? 'The round is closed.' : 'No turn open.'}</h3>
      <p>${detail.group.status === 'completed' ? 'Replay every turn, check what each seat paid and received, then propose the next round from the recap.' : 'All turns are settled. Open the next turn when the circle is ready.'}</p>
      ${detail.group.status === 'completed' ? `<a class="btn btn--lime" href="#/g/${detail.group.id}/recap">Open round recap ${icon('arrow')}</a>` : detail.group.isOrganizer ? `<button class="btn btn--lime" type="button" data-action="open-next">Open the next turn ${icon('arrow')}</button>` : ''}
    </div>
  `;
}

function nextAction(detail) {
  const { group, cycle, me, settlement } = detail;
  const memberCount = group.memberCount || 0;
  if (group.status === 'completed') {
    return {
      label: 'Open recap', action: 'go', path: '/g', disabled: false,
      tone: 'cyan', icon: 'check', title: 'The circle closed.',
      copy: 'Every seat took its pot. Replay the round, check what each member paid and received, then propose the next round.',
      meta: pill('ALL TURNS SETTLED', 'lime'),
    };
  }
  if (group.status === 'forming') {
    const need = Math.max(0, 5 - memberCount);
    return {
      label: group.isOrganizer ? 'Start circle' : 'Invite',
      action: group.isOrganizer ? 'open-start' : 'open-invite',
      disabled: group.isOrganizer && memberCount < 5,
      tone: 'cyan', icon: 'users',
      title: group.isOrganizer ? 'Open the circle.' : 'Fill the circle.',
      copy: group.isOrganizer
        ? (need ? `${need} more member${need === 1 ? '' : 's'} before turn one can open.` : 'Enough members are in. Turn one can open now.')
        : 'Share the invite code. The organizer starts turn one once five seats are filled.',
      meta: pill(`${memberCount}/${group.maxMembers} SEATS`, 'lime'),
    };
  }
  if (!cycle) {
    return group.isOrganizer
      ? { label: 'Open turn', action: 'open-next', disabled: false, tone: 'lime', icon: 'calendar', title: 'Open the next turn.', copy: 'The circle is idle until a turn is opened.', meta: '' }
      : { label: 'Refresh', action: 'refresh', disabled: false, tone: 'cyan', icon: 'spin', title: 'Waiting on the organizer.', copy: 'The organizer opens the next turn.', meta: '' };
  }
  const timerFor = (value) => (value
    ? `<div class="move-card__timer"><span>CLOSES IN</span><b data-countdown="${esc(value)}" data-done="Closed">00:00:00</b></div>`
    : '');
  if (cycle.status === 'contributing') {
    if (cycle.myContribution?.status !== 'paid') {
      return {
        label: 'Contribute', action: 'open-contribute', disabled: false,
        tone: 'amber', icon: 'wallet', title: `Fund turn ${cycle.number}.`,
        copy: `Your ${money(cycle.amountDueMinor || cycle.contributionMinor)} must clear before the turn pays out.`,
        meta: timerFor(cycle.contributionDueAt),
      };
    }
    const left = Math.max(0, cycle.memberCount - cycle.paidCount);
    return {
      label: 'Pot status', action: 'go', path: '/g', disabled: false,
      tone: 'cyan', icon: 'check', title: 'You are funded.',
      copy: left ? `Waiting on ${left} seat${left === 1 ? '' : 's'}. The turn pays out automatically when the pot is whole.` : 'The pot is whole. The seat is paid now.',
      meta: pill(`${cycle.paidCount}/${cycle.memberCount} FUNDED`, 'lime'),
    };
  }
  if (cycle.status === 'funded' || cycle.status === 'auction') {
    const owner = cycle.turnOwner;
    const mineTurn = Boolean(owner && owner.membershipId === me?.membershipId);
    if (cycle.isFinal) {
      return {
        label: 'Final turn', action: 'go', path: '/g/auction', disabled: false, tone: 'cyan', icon: 'flag',
        title: 'The final seat.',
        copy: mineTurn ? 'The last pot is yours the moment the turn is whole.' : `${owner?.name || 'The last seat'} takes the final pot at 0% with no bond.`,
        meta: pill('PAYS NOW', 'lime'),
      };
    }
    if (mineTurn) {
      return {
        label: 'Your turn', action: 'go', path: '/g/auction', disabled: false, tone: 'lime', icon: 'bolt',
        title: 'This pot is yours.',
        copy: `${money(cycle.payoutNow || 0)} lands the moment the turn is whole. No bid, no wait.`,
        meta: pill('PAYING OUT', 'lime'),
      };
    }
    return {
      label: 'Watch the turn', action: 'go', path: '/g/auction', disabled: false, tone: 'cyan', icon: 'wheel',
      title: `Seat ${owner?.seatNo || cycle.number} takes this pot.`,
      copy: me?.hasWon
        ? 'You already took yours. You still fund each turn, and you keep a share of every discount paid.'
        : `Your seat pays on turn ${me?.seat || '—'}. Every turn you wait earns a share of the discount paid.`,
      meta: pill('PAYS NOW', 'lime'),
    };
  }
  if (settlement || cycle.status === 'settled') {
    if (group.isOrganizer && group.status !== 'completed' && !settlement?.isFinal) {
      return {
        label: 'Next turn', action: 'open-next', disabled: false,
        tone: 'lime', icon: 'calendar', title: `Turn ${cycle.number} is settled.`,
        copy: `${settlement?.winnerName || 'The winner'} took ${money(settlement?.winnerNetMinor || 0)} net. Open turn ${cycle.number + 1} when the circle is ready.`,
        meta: '',
      };
    }
    return {
      label: 'View receipt', action: 'go', path: '/g/auction', disabled: false,
      tone: 'cyan', icon: 'ledger', title: 'Settled.',
      copy: settlement ? `${settlement.winnerName} took the pot at ${pct(settlement.discountBps)}.` : 'This turn is written to the ledger.',
      meta: '',
    };
  }
  return { label: 'Refresh', action: 'refresh', disabled: false, tone: 'cyan', icon: 'spin', title: 'Check the turn.', copy: 'The circle is updating.', meta: '' };
}

function seatPanel(detail) {
  const { me, members, cycle, group, settlement } = detail;
  const myMember = me?.membershipId ? (members || []).find((member) => member.id === me.membershipId) : null;
  const seat = myMember?.seat ?? null;
  const next = nextAction(detail);
  const score = myMember?.trustScore ?? me?.trustScore ?? 50;
  const thisTurn = !cycle ? 'No turn open'
    : cycle.status === 'contributing' ? (myMember?.paidThisCycle ? 'Funded' : `Due ${money(cycle.amountDueMinor || cycle.contributionMinor)}`)
      : settlement?.winnerMembershipId === myMember?.id ? 'Took the pot'
        : cycle.turnOwner?.membershipId === myMember?.id ? 'This turn pays you'
          : settlement ? 'Waited this turn' : `Pays on turn ${myMember?.seat || '—'}`;
  const standing = !myMember ? '—'
    : settlement?.winnerMembershipId === myMember.id ? `Took turn ${cycle?.number} · ${money(settlement.winnerNetMinor)} net`
      : myMember.hasWon ? 'Already took a pot' : 'Still waiting for the pot';
  return `
    <div class="seat-panel">
      <div class="seat-badge">
        <span class="seat-badge__ring">${trustRing(score)}<b>${seat ?? '—'}</b></span>
        <div><b>${esc(me?.name || 'You')}</b><span>Seat ${seat ?? '—'} of ${group.memberCount} · ${esc(group.name)}</span></div>
      </div>
      <div class="receipt__rows">
        <div class="receipt__row"><span>This turn</span><b>${thisTurn}</b></div>
        <div class="receipt__row"><span>Your standing</span><b>${standing}</b></div>
        <div class="receipt__row"><span>Bond band</span><b class="amber">${pct(me?.bondBps || 0)}${myMember?.hasWon ? ' · released' : ''}</b></div>
        <div class="receipt__row"><span>Guarantor</span><b>${myMember?.guarantor?.name ? esc(myMember.guarantor.name) : 'None yet'}</b></div>
      </div>
      <div class="seat-panel__next">
        <span>NEXT STEP</span>
        <b>${esc(next.title)}</b>
        <span>${esc(next.copy)}</span>
      </div>
      <button class="btn btn--lime btn--block" type="button" data-action="${next.action}" ${next.path ? `data-path="${esc(next.path)}"` : ''} ${next.disabled ? 'disabled' : ''}>${next.label} ${icon('arrow')}</button>
    </div>
  `;
}

function seatPanelForming(detail) {
  const { group, members, me } = detail;
  const myMember = me?.membershipId ? (members || []).find((member) => member.id === me.membershipId) : null;
  const need = Math.max(0, 5 - group.memberCount);
  const seatsUnpaid = detail.round?.seatsUnpaid || 0;
  const seat = seatStateOf(detail);
  const seatBlock = group.visibility !== 'open' ? ''
    : seat?.key === 'pending' ? `
      <div class="seat-panel__next is-amber">
        <span>YOUR SEAT · UNPAID</span>
        <b>Pay ${money(me.seatDueMinor || group.contributionMinor)} to keep seat ${myMember?.seat ?? '—'}.</b>
        <span>The hold releases in <b data-countdown="${esc(seat.expiresAt || '')}" data-done="released">—</b>. If it releases, the seat goes back to the open list.</span>
        <button class="btn btn--lime btn--block" type="button" data-action="pay-seat" data-group="${esc(group.id)}">Pay seat ${money(me.seatDueMinor || group.contributionMinor)} ${icon('arrow')}</button>
      </div>`
      : seat?.key === 'paid' ? `
      <div class="seat-panel__next">
        <span>TURN 1 PREPAID</span>
        <b>${money(me.seatPaidMinor)} is already in for turn 1.</b>
        <span>It is credited the moment the circle starts. If it never starts within ${SEAT_REFUND_DAYS} days, the seat returns to your wallet.</span>
      </div>`
      : seat?.key === 'none' ? `
      <div class="seat-panel__next is-amber">
        <span>YOUR SEAT · UNPAID</span>
        <b>This seat still needs its turn 1 payment.</b>
        <span>Pay ${money(me.seatDueMinor || group.contributionMinor)} so the organizer can start.</span>
        <button class="btn btn--lime btn--block" type="button" data-action="pay-seat" data-group="${esc(group.id)}">Pay seat ${icon('arrow')}</button>
      </div>` : '';
  return `
    <div class="seat-panel">
      <div class="seat-badge">
        <span class="seat-badge__ring">${trustRing(myMember?.trustScore ?? me?.trustScore ?? 50)}<b>${myMember?.seat ?? '—'}</b></span>
        <div><b>${esc(me?.name || 'You')}</b><span>Seat ${myMember?.seat ?? '—'} of ${group.maxMembers} · ${esc(group.name)}</span></div>
      </div>
      <div class="receipt__rows">
        <div class="receipt__row"><span>Contribution</span><b>${money(group.contributionMinor)} per turn</b></div>
        <div class="receipt__row"><span>KYC</span><b class="${myMember?.kycStatus === 'verified' ? 'lime' : 'amber'}">${myMember?.kycStatus === 'verified' ? 'Verified' : 'Pending before payout'}</b></div>
        <div class="receipt__row"><span>Organizer fee</span><b>${pct(group.organizerFeeBps)} of each pot</b></div>
        <div class="receipt__row"><span>Payout</span><b>Instant, when the pot is whole</b></div>
        <div class="receipt__row"><span>Visibility</span><b>${group.visibility === 'open' ? 'Open · seat prepaid' : 'Private · invite only'}</b></div>
      </div>
      ${seatBlock}
      <div class="seat-panel__next">
        <span>WHAT HAPPENS NEXT</span>
        <b>${need ? `${need} more ${need === 1 ? 'seat' : 'seats'} before turn one.` : seatsUnpaid ? `${seatsUnpaid} joining seat${seatsUnpaid === 1 ? ' is' : 's are'} still paying turn one.` : 'Enough seats. Turn one can start.'}</b>
        <span>${need
          ? `No money moves while the circle forms, and the amount stays ${money(group.contributionMinor)} for every turn.`
          : seatsUnpaid
            ? 'Seat payments land in turn one. The organizer cannot open the wheel until every joining seat has paid.'
            : 'The organizer opens turn one. Everyone funds the same amount, then the first seat is paid.'}</span>
      </div>
    </div>
  `;
}

function seatBoard(detail) {
  const { group, members, me } = detail;
  const list = [...(members || [])].sort((a, b) => (a.seat || 0) - (b.seat || 0));
  const max = Number(group.maxMembers) || list.length;
  const fresh = new Set(state.newMemberIds || []);
  const openCircle = group.visibility === 'open';
  const tiles = [];
  for (let seat = 1; seat <= max; seat += 1) {
    const member = list.find((row) => Number(row.seat) === seat);
    if (!member) {
      tiles.push(`
        <button class="seatboard__tile seatboard__tile--open" type="button" data-action="${openCircle ? 'open-discover' : 'open-invite'}" aria-label="${openCircle ? `Open seat ${seat} · open to verified members` : `Invite someone into seat ${seat}`}">
          <span class="seatboard__no">SEAT ${seat}</span>
          <span class="seatboard__plus">${icon('plus')}</span>
          <span class="seatboard__name">Open</span>
          <span class="seatboard__tag">${openCircle ? 'TAKE IT' : 'INVITE'}</span>
        </button>`);
      continue;
    }
    const mine = member.userId === me?.id || member.id === me?.membershipId;
    const isNew = fresh.has(member.id);
    const seatPending = openCircle && member.role !== 'organizer' && member.seatStatus !== 'paid';
    const tag = mine ? 'YOU' : member.role === 'organizer' ? 'ORGANIZER' : seatPending ? 'UNPAID' : member.hasWon ? 'TAKEN' : 'MEMBER';
    tiles.push(`
      <div class="seatboard__tile${mine ? ' is-me' : ''}${isNew ? ' is-new' : ''}${seatPending ? ' is-unpaid' : ''}">
        <span class="seatboard__no">SEAT ${seat}</span>
        <span class="seatboard__avatar">${esc(initials(member.name))}</span>
        <span class="seatboard__name">${esc(String(member.name || '').split(/\s+/)[0])}</span>
        <span class="seatboard__tag">${tag}</span>
      </div>`);
  }
  return `<div class="seatboard">${tiles.join('')}</div>`;
}

function gatherCard(detail) {
  const { group } = detail;
  const minimum = 5;
  const need = Math.max(0, minimum - group.memberCount);
  const ready = need === 0;
  const openCircle = group.visibility === 'open';
  const seatsUnpaid = detail.round?.seatsUnpaid || 0;
  const canStart = ready && seatsUnpaid === 0;
  return `
    <div class="gather">
      <div class="gather__head">
        <div>
          <h2>${ready ? (canStart ? 'The circle is ready to start.' : 'Seats are in. Payments are not.') : `${group.memberCount} of ${group.maxMembers} seats taken.`}</h2>
          <p>${ready
            ? (canStart ? 'Every seat has joined and every joining seat has prepaid turn 1. The organizer opens the wheel when ready.' : `${seatsUnpaid} joining seat${seatsUnpaid === 1 ? ' is' : 's are'} still unpaid. The organizer starts once all turn 1 payments land.`)
            : openCircle
              ? `${need} more ${need === 1 ? 'seat' : 'seats'} to reach the five-member minimum. Verified members take seats from the open list and prepay turn 1.`
              : `${need} more ${need === 1 ? 'seat' : 'seats'} to reach the five-member minimum. It can fill up to ${group.maxMembers}.`}</p>
        </div>
        ${pill(`${group.memberCount}/${group.maxMembers}`, ready ? 'lime' : '')}
      </div>
      ${seatBoard(detail)}
      ${swapDesk(detail)}
      <div class="gather__bar">
        ${progressBar(ready ? group.maxMembers : group.memberCount, ready ? group.maxMembers : minimum)}
        <span class="hint">${ready
          ? (seatsUnpaid ? `Prepaid seats are credited to turn 1. ${seatsUnpaid} seat${seatsUnpaid === 1 ? '' : 's'} still to pay.` : 'Five-seat minimum reached and every seat is paid. More seats can still join until the organizer starts.')
          : openCircle ? 'Open seats · each joining member verifies their ID and pays turn 1 before the start.' : 'Minimum five seats · each member joins with their own passkey and pays the same fixed contribution.'}</span>
      </div>
      ${openCircle ? `
        <div class="gather__code gather__code--open">
          <div><span>OPEN CIRCLE</span><b>Seats are taken from the open list</b></div>
          <a class="iconbtn" href="#/open" aria-label="Open the open circles list">${icon('users')}</a>
        </div>` : `
        <div class="gather__code">
          <div><span>INVITE CODE</span><b>${esc(group.inviteCode)}</b></div>
          <button class="iconbtn" type="button" data-action="copy" data-copy="${esc(group.inviteCode)}" aria-label="Copy invite code">${icon('copy')}</button>
        </div>`}
      <div class="group-hero__foot">
        ${openCircle
          ? `<a class="btn btn--line btn--sm" href="#/open">${icon('users')} Open list</a>`
          : `<button class="btn btn--line btn--sm" type="button" data-action="open-invite">${icon('share')} Share invite</button>`}
        ${detail.round && !detail.round.iAccepted
          ? `<button class="btn btn--lime btn--sm" type="button" data-action="open-start">Accept round ${detail.round.number} ${icon('check')}</button>`
          : group.isOrganizer
          ? `<button class="btn btn--lime btn--sm" type="button" data-action="open-start" ${canStart ? '' : 'disabled'}>${canStart ? `Start round ${detail.round?.number || 1}` : seatsUnpaid ? `Waiting on ${seatsUnpaid} seat${seatsUnpaid === 1 ? '' : 's'}` : 'Start round'} ${icon('arrow')}</button>`
          : `<span class="hint">${canStart ? `You accepted. ${detail.round?.acceptedCount || 0}/${detail.round?.memberCount || group.memberCount} members accepted.` : ready ? 'The organizer starts once every joining seat has paid turn 1.' : openCircle ? 'Seats open to verified members from the open list.' : 'Send the invite code to friends who want the pot first.'}</span>`}
        ${detail.round ? `<span class="hint">${detail.round.acceptedCount}/${detail.round.memberCount} accepted · ${cadenceLabel(group.cadence)} payouts${openCircle ? ` · ${seatsUnpaid} unpaid seat${seatsUnpaid === 1 ? '' : 's'}` : ''}</span>` : ''}
      </div>
    </div>
  `;
}

async function viewCircle() {
  if (!ensureActiveGroup()) {
    setWorkspace(emptyGroupPage('Your circle', 'The pot, members, and rules in one place.'));
    return;
  }
  try {
    const detail = await loadGroupDetail();
    if (!detail) { setWorkspace(emptyGroupPage('Your circle', 'The pot, members, and rules in one place.')); return; }
    renderCircle(detail);
  } catch (error) { renderError(error.message); }
}

/* ---------------- live strip ---------------- */

function liveStrip(detail) {
  const cycle = detail?.cycle;
  if (!cycle) return '';
  const total = Number(cycle.memberCount || detail.group.memberCount || 0);
  const paid = Number(cycle.paidCount || 0);
  const percent = total ? Math.max(0, Math.min(100, Math.round((paid / total) * 100))) : 0;
  const captured = Number(cycle.potCapturedMinor || 0);
  const expected = Number(cycle.potExpectedMinor || detail.group.contributionMinor * total);
  const events = (detail.ledger || []).slice(0, 3);
  const settled = cycle.status === 'settled';
  const label = settled ? 'TURN SETTLED' : cycle.status === 'contributing' ? 'FUNDING LIVE' : String(cycle.status || '').toUpperCase();
  return `
    <section class="live-strip${settled ? ' is-settled' : ''}" data-live-strip aria-live="off">
      <div class="live-strip__top">
        <span class="live-dot" aria-hidden="true"></span>
        <b>${esc(label)}</b>
        <span class="live-strip__facts">${paid}/${total} in · ${money(captured)} of ${money(expected)}</span>
        ${detail.me?.seat ? `<span class="live-strip__seat">YOUR SEAT ${detail.me.seat}</span>` : ''}
      </div>
      <div class="live-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="Turn funding"><i style="width:${percent}%"></i></div>
      <div class="live-strip__feed">
        ${events.length ? events.map((entry, index) => `
          <span class="live-chip" style="--i:${index}">
            <b>${esc(entry.actorName || 'Circle')}</b>
            <span>${esc(entry.memo || entry.kind || 'ledger entry')}</span>
            <em>${money(Math.abs(Number(entry.amountMinor || 0)))}</em>
          </span>`).join('') : '<span class="live-chip"><span>Waiting for the first contribution of this turn.</span></span>'}
      </div>
    </section>
  `;
}

/* One turn, four mechanical stages. Members read this instead of guessing. */
function turnStory(detail) {
  const { group, cycle, settlement } = detail;
  if (!cycle) return '';
  const total = Number(cycle.memberCount || group.memberCount || 0);
  const paid = Number(cycle.paidCount || 0);
  const target = Number(cycle.potExpectedMinor || group.contributionMinor * total);
  const pot = Number(settlement?.potMinor ?? cycle.potCapturedMinor ?? 0);
  const owner = cycle.turnOwner;
  const minePaid = cycle.myContribution?.status === 'paid';
  const settled = Boolean(settlement);
  const whole = paid >= total && total > 0;
  const stage = settled ? 3 : whole ? 2 : 0;
  const nextTurn = Number(cycle.number || 1) + 1;
  const steps = [
    { k: 'FUND', b: `Every seat pays ${money(group.contributionMinor)}`, em: `${paid} of ${total} seats in`, done: whole, live: stage === 0 },
    { k: 'SEAL', b: `The pot closes at ${money(target)}`, em: whole ? 'sealed, no bids' : `${money(Math.max(0, target - pot))} to go`, done: whole, live: false },
    { k: 'PAY', b: owner ? `Seat ${owner.seatNo} is paid` : 'The turn’s seat is paid', em: settled ? `${money(settlement.winnerNetMinor)} net` : 'the moment the pot is whole', done: settled, live: stage === 2 },
    { k: 'NEXT', b: cycle.isFinal ? 'The round closes' : `Turn ${nextTurn} opens`, em: cycle.isFinal ? 'fund split, then a new round' : 'fresh contributions, same seats', done: false, live: false },
  ];
  const brief = settled
    ? `Turn ${cycle.number} is settled: ${money(settlement.winnerNetMinor)} net to ${settlement.winnerName}. ${cycle.isFinal ? 'This was the final turn — the round closes and any fund split lands in the ledger.' : `The organizer opens turn ${nextTurn} when everyone is ready; each seat pays again.`}`
    : whole
      ? `The pot is whole. ${owner ? `${owner.name} (seat ${owner.seatNo})` : 'The turn’s seat'} is being paid ${money(pot)} now. Contributions for the next turn open after this receipt posts.`
      : minePaid
        ? `You are in this turn. The pot pays ${owner ? `${owner.name.split(/\s+/)[0]} on seat ${owner.seatNo}` : 'its seat'} as soon as the last seat funds — ${money(Math.max(0, target - pot))} to go.`
        : `Your ${money(cycle.amountDueMinor || group.contributionMinor)} contribution is the next move. When the last seat pays, the pot closes and ${owner ? `${owner.name.split(/\s+/)[0]} is paid` : 'the turn’s seat is paid'}.`;
  const action = !settled && !whole && !minePaid
    ? `<button class="btn btn--lime btn--sm" type="button" data-action="open-contribute">Pay turn ${cycle.number} ${icon('arrow')}</button>`
    : !settled && !whole
      ? `<span class="turn-story__wait">${icon('clock')} Waiting on ${total - paid} seat${total - paid === 1 ? '' : 's'}</span>`
      : '';
  return `
    <section class="card span-12 turn-story" data-turn-story aria-label="How this turn runs">
      <div class="card__head">
        <h2 class="card__title">How this turn runs</h2>
        <span class="turn-story__pos">STEP ${stage + 1} OF 4</span>
      </div>
      <ol class="turn-story__steps">
        ${steps.map((step, index) => `<li class="turn-story__step${step.done ? ' is-done' : ''}${step.live ? ' is-live' : ''}">
          <span class="turn-story__node">${step.done ? icon('check') : index + 1}</span>
          <span class="turn-story__copy"><b>${step.k}</b><strong>${esc(step.b)}</strong><em>${esc(step.em)}</em></span>
        </li>`).join('')}
      </ol>
      <div class="turn-story__next">
        <span class="turn-story__next-copy">${icon('bolt')}<span>${esc(brief)}</span></span>
        ${action}
      </div>
      <p class="turn-story__why">Seat prices are posted, never bid. Funding decides <b>when</b> a seat is paid; the rulebook decides <b>which</b> seat and at what price.</p>
    </section>
  `;
}

function startCircleLivePoll() {
  clearTimeout(state.pollTimer);
  const onEngine = () => Boolean(groupRoute(state.route)) && groupRoute(state.route).view === '';
  const signature = (detail) => [
    detail?.cycle?.paidCount, detail?.cycle?.status, detail?.settlement?.id,
    detail?.ledger?.length, detail?.group?.memberCount, detail?.group?.status,
    (detail?.turns || []).length,
  ].join(':');
  const tick = async () => {
    if (!onEngine() || document.hidden || !state.activeGroupId) return;
    if (dom.sheet?.open || dom.authDialog?.open) {
      state.pollTimer = setTimeout(tick, 6000);
      return;
    }
    try {
      let detail = await api(`/groups/${state.activeGroupId}`, { timeout: 10000 });
      const previous = state.group;
      // A whole pot pays out with no clock and no button: whoever is watching closes it.
      if (detail.cycle?.canClose && !detail.settlement && state.autoSettleCycle !== detail.cycle.id) {
        state.autoSettleCycle = detail.cycle.id;
        try {
          await api(`/groups/${detail.group.id}/cycles/${detail.cycle.id}/close`, { method: 'POST', body: {} });
          detail = await api(`/groups/${state.activeGroupId}`, { timeout: 10000 });
        } catch { state.autoSettleCycle = null; }
      }
      state.group = detail;
      state.wallet = detail.wallet || state.wallet;
      if (detail.now) state.clockSkew = Date.now() - Date.parse(detail.now);
      syncChrome();
      if (!onEngine()) return;
      if (signature(previous) !== signature(detail)) renderCircle(detail);
    } catch { /* polling is best effort */ }
    if (onEngine()) state.pollTimer = setTimeout(tick, 6000);
  };
  state.pollTimer = setTimeout(tick, 6000);
}

function fairnessMarkup(detail) {
  const members = detail.members || [];
  const received = members.filter((member) => member.hasWon);
  return `<details class="fairness-strip"><summary><span>${icon('shield')} One member. One pot per circle.</span><b>${received.length}/${members.length} received · ${members.length - received.length} waiting</b></summary><div><p>Each turn belongs to a seat, and every seat has a posted price set by the rulebook — not by the organizer. Seat 1 pays the most for speed; the price falls along the wheel and the last seat pays 0%. Previous winners keep contributing but take no further pot. Nobody bids, so nothing can be sniped, hidden, or rigged.</p><div class="fairness-strip__members">${members.map((member) => `<span class="${member.hasWon ? 'is-received' : ''}">${esc(member.name)} <b>${member.hasWon ? 'Received · still contributes' : `Pays on turn ${member.seat}`}</b></span>`).join('')}</div><a href="#/practice">See how it works with virtual money ${icon('arrow')}</a></div></details>`;
}

/* ---------------- round-complete recap ---------------- */

function stopRecapPlayback() {
  if (!state.recap) return;
  if (state.recap.timer) clearInterval(state.recap.timer);
  state.recap.timer = null;
}

function recapSpeech(recap, turn) {
  const bits = [`Turn ${turn.number} of ${recap.turnsTotal}. ${turn.winnerName} was paid a pot of ${money(turn.potMinor)}.`];
  if (turn.reason === 'final') {
    bits.push(`Final turn: no discount and no bond${turn.organizerWaivedMinor > 0 ? ', and the organizer fee moved to the guarantee fund' : ''}.`);
  } else if (turn.reason === 'random') {
    bits.push('This turn carried no seat price, so the whole pot went to its seat.');
  } else {
    bits.push(`The early-bird seat price was ${pct(turn.discountBps)}, ${money(turn.discountMinor)} split among ${turn.waiterCount} seat${turn.waiterCount === 1 ? ' that waited' : 's that waited'}.`);
  }
  bits.push(`Fees: ${money(turn.platformFeeMinor)} platform, ${money(turn.organizerFeeMinor)} organizer${turn.organizerWaivedMinor > 0 ? `, ${money(turn.organizerWaivedMinor)} waived to the fund` : ''}, ${money(turn.fundFeeMinor)} to the guarantee fund.`);
  if (turn.bondHeldMinor > 0) bits.push(`${money(turn.bondHeldMinor)} bond held, returned as the winner kept paying.`);
  if (turn.lateFeesMinor > 0) bits.push(`Late fees collected this turn: ${money(turn.lateFeesMinor)}.`);
  if (turn.coveredCount > 0) bits.push(`${turn.coveredCount} contribution${turn.coveredCount === 1 ? ' was' : 's were'} covered so the pot closed on time.`);
  bits.push(`Winner net ${money(turn.winnerNetMinor)}.`);
  return bits.join(' ');
}

function replayStandings(recap, upto) {
  const rows = new Map();
  for (const member of recap.members || []) {
    rows.set(member.id, {
      id: member.id, name: member.name, seat: member.seat, role: member.role,
      paid: 0, late: 0, shares: 0, received: 0, receivedTurn: null,
    });
  }
  for (let index = 0; index <= upto; index += 1) {
    const turn = recap.turns[index];
    if (!turn) continue;
    for (const payment of turn.payments || []) {
      const row = rows.get(payment.membershipId);
      if (!row) continue;
      row.paid += Number(payment.amountMinor) || 0;
      row.late += Number(payment.lateFeeMinor) || 0;
    }
    for (const share of turn.shares || []) {
      const row = rows.get(share.membershipId);
      if (row) row.shares += Number(share.shareMinor) || 0;
    }
    const winner = rows.get(turn.winnerMembershipId);
    if (winner) {
      winner.received += Number(turn.winnerNetMinor) || 0;
      winner.receivedTurn = turn.number;
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, net: row.received + row.shares - row.paid - row.late }))
    .sort((left, right) => (Number(left.seat) || 0) - (Number(right.seat) || 0));
}

function replayMoneyFlow(recap, turn) {
  const payments = turn.payments || [];
  const collected = payments.reduce((total, item) => total + (Number(item.amountMinor) || 0), 0);
  const late = payments.reduce((total, item) => total + (Number(item.lateFeeMinor) || 0), 0);
  const covered = payments.filter((item) => item.covered).length;
  const shares = turn.shares || [];
  return `
    <div class="replay-flow">
      <div class="replay-col replay-col--in">
        <div class="replay-col__head"><span>MONEY IN</span><b>${money(collected)}</b></div>
        <div class="replay-col__rows">
          ${payments.map((item) => `<div class="replay-row"><span>${esc(item.name)}${item.covered ? '<em class="is-amber"> covered</em>' : ''}${item.lateFeeMinor ? `<em class="is-amber"> +${money(item.lateFeeMinor)} late</em>` : ''}</span><b>${money(item.amountMinor)}</b></div>`).join('') || '<p class="hint">No settled contributions recorded.</p>'}
        </div>
        <div class="replay-col__foot">
          <span>${payments.length} seat${payments.length === 1 ? '' : 's'} funded${late ? ` · ${money(late)} late fees to the fund` : ''}${covered ? ` · ${covered} shortfall${covered === 1 ? '' : 's'} covered` : ''}</span>
        </div>
      </div>
      <div class="replay-col replay-col--split">
        <div class="replay-col__head"><span>HOW THE POT SPLIT</span><b>${money(turn.potMinor)}</b></div>
        <div class="replay-col__rows">
          <div class="replay-row"><span>Funded pot</span><b>${money(turn.potMinor)}</b></div>
          ${turn.discountMinor ? `<div class="replay-row replay-row--share"><span>Seat price ${pct(turn.discountBps)} → ${turn.waiterCount} patient seat${turn.waiterCount === 1 ? '' : 's'}</span><b>− ${money(turn.discountMinor)}</b></div>` : ''}
          <div class="replay-row"><span>Platform ${pct(recap.platformBps || 100)}</span><b>− ${money(turn.platformFeeMinor)}</b></div>
          <div class="replay-row"><span>Organizer${turn.organizerWaivedMinor ? ' · waived to fund' : ''}</span><b>− ${money(turn.organizerWaivedMinor || turn.organizerFeeMinor)}</b></div>
          <div class="replay-row"><span>Guarantee fund ${pct(recap.fundBps || 100)}</span><b>− ${money(turn.fundFeeMinor)}</b></div>
          ${turn.bondHeldMinor ? `<div class="replay-row"><span>Bond held · returns as they pay</span><b class="amber">− ${money(turn.bondHeldMinor)}</b></div>` : ''}
          <div class="replay-row replay-row--total"><span>Winner net</span><b class="lime">${money(turn.winnerNetMinor)}</b></div>
        </div>
        <div class="replay-col__foot replay-balance ${(turn.winnerNetMinor + turn.discountMinor + turn.platformFeeMinor + turn.organizerFeeMinor + turn.organizerWaivedMinor + turn.fundFeeMinor + turn.bondHeldMinor) === turn.potMinor ? 'is-ok' : 'is-bad'}">
          ${icon('check')} Every shilling of the pot is accounted for.
        </div>
      </div>
      <div class="replay-col replay-col--out">
        <div class="replay-col__head"><span>MONEY OUT</span><b>${money(turn.winnerNetMinor + turn.discountMinor)}</b></div>
        <div class="replay-col__rows">
          <div class="replay-row replay-row--winner"><span>${esc(turn.winnerName)} · seat ${turn.winnerSeat ?? '—'}</span><b class="lime">${money(turn.winnerNetMinor)}</b></div>
          ${shares.map((share) => `<div class="replay-row"><span>${esc(share.name)} · patience share</span><b class="cyan">${money(share.shareMinor)}</b></div>`).join('') || '<p class="hint">No patience shares on this turn.</p>'}
        </div>
        <div class="replay-col__foot"><span>${shares.length ? `${shares.length} waiting seat${shares.length === 1 ? '' : 's'} each took ${money(turn.waiterShareMinor)}.` : 'The whole pot went to one seat.'}</span></div>
      </div>
    </div>
  `;
}

function recapBody(detail) {
  const recap = detail.recap;
  if (!recap?.turns?.length) return '';
  const last = recap.turns.length - 1;
  const index = Math.max(0, Math.min(last, Number(state.recap.index) || 0));
  state.recap.index = index;
  const turn = recap.turns[index];
  const totals = recap.totals;
  const playing = Boolean(state.recap.timer);
  const members = [...recap.members].sort((a, b) => (Number(a.seat) || 0) - (Number(b.seat) || 0));
  const standings = replayStandings(recap, index);
  const myId = recap.me?.id;
  const toMembers = totals.winnerNetMinor + totals.discountMinor + totals.bondReturnedMinor + totals.fundSplitMinor;
  const outstandingBonds = Math.max(0, totals.bondHeldMinor - totals.bondReturnedMinor);
  const nextRound = recap.circleNumber + 1;
  const closed = detail.circle?.status === 'completed' || index === last;
  return `
    <div class="recap__hero replay-hero">
      <div class="recap__hero-copy">
        <span class="eyebrow">ROUND ${recap.circleNumber} · REPLAY${recap.completedAt ? ` · CLOSED ${esc(fmtDate(recap.completedAt))}` : ' · IN PROGRESS'}</span>
        <h2>Every turn, seat by seat.</h2>
        <p>${recap.members.length} seats funded ${recap.turnsTotal} turns of ${money(detail.group.contributionMinor)} each. ${money(totals.potMinor)} moved through the wheel. Step through the turns to see exactly which seat funded, what it paid for, and who took the pot.</p>
      </div>
      <div class="recap__stats">
        <div><span>POTS SETTLED</span><b>${recap.turnsTotal}</b><small>one per member</small></div>
        <div><span>TO MEMBERS</span><b class="lime">${money(toMembers)}</b><small>nets, shares, bonds, split</small></div>
        <div><span>FEES &amp; FUND</span><b>${money(totals.feesMinor)}</b><small>platform ${money(totals.platformFeeMinor)} · fund ${money(totals.fundFeeMinor)}</small></div>
        <div><span>BALANCE</span><b class="${recap.balanced ? 'lime' : 'amber'}">${recap.balanced ? 'Exact' : 'Check'}</b><small>every pot to the shilling</small></div>
      </div>
    </div>
    <div class="recap__strip" role="group" aria-label="Replay turns">
      ${recap.turns.map((item, itemIndex) => `<button type="button" class="recap__chip${itemIndex === index ? ' is-active' : ''}${item.isFinal ? ' is-final' : ''}" data-action="recap-turn" data-turn="${item.number}" aria-pressed="${itemIndex === index}"><span>T${item.number}</span><b>${esc(item.winnerName.split(/\s+/)[0])}</b><em>${item.isFinal ? 'FINAL' : pct(item.discountBps)}</em></button>`).join('')}
    </div>
    <div class="recap__turn replay-turn${turn.isFinal ? ' is-final' : ''}" aria-live="polite">
      <div class="replay-engine">
        ${engineMarkup({
          key: `replay:${recap.circleId}:${turn.number}`,
          phase: 'settled',
          paid: turn.paidCount,
          total: recap.members.length,
          potMinor: turn.potMinor,
          round: recap.circleNumber,
          turn: turn.number,
          winnerName: turn.winnerName,
          winnerNetMinor: turn.winnerNetMinor,
          virtual: false,
        })}
      </div>
      <div class="recap__turn-head">
        <div>
          <span class="recap__k">TURN ${turn.number}${turn.isFinal ? ' · FINAL' : ''} · ${turn.isFinal ? 'FINAL SEAT · NO DISCOUNT' : `${pct(turn.discountBps)} SEAT PRICE`}</span>
          <h3>${esc(turn.winnerName)} was paid the pot</h3>
          <small>Seat ${turn.winnerSeat ?? '—'} · settled ${esc(fmtDateTime(turn.settledAt))} · ${turn.paidCount} contribution${turn.paidCount === 1 ? '' : 's'} cleared</small>
        </div>
        <div class="recap__net"><span>WINNER NET</span><b>${money(turn.winnerNetMinor)}</b></div>
      </div>
      ${replayMoneyFlow(recap, turn)}
      <p class="recap__narrative">${esc(recapSpeech(recap, turn))}</p>
      <div class="recap__controls">
        <button class="btn btn--line btn--sm" type="button" data-action="recap-step" data-delta="-1" ${index === 0 ? 'disabled' : ''}>${icon('chevron')} Previous</button>
        <button class="btn btn--lime btn--sm" type="button" data-action="${playing ? 'recap-stop' : 'recap-play'}">${icon('spin')} ${playing ? 'Pause replay' : index >= last ? 'Replay from turn 1' : 'Play replay'}</button>
        <button class="btn btn--line btn--sm" type="button" data-action="recap-step" data-delta="1" ${index === last ? 'disabled' : ''}>Next ${icon('chevron')}</button>
        <button class="btn btn--line btn--sm" type="button" data-action="recap-speak">${icon('bolt')} Read this turn</button>
      </div>
    </div>
    <div class="replay-seats">
      <div class="replay-seats__head"><h3>What every seat has, as of turn ${turn.number}</h3><span>RUNNING TOTALS · UPDATES AS YOU STEP</span></div>
      <div class="recap__members" role="table" aria-label="Running totals per member">
        <div class="recap__members-head" role="row"><span>MEMBER</span><span>PAID IN</span><span>SHARES</span><span>POT TAKEN</span><span>NET SO FAR</span></div>
        ${standings.map((member) => `<div class="recap__member${member.id === myId ? ' is-me' : ''}" role="row">
          <span class="recap__who">${esc(member.name)}${member.id === myId ? ' · you' : ''}${member.role === 'organizer' ? ' · organizer' : ''}</span>
          <span data-label="Paid in">${money(member.paid)}${member.late ? `<em class="is-amber"> +${money(member.late)} late</em>` : ''}</span>
          <span class="is-cyan" data-label="Shares">${money(member.shares)}</span>
          <span data-label="Pot taken">${member.receivedTurn ? `${money(member.received)}<em>T${member.receivedTurn}</em>` : '<em>waiting</em>'}</span>
          <b class="${member.net >= 0 ? 'is-lime' : 'is-amber'}" data-label="Net">${member.net >= 0 ? '+' : '−'} ${money(Math.abs(member.net))}</b>
        </div>`).join('')}
        <p class="recap__members-note">Net so far = pot taken + patience shares − contributions − late fees. Bonds and the final fund split are added when the round closes.</p>
      </div>
    </div>
    ${closed && recap.members.every((member) => member.receivedTurn) ? `
    <div class="recap__members recap__members--final" role="table" aria-label="Final result per member">
      <div class="recap__members-head" role="row"><span>MEMBER</span><span>PAID IN</span><span>SHARES + RETURNS</span><span>RECEIVED</span><span>FINAL NET</span></div>
      ${members.map((member) => `<div class="recap__member${member.id === myId ? ' is-me' : ''}" role="row">
        <span class="recap__who">${esc(member.name)}${member.id === myId ? ' · you' : ''}${member.role === 'organizer' ? ' · organizer' : ''}${member.bondReturnedMinor > 0 ? ` · bond ${money(member.bondReturnedMinor)} back` : ''}${member.fundSplitMinor > 0 ? ` · split ${money(member.fundSplitMinor)}` : ''}</span>
        <span data-label="Paid in">${money(member.paidMinor)}${member.lateFeesMinor ? `<em class="is-amber"> +${money(member.lateFeesMinor)} late</em>` : ''}</span>
        <span class="is-cyan" data-label="Shares">${money(member.discountsMinor + member.bondReturnedMinor + member.fundSplitMinor)}</span>
        <span data-label="Received">${member.receivedTurn ? `${money(member.receivedMinor)}<em>T${member.receivedTurn}</em>` : '<em>waiting</em>'}</span>
        <b class="${member.netMinor >= 0 ? 'is-lime' : 'is-amber'}" data-label="Net">${member.netMinor >= 0 ? '+' : '−'} ${money(Math.abs(member.netMinor))}</b>
      </div>`).join('')}
      <p class="recap__members-note">Final net = pot received + patience shares + bond returned + fund split − contributions − late fees. Every figure comes from a ledger entry.</p>
    </div>` : ''}
    <div class="recap__assure">
      <div><b>${icon('shield')} Pots balance to the shilling</b><span>${recap.balanced ? 'Each pot equals winner net + discounts + fees + bond, on every turn.' : 'A pot did not balance. The ledger is the source of truth; contact support before continuing.'}</span></div>
      <div><b>${icon('check')} One pot per member</b><span>${recap.members.every((member) => member.receivedTurn) ? 'Every seat received exactly once; no member could win twice.' : 'A seat did not receive in this round. The record shows exactly where it stopped.'}</span></div>
      <div><b>${icon('wallet')} Bonds came back</b><span>${money(totals.bondReturnedMinor)} returned as winners kept funding${outstandingBonds ? ` · ${money(outstandingBonds)} still held on open payouts` : ' · no bond was kept'}.</span></div>
    </div>
    <div class="recap__cta">
      <div>
        <b>${detail.round?.canPropose ? `Round ${nextRound} is ready when you are.` : 'What happens next?'}</b>
        <span>${detail.round?.canPropose ? 'Starting it lives on the circle page. The same roster re-accepts fresh terms before any new money moves.' : `The organizer proposes round ${nextRound}. Every member re-accepts the terms before turn one.`}</span>
      </div>
      <div class="recap__cta-actions">
        <a class="btn btn--line btn--sm" href="#${activeGroupPath('')}">Circle home ${icon('chevron')}</a>
        <a class="btn btn--line btn--sm" href="#${activeGroupPath('/ledger')}">Full ledger ${icon('chevron')}</a>
      </div>
    </div>
  `;
}

function recapUpdate(index) {
  const recap = state.group?.recap;
  if (!recap?.turns?.length) return;
  const last = recap.turns.length - 1;
  state.recap.index = Math.max(0, Math.min(last, index));
  if (state.recap.index >= last) stopRecapPlayback();
  const turn = recap.turns[state.recap.index];
  if (state.activeGroupId && turn) {
    history.replaceState(null, '', `#/g/${state.activeGroupId}/recap/${turn.number}`);
  }
  const body = document.querySelector('[data-recap-body]');
  if (body) {
    body.innerHTML = recapBody(state.group);
    mountEngines(body);
  }
}

async function viewRecap(turn) {
  if (!ensureActiveGroup()) {
    setWorkspace(emptyGroupPage('Round replay', 'The replay builds itself as your circle settles its turns.'));
    return;
  }
  try {
    const [detail, payload] = await Promise.all([
      loadGroupDetail(),
      api(`/groups/${state.activeGroupId}/recap`),
    ]);
    if (!detail || !payload?.recap) {
      setWorkspace(emptyGroupPage('Round replay', 'No turn has settled yet. The replay opens as soon as the first pot lands.'));
      return;
    }
    const recap = payload.recap;
    detail.recap = recap;
    state.group = detail;
    if (state.recap.key !== recap.circleId) {
      stopRecapPlayback();
      state.recap = { key: recap.circleId, index: 0, timer: null };
    }
    const wanted = turn ? recap.turns.findIndex((item) => item.number === Number(turn)) : recap.turns.length - 1;
    state.recap.index = wanted < 0 ? recap.turns.length - 1 : wanted;
    renderRecap(detail);
  } catch (error) { renderError(error.message); }
}

function renderRecap(detail) {
  const recap = detail.recap;
  const status = detail.circle?.status === 'completed' ? 'Round closed' : 'Round running';
  setWorkspace(`
    <div class="page replay-page">
      ${pageHead({
        eyebrow: `CIRCLE ${esc(detail.group.inviteCode)} · ROUND ${recap.circleNumber}`,
        title: 'The replay.',
        sub: `${status} · ${recap.turnsTotal} pots settled · ${recap.members.length} seats · every figure from the ledger`,
        actions: `<a class="btn btn--line btn--sm" href="#${activeGroupPath('')}">${icon('wheel')} Circle</a><a class="btn btn--line btn--sm" href="#${activeGroupPath('/turn')}">${icon('bolt')} Live turn</a><a class="btn btn--line btn--sm" href="#${activeGroupPath('/ledger')}">${icon('ledger')} Ledger</a>`,
      })}
      ${detail.circle?.status === 'completed' ? celebrationMarkup(detail, { context: 'recap' }) : ''}
      <div data-recap-root data-recap-body>${recapBody(detail)}</div>
    </div>
  `);
  mountEngines(dom.workspace);
}

function celebrationMarkup(detail, options = {}) {
  const recap = detail.recap;
  if (!recap?.turns?.length) return '';
  const totals = recap.totals || {};
  const members = [...(recap.members || [])];
  const mine = members.find((member) => member.id === recap.me?.id) || null;
  const ranked = [...members].sort((a, b) => Number(b.netMinor || 0) - Number(a.netMinor || 0));
  const nextRound = (Number(recap.circleNumber) || 1) + 1;
  const canPropose = Boolean(detail.round?.canPropose);
  const signed = (value) => `${Number(value) >= 0 ? '+' : '−'} ${money(Math.abs(Number(value) || 0))}`;
  const potMoved = Number(totals.potMinor || 0);
  const shareLine = mine
    ? `THE WHEEL · Round ${recap.circleNumber} closed. I paid in ${money(mine.paidMinor)} and finished ${signed(mine.netMinor)}. Every shilling is on the ledger.`
    : `THE WHEEL · Round ${recap.circleNumber} closed. ${money(potMoved)} moved through the wheel and every seat got paid once.`;
  const confetti = Array.from({ length: 18 }, (_, index) => {
    const colour = ['var(--lime)', 'var(--cyan)', 'var(--amber)', '#ff6b6b'][index % 4];
    return `<i style="--x:${(index * 53 + 7) % 100}%;--delay:${(index % 7) * 0.22}s;--spin:${(index % 2) ? 1 : -1};--c:${colour}"></i>`;
  }).join('');
  return `
    <section class="card span-12 celebrate" aria-label="Round ${recap.circleNumber} completed">
      <div class="celebrate__confetti" aria-hidden="true">${confetti}</div>
      <header class="celebrate__head">
        <span class="celebrate__k">ROUND ${recap.circleNumber} · COMPLETE${recap.completedAt ? ` · ${esc(fmtDate(recap.completedAt))}` : ''}</span>
        <h2>The wheel made a full turn.</h2>
        <p>${members.length} seats took ${recap.turnsTotal} pots. ${money(potMoved)} moved, every seat was paid once, and the ledger balanced to the shilling.</p>
      </header>
      <div class="celebrate__stats">
        <div><span>SEATS PAID</span><b>${members.length}</b></div>
        <div><span>POTS SETTLED</span><b>${recap.turnsTotal}</b></div>
        <div><span>MOVED</span><b class="lime">${money(potMoved)}</b></div>
        <div><span>FEES &amp; FUND</span><b>${money(totals.feesMinor || 0)}</b></div>
      </div>
      ${mine ? `
        <div class="celebrate__me">
          <div class="celebrate__me-main">
            <span>YOUR ROUND</span>
            <b class="${Number(mine.netMinor) >= 0 ? 'is-up' : 'is-down'}">${signed(mine.netMinor)}</b>
            <em>${mine.receivedTurn ? `Pot taken on turn ${mine.receivedTurn}` : 'You waited the whole round'} · ${money(mine.paidMinor)} paid in</em>
          </div>
          <div class="celebrate__me-chips">
            <span><em>Pot received</em><b>${mine.receivedTurn ? money(mine.receivedMinor) : '—'}</b></span>
            <span><em>Patience shares</em><b class="cyan">${money(mine.discountsMinor || 0)}</b></span>
            <span><em>Bond back</em><b>${money(mine.bondReturnedMinor || 0)}</b></span>
            <span><em>Fund split</em><b>${mine.fundSplitMinor ? money(mine.fundSplitMinor) : '—'}</b></span>
          </div>
        </div>` : ''}
      <div class="celebrate__board">
        <div class="celebrate__board-head"><span>EVERY SEAT</span><span>NET</span></div>
        <ol class="celebrate__rows">
          ${ranked.map((member, index) => `<li class="celebrate__row${member.id === recap.me?.id ? ' is-me' : ''}${index < 3 ? ` is-podium is-podium-${index + 1}` : ''}">
            <span class="celebrate__rank">${index + 1}</span>
            <span class="celebrate__who"><b>${esc(member.name)}${member.id === recap.me?.id ? ' · you' : ''}</b><em>${member.receivedTurn ? `pot on turn ${member.receivedTurn}` : 'waited'}${Number(member.discountsMinor) ? ` · shares ${money(member.discountsMinor)}` : ''}</em></span>
            <b class="celebrate__net ${Number(member.netMinor) >= 0 ? 'is-up' : 'is-down'}">${signed(member.netMinor)}</b>
          </li>`).join('')}
        </ol>
        <p class="celebrate__note">${icon('shield')} Net = pot received + patience shares + bond returned + fund split − contributions paid. Nothing here is an estimate; every figure is a ledger entry.</p>
      </div>
      <div class="celebrate__foot">
        <div class="celebrate__next">
          <b>${canPropose ? `Keep the wheel turning?` : 'What happens next?'}</b>
          <span>${canPropose ? `Round ${nextRound} needs every member to accept fresh terms before any money moves. Nothing starts on its own.` : `The organizer can propose round ${nextRound}. Every member re-accepts before turn one.`}</span>
        </div>
        <div class="celebrate__actions">
          <button class="btn btn--line btn--sm" type="button" data-action="copy" data-copy="${esc(shareLine)}">${icon('copy')} Copy my result</button>
          ${options.context === 'dashboard' ? `<a class="btn btn--line btn--sm" href="#/g/${detail.group.id}">Round page ${icon('chevron')}</a>` : `<a class="btn btn--line btn--sm" href="#${activeGroupPath('/ledger')}">Full ledger ${icon('chevron')}</a>`}
          ${canPropose ? `<button class="btn btn--lime btn--sm" type="button" data-action="open-propose-round">Start round ${nextRound} ${icon('arrow')}</button>` : ''}
        </div>
      </div>
    </section>
  `;
}

function engineHead(detail) {
  const { group, cycle } = detail;
  const forming = group.status === 'forming';
  const completed = group.status === 'completed';
  const stateLabel = completed ? 'ROUND CLOSED' : forming ? 'FORMING' : `TURN ${cycle?.number || '—'} · ${String(cycle?.status || '').toUpperCase()}`;
  return `
    <header class="engine-page__top">
      <div class="engine-page__id">
        <span class="eyebrow">CIRCLE ${esc(group.inviteCode)} · ROUND ${detail.round?.number || 1}</span>
        <h1>${esc(group.name)}</h1>
        <div class="engine-page__meta">
          <span>${money(group.contributionMinor)} / turn</span>
          <span>${group.memberCount} of ${group.maxMembers} seats</span>
          <span>${cadenceLabel(group.cadence)}</span>
          <span class="engine-page__state">${esc(stateLabel)}</span>
        </div>
      </div>
      <div class="engine-page__actions">
        ${statusPill(completed ? 'completed' : forming ? 'forming' : cycle?.status || group.status)}
        ${group.visibility === 'open' && forming ? `<a class="btn btn--line btn--sm" href="#/open">${icon('users')} Open list</a>` : ''}
        ${completed ? '' : `<button class="btn btn--line btn--sm" type="button" data-action="open-invite">${icon('share')} Invite</button>`}
        <a class="btn btn--line btn--sm" href="#${activeGroupPath('/ledger')}">${icon('ledger')} Ledger</a>
      </div>
    </header>
  `;
}

function engineActions(detail) {
  const { group, cycle, settlement } = detail;
  if (group.status === 'completed') {
    return `<a class="btn btn--lime btn--block" href="#${activeGroupPath('/recap')}">${icon('spin')} Replay every turn</a>`;
  }
  if (!cycle) {
    return group.status === 'forming'
      ? `<button class="btn btn--lime btn--block" type="button" data-action="open-invite">${icon('users')} Fill the circle</button>`
      : '';
  }
  if (settlement) {
    return `<a class="btn btn--line btn--block" href="#${activeGroupPath('/turn')}">${icon('ledger')} Open the receipt</a>`;
  }
  if (cycle.myContribution?.status === 'paid') {
    const waiting = Math.max(0, (cycle.memberCount || 0) - (cycle.paidCount || 0));
    return `<span class="engine-rail__wait">${icon('clock')} You are in · waiting on ${waiting} seat${waiting === 1 ? '' : 's'}</span>`;
  }
  return `<button class="btn btn--lime btn--block" type="button" data-action="open-contribute">${icon('bolt')} Contribute ${money(cycle.amountDueMinor || cycle.contributionMinor)}</button>`;
}

function engineRoom(detail) {
  const { group, cycle, settlement, me } = detail;
  const total = Number(cycle?.memberCount || group.memberCount || 0);
  const paid = Number(cycle?.paidCount || 0);
  const target = Number(cycle?.potExpectedMinor || group.contributionMinor * total);
  const pot = Number(settlement?.potMinor ?? cycle?.potCapturedMinor ?? 0);
  const owner = cycle?.turnOwner;
  const ownerFirst = owner?.name ? owner.name.split(/\s+/)[0] : '';
  return `
    <section class="engine-room" data-engine-room aria-label="Circle engine">
      <div class="engine-room__stage">
        ${engineMarkup({
          key: cycle?.id || group.id,
          phase: settlement ? 'settled' : cycle?.status === 'contributing' ? 'contributing' : cycle ? 'funded' : 'forming',
          paid, total, potMinor: pot,
          round: detail.round?.number || 1,
          turn: cycle?.number || 0,
          winnerName: settlement?.winnerName,
          winnerNetMinor: settlement?.winnerNetMinor,
        })}
      </div>
      <aside class="engine-room__rail">
        <div class="engine-rail__pot">
          <span>${settlement ? 'SETTLED POT' : 'POT THIS TURN'}</span>
          <b>${money(pot)}</b>
          <em>target ${money(target)}</em>
        </div>
        ${progressBar(pot, target)}
        <div class="engine-rail__grid">
          ${stat('FUNDED', `${paid}/${total}`, settlement ? 'turn settled' : 'seats in')}
          ${stat('PAID SEAT', owner ? `Seat ${owner.seatNo}` : '—', ownerFirst || 'no seat open')}
          ${stat('YOUR SEAT', me?.seat || '—', me?.hasWon ? 'pot received' : me?.seat ? `pays turn ${me.seat}` : 'waiting')}
          ${stat('YOUR BOND', pct(me?.bondBps || 0), 'returns as you pay')}
        </div>
        ${settlement ? `<div class="engine-rail__winner">
          <span>${icon('check')} Turn ${cycle.number} settled</span>
          <b>${esc(settlement.winnerName)}</b>
          <em>${money(settlement.winnerNetMinor)} net</em>
        </div>` : ''}
        <div class="engine-rail__actions">${engineActions(detail)}</div>
        <p class="engine-rail__note">${icon('lock')} The pot closes only when every seat funds. Settlement writes itself to the ledger.</p>
      </aside>
    </section>
  `;
}

function turnTrack(detail) {
  const { group, cycle, turns = [] } = detail;
  const total = Number(detail.circle?.turnsTotal || cycle?.memberCount || group.memberCount || 0);
  if (!total) return '';
  const byNumber = new Map(turns.map((turn) => [Number(turn.number), turn]));
  const settledCount = turns.filter((turn) => turn.status === 'settled').length;
  const current = Number(cycle?.number || 0);
  const chips = Array.from({ length: total }, (_, index) => {
    const number = index + 1;
    const turn = byNumber.get(number);
    const settled = turn?.status === 'settled';
    const live = !settled && number === current;
    const isFinal = Boolean(turn?.isFinal) || number === total;
    const firstName = turn?.winnerName ? turn.winnerName.split(/\s+/)[0] : '';
    const body = settled
      ? `<span>T${number}</span><b>${esc(firstName)}</b><em>${isFinal ? 'FINAL' : pct(turn.discountBps || 0)}</em>`
      : `<span>T${number}</span><b>${live ? 'LIVE' : 'LOCKED'}</b><em>${isFinal ? 'FINAL' : live ? `${cycle?.paidCount || 0}/${cycle?.memberCount || total}` : '—'}</em>`;
    const className = `turn-chip${settled ? ' is-done' : ''}${live ? ' is-live' : ''}${isFinal ? ' is-final' : ''}`;
    return settled
      ? `<a class="${className}" href="#${activeGroupPath(`/recap/${number}`)}" aria-label="Replay turn ${number}">${body}</a>`
      : `<span class="${className}" aria-label="Turn ${number} ${live ? 'live' : 'locked'}">${body}</span>`;
  }).join('');
  return `
    <section class="turn-track" aria-label="Turns in this round">
      <div class="turn-track__head">
        <span>TURN BY TURN</span>
        <b>${settledCount} of ${total} settled</b>
        ${settledCount ? `<a class="turn-track__link" href="#${activeGroupPath('/recap')}">${icon('ledger')} Replay the round</a>` : ''}
      </div>
      <div class="turn-track__rail">${chips}</div>
    </section>
  `;
}

function renderCircle(detail) {
  const { group, cycle, settlement } = detail;
  const forming = group.status === 'forming';
  const completed = group.status === 'completed' && Boolean(detail.recap);
  setWorkspace(`
    <div class="engine-page${completed ? ' is-complete' : ''}${forming ? ' is-forming' : ''}">
      ${engineHead(detail)}
      ${forming ? '' : engineRoom(detail)}
      ${forming ? '' : turnTrack(detail)}
      ${forming ? '' : liveStrip(detail)}
      ${forming ? '' : turnStory(detail)}
      ${completed ? celebrationMarkup(detail, { context: 'page' }) : ''}
      <div class="engine-grid">
        ${forming ? `
          <section class="card span-7">
            <div class="card__head"><h2 class="card__title">Gathering the circle</h2>${statusPill('forming')}</div>
            ${gatherCard(detail)}
          </section>
          <section class="card span-5">
            <div class="card__head"><h2 class="card__title">Your seat</h2>${statusPill('forming')}</div>
            ${seatPanelForming(detail)}
          </section>
          ${group.visibility === 'open' ? `
          <section class="card span-12">
            <div class="card__head"><h2 class="card__title">Prepaid seats</h2>${pill('OPEN CIRCLE · ANYONE VERIFIED CAN TAKE A SEAT', 'lime')}</div>
            ${openSeatBoard(detail)}
            <div class="oc-assure oc-assure--inline">
              <div class="oc-assure__step"><span>01</span><b>ID verified once</b><em>One ID, one account. A second account cannot take a second seat here.</em></div>
              <div class="oc-assure__step"><span>02</span><b>Turn 1 prepaid</b><em>Seat money becomes the first contribution when the circle starts.</em></div>
              <div class="oc-assure__step"><span>03</span><b>Never trapped</b><em>Refunded to the wallet if the circle stalls for ${SEAT_REFUND_DAYS} days or the member leaves before the start.</em></div>
            </div>
          </section>` : ''}
          <section class="card span-12">
            <div class="card__head"><h2 class="card__title">Before turn one</h2>${pill(`SEAT ${group.memberCount} OF 5 MINIMUM`, 'lime')}</div>
            <ol class="firstturn__steps">
              <li class="${group.memberCount < 5 ? 'is-active' : ''}"><b>01</b><span><strong>Fill five seats</strong><em>${group.visibility === 'open' ? 'Verified members take open seats from the open list and prepay turn 1. Seats lock when the circle starts.' : 'Each member joins with the invite code and creates their own passkey. Seats lock when the circle starts.'}</em></span><i>${group.memberCount >= 5 ? 'DONE' : `${group.memberCount}/5`}</i></li>
              <li class="${group.memberCount >= 5 ? 'is-active' : ''}"><b>02</b><span><strong>Start turn one</strong><em>The organizer opens the circle. The contribution and member count lock at that moment.</em></span><i>${group.memberCount >= 5 ? 'NOW' : 'NEXT'}</i></li>
              <li><b>03</b><span><strong>Fund, then the wheel turns</strong><em>Every seat funds the same ${money(group.contributionMinor)}. Once the pot is whole, the turn's seat is paid — no bidding, no waiting on a clock.</em></span><i>THEN</i></li>
            </ol>
          </section>
        ` : `
          <section class="card span-7 auction__stage">
            <div class="auction__head">
              <div><span class="auction__label">TURN ${cycle?.number || '—'} · ${(cycle?.status || group.status).toUpperCase()}</span><div class="countdown${cycle?.status === 'funded' ? ' is-closed' : ''}">${cycle?.status === 'funded' ? 'PAYING NOW' : `${cycle?.paidCount || 0}/${cycle?.memberCount || group.memberCount}`}</div></div>
              <div class="auction__pot"><span>${settlement ? 'SETTLED POT' : 'CAPTURED POT'}</span><b>${money(settlement?.potMinor ?? cycle?.potCapturedMinor ?? 0)}</b></div>
            </div>
            ${wheelMarkup(detail, { timer: false })}
            ${seatLadderStrip(detail)}
            ${lifecycleTrack(detail)}
            <div class="auction__foot">
              <span class="sealed-note">${icon('lock')} ${settlement ? 'Every figure is a ledger entry.' : 'The pot is funded before a seat is paid.'}</span>
              <a class="btn btn--line btn--sm" href="#${activeGroupPath('/turn')}">${settlement ? 'Open receipt' : 'Open this turn'} ${icon('chevron')}</a>
            </div>
          </section>
          <section class="card span-5">
            <div class="card__head"><h2 class="card__title">Your seat</h2>${statusPill(cycle?.status || group.status)}</div>
            ${seatPanel(detail)}
          </section>
        `}
      </div>
      ${settlement ? `
        <section class="card">
          <div class="card__head"><h2 class="card__title">Where the pot went</h2>${pill(`TURN ${cycle.number} · ${settlement.winnerName.split(/\s+/)[0]}`, 'lime')}</div>
          ${flowMarkup(settlement, detail)}
        </section>
      ` : ''}
      ${fairnessMarkup(detail)}
      <details class="engine-fold">
        <summary>${icon('users')} Members, guarantee fund &amp; the rules</summary>
        <div class="engine-fold__body">
          <div class="engine-grid">
            <section class="card span-7">
              <div class="card__head"><h2 class="card__title">Members</h2><a class="card__link" href="#${activeGroupPath('/members')}">Manage ${icon('chevron')}</a></div>
              <div class="members__head"><span>MEMBER</span><span>STANDING</span><span>THIS TURN</span></div>
              <div class="members">
                ${(detail.members || []).slice(0, 6).map((member) => memberRow(member, { compact: true })).join('')}
              </div>
              ${detail.members?.length > 6 ? `<p class="hint" style="margin-top:12px">+${detail.members.length - 6} more in the members list.</p>` : ''}
            </section>
            <section class="card span-5">
              <div class="card__head"><h2 class="card__title">Guarantee fund</h2>${pill(money(detail.fund?.balanceMinor || 0), 'lime')}</div>
              <div class="next-turn">
                <p class="hint" style="margin:0">Every pot contributes 1% to the fund. Late fees, forfeited bonds, and a waived organizer fee also land here. The fund covers a shortfall only when the guarantor and organizer cannot.</p>
                <div class="members">
                  ${(detail.fund?.entries || []).slice(0, 4).map(fundEntryRow).join('') || '<p class="hint">The fund is empty until the first settled pot.</p>'}
                </div>
                <div class="group-hero__foot">
                  <a class="btn btn--line btn--sm" href="#${activeGroupPath('/ledger')}">View ledger ${icon('chevron')}</a>
                  ${group.isOrganizer && cycle?.paidCount !== cycle?.memberCount ? `<button class="btn btn--line btn--sm" type="button" data-action="open-cover">Cover shortfall</button>` : ''}
                </div>
              </div>
            </section>
            <section class="card span-12 oc-protect">
              <div class="card__head"><h2 class="card__title">Nobody loses quietly</h2>${forming ? pill('STARTS WITH ZERO EXPOSURE') : pill(`COVER ${Number(detail.protection?.coveragePct) || 0}%`, Number(detail.protection?.coveragePct) >= 100 ? 'lime' : 'cyan')}</div>
              ${forming ? '<p class="hint" style="margin:0">No contributions move while the circle forms. The cover pool builds from the first winner\'s bond, the guarantee fund, and the organizer\'s own seat — before anyone\'s money is at risk.</p>' : protectionPanel(detail)}
            </section>
            <section class="card span-12">
              <div class="card__head"><h2 class="card__title">The rules you accepted</h2><a class="card__link" href="#rules">Rulebook ${icon('chevron')}</a></div>
              <div class="stat-grid">
                ${stat('CONTRIBUTION', money(group.contributionMinor), 'fixed')}
                ${stat('SEAT LADDER', '10 → 1 → 0%', 'posted prices')}
                ${stat('PLATFORM', pct(detail.rules?.platformBps || 100), 'of each pot')}
                ${stat('ORGANIZER', pct(group.organizerFeeBps), 'waived to fund if they win')}
                ${stat('GUARANTEE FUND', pct(detail.rules?.fundBps || 100), 'of each pot')}
                ${stat('LATE FEE', pct(detail.rules?.lateFeeBps || 200), `after ${detail.rules?.graceHours || 24}h, cap ${pct(detail.rules?.lateCapBps || 1000)}`)}
                ${stat('PAYOUT', 'Instant', 'when the pot is whole')}
                ${stat('BOND BANDS', '25/20/15/10%', 'by trust tier')}
              </div>
            </section>
          </div>
        </div>
      </details>
    </div>
  `);
  armCountdown();
  armWheelFx(detail);
  mountEngines(dom.workspace);
  if (forming) startFormingPoll();
  else if (cycle) startCircleLivePoll();
}
function turnRail(detail, activeNumber) {
  const total = Number(detail.circle?.turnsTotal || 0);
  if (!total) return '';
  const settled = new Map((detail.turns || []).map((turn) => [Number(turn.number), turn]));
  const current = Number(detail.cycle?.number || 0);
  const chips = Array.from({ length: total }, (_, index) => {
    const number = index + 1;
    const done = settled.get(number);
    const final = number === total;
    const live = number === current && !done;
    const active = number === activeNumber;
    const body = `<span>T${number}</span><b>${done ? esc(String(done.winnerName).split(/\s+/)[0]) : live ? 'LIVE' : final ? 'FINAL' : 'LOCKED'}</b><em>${done ? (final ? 'final' : pct(done.discountBps)) : live ? `${detail.cycle?.paidCount || 0}/${detail.cycle?.memberCount || total}` : '—'}</em>`;
    const cls = `turn-rail__chip${done ? ' is-done' : ''}${live ? ' is-live' : ''}${active ? ' is-active' : ''}${final ? ' is-final' : ''}`;
    if (done) return `<a class="${cls}" href="#${activeGroupPath(`/recap/${number}`)}" aria-current="${active ? 'page' : 'false'}">${body}</a>`;
    if (live) return `<a class="${cls}" href="#${activeGroupPath('/turn')}" aria-current="${active ? 'page' : 'false'}">${body}</a>`;
    return `<span class="${cls}">${body}</span>`;
  }).join('');
  return `<nav class="turn-rail" aria-label="Turns in this round">${chips}</nav>`;
}

async function viewAuction() {
  if (!ensureActiveGroup()) {
    setWorkspace(emptyGroupPage('The wheel', 'The turn opens as soon as your circle starts.'));
    return;
  }
  try {
    const detail = await loadGroupDetail();
    if (!detail) { setWorkspace(emptyGroupPage('The wheel', 'The turn opens as soon as your circle starts.')); return; }
    const wanted = groupRoute()?.turn;
    const current = Number(detail.cycle?.number || 0);
    if (wanted && wanted !== current) {
      navigate(`/g/${detail.group.id}/recap/${wanted}`, { replace: true });
      return;
    }
    renderAuction(detail);
  } catch (error) { renderError(error.message); }
}

function renderAuction(detail, options = {}) {
  const { group, cycle, settlement, me } = detail;
  if (!cycle) {
    if (group.status === 'forming') {
      setWorkspace(`
        <div class="page">
          ${pageHead({ eyebrow: 'THE WHEEL', title: 'The circle is still forming.', sub: `${group.memberCount} of ${group.maxMembers} seats are in. The wheel starts once the organizer opens turn one.` })}
          <section class="card">
            <div class="card__head"><h2 class="card__title">Seats so far</h2>${statusPill('forming')}</div>
            ${seatBoard(detail)}
            <div class="group-hero__foot" style="margin-top:14px">
              <button class="btn btn--line btn--sm" type="button" data-action="open-invite">${icon('share')} Invite code</button>
              <a class="btn btn--lime btn--sm" href="#${activeGroupPath('')}">Circle home ${icon('chevron')}</a>
            </div>
          </section>
        </div>
      `);
      startFormingPoll();
      return;
    }
    setWorkspace(`
      <div class="page">
        ${pageHead({ eyebrow: 'THE WHEEL', title: 'No turn open.', sub: 'The wheel runs on a funded pot. Start or resume a turn first.' })}
        <section class="card">${emptyTurnPanel(detail)}</section>
      </div>
    `);
    return;
  }
  const live = ['funded', 'auction', 'settling'].includes(cycle.status);
  const winner = settlement ? (detail.members || []).find((member) => member.id === settlement.winnerMembershipId) : null;
  const myShare = settlement?.myShareMinor || 0;
  const myBond = settlement?.myBondMinor || 0;
  setWorkspace(`
    <div class="page">
      ${pageHead({
        eyebrow: `THE WHEEL · TURN ${cycle.number}${cycle.isFinal ? ' · FINAL' : ''}`,
        title: settlement ? 'Settled.' : cycle.status === 'contributing' ? 'The pot is funding.' : cycle.isFinal ? 'The final turn.' : 'This turn is paying out.',
        sub: `${esc(group.name)} · pot ${money(cycle.potCapturedMinor)} of ${money(cycle.potExpectedMinor)} · seat ${cycle.turnOwner?.seatNo || cycle.number}`,
        actions: `${statusPill(cycle.status)}<a class="btn btn--line btn--sm" href="#${activeGroupPath('')}">${icon('wheel')} Circle</a>${(detail.turns || []).length ? `<a class="btn btn--line btn--sm" href="#${activeGroupPath('/recap')}">${icon('spin')} Replay</a>` : ''}${cycle.status === 'contributing' ? `<button class="btn btn--lime btn--sm" type="button" data-action="open-contribute" ${cycle.myContribution?.status === 'paid' ? 'disabled' : ''}>${cycle.myContribution?.status === 'paid' ? 'Contribution in' : 'Contribute'}</button>` : ''}`,
      })}
      ${turnRail(detail, cycle.number)}
      ${fairnessMarkup(detail)}
      ${engineMarkup({ key: cycle.id, phase: settlement ? 'settled' : cycle.status === 'contributing' ? 'contributing' : 'funded', paid: cycle.paidCount, total: cycle.memberCount, potMinor: settlement?.potMinor ?? cycle.potCapturedMinor, round: detail.round?.number || 1, turn: cycle.number, winnerName: settlement?.winnerName, winnerNetMinor: settlement?.winnerNetMinor })}
      <div class="auction-grid">
        <section class="card span-7 auction__stage">
          <div class="auction__head">
            <div>
              <span class="auction__label">${settlement ? 'SETTLED' : cycle.status === 'funded' ? 'PAYS OUT NOW' : cycle.status === 'contributing' ? 'CONTRIBUTION CLOSES IN' : 'STATUS'}</span>
              <div class="countdown${settlement || cycle.status === 'funded' ? ' is-closed' : ''}" ${settlement || cycle.status === 'funded' ? '' : `data-countdown="${esc(cycle.contributionDueAt)}" data-done="Due"`}>${settlement ? 'FINAL' : cycle.status === 'funded' ? 'NOW' : '00:00:00'}</div>
            </div>
            <div class="auction__pot"><span>${settlement ? 'SETTLED POT' : 'POT'}</span><b>${money(settlement?.potMinor ?? cycle.potCapturedMinor)}</b></div>
          </div>
          ${wheelMarkup(detail, { timer: false })}
          ${seatLadderStrip(detail)}
          ${lifecycleTrack(detail)}
          <div class="auction__stats">
            ${stat('MEMBERS', String(cycle.memberCount), 'fixed')}
            ${stat('FUNDED', `${cycle.paidCount}/${cycle.memberCount}`, 'whole pot')}
            ${stat('SEAT PRICE', pct((cycle.ladderMinor || [])[(cycle.number || 1) - 1] || 0), cycle.isFinal ? 'final turn' : 'posted, never bid')}
            ${stat('WINNER', settlement ? esc(settlement.winnerName.split(/\s+/)[0]) : cycle.isFinal ? 'FINAL TURN' : '—', settlement ? `${pct(settlement.discountBps)} discount` : 'revealed at settle', settlement ? 'lime' : '')}
          </div>
          <div class="auction__foot">
            <span class="sealed-note">${icon('lock')} ${settlement ? 'Every figure below is a ledger entry.' : cycle.isFinal ? 'The last seat takes the pot at 0% discount and no bond.' : 'Seat prices are posted at the start. Nobody guesses a number.'}</span>
            ${cycle.canClose && !settlement ? `<button class="btn btn--lime btn--sm" type="button" data-action="open-settle">Settle this turn ${icon('arrow')}</button>` : ''}
          </div>
        </section>
        <section class="card span-5 bidpanel-card">
          ${settlement ? receiptPanel(detail, winner, myShare, myBond) : auctionSidePanel(detail)}
        </section>
      </div>
    </div>
  `);
  armCountdown();
  mountEngines(dom.workspace);
  if (settlement) {
    const animate = options.animate ?? (state.wheelAnimatedCycleId !== settlement.id);
    revealSeats(detail, animate);
    if (animate) state.wheelAnimatedCycleId = settlement.id;
  }
  armWheelFx(detail);
  if (live) startAuctionPoll();
}

function auctionSidePanel(detail) {
  const { cycle, group, me } = detail;
  if (cycle.status === 'contributing') {
    const paid = cycle.myContribution?.status === 'paid';
    return `
      <div class="bidpanel">
        <div class="card__head"><h2 class="card__title">Pot funding</h2>${statusPill('contributing')}</div>
        ${progressBar(cycle.potCapturedMinor, cycle.potExpectedMinor)}
        <div class="count-row"><span>Funded</span><b>${money(cycle.potCapturedMinor)} / ${money(cycle.potExpectedMinor)}</b></div>
        <div class="estimate">
          <div class="estimate__row"><span>Your contribution</span><b>${paid ? 'PAID' : money(cycle.amountDueMinor || cycle.contributionMinor)}</b></div>
          <div class="estimate__row"><span>Late fee</span><b class="${cycle.lateFeeMinor ? 'amber' : ''}">${cycle.lateFeeMinor ? money(cycle.lateFeeMinor) : 'None'}</b></div>
          <div class="estimate__row"><span>Deadline</span><b>${fmtDateTime(cycle.contributionDueAt)}</b></div>
        </div>
        <div class="notice notice--amber">${icon('clock')}<span>The turn pays out only when every active member has funded it. No IOUs, no partial pot.</span></div>
        <button class="btn btn--lime btn--block" type="button" data-action="open-contribute" ${paid ? 'disabled' : ''}>${paid ? 'Contribution in' : 'Contribute now'}</button>
        ${group.isOrganizer ? `<button class="btn btn--line btn--block" type="button" data-action="open-cover" ${cycle.paidCount === cycle.memberCount ? 'disabled' : ''}>Cover a shortfall</button>` : ''}
      </div>
    `;
  }
  if (cycle.status === 'settling') {
    return `<div class="empty"><span class="empty__art">${icon('spin')}</span><h3>Settling.</h3><p>The settlement is being written to the ledger. This panel refreshes automatically.</p><button class="btn btn--line" type="button" data-action="refresh">Refresh</button></div>`;
  }
  if (cycle.status !== 'funded') {
    return `<div class="empty"><span class="empty__art">${icon('wheel')}</span><h3>No open turn.</h3><p>The next turn opens when the organizer starts it.</p></div>`;
  }
  return turnSeatCard(detail);
}

function turnSeatCard(detail) {
  const { cycle, group, me, members } = detail;
  const myMember = (members || []).find((member) => member.id === me?.membershipId) || null;
  const owner = cycle.turnOwner;
  const mine = Boolean(owner && owner.membershipId === me?.membershipId);
  const ladder = cycle.ladderMinor || group?.seatLadderBps || [];
  const seatPrice = ladder[(cycle.number || 1) - 1] ?? 0;
  const mySeat = Number(myMember?.seat || 0);
  const myPrice = mySeat ? ladder[mySeat - 1] : null;
  const whole = Boolean(cycle.canClose);
  return `
    <div class="bidpanel">
      <div class="card__head"><h2 class="card__title">${whole ? 'Paying out' : 'This turn’s seat'}</h2>${statusPill(whole ? 'live' : 'contributing')}</div>
      ${whole
        ? `<div class="notice notice--lime">${icon('spin')}<span>The pot is whole. Turn ${cycle.number} pays seat ${owner?.seatNo || cycle.number} now — no clock to wait for.</span></div>`
        : `<div class="notice notice--cyan">${icon('clock')}<span>The turn pays out the moment every seat has funded it. No auction, no bid window.</span></div>`}
      <div class="estimate">
        <div class="estimate__row"><span>This turn pays</span><b>${owner ? esc(owner.name) : `Seat ${cycle.number}`}${mine ? ' · you' : ''}</b></div>
        <div class="estimate__row"><span>Seat price</span><b>${pct(seatPrice)}</b></div>
        <div class="estimate__row"><span>Take-home</span><b class="lime">${money(cycle.payoutNow || 0)}</b></div>
        <div class="estimate__row"><span>Your seat</span><b>${mySeat ? `Seat ${mySeat} · ${pct(myPrice ?? 0)}` : '—'}</b></div>
      </div>
      <p class="hint">${mine ? 'This pot is yours as soon as the turn is whole.' : mySeat ? `Seat ${mySeat} pays on turn ${mySeat}. Waiting seats share every discount paid along the way.` : 'Your seat pays on its own turn.'}</p>
      ${cycle.canClose ? `<button class="btn btn--line btn--block" type="button" data-action="open-settle">Write the receipt now</button>` : ''}
    </div>
  `;
}

function seatLadderStrip(detail) {
  const { group, cycle, me, members } = detail;
  const ladder = cycle?.ladderMinor || group?.seatLadderBps || [];
  if (!ladder.length) return '';
  const myMember = (members || []).find((member) => member.id === me?.membershipId) || null;
  const mySeat = Number(myMember?.seat || 0);
  return `<div class="ladder" role="list" aria-label="Seat prices">
    ${ladder.map((bps, index) => {
      const turn = index + 1;
      const final = turn === ladder.length;
      const cls = ['ladder__seat', cycle?.number === turn ? 'is-now' : '', mySeat === turn ? 'is-mine' : '', final ? 'is-final' : ''].filter(Boolean).join(' ');
      return `<div class="${cls}" role="listitem"><span>TURN ${turn}</span><b>${final ? '0%' : pct(bps)}</b><em>${mySeat === turn ? 'your seat' : final ? 'full pot' : 'discount'}</em></div>`;
    }).join('')}
  </div>`;
}

function potGuideTurnAt(group, index) {
  if (!group?.startedAt) return null;
  let at = new Date(Date.parse(group.startedAt));
  const cadence = groupCadence(group);
  for (let step = 0; step < index; step += 1) at = new Date(scheduledTurnAt(at, cadence));
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

// The whole circle on one sheet: every turn, its posted seat price, who it
// pays, and where the earning actually comes from. Numbers mirror
// settlementMath so the plan cannot drift from the payout.
function openPotGuide() {
  const detail = state.group;
  if (!detail?.group) return;
  const group = detail.group;
  const seats = Math.max(2, Number(detail.circle?.turnsTotal || group.turnsTotal || group.memberCount || 5));
  const contribution = Number(group.contributionMinor || 0);
  const pot = contribution * seats;
  const organizerBps = Number(group.organizerFeeBps || 100);
  const mySeat = Number(detail.me?.seat || 0);
  const bySeat = new Map((detail.members || []).map((member) => [Number(member.seat), member]));
  const turns = Array.from({ length: seats }, (_, index) => {
    const turn = index + 1;
    const member = bySeat.get(turn) || null;
    const math = seatNetPreview(seats, turn, pot, {
      trust: member?.trustScore ?? 60,
      organizerWins: member?.role === 'organizer',
      organizerFeeBps: organizerBps,
    });
    return { turn, member, math, at: potGuideTurnAt(group, index) };
  });
  const mine = turns.find((row) => row.turn === mySeat) || null;
  const patience = mine ? turns.filter((row) => row.turn < mine.turn).reduce((sum, row) => sum + Number(row.math.waiterShareMinor || 0), 0) : 0;
  const finalNet = turns[turns.length - 1]?.math.winnerNetMinor || 0;
  openSheet({
    kicker: 'THE WHOLE CIRCLE',
    title: 'How the pot moves.',
    body: `
      <div class="potguide">
        <div class="potguide__plate">
          <div><span>ONE TURN · FULL POT</span><b>${money(pot)}</b><em>${seats} seats × ${money(contribution)} each</em></div>
          <div class="potguide__plate-meta"><span>${cadenceLabel(groupCadence(group)).toUpperCase()}</span><span>${seats} TURNS</span><span>NO INTEREST</span></div>
        </div>
        <ol class="potguide__mech">
          <li><b>01</b><span><strong>Every seat pays ${money(contribution)} each turn</strong><em>The pot only moves when every seat is in. No partial payouts, no IOUs, no borrowing.</em></span></li>
          <li><b>02</b><span><strong>The turn's seat takes ${money(pot)}</strong><em>Minus the posted seat price, the small fees, and a bond that comes back as they keep paying.</em></span></li>
          <li><b>03</b><span><strong>Early seats pay for speed</strong><em>Turn 1 carries the biggest seat price. Every seat that waits shares that money — this is where a member earns.</em></span></li>
          <li><b>04</b><span><strong>The last seat pays 0%</strong><em>Wait the full circle and take the whole pot. Early money or a bigger net — never both.</em></span></li>
        </ol>
        <div class="potguide__head"><h3>Every seat, in turn order</h3><span>${group.startedAt ? 'PROJECTED FROM THE START DATE' : 'DATES LOCK WHEN THE CIRCLE STARTS'}</span></div>
        <div class="potguide__turns">
          ${turns.map((row) => {
            const final = row.turn === seats;
            const isMe = row.turn === mySeat;
            return `<div class="potguide__turn${isMe ? ' is-mine' : ''}">
              <span class="potguide__turn-k"><b>TURN ${row.turn}</b><em>${row.at ? fmtDate(row.at) : row.turn === 1 ? 'at the start' : '—'}</em></span>
              <span class="potguide__turn-who"><b>${row.member ? esc(row.member.name) : `Seat ${row.turn}`}${isMe ? ' · you' : ''}</b><em>${row.member?.hasWon ? 'already took a pot' : 'pays every turn'}</em></span>
              <span class="potguide__turn-price"><b>${final ? '0%' : pct(row.math.discountBps)}</b><em>seat price</em></span>
              <span class="potguide__turn-net"><b>${money(row.math.winnerNetMinor)}</b><em>takes now</em></span>
              <span class="potguide__turn-share"><b>${row.math.waiterShareMinor ? `+${money(row.math.waiterShareMinor)}` : '—'}</b><em>each waiter</em></span>
            </div>`;
          }).join('')}
        </div>
        ${mine ? `<div class="potguide__mine">
          <span class="potguide__mine-k">YOUR SEAT ${mySeat}</span>
          <b>${mine.at ? `Pays on turn ${mySeat} · ${fmtDate(mine.at)}` : `Pays on turn ${mySeat}, once the circle starts`}</b>
          <div class="potguide__mine-grid">
            <span>Takes now<b class="is-ok">${money(mine.math.winnerNetMinor)}</b><em>after seat price & fees</em></span>
            ${mine.math.bondHoldMinor ? `<span>Bond held<b>${money(mine.math.bondHoldMinor)}</b><em>returns as you pay</em></span>` : ''}
            <span>Patience so far<b class="is-ok">${money(patience)}</b><em>shared from earlier seats</em></span>
            <span>You pay in all<b>${money(contribution * seats)}</b><em>${money(contribution)} × ${seats} turns</em></span>
          </div>
          <p>${mySeat === seats
            ? 'You hold the final seat: no seat price, no bond, and the biggest net of anyone. Your money arrives last.'
            : `Seats that take the pot before you pay a price for it, and you share that price. Later seats finish bigger; earlier seats finish faster.`}</p>
        </div>` : `<p class="potguide__note">Take a seat and this sheet shows your line: what your turn pays, the bond that returns, and the patience shares you collect while you wait.</p>`}
        <p class="potguide__note">Fees per pot: platform ${pct(detail.rules?.platformBps || 100)}, guarantee fund ${pct(detail.rules?.fundBps || 100)} (split back to perfect records at the close), organizer ${pct(organizerBps)} (waived to the fund if the organizer wins). Seat prices are set by the rulebook, never by a member. The final seat finishes near ${money(finalNet)} with no seat price and no bond.</p>
      </div>
    `,
    foot: '<button class="btn btn--line" type="button" data-action="close-sheet">Close</button>',
  });
}

function receiptPanel(detail, winner, myShare, myBond) {
  const settlement = detail.settlement;
  const me = detail.me;
  const iWon = winner?.id === me?.membershipId;
  const iWait = !iWon && myShare > 0;
  return `
    <div class="receipt">
      <div class="receipt__head">${statusPill(settlement.isFinal ? 'settled' : settlement.status === 'held' ? 'settled' : 'settled')}<span class="mono">TURN ${detail.cycle.number} · ${esc(settlement.winnerName.split(/\s+/)[0])}</span></div>
      <h3 class="receipt__title">${iWon ? 'You took the pot.' : settlement.isFinal ? 'The circle closed.' : 'The wheel paid.'}</h3>
      <p class="receipt__winner">${settlement.isFinal ? 'The final seat took the pot with no seat price and no bond.' : `${esc(settlement.winnerName)} took the pot early at a ${pct(settlement.discountBps)} seat price; ${settlement.waiterCount} seat${settlement.waiterCount === 1 ? ' that waited' : 's that waited'} shared ${money(settlement.discountMinor)} for their patience.`}</p>
      <div class="receipt__rows">
        <div class="receipt__row"><span>Pot captured</span><b>${money(settlement.potMinor)}</b></div>
        <div class="receipt__row"><span>Early-bird price · ${pct(settlement.discountBps)}</span><b>− ${money(settlement.discountMinor)}</b></div>
        <div class="receipt__row receipt__row--sub"><span>Patience share · ${settlement.waiterCount} seat${settlement.waiterCount === 1 ? '' : 's'}</span><b>${money(settlement.waiterShareMinor)} each</b></div>
        <div class="receipt__row"><span>Platform · ${pct(detail.rules?.platformBps || 100)}</span><b>− ${money(settlement.platformFeeMinor)}</b></div>
        <div class="receipt__row"><span>Organizer${settlement.organizerFeeWaivedMinor ? ' · waived to fund' : ` · ${pct(detail.group.organizerFeeBps)}`}</span><b>− ${money(settlement.organizerFeeMinor)}</b></div>
        <div class="receipt__row"><span>Guarantee fund · ${pct(detail.rules?.fundBps || 100)}</span><b>− ${money(settlement.fundFeeMinor)}</b></div>
        <div class="receipt__row"><span>Bond held${settlement.bondTargetMinor > settlement.bondHoldMinor ? ' · balance owed' : ''}</span><b class="amber">− ${money(settlement.bondHoldMinor)}</b></div>
      </div>
      <div class="receipt__total"><span>Winner net</span><b>${money(settlement.winnerNetMinor)}</b></div>
      <p class="receipt__note">${settlement.status === 'held' ? `Held until ${fmtDateTime(settlement.releaseAt)}.` : 'Released. The winner can withdraw from the wallet.'} ${settlement.bondHoldMinor ? 'The bond releases as the winner pays the remaining turns.' : ''} ${settlement.isFinal ? 'The unused guarantee fund is split among members with a perfect record.' : ''}</p>
      ${iWon ? `<div class="notice notice--lime">${icon('wallet')}<span>${money(settlement.winnerNetMinor)} ${settlement.status === 'held' ? 'is in your wallet, held for release' : 'is available in your wallet'}.</span></div>` : ''}
      ${iWait ? `<div class="notice notice--lime">${icon('trend')}<span>Your patience share of ${money(myShare)} is available in your wallet now.</span></div>` : ''}
      ${myBond > 0 ? `<div class="notice notice--amber">${icon('lock')}<span>${money(myBond)} of your payout is held as a bond and releases as you fund the remaining turns.</span></div>` : ''}
      <div class="group-hero__foot" style="margin-top:14px">
        <a class="btn btn--line btn--sm" href="#${activeGroupPath('/ledger')}">Ledger ${icon('chevron')}</a>
        <a class="btn btn--line btn--sm" href="#${activeGroupPath(`/recap/${detail.cycle.number}`)}">Replay this turn ${icon('spin')}</a>
        <button class="btn btn--line btn--sm" type="button" data-action="download-receipt">${icon('download')} Receipt</button>
      </div>
    </div>
  `;
}

async function viewLedger() {
  if (!ensureActiveGroup()) {
    setWorkspace(emptyGroupPage('Ledger', 'Every movement in the circle is a ledger entry.'));
    return;
  }
  try {
    const [detail, ledger] = await Promise.all([
      loadGroupDetail({ silent: true }),
      api(`/groups/${state.activeGroupId}/ledger`),
    ]);
    if (!detail) { setWorkspace(emptyGroupPage('Ledger', 'Every movement in the circle is a ledger entry.')); return; }
    state.ledger = ledger;
    renderLedger(detail, ledger);
  } catch (error) { renderError(error.message); }
}

function ledgerGroups(entries) {
  const groups = [];
  entries.forEach((entry) => {
    const label = entry.cycleNumber ? `Turn ${entry.cycleNumber}` : 'Circle account';
    let group = groups.find((item) => item.label === label);
    if (!group) {
      group = { label, entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  });
  return groups;
}

function renderLedger(detail, ledger) {
  const entries = ledger.entries || [];
  const wallet = ledger.wallet || detail.wallet || {};
  const fund = ledger.fund || detail.fund || { balanceMinor: 0, entries: [] };
  const filters = [
    ['all', 'All'], ['contributions', 'Contributions'], ['payouts', 'Payouts'],
    ['fees', 'Fees'], ['bonds', 'Bonds'],
  ];
  const filtered = entries.filter((entry) => {
    if (state.ledgerFilter === 'all') return true;
    if (state.ledgerFilter === 'contributions') return entry.kind === 'contribution' || entry.kind === 'cover';
    if (state.ledgerFilter === 'payouts') return entry.kind === 'winner' || entry.kind === 'discount' || entry.kind === 'withdrawal' || entry.kind === 'fund_split';
    if (state.ledgerFilter === 'fees') return ['platform_fee', 'organizer_fee', 'fund_fee'].includes(entry.kind);
    if (state.ledgerFilter === 'bonds') return String(entry.kind).startsWith('bond');
    return true;
  });
  const sumKinds = (kinds) => entries.reduce((sum, entry) => sum + (kinds.includes(entry.kind) ? Number(entry.amountMinor || 0) : 0), 0);
  const contributed = sumKinds(['contribution', 'cover']);
  const shares = sumKinds(['discount']);
  const potsPaid = sumKinds(['winner']);
  const fees = sumKinds(['platform_fee', 'organizer_fee', 'fund_fee']);
  setWorkspace(`
    <div class="page">
      ${pageHead({
        eyebrow: `LEDGER · ${esc(detail.group.name)}`,
        title: 'Every movement, in order.',
        sub: `Contributions, patience shares, fees, bonds, and withdrawals across the latest ${entries.length} entries. Amounts are recorded in Kenyan shillings.`,
        actions: `<button class="btn btn--line btn--sm" type="button" data-action="statement">${icon('download')} Statement</button>`,
      })}
      <div class="dash-pulse">
        <div><span>CONTRIBUTED</span><b>${money(contributed)}</b><em>seats into pots</em></div>
        <div><span>PATIENCE SHARES</span><b>${money(shares)}</b><em>paid to seats that waited</em></div>
        <div><span>POTS PAID</span><b>${money(potsPaid)}</b><em>winner nets</em></div>
        <div><span>FEES &amp; FUND</span><b>${money(fees)}</b><em>platform, organizer, fund</em></div>
      </div>
      <div class="dash-grid">
        <section class="card span-8">
          <div class="card__head"><h2 class="card__title">Activity</h2>${pill(`${entries.length} entries`)}</div>
          <div class="tabs" role="tablist" aria-label="Ledger filters">
            ${filters.map(([key, label]) => `<button class="tab${state.ledgerFilter === key ? ' is-active' : ''}" type="button" role="tab" aria-selected="${state.ledgerFilter === key}" data-action="filter-ledger" data-filter="${key}">${label}</button>`).join('')}
          </div>
          ${filtered.length ? `<div class="ledger">${ledgerGroups(filtered).map((group) => `
            <div class="ledger__group">
              <div class="ledger__grouphead">
                <span>${esc(group.label)}</span>
                <span>${group.entries.length} ${group.entries.length === 1 ? 'entry' : 'entries'}</span>
              </div>
              ${group.entries.map(ledgerRow).join('')}
            </div>
          `).join('')}</div>` : `
            <div class="empty"><span class="empty__art">${icon('ledger')}</span><h3>No entries here.</h3><p>Move to another filter, or come back when the circle settles a turn.</p></div>
          `}
        </section>
        <section class="card span-4">
          <div class="card__head"><h2 class="card__title">Balance</h2>${pill('KES', 'lime')}</div>
          <span class="stat__k">AVAILABLE NOW</span>
          <b class="pot-line__v" style="font-size:30px">${money(wallet.availableMinor || 0)}</b>
          <div class="wallet-card__break">
            <div class="wallet-card__row"><span>On hold</span><b class="amber">${money(wallet.pendingMinor || 0)}</b></div>
            <div class="wallet-card__row"><span>Bond held</span><b>${money(wallet.bondHeldMinor || 0)}</b></div>
            <div class="wallet-card__row"><span>Discounts earned</span><b class="lime">${money(wallet.discountEarnedMinor || 0)}</b></div>
          </div>
          <div class="wallet-card__actions">
            <button class="btn btn--line btn--sm" type="button" data-action="open-wallet">Wallet</button>
            <button class="btn btn--lime btn--sm" type="button" data-action="open-withdraw" ${!state.config.withdrawalsConfigured || !wallet.availableMinor ? 'disabled' : ''}>Withdraw</button>
          </div>
        </section>
        <section class="card span-12">
          <div class="card__head"><h2 class="card__title">Guarantee fund</h2>${pill(money(fund.balanceMinor || 0), 'lime')}</div>
          ${(fund.entries || []).length ? `<div class="ledger">${fund.entries.slice(0, 10).map(fundEntryRow).join('')}</div>` : `<div class="empty"><span class="empty__art">${icon('shield')}</span><h3>The fund is empty.</h3><p>It fills with 1% of each settled pot, late fees, and forfeited bonds.</p></div>`}
        </section>
      </div>
    </div>
  `);
}

async function viewMembers() {
  if (!ensureActiveGroup()) {
    setWorkspace(emptyGroupPage('Members', 'The people in your circle and the guarantees between them.'));
    return;
  }
  try {
    const detail = await loadGroupDetail();
    if (!detail) { setWorkspace(emptyGroupPage('Members', 'The people in your circle and the guarantees between them.')); return; }
    renderMembers(detail);
  } catch (error) { renderError(error.message); }
}

function memberRow(member, options = {}) {
  const isMe = member.userId === state.me?.id;
  const idChecked = member.kycStatus === 'verified' || member.seatStatus === 'paid';
  const tags = [
    member.kycStatus === 'verified' ? pill('VERIFIED', 'lime') : idChecked ? pill('ID CHECKED', 'lime') : pill('KYC PENDING', 'amber'),
    member.hasWon ? pill('TAKEN', 'cyan') : '',
    member.paidThisCycle ? pill('PAID', 'lime') : (options.compact ? '' : pill('UNPAID', '')),
  ].filter(Boolean).join('');
  const actions = options.compact ? '' : `
    ${!idChecked && state.group?.group?.isOrganizer && !isMe ? `<button class="btn btn--sm btn--line" type="button" data-action="open-verify" data-member="${esc(member.id)}">Verify</button>` : ''}
    ${state.group?.group?.isOrganizer && !isMe ? `<button class="btn btn--sm btn--quiet" type="button" data-action="open-guarantee" data-member="${esc(member.id)}">Guarantee</button>` : ''}
    ${!isMe ? `<button class="btn btn--sm btn--quiet" type="button" data-action="open-dispute" data-member="${esc(member.id)}" aria-label="Report an issue with ${esc(member.name)}">${icon('flag')}</button>` : ''}
  `;
  return `
    <div class="member">
      <span class="avatar">${initials(member.name)}</span>
      <div class="member__main"><b>${esc(member.name)}${isMe ? ' · you' : ''}${member.role === 'organizer' ? ' · organizer' : ''}</b><span>${esc(member.phoneMasked || 'Phone private')} · joined ${fmtDate(member.joinedAt)}</span></div>
      <div class="member__meta"><span>TRUST <b>${member.trustScore}</b></span><div class="trustbar"><i style="width:${member.trustScore}%"></i></div><span>${member.guarantor ? `Guaranteed by ${esc(member.guarantor.name)}` : 'No guarantor'}</span></div>
      <div class="member__tags">${tags}${actions}</div>
    </div>
  `;
}

function memberCard(member, detail) {
  const isMe = member.userId === state.me?.id;
  const isOrganizer = Boolean(detail.group?.isOrganizer);
  const idChecked = member.kycStatus === 'verified' || member.seatStatus === 'paid';
  const actions = [
    detail.swaps?.open && !isMe
      ? `<button class="btn btn--sm btn--line" type="button" data-action="open-swap" data-member="${esc(member.id)}">${icon('swap')} Swap</button>` : '',
    !idChecked && isOrganizer && !isMe
      ? `<button class="btn btn--sm btn--line" type="button" data-action="open-verify" data-member="${esc(member.id)}">Verify</button>` : '',
    isOrganizer && !isMe
      ? `<button class="btn btn--sm btn--quiet" type="button" data-action="open-guarantee" data-member="${esc(member.id)}">Guarantee</button>` : '',
    !isMe
      ? `<button class="btn btn--sm btn--quiet" type="button" data-action="open-dispute" data-member="${esc(member.id)}" aria-label="Report an issue with ${esc(member.name)}">${icon('flag')}</button>` : '',
  ].filter(Boolean).join('');
  return `
    <article class="member member-card${isMe ? ' is-me' : ''}">
      <div class="member-card__top">
        <span class="member-card__seat">SEAT ${String(member.seat || 0).padStart(2, '0')}</span>
        <span class="member-card__badges">${isMe ? pill('YOU', 'lime') : member.role === 'organizer' ? pill('ORGANIZER', 'cyan') : ''}</span>
      </div>
      <div class="member-card__id">
        <span class="avatar avatar--lg">${initials(member.name)}</span>
        <div><b>${esc(member.name)}</b><span>${esc(member.phoneMasked || 'Phone private')}</span></div>
      </div>
      <div class="member-card__ring">
        ${trustRing(member.trustScore)}
        <div><b>${member.trustScore}</b><span>${tierName(member.trustScore)} · ${pct(member.bondBps)} bond</span></div>
      </div>
      <div class="member-card__facts">
        <span>This turn <b class="${member.paidThisCycle ? 'lime' : 'amber'}">${member.paidThisCycle ? 'Funded' : 'Due'}</b></span>
        <span>Payout <b>${member.hasWon ? 'Taken' : 'Waiting'}</b></span>
        <span>KYC <b class="${idChecked ? 'lime' : 'amber'}">${member.kycStatus === 'verified' ? 'Verified' : idChecked ? 'ID checked' : 'Pending'}</b></span>
        <span>Guarantor <b>${member.guarantor ? esc(member.guarantor.name) : 'None'}</b></span>
      </div>
      <div class="member-card__foot">${actions || '<span class="member-card__self">Your seat</span>'}</div>
    </article>
  `;
}

function swapDesk(detail) {
  const swaps = detail.swaps || {};
  const incoming = swaps.incoming || [];
  const outgoing = swaps.outgoing || [];
  const rows = [
    ...incoming.map((offer) => `
      <div class="swap-row is-incoming">
        <span class="swap-row__icon">${icon('swap')}</span>
        <div class="swap-row__main">
          <b>${esc(offer.fromName)} wants to trade seats</b>
          <span>Seat ${offer.fromSeat} for your seat ${offer.toSeat}${offer.note ? ` · “${esc(offer.note)}”` : ''} · expires <span data-countdown="${esc(offer.expiresAt)}" data-done="offer expired">—</span></span>
        </div>
        <div class="swap-row__actions">
          <button class="btn btn--sm btn--lime" type="button" data-action="swap-accept" data-swap="${esc(offer.id)}">Accept trade</button>
          <button class="btn btn--sm btn--quiet" type="button" data-action="swap-decline" data-swap="${esc(offer.id)}">Decline</button>
        </div>
      </div>`),
    ...outgoing.map((offer) => `
      <div class="swap-row">
        <span class="swap-row__icon">${icon('clock')}</span>
        <div class="swap-row__main">
          <b>Waiting on ${esc(offer.toName)}</b>
          <span>Your seat ${offer.fromSeat} for their seat ${offer.toSeat} · expires <span data-countdown="${esc(offer.expiresAt)}" data-done="offer expired">—</span></span>
        </div>
        <div class="swap-row__actions">
          <button class="btn btn--sm btn--quiet" type="button" data-action="swap-cancel" data-swap="${esc(offer.id)}">Withdraw</button>
        </div>
      </div>`),
  ].join('');
  if (rows) {
    return `<div class="swap-desk" role="region" aria-label="Seat swaps">${rows}<p class="swap-desk__foot">Seat swaps move seat numbers only. No money, bonds, or ledger entries change hands.</p></div>`;
  }
  if (!swaps.open) {
    return `<p class="hint swap-desk__hint">${icon('lock')}<span>${esc(swaps.reason || 'Seat swaps open while the circle is forming.')}</span></p>`;
  }
  return `<p class="hint swap-desk__hint">${icon('swap')}<span>Want the pot sooner or later? Use <b>Swap</b> on any member. Both of you must agree before seats move.</span></p>`;
}

function openSwapSheet(memberId) {
  const detail = state.group;
  const member = detail?.members?.find((item) => item.id === memberId);
  const myMember = (detail?.members || []).find((item) => item.id === detail?.me?.membershipId);
  if (!detail || !member || !myMember || member.id === myMember.id) return;
  if (!detail.swaps?.open) {
    toast(detail.swaps?.reason || 'Swaps are closed while the round runs.', 'error');
    return;
  }
  const ladder = detail.cycle?.ladderMinor || detail.group?.seatLadderBps || [];
  const mySeat = Number(myMember.seat) || 1;
  const theirSeat = Number(member.seat) || 1;
  const price = (seat) => (ladder.length ? `${pct(ladder[seat - 1] ?? 0)} seat price` : 'seat price on the ladder');
  openSheet({
    kicker: 'SEAT SWAP · FORMING ONLY',
    title: `Trade seats with ${String(member.name || '').split(/\s+/)[0]}?`,
    body: `
      <div class="swap-stage">
        <div class="swap-stage__seat"><span>YOU MOVE TO</span><b>Seat ${theirSeat}</b><small>${price(theirSeat)}</small></div>
        <span class="swap-stage__arrow">${icon('swap')}</span>
        <div class="swap-stage__seat"><span>THEY MOVE TO</span><b>Seat ${mySeat}</b><small>${price(mySeat)}</small></div>
      </div>
      <div class="estimate">
        <div class="estimate__row"><span>Who approves</span><b>Both members, personally</b></div>
        <div class="estimate__row"><span>What moves</span><b>Seat numbers only</b></div>
        <div class="estimate__row"><span>Money and bonds</span><b>Nothing moves</b></div>
        <div class="estimate__row"><span>When it applies</span><b>Before turn one starts</b></div>
        <div class="estimate__row"><span>Offer life</span><b>48 hours</b></div>
      </div>
      <form class="form" data-form="swap" data-id="${esc(member.id)}" style="margin-top:14px">
        <label class="field"><span>Why the swap? Optional, shown to them</span><input class="input" name="note" maxlength="160" autocomplete="off" placeholder="e.g. I need the pot earlier this month"></label>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block" type="submit">Send swap offer ${icon('arrow')}</button>
      </form>
      <p class="hint" style="margin-top:10px">They must accept before any seat moves. Seat prices on the ladder stay posted for everyone.</p>
    `,
  });
}

async function submitSwapOffer(form) {
  const detail = state.group;
  const targetMembershipId = form.dataset.id;
  if (!detail || !targetMembershipId) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Sending');
  try {
    const result = await api(`/groups/${detail.group.id}/seat-swaps`, {
      method: 'POST',
      body: { targetMembershipId, note: String(form.note?.value || '').trim() || undefined },
    });
    closeSheet();
    toast(`Offer sent to ${result.swap?.toName || 'the member'}. Seats move only when they accept.`, 'lime');
    await refreshRoute();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function respondSwap(swapId, action, button) {
  const detail = state.group;
  if (!detail || !swapId) return;
  setBusy(button, true);
  try {
    const result = await api(`/groups/${detail.group.id}/seat-swaps/${swapId}`, { method: 'POST', body: { action } });
    if (action === 'accept') toast(`Done. You hold seat ${result.mySeat} from turn one.`, 'lime');
    else if (action === 'decline') toast('Declined. Seats stay as they are.');
    else toast('Offer withdrawn. Seats stay as they are.');
  } catch (error) {
    toast(error.message, 'error');
  }
  await refreshRoute();
}

function renderMembers(detail) {
  const group = detail.group;
  const verified = (detail.members || []).filter((member) => member.kycStatus === 'verified' || member.seatStatus === 'paid').length;
  const members = [...(detail.members || [])].sort((a, b) => (a.seat || 0) - (b.seat || 0));
  setWorkspace(`
    <div class="page">
      ${pageHead({
        eyebrow: `MEMBERS · ${esc(group.inviteCode)}`,
        title: 'The circle.',
        sub: `${group.memberCount} of ${group.maxMembers} seats · ${verified} verified for payout · ${group.status === 'forming' ? 'forming' : 'seats locked'}`,
        actions: `<button class="btn btn--line btn--sm" type="button" data-action="open-invite">${icon('share')} Invite</button>`,
      })}
      <div class="dash-grid">
        <section class="card span-8">
          <div class="card__head"><h2 class="card__title">Members</h2>${pill(`${members.length} seats`)}</div>
          ${swapDesk(detail)}
          <div class="member-grid">${members.map((member) => memberCard(member, detail)).join('')}</div>
        </section>
        <section class="card span-4">
          <div class="card__head"><h2 class="card__title">Invite</h2>${pill('PRIVATE', 'lime')}</div>
          <div class="invite-code"><div><span>INVITE CODE</span><br><b>${esc(group.inviteCode)}</b></div><button class="iconbtn" type="button" data-action="copy" data-copy="${esc(group.inviteCode)}" aria-label="Copy invite code">${icon('copy')}</button></div>
          <p class="hint" style="margin-top:12px">Only share this code with people you trust. The circle is private; the code is the door.</p>
          <button class="btn btn--line btn--block" type="button" data-action="open-invite">${icon('share')} Share invite</button>
          <div class="divider"></div>
          <div class="trust-facts">
            <span>Guarantor limit <b>2 members each</b></span>
            <span>One guarantor <b>per member</b></span>
            <span>KYC before payout <b>Organizer verifies</b></span>
            <span>First payout hold <b>48 hours</b></span>
          </div>
        </section>
        <section class="card span-12">
          <div class="card__head"><h2 class="card__title">How guarantees hold</h2></div>
          <div class="stat-grid">
            ${stat('GUARANTEE FUND', money(detail.fund?.balanceMinor || 0), '1% of every pot')}
            ${stat('DEFAULTS', String(detail.members.reduce((sum, member) => sum + Number(member.defaults || 0), 0)), 'circle lifetime', 'amber')}
            ${stat('VERIFIED', `${verified}/${detail.members.length}`, 'identity checked')}
            ${stat('TURNS LEFT', String(Math.max(0, (detail.circle?.turnsTotal || group.memberCount) - (detail.cycle?.number || 0))), 'this circle')}
          </div>
          <p class="hint" style="margin-top:14px">A guarantor can cover up to two members. The fund is the second line of defence. A defaulting member loses their place and their bond; the winner's payout is never reversed.</p>
        </section>
      </div>
    </div>
  `);
}

async function viewSettings() {
  try {
    const [account, detail] = await Promise.all([
      api('/account'),
      ensureActiveGroup() ? api(`/groups/${state.activeGroupId}`).catch(() => null) : Promise.resolve(null),
    ]);
    state.account = account;
    if (account.user) state.me = account.user;
    if (account.wallet) state.wallet = account.wallet;
    if (detail) state.group = detail;
    renderSettings(account, detail);
    resumeWalletTopUp();
  } catch (error) { renderError(error.message); }
}

function paymentsRailPanel() {
  const config = state.config || {};
  const mode = config.paymentsProvider === 'paysasa' ? 'PAYSASA CONNECTED' : config.paymentsProvider === 'simulated' ? 'LOCAL CHECKOUT' : 'NOT CONNECTED';
  const endpoint = `${location.origin}${config.webhookPath || '/functions/v1/app/payments/paysasa/webhook'}`;
  return `<section class="admin-panel admin-panel--rail">
    <div class="admin-panel__head"><span>Payment rail</span><span>${mode}</span></div>
    <div class="admin-panel__body">
      <div class="admin-row">
        <span class="admin-row__dot ${config.paymentsConfigured ? 'is-ok' : 'is-warn'}"></span>
        <span class="admin-row__copy"><b>${config.paymentsConfigured ? 'Checkouts open' : 'Checkouts closed'}</b><em>${config.paymentsConfigured ? 'Top-ups and contributions open a Paysasa checkout. The signed webhook, not the browser, settles them.' : 'The payment account is not configured on the server yet.'}</em></span>
      </div>
      <div class="admin-rail__label">SIGNED WEBHOOK ENDPOINT</div>
      <code class="admin-rail__url">${esc(endpoint)}</code>
      <button class="btn btn--line btn--sm" type="button" data-action="copy" data-copy="${esc(endpoint)}">${icon('copy')} Copy endpoint</button>
      <div class="admin-rail__steps">
        <div><span>01</span><b>Paste it in Paysasa</b><em>Business webhook URL. A quick tunnel address changes every restart, so re-paste it each session.</em></div>
        <div><span>02</span><b>Secret stays on the server</b><em>The signing secret is read from the server environment; the browser never sees it.</em></div>
        <div><span>03</span><b>Run one test charge</b><em>Top up the stash from the wallet, approve the M-PESA prompt, then confirm the ledger entry.</em></div>
      </div>
      <div class="admin-rail__check">
        <button class="btn btn--line btn--sm" type="button" data-action="rail-probe">${icon('gauge')} Test the rail</button>
        <em>Opens one small sandbox checkout and cancels it, so you see exactly what the provider answers.</em>
      </div>
      <div class="admin-rail__result" data-rail-result hidden></div>
      ${testApprovalsRow()}
      <div class="admin-panel__note">Withdrawals: ${config.withdrawalsConfigured ? 'open to M-PESA.' : esc(config.withdrawalBlocker || 'paused until payout terms are verified.')}</div>
    </div>
  </section>`;
}

function testApprovalsRow() {
  const approvals = state.testApprovals || state.config.testApprovals || { available: false, enabled: false };
  return `<div class="admin-rail__label">SANDBOX TEST APPROVALS</div>
    <div class="admin-row admin-row--toggle">
      <span class="admin-row__dot ${approvals.enabled ? 'is-ok' : 'is-warn'}"></span>
      <span class="admin-row__copy"><b>${approvals.enabled ? 'Cancelled prompts book as paid' : 'Cancelled prompts stay unpaid'}</b><em>${approvals.available
        ? 'Testing only: when on, a cancelled or failed sandbox prompt still writes the stash top-up, marked as a sandbox approval. Never honoured on a live key.'
        : 'Unavailable until a simulated or sandbox payment account is connected. Live keys can never auto-approve.'}</em></span>
      <button class="btn btn--line btn--sm" type="button" data-action="test-approvals-toggle" ${approvals.available ? '' : 'disabled'}>${approvals.enabled ? 'Turn off' : 'Turn on'}</button>
    </div>`;
}

async function toggleTestApprovals(button) {
  const current = state.testApprovals || state.config.testApprovals || { enabled: false };
  const next = !current.enabled;
  setBusy(button, true, next ? 'Turning on' : 'Turning off');
  try {
    const result = await api('/admin/payments/test-approvals', { method: 'POST', body: { enabled: next } });
    state.testApprovals = result;
    state.config.testApprovals = result;
    setBusy(button, false);
    toast(next
      ? 'Sandbox test approvals on: a cancelled prompt now books the top-up.'
      : 'Sandbox test approvals off: cancelled prompts stay unpaid.', next ? 'lime' : '');
    soundAt(next ? 'confirm' : 'latch', button);
    await viewAdmin();
  } catch (error) {
    setBusy(button, false);
    toast(error.message, 'error');
  }
}

async function runRailProbe(button) {
  setBusy(button, true, 'Testing rail');
  const box = button.closest('.admin-panel__body')?.querySelector('[data-rail-result]');
  try {
    const { probe } = await api('/admin/payments/probe', { method: 'POST', body: {} });
    setBusy(button, false);
    if (!box) return;
    const refused = probe.ok ? false : probe.code !== 'probe_skipped';
    box.hidden = false;
    box.className = `admin-rail__result ${probe.ok ? 'is-ok' : refused ? 'is-bad' : 'is-warn'}`;
    const hint = /chama/i.test(probe.message || '')
      ? 'This business is registered as a chama, and Paysasa only opens hosted checkout to standard businesses. Verify the business, collect through its Contribution or Paybill routing, or keep the local simulator for walkthroughs.'
      : '';
    box.innerHTML = `${icon(probe.ok ? 'check' : refused ? 'alert' : 'clock')}
      <div><b>${probe.ok ? 'Rail is collecting' : refused ? 'Provider refused' : 'Check skipped'}</b>
      <em>${esc(probe.message)}</em>
      <span>${esc(String(probe.mode || 'unknown').toUpperCase())}${probe.keyKind ? ` · ${esc(probe.keyKind.toUpperCase())} KEY` : ''}${probe.providerStatus ? ` · HTTP ${probe.providerStatus}` : ''}</span>
      ${hint ? `<p class="admin-rail__hint">${esc(hint)}</p>` : ''}</div>`;
    const panel = button.closest('.admin-panel--rail');
    if (panel) {
      panel.querySelector('.admin-panel__head span:last-child').textContent = probe.ok ? 'RAIL OPEN' : refused ? 'PROVIDER REFUSED' : 'CHECK SKIPPED';
      const title = panel.querySelector('.admin-row__copy b');
      const copy = panel.querySelector('.admin-row__copy em');
      if (refused && title) { title.textContent = 'Checkouts refused'; if (copy) copy.textContent = probe.message; }
      if (probe.ok && title) { title.textContent = 'Checkouts open'; if (copy) copy.textContent = 'Top-ups and contributions open a Paysa checkout. The signed webhook, not the browser, settles them.'; }
    }
    soundAt(probe.ok ? 'confirm' : 'error', button);
  } catch (error) {
    setBusy(button, false);
    toast(error.message || 'The rail check did not run.', 'error');
  }
}

function adminStat(label, value, meta, tone = '') {
  return `<div class="admin-stat${tone ? ` is-${tone}` : ''}"><span>${label}</span><b>${value}</b><em>${meta}</em></div>`;
}

function adminOverviewMarkup(overview, ids) {
  if (!overview) {
    return `<section class="admin-panel"><div class="admin-panel__body"><div class="admin-empty">The overview did not load. Refresh to try again.</div></div></section>`;
  }
  const totals = overview.totals || {};
  const circles = overview.circles || [];
  const unbalanced = overview.unbalanced || [];
  const settled = Number(totals.balancedSettlements || 0) + Number(totals.unbalancedSettlements || 0);
  return `
    <div class="admin-stat-grid">
      ${adminStat('CIRCLES', String(totals.groups ?? 0), `${totals.active ?? 0} active · ${totals.forming ?? 0} forming · ${totals.completed ?? 0} closed`)}
      ${adminStat('MEMBERS', String(totals.members ?? 0), 'seated right now')}
      ${adminStat('POT MOVED', money(totals.potMinor || 0), `winners took ${money(totals.winnerNetMinor || 0)}`)}
      ${adminStat('FEES', money(totals.feesMinor || 0), `platform ${money(totals.platformFeeMinor || 0)} · fund ${money(totals.fundFeeMinor || 0)}`, 'lime')}
      ${adminStat('FUND', money(totals.fundBalanceMinor || 0), 'guarantee pool')}
      ${adminStat('BONDS HELD', money(totals.bondsHeldMinor || 0), 'returned as winners pay')}
      ${adminStat('WALLETS', money(totals.walletBalanceMinor || 0), 'member balances')}
      ${adminStat('SETTLEMENTS', settled ? `${totals.balancedSettlements}/${settled}` : '—', unbalanced.length ? `${unbalanced.length} unbalanced` : 'every pot balances', unbalanced.length ? 'amber' : 'lime')}
    </div>
    <div class="admin-grid admin-grid--console">
      <section class="admin-panel admin-panel--wide">
        <div class="admin-panel__head"><span>Circles</span><span>${circles.length} ON BOOKS</span></div>
        <div class="admin-panel__body">
          <div class="admin-table" role="table" aria-label="Circles">
            <div class="admin-table__head" role="row"><span>CIRCLE</span><span>STATE</span><span>SEATS</span><span>TURN</span><span>POT</span><span>FUND</span><span>BONDS</span></div>
            ${circles.map((circle) => `<div class="admin-table__row" role="row">
              <span><b>${esc(circle.name)}</b><em>${money(circle.contributionMinor)} / turn</em></span>
              <span><b class="admin-table__state is-${esc(circle.status)}">${esc(String(circle.status).toUpperCase())}</b><em>${circle.turnStatus ? esc(circle.turnStatus) : '—'}</em></span>
              <span>${circle.memberCount}/${circle.maxMembers}<em>seated</em></span>
              <span>${circle.round ? `R${circle.round}` : '—'}${circle.turn ? ` · T${circle.turn}` : ''}<em>${circle.settledTurns} settled</em></span>
              <span>${money(circle.potCapturedMinor)}<em>of ${money(circle.potExpectedMinor)}</em></span>
              <span>${money(circle.fundMinor)}<em>pool</em></span>
              <span>${money(circle.bondHeldMinor)}<em>held</em></span>
            </div>`).join('') || '<div class="admin-empty">No circles on the books yet.</div>'}
          </div>
        </div>
      </section>
      <section class="admin-panel">
        <div class="admin-panel__head"><span>Pot audit</span><span>${unbalanced.length ? 'CHECK' : 'EXACT'}</span></div>
        <div class="admin-panel__body">
          ${unbalanced.length ? unbalanced.map((row) => `<div class="admin-row">
            <span class="admin-row__dot is-warn"></span>
            <span class="admin-row__copy"><b>Pot does not balance</b><em>Circle ${esc(String(row.groupId).slice(0, 8))} · cycle ${esc(String(row.cycleId).slice(0, 8))} · pot ${money(row.potMinor)} vs allocated ${money(row.allocatedMinor)}</em></span>
          </div>`).join('') : `<div class="admin-row">
            <span class="admin-row__dot is-ok"></span>
            <span class="admin-row__copy"><b>Every settled pot balances</b><em>Winner net + seat shares + platform + organizer + fund + bond equals the pot, checked on the server for every settlement.</em></span>
          </div>`}
          <div class="admin-panel__note">Fees this round: ${money(totals.feesMinor || 0)}. ${money(totals.organizerWaivedMinor || 0)} of organizer fee was waived to the fund when the organizer won.</div>
        </div>
      </section>
      <section class="admin-panel">
        <div class="admin-panel__head"><span>Identity desk</span><span>${ids?.pendingCount ?? 0} WAITING</span></div>
        <div class="admin-panel__body">
          <div class="admin-row">
            <span class="admin-row__dot ${(ids?.pendingCount ?? 0) ? 'is-warn' : 'is-ok'}"></span>
            <span class="admin-row__copy"><b>${(ids?.pendingCount ?? 0) ? `${ids.pendingCount} ID${ids.pendingCount === 1 ? '' : 's'} waiting for a reviewer` : 'No IDs waiting'}</b><em>${ids?.providerConfigured ? 'A register is connected: exact name, DOB and phone matches verify themselves and anything else waits for you.' : 'No register connected: every typed ID waits for a human decision.'}</em></span>
          </div>
          <button class="btn btn--line btn--sm" type="button" data-action="admin-tab" data-tab="ids">${icon('shield')} Open the ID desk</button>
        </div>
      </section>
    </div>
  `;
}

async function viewAdmin() {
  if (!state.me?.isAdmin) {
    renderOperatorRefusal();
    return;
  }
  if (!state.adminUnlocked) { renderOperatorDoor(); return; }
  const filter = state.adminFilter || 'pending';
  const view = state.adminView === 'ids' ? 'ids' : 'overview';
  document.body.dataset.admin = 'on';
  renderLoading();
  try {
    const [data, overview, approvals] = await Promise.all([
      api(`/admin/identity?status=${filter}`),
      api('/admin/overview').catch(() => null),
      api('/admin/payments/test-approvals', { timeout: 8000 }).catch(() => null),
    ]);
    if (approvals) state.testApprovals = approvals;
    const queue = data.queue || [];
    const operator = String(state.me.name || 'Operator');
    const queueLabel = filter === 'pending' ? 'Waiting for a decision' : filter === 'reviewed' ? 'Decided IDs' : 'All typed IDs';
    setWorkspace(`
      <div class="admin-shell">
        <header class="admin-top">
          <div class="admin-id">
            <span class="admin-crest">${icon('shield')}</span>
            <span><b>OPERATOR CONSOLE</b><em>${view === 'overview' ? 'BOOKS, FEES &amp; CIRCLES' : 'ID REVIEW'} · ${esc(operator.toUpperCase())}</em></span>
          </div>
          <div class="admin-status">
            <span class="admin-chip admin-chip--live"><b>PIN VERIFIED</b></span>
            <span class="admin-chip">QUEUE <b>${data.pendingCount ?? 0}</b></span>
            <span class="admin-chip">RAIL <b>${data.providerConfigured ? 'AUTO' : 'MANUAL'}</b></span>
            <button class="admin-chip" type="button" data-action="admin-refresh">REFRESH</button>
            <button class="admin-chip" type="button" data-action="admin-lock">CLOSE DOOR</button>
            <button class="admin-chip" type="button" data-action="open-app">MEMBER APP</button>
          </div>
        </header>
        <main class="admin-body">
          <div class="admin-heading">
            <div>
              <h1>${view === 'overview' ? 'The books.' : 'Typed ID queue'}</h1>
              <p>${view === 'overview'
                ? 'Every circle, every pot, every fee — read straight from the ledger. This room is walled off from the member app: same service, different door.'
                : 'No photo, no upload. Members type the ID number, the name on it, date of birth and the phone on the account. Check the match, then approve or return it.'}</p>
            </div>
            <div class="admin-tabs" role="group" aria-label="Console view">
              <button type="button" data-action="admin-tab" data-tab="overview" aria-pressed="${view === 'overview'}">Overview</button>
              <button type="button" data-action="admin-tab" data-tab="ids" aria-pressed="${view === 'ids'}">ID desk</button>
            </div>
          </div>
          ${view === 'overview' ? adminOverviewMarkup(overview, data) : `
          <div class="admin-tabs admin-tabs--filters" role="group" aria-label="Queue filter">
            <button type="button" data-action="admin-filter" data-filter="pending" aria-pressed="${filter === 'pending'}">Waiting</button>
            <button type="button" data-action="admin-filter" data-filter="reviewed" aria-pressed="${filter === 'reviewed'}">Decided</button>
            <button type="button" data-action="admin-filter" data-filter="all" aria-pressed="${filter === 'all'}">All</button>
          </div>
          <div class="admin-grid">
            <section class="admin-panel">
              <div class="admin-panel__head"><span>${esc(queueLabel)}</span><span>${queue.length} SHOWN</span></div>
              <div class="admin-panel__body">
                ${queue.length ? queue.map((entry) => adminReviewCard(entry, filter)).join('') : `<div class="admin-empty">${filter === 'pending' ? 'Queue clear. Every typed ID carries a decision.' : 'Nothing recorded under this filter yet.'}</div>`}
              </div>
            </section>
            <section class="admin-panel">
              <div class="admin-panel__head"><span>Audit trail</span><span>RECENT</span></div>
              <div class="admin-panel__body">
                ${(data.recent || []).length ? (data.recent || []).map((entry) => `
                  <div class="admin-row">
                    <span class="admin-row__dot ${entry.action === 'identity_approved' ? 'is-ok' : 'is-warn'}"></span>
                    <span class="admin-row__copy"><b>${esc(entry.targetName || 'Member')}</b><em>${entry.action === 'identity_approved' ? 'approved' : 'returned'} by ${esc(entry.adminName || 'reviewer')} · ${fmtDateTime(entry.at)}${entry.note ? ` · ${esc(entry.note)}` : ''}</em></span>
                  </div>
                `).join('') : '<div class="admin-empty">No decisions yet. Every approval and return lands here with who and when.</div>'}
                <div class="admin-panel__note">${data.providerConfigured
                  ? 'An ID database is connected: a name-and-number match verifies instantly, and anything unmatched waits for you.'
                  : 'No ID database is connected: every typed ID waits for a human decision. Reviewing is limited to the operator phone numbers configured on the backend; each decision is attributed in the audit trail.'}</div>
              </div>
            </section>
            ${paymentsRailPanel()}
          </div>`}
        </main>
      </div>
    `);
  } catch (error) {
    document.body.dataset.admin = 'off';
    renderError(error.message);
  }
}

function renderOperatorRefusal() {
  document.body.dataset.admin = 'on';
  setWorkspace(`
    <div class="admin-shell">
      <header class="admin-top">
        <div class="admin-id">
          <span class="admin-crest">${icon('lock')}</span>
          <span><b>OPERATOR DOOR</b><em>NO KEY ON FILE · SEALED</em></span>
        </div>
        <div class="admin-status">
          <span class="admin-chip">ID REVIEW</span>
          <span class="admin-chip">ACCESS <b>REFUSED</b></span>
        </div>
      </header>
      <main class="admin-body door-wrap">
        <div class="door door--refused">
          <span class="door__seal">${icon('lock')}</span>
          <p class="eyebrow">Restricted · ID review</p>
          <h1 class="door__title">Not on the operator list.</h1>
          <p class="door__copy">This room is for verified ID reviewers. Your member seat still works everywhere else: circles, open seats, ledger and NURU.</p>
          <p class="door__rule">Operator numbers are set on the backend by the circle's founder. Typing the address is not enough.</p>
          <button class="btn btn--line btn--block" type="button" data-action="open-app">Back to the member app</button>
        </div>
      </main>
    </div>
  `);
}

function renderOperatorDoor() {
  document.body.dataset.admin = 'on';
  const pinStage = state.adminLatchOpen;
  setWorkspace(`
    <div class="admin-shell">
      <header class="admin-top">
        <div class="admin-id">
          <span class="admin-crest">${icon('lock')}</span>
          <span><b>OPERATOR DOOR</b><em>${pinStage ? 'LATCH RELEASED · PIN REQUIRED' : 'SEALED · HOLD TO RELEASE'}</em></span>
        </div>
        <div class="admin-status">
          <span class="admin-chip">BOOKS &amp; ID REVIEW</span>
          <span class="admin-chip">SESSION <b>LOCKED</b></span>
        </div>
      </header>
      <main class="admin-body door-wrap">
        <div class="door">
          <span class="door__seal">${icon(pinStage ? 'lock' : 'shield')}</span>
          <p class="eyebrow">Restricted · operator</p>
          ${pinStage ? `
            <h1 class="door__title">Enter the PIN.</h1>
          <p class="door__copy">The latch is open. The console needs the operator PIN to finish. The PIN is checked on the server, never in this page. Five wrong tries lock the door for ten minutes.</p>
          <form class="form door-pin" data-form="admin-unlock" novalidate>
            <label class="field">
              <span>Operator PIN</span>
              <input class="input" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="32" required aria-describedby="pinRule">
            </label>
            <p class="error" data-form-error hidden></p>
            <button class="btn btn--lime btn--block" type="submit">Open the console ${icon('arrow')}</button>
          </form>
          <p class="door__rule" id="pinRule">Only operator phones reach this door, and only the server knows the PIN.</p>
          <button class="btn btn--line btn--block" type="button" data-action="admin-relatch">Seal the latch</button>
          ` : `
          <h1 class="door__title">Hold the latch.</h1>
          <p class="door__copy">The operator console is a separate room from the member app. Hold the handle for one second to release the latch, then enter the operator PIN. The door seals itself the moment you step back into the circle.</p>
          <button class="latch latch--door" type="button" data-latch aria-describedby="doorRule">
            <span class="latch__arc" aria-hidden="true"></span>
            <span class="latch__copy">Release the latch<small>Press and hold for one second</small></span>
          </button>
          <p class="door__rule" id="doorRule">Only operator phone numbers reach this door. Typing the address is not enough.</p>
          `}
          <button class="btn btn--line btn--block" type="button" data-action="open-app">Back to the member app</button>
        </div>
      </main>
    </div>
  `);
  if (pinStage) setTimeout(() => dom.workspace?.querySelector('.door-pin input[name="pin"]')?.focus(), 60);
}

async function submitAdminUnlock(form) {
  const button = form.querySelector('[type="submit"]');
  const pin = String(new FormData(form).get('pin') || '').trim();
  if (pin.length < 4) { formError(form, 'Enter the operator PIN.'); return; }
  setBusy(button, true, 'Checking');
  try {
    const data = await api('/admin/unlock', { method: 'POST', body: { pin } });
    const field = form.querySelector('input[name="pin"]');
    if (field) field.value = '';
    state.adminUnlocked = true;
    state.adminLatchOpen = false;
    sound('open');
    toast(data.message || 'Door released.', 'lime');
    await viewAdmin();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
    form.querySelector('input[name="pin"]')?.select();
    soundAt('error', form);
  }
}

function providerLabel(value) {
  if (!value) return 'Register';
  return value === 'kora' ? 'Kora' : value === 'custom' ? 'Register' : String(value);
}

function registerVerdict(entry) {
  if (!entry.identityCheckedAt) return 'Not run';
  const provider = providerLabel(entry.identityProvider);
  if (entry.identityDobMatch == null && entry.identityPhoneMatch == null) return `${provider} · no record match`;
  const mark = (value) => (value === true ? 'match' : value === false ? 'no match' : 'not checked');
  return `${provider} · DOB ${mark(entry.identityDobMatch)} · phone ${mark(entry.identityPhoneMatch)}`;
}

function adminReviewCard(entry, filter) {
  const decided = entry.identityStatus !== 'pending';
  return `
    <article class="admin-review">
      <div class="admin-review__head">
        <span class="avatar avatar--sm">${initials(entry.name)}</span>
        <div class="admin-review__who"><b>${esc(entry.name)}</b><span>${esc(entry.phone || '')} · joined ${fmtDate(entry.memberSince)} · ${entry.activeCircles} active circle${entry.activeCircles === 1 ? '' : 's'}</span></div>
        ${pill(entry.identityStatus.toUpperCase(), entry.identityStatus === 'pending' ? 'amber' : entry.identityStatus === 'verified' ? 'lime' : 'amber')}
      </div>
      <div class="admin-review__facts">
        <div><span>Name typed</span><b>${esc(entry.identityName || '—')}</b></div>
        <div><span>ID number</span><b class="mono">···· ${esc(entry.identityLast4 || '')}</b></div>
        <div><span>Date of birth</span><b>${entry.dateOfBirth ? `${fmtDate(`${entry.dateOfBirth}T12:00:00`)} · ${entry.age} yrs` : 'Not given'}</b></div>
        <div><span>Source</span><b>${entry.identitySource === 'provider' ? 'Register match' : 'Typed by member'}</b></div>
        <div><span>Register check</span><b>${registerVerdict(entry)}</b></div>
        <div><span>Submitted</span><b>${entry.submittedAt ? fmtDateTime(entry.submittedAt) : '—'}</b></div>
        <div><span>Trust</span><b>${entry.trustScore} / 99</b></div>
      </div>
      ${entry.nameMismatch ? `<div class="notice notice--amber">${icon('alert')}<span>The typed name differs from the account name. Check the spelling before approving.</span></div>` : ''}
      ${entry.note ? `<p class="hint">Reviewer note · ${esc(entry.note)}</p>` : ''}
      ${decided ? '' : `
        <div class="admin-review__actions">
          <button class="btn btn--lime btn--sm" type="button" data-action="admin-approve" data-id="${esc(entry.id)}">${icon('check')} Approve ID</button>
          <button class="btn btn--line btn--sm" type="button" data-action="admin-reject" data-id="${esc(entry.id)}" data-name="${esc(entry.name)}">${icon('alert')} Return with a note</button>
        </div>
      `}
    </article>
  `;
}

async function approveIdentity(id, button) {
  setBusy(button, true, 'Approving');
  try {
    const data = await api(`/admin/identity/${id}`, { method: 'POST', body: { action: 'approve' } });
    toast(data.message, 'lime');
    await loadMe();
    await viewAdmin();
  } catch (error) {
    setBusy(button, false);
    apiToast(error);
  }
}

function openRejectIdentitySheet(id, name) {
  openSheet({
    kicker: 'RETURN ID',
    title: `Return ${name}'s details.`,
    body: `
      <p class="hint">They see this note in Account and can resubmit with the corrected name, number or phone.</p>
      <form class="form" data-form="admin-reject" data-id="${esc(id)}" novalidate>
        <label class="field"><span>What should they fix?</span><textarea class="input" name="note" rows="3" maxlength="240" placeholder="e.g. The name does not match the ID number. Check the spelling." required></textarea></label>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block" type="submit">Return with this note ${icon('arrow')}</button>
      </form>
    `,
  });
}

async function submitRejectIdentity(form) {
  const button = form.querySelector('[type="submit"]');
  formError(form, '');
  const note = String(form.note.value || '').trim();
  if (note.length < 4) { formError(form, 'Add a short note so the member knows what to fix.'); return; }
  setBusy(button, true, 'Returning');
  try {
    const data = await api(`/admin/identity/${form.dataset.id}`, { method: 'POST', body: { action: 'reject', note } });
    closeSheet();
    toast(data.message, 'lime');
    await viewAdmin();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

function renderSettings(account, detail) {
  const user = account.user || state.me;
  const passkeys = account.passkeys || [];
  const sessions = account.sessions || [];
  const connected = Boolean(state.config.paymentsConfigured);
  const wallet = account.wallet || state.wallet || {};
  const group = detail?.group || null;
  const me = detail?.me || null;
  const myScore = me?.trustScore ?? user?.trustScore ?? 50;
  const mySeat = me?.membershipId
    ? detail.members?.find((member) => member.id === me.membershipId)?.seat ?? null
    : null;
  const identityStatus = user?.identityStatus || 'unverified';
  const identityCopy = identityStatus === 'verified'
    ? `${user?.identityProvider ? 'Register verified' : 'Verified'} · ····${user?.identityLast4 || ''}`
    : identityStatus === 'pending'
      ? `In review · ····${user?.identityLast4 || ''}`
      : identityStatus === 'rejected' ? 'Returned · fix and resend' : 'Not verified';
  const registerCopy = user?.identityCheckedAt
    ? (user.identityDobMatch == null && user.identityPhoneMatch == null
      ? `${providerLabel(user.identityProvider)} · no record match`
      : `${providerLabel(user.identityProvider)} · ${user.identityDobMatch === true ? 'DOB matched' : user.identityDobMatch === false ? 'DOB differs' : 'DOB not checked'} · ${user.identityPhoneMatch === true ? 'phone matched' : user.identityPhoneMatch === false ? 'phone differs' : 'phone not checked'}`)
    : null;
  setWorkspace(`
    <div class="page">
      ${pageHead({
        eyebrow: 'ACCOUNT',
        title: 'Your account.',
        sub: 'Passkeys, devices, and the payout rail. Nothing here is shared with other members except your name and standing.',
        actions: `<button class="btn btn--line btn--sm" type="button" data-action="sign-out">${icon('logout')} Sign out</button>`,
      })}
      <div class="settings-grid">
        <section class="card span-6">
          <div class="card__head"><h2 class="card__title">Identity</h2>${pill(tierName(user?.trustScore || 50), 'lime')}</div>
          <div class="setting"><div class="setting__copy"><b>Name</b><span>Shown to your circle</span></div><span class="setting__v">${esc(user?.name || '—')}</span></div>
          <div class="setting"><div class="setting__copy"><b>Phone</b><span>Used for payout after KYC</span></div><span class="setting__v">${esc(user?.phoneMasked || user?.phone || '—')}</span></div>
          <div class="setting"><div class="setting__copy"><b>Member since</b><span>Passkey account</span></div><span class="setting__v">${fmtDate(user?.createdAt)}</span></div>
          <div class="setting"><div class="setting__copy"><b>Date of birth</b><span>${user?.dateOfBirth ? 'Checked against your ID' : 'Add it with your ID details'}</span></div><span class="setting__v">${user?.dateOfBirth ? `${fmtDate(`${user.dateOfBirth}T12:00:00`)}<em> · ${Math.floor(ageFromDob(user.dateOfBirth))} yrs</em>` : '—'}</span></div>
          <div class="setting"><div class="setting__copy"><b>Trust score</b><span>Bond band follows this score</span></div><span class="setting__v">${user?.trustScore ?? 50} / 99</span></div>
          <div class="setting"><div class="setting__copy"><b>ID check</b><span>Name, date of birth and phone · no photo</span></div><span class="setting__v ${identityStatus === 'verified' ? 'lime' : identityStatus === 'rejected' ? 'amber' : identityStatus === 'pending' ? '' : 'amber'}">${identityCopy}</span></div>
          ${registerCopy ? `<div class="setting"><div class="setting__copy"><b>Register check</b><span>${esc(registerCopy)}</span></div><span class="setting__v">${fmtDateTime(user.identityCheckedAt)}</span></div>` : ''}
          ${installRow()}
          <div class="setting"><div class="setting__copy"><b>Circle</b><span>${group ? 'Active seat' : 'No circle'}</span></div><span class="setting__v">${esc(group?.name || '—')}</span></div>
          ${identityStatus === 'verified' ? '' : `<button class="btn btn--line btn--block" type="button" data-action="open-identity">${icon('shield')} ${identityStatus === 'pending' || identityStatus === 'rejected' ? 'View or replace ID details' : 'Add ID details'}</button>`}
          ${user?.isAdmin ? `<div class="divider"></div><div class="setting"><div class="setting__copy"><b>Operator console</b><span>Separate room · hold the latch to enter</span></div><button class="btn btn--line btn--sm" type="button" data-action="open-admin">Open</button></div>` : ''}
        </section>
        <section class="card span-6">
          <div class="card__head"><h2 class="card__title">Seat &amp; bond</h2>${pill(tierName(myScore), 'lime')}</div>
          <div class="seat-badge">
            <span class="seat-badge__ring">${trustRing(myScore)}<b>${mySeat ?? '—'}</b></span>
            <div><b>${esc(group?.name || 'No circle yet')}</b><span>${group ? `Seat ${mySeat ?? '—'} of ${detail?.group?.memberCount ?? '—'} · ${me?.hasWon ? 'took the pot' : 'waiting for the pot'}` : 'Join or create a circle'}</span></div>
          </div>
          <p class="hint" style="margin:0">The bond is held from your payout and released as you fund the turns that follow. The final turn carries no bond.</p>
          ${bondLadder(me?.bondBps ?? (myScore >= 80 ? 1000 : myScore >= 60 ? 1500 : myScore >= 40 ? 2000 : 2500))}
        </section>
        <section class="card span-6">
          <div class="card__head"><h2 class="card__title">Payout rail</h2>${pill(state.config.withdrawalsConfigured ? 'CONNECTED' : 'WITHDRAWALS PAUSED', state.config.withdrawalsConfigured ? 'lime' : 'amber')}</div>
          <div class="statusline ${state.config.withdrawalsConfigured ? 'statusline--live' : 'statusline--sandbox'}">${state.config.withdrawalsConfigured
            ? 'Payment account connected. Contributions are collected and withdrawals settle through Paysasa to M-PESA.'
            : esc(state.config.withdrawalBlocker || 'M-PESA withdrawals open once the provider confirms the exact payout fee. Your balance stays recorded in your wallet.')}${connected && !state.config.withdrawalsConfigured ? ' Contributions are collected through Paysasa.' : ''}</div>
          <div class="setting"><div class="setting__copy"><b>Available to withdraw</b><span>After holds and pending settlements</span></div><span class="setting__v lime">${money(wallet.availableMinor || 0)}</span></div>
          <div class="setting"><div class="setting__copy"><b>On hold</b><span>First payouts and bonds</span></div><span class="setting__v amber">${money(wallet.pendingMinor || 0)}</span></div>
          <div class="setting"><div class="setting__copy"><b>Settlement currency</b><span>East Africa Time</span></div><span class="setting__v">KES · EAT</span></div>
          <button class="btn btn--line btn--block" type="button" data-action="open-withdraw" ${!state.config.withdrawalsConfigured || !wallet.availableMinor ? 'disabled' : ''}>${icon('download')} Withdraw to M-PESA</button>
        </section>
        <section class="card span-6">
          <div class="card__head"><h2 class="card__title">Machine room</h2>${pill(globalThis.WheelSound?.enabled?.() ? 'SOUND ON' : 'SILENT', globalThis.WheelSound?.enabled?.() ? 'lime' : 'amber')}</div>
          <div class="setting"><div class="setting__copy"><b>Machine sound</b><span>Servos, latches and NURU’s kalimba, synthesised on this device</span></div>
            <button class="sound-toggle" type="button" data-action="toggle-sound" aria-pressed="false">
              <span class="sound-toggle__slot" aria-hidden="true"></span>
              <svg class="i" data-sound-icon><use href="#i-sound-on"></use></svg>
              <span data-sound-label>Sound on</span>
            </button>
          </div>
          <div class="setting"><div class="setting__copy"><b>Voice</b><span>Read-aloud prefers a Kenyan or wider African English voice when the device has one</span></div><span class="setting__v">Circle voice</span></div>
          <p class="hint">Sound never leaves this device and never blocks an action. Prefer quiet? The switch silences the whole room, not just the alerts.</p>
        </section>
        <section class="card span-6">
          <div class="card__head"><h2 class="card__title">Passkeys</h2><button class="btn btn--line btn--sm" type="button" data-action="open-passkey">${icon('plus')} Add</button></div>
          ${passkeys.length ? passkeys.map((passkey) => `
            <div class="device">
              <span class="avatar avatar--sm">${icon('key')}</span>
              <div class="device__main"><b>${esc(passkey.label || 'Passkey')}</b><span>${esc(passkey.rpId || '')} · used ${passkey.lastUsedAt ? fmtDateTime(passkey.lastUsedAt) : 'never'}</span></div>
              ${pill('PASSKEY', 'lime')}
            </div>
          `).join('') : `<p class="hint">No passkeys on record. Add one to keep this account recoverable.</p>`}
          <div class="divider"></div>
          <div class="setting"><div class="setting__copy"><b>Recovery codes</b><span>Single-use codes for a lost device</span></div><span class="setting__v">${account.recoveryRemaining ?? 0} left</span></div>
          <button class="btn btn--line btn--block" type="button" data-action="regen-recovery">${icon('shield')} Generate new recovery codes</button>
        </section>
        <section class="card span-6">
          <div class="card__head"><h2 class="card__title">Devices</h2>${pill(`${sessions.length} active`, 'cyan')}</div>
          ${sessions.length ? sessions.map((session) => `
            <div class="device">
              <span class="avatar avatar--sm">${icon('phone')}</span>
              <div class="device__main"><b>${esc(session.deviceLabel)}${session.current ? ' · this device' : ''}</b><span>${esc(session.userAgent || '')} · ${fmtDateTime(session.createdAt)}</span></div>
              ${session.current ? pill('CURRENT', 'lime') : `<button class="btn btn--sm btn--quiet" type="button" data-action="revoke-session" data-id="${esc(session.id)}">Revoke</button>`}
            </div>
          `).join('') : `<p class="hint">No active sessions.</p>`}
          <div class="divider"></div>
          <button class="btn btn--danger btn--block" type="button" data-action="sign-out-all">${icon('logout')} Sign out everywhere</button>
        </section>
        <section class="card span-12 danger-zone">
          <div class="card__head"><h2 class="card__title">Sensitive actions</h2>${icon('alert')}</div>
          <div class="setting"><div class="setting__copy"><b>Disputes and access recovery</b><span>A dispute is visible to the organizer. Recovery codes are the only self-serve way back into a lost passkey.</span></div><button class="btn btn--line btn--sm" type="button" data-action="open-dispute">${icon('flag')} Report an issue</button></div>
          <p class="hint">THE WHEEL never asks for your <span class="nowrap">M-PESA</span> PIN, passkey, or recovery codes. Only enter them into this app on a device you control.</p>
        </section>
      </div>
    </div>
  `);
}

/* ---------------- sheets ---------------- */

function openCreateSheet(preset = '') {
  if (!state.me) { openAuth('register'); return; }
  const contribution = 1000;
  const openPreset = preset === 'open';
  openSheet({
    kicker: 'NEW CIRCLE',
    title: 'Name the circle.',
    body: `
      <form class="form" data-form="create-group" novalidate>
        <label class="field"><span>Circle name</span><input class="input" name="name" maxlength="60" placeholder="e.g. Kilimani Table" required></label>
        <div class="field__row">
          <label class="field"><span>Contribution · KES</span><input class="input" name="contribution" type="number" inputmode="numeric" min="200" max="5000" step="50" value="${contribution}" required></label>
          <label class="field"><span>Members</span><select class="select" name="maxMembers"><option>5</option><option>6</option><option selected>8</option><option>10</option><option>12</option></select></label>
        </div>
        <fieldset class="field vis-pick">
          <legend><span>Who can take a seat?</span></legend>
          <label class="vis-option">
            <input type="radio" name="visibility" value="private" ${openPreset ? '' : 'checked'}>
            <span class="vis-option__body"><b>Private · invite only</b><em>You choose who joins with an invite code.</em></span>
            ${openPreset ? '' : '<span class="vis-option__tag">DEFAULT</span>'}
          </label>
          <label class="vis-option">
            <input type="radio" name="visibility" value="open" ${openPreset ? 'checked' : ''}>
            <span class="vis-option__body"><b>Open · seats taken online</b><em>Verified members take open seats by paying turn 1. No approval step.</em></span>
            <span class="vis-option__tag">FILLS FASTER</span>
          </label>
        </fieldset>
        <div class="vis-note" data-vis-note></div>
        <label class="field"><span>Organizer fee</span><select class="select" name="organizerFee"><option value="0">0% · voluntary</option><option value="50">0.5%</option><option value="100" selected>1% · default</option><option value="150">1.5% · maximum</option></select></label>
        <label class="field"><span>Payout period</span><select class="select" name="cadence"><option value="weekly" selected>Weekly · one winner every 7 days</option><option value="fortnightly">Every two weeks</option><option value="monthly">Monthly · same date each month</option></select></label>
        <div class="notice notice--cyan">${icon('lock')}<span>Sealed bids for 24 hours. A funded pot waits for its scheduled date. Every member accepts the period before turn one. The pot is funded before a seat is paid. The organizer fee is waived to the fund if the organizer wins.</span></div>
        <div class="estimate">
          <div class="estimate__row"><span>Minimum circle</span><b>5 members · ${money(contribution * MINOR * 5)} pot</b></div>
          <div class="estimate__row"><span>Platform fee</span><b>1% of each pot</b></div>
          <div class="estimate__row"><span>Guarantee fund</span><b>1% of each pot</b></div>
        </div>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">Create the circle ${icon('arrow')}</button>
        <p class="hint">You become the organizer. You can verify members and cover a shortfall, but you cannot change a settled turn.</p>
      </form>
    `,
    onMount: () => {
      const form = dom.sheetBody?.querySelector('form');
      if (!form) return;
      const note = form.querySelector('[data-vis-note]');
      const update = () => {
        const open = form.querySelector('input[name="visibility"]:checked')?.value === 'open';
        if (!note) return;
        note.classList.toggle('is-open', open);
        note.innerHTML = open
          ? `${icon('users')}<span><b>Any verified member can take an open seat by paying turn 1.</b> You cannot reject a joiner — the prepaid seat is the approval. Turn one starts only when every joining seat has paid, and a stalled seat is refunded after ${SEAT_REFUND_DAYS} days.</span>`
          : `${icon('lock')}<span><b>Invite code only.</b> Members join with their own passkey, and no money moves until you start the first turn. You can open the circle later only by creating a new one.</span>`;
      };
      form.querySelectorAll('input[name="visibility"]').forEach((input) => input.addEventListener('change', update));
      update();
    },
  });
}

function openJoinSheet(code = '') {
  if (!state.me) {
    state.pendingJoin = String(code || '').trim().toUpperCase() || null;
    if (state.pendingJoin) sessionStorage.setItem('wheel.pendingJoin', state.pendingJoin);
    openAuth('start');
    if (dom.authAsideTitle && state.pendingJoin) {
      dom.authAsideTitle.textContent = 'Join the circle.';
      dom.authAsideCopy.textContent = 'Sign in or create a passkey account, then this invite code takes your seat.';
    }
    return;
  }
  openSheet({
    kicker: 'INVITE',
    title: 'Join a circle.',
    body: `
      <form class="form" data-form="join-group" novalidate>
        <div class="invite-code"><div><span>ENTER THE CODE</span><br><b>${esc(code || '—')}</b></div>${icon('users')}</div>
        <label class="field"><span>Invite code</span><input class="input mono" name="inviteCode" value="${esc(code || '')}" maxlength="12" autocomplete="off" spellcheck="false" placeholder="e.g. K7M2QP" required></label>
        <div class="notice notice--cyan">${icon('shield')}<span>Joining accepts the circle's contribution, bond band, and settlement rules. Your seat locks when the circle starts.</span></div>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">Take my seat ${icon('arrow')}</button>
      </form>
    `,
  });
}

async function joinGroup(code, options = {}) {
  const normalised = String(code || '').trim().toUpperCase();
  if (!normalised) { openJoinSheet(); return; }
  if (!state.me) {
    state.pendingJoin = normalised;
    sessionStorage.setItem('wheel.pendingJoin', normalised);
    openAuth('start');
    return;
  }
  try {
    const data = await api('/groups/join', { method: 'POST', body: { inviteCode: normalised } });
    state.pendingJoin = null;
    sessionStorage.removeItem('wheel.pendingJoin');
    if (data.group?.id) {
      state.activeGroupId = data.group.id;
      localStorage.setItem('wheel.activeGroup', data.group.id);
    }
    await loadMe();
    closeSheet();
    toast(`You joined ${data.group?.name || 'the circle'}.`, 'lime');
    navigate('/g');
  } catch (error) {
    if (options.fromLink) {
      apiToast(error);
      navigate('/app', { replace: true });
    } else {
      const form = dom.sheetBody?.querySelector('form');
      if (form) formError(form, error.message);
      else apiToast(error);
    }
  }
}

function openInviteSheet() {
  const group = state.group?.group || state.groups.find((item) => item.id === state.activeGroupId);
  if (!group) { toast('Create a circle first.'); return; }
  const link = `${location.origin}${location.pathname}#/join/${encodeURIComponent(group.inviteCode)}`;
  openSheet({
    kicker: 'INVITE',
    title: 'Bring your people.',
    body: `
      <div class="invite-code"><div><span>INVITE CODE</span><br><b>${esc(group.inviteCode)}</b></div><button class="iconbtn" type="button" data-action="copy" data-copy="${esc(group.inviteCode)}" aria-label="Copy invite code">${icon('copy')}</button></div>
      <p class="hint" style="margin-top:12px">Send this link. The person signs in with a passkey, accepts the rules, and takes a seat.</p>
      <div class="field" style="margin-top:14px"><span>Invite link</span><div class="invite-code"><span class="mono" style="font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(link)}</span><button class="iconbtn" type="button" data-action="copy" data-copy="${esc(link)}" aria-label="Copy invite link">${icon('copy')}</button></div></div>
      <div class="notice notice--amber">${icon('users')}<span>Only share with people you trust. The organizer verifies each member before the first payout. The circle is capped at ${group.maxMembers} seats.</span></div>
    `,
    foot: `<button class="btn btn--line" type="button" data-action="close-sheet">Close</button><button class="btn btn--lime" type="button" data-action="share" data-url="${esc(link)}" data-title="${esc(group.name)}">${icon('share')} Share invite</button>`,
  });
}

function openContributeSheet() {
  const detail = state.group;
  if (!detail?.cycle) { toast('There is no turn to fund yet.'); return; }
  const cycle = detail.cycle;
  const paid = cycle.myContribution?.status === 'paid';
  if (paid) { toast('Your contribution for this turn is already in.', 'lime'); return; }
  const amount = cycle.amountDueMinor || cycle.contributionMinor;
  const connected = state.config.paymentsConfigured;
  const saved = cycle.savedMinor ?? detail.wallet?.availableMinor ?? 0;
  const covers = Boolean(cycle.savedCoversMinor) || saved >= amount;
  const short = Math.max(0, amount - saved);
  const stashBlock = saved > 0
    ? `<div class="estimate" style="margin-top:10px">
         <div class="estimate__row"><span>In your stash</span><b class="lime">${money(saved)}</b></div>
         ${covers
           ? `<div class="estimate__row"><span>After this turn</span><b>${money(saved - amount)}</b></div>`
           : `<div class="estimate__row"><span>Still needed</span><b class="amber">${money(short)}</b></div>`}
       </div>`
    : '';
  openSheet({
    kicker: `TURN ${cycle.number} · CONTRIBUTION`,
    title: paid ? 'Already funded.' : 'Fund your seat.',
    body: `
      <div class="estimate">
        <div class="estimate__row"><span>Your contribution</span><b>${money(cycle.contributionMinor)}</b></div>
        ${cycle.lateFeeMinor ? `<div class="estimate__row"><span>Late fee</span><b class="amber">${money(cycle.lateFeeMinor)}</b></div>` : ''}
        <div class="estimate__row estimate__row--total"><span>Total due</span><b>${money(amount)}</b></div>
      </div>
      ${stashBlock}
      <p class="error" data-form-error hidden></p>
      ${covers
        ? `<button class="btn btn--lime btn--block btn--lg" type="button" data-action="pay-savings">Pay ${money(amount)} from stash ${icon('arrow')}</button>`
        : saved > 0
          ? `<button class="btn btn--lime btn--block" type="button" data-action="open-topup">Add ${money(short)} to stash ${icon('arrow')}</button>
             <p class="hint">Or pay this turn directly with M-PESA — no need to top up first.</p>`
          : connected
            ? `<button class="btn btn--lime btn--block" type="button" data-action="open-topup">Stash a little each week ${icon('arrow')}</button>
               <p class="hint">A small balance covers a turn without a fresh M-PESA prompt every circle. Even ${money(cycle.contributionMinor)} once covers one turn.</p>`
            : ''}
      ${connected
        ? `<button class="btn ${covers || saved > 0 ? 'btn--line' : 'btn--lime'} btn--block" type="button" data-action="pay-contribution" style="margin-top:10px">Pay ${money(amount)} with M-PESA ${icon('arrow')}</button>`
        : `<div class="notice notice--amber" style="margin-top:12px">${icon('alert')}<span>M-PESA checkout opens when the organizer connects the payment account. Your stash can still cover a turn.</span></div>`}
      <p class="hint">No cash changes hands inside the app. The organizer's connected account collects contributions and settles payouts.</p>
    `,
    foot: '',
  });
}

async function payFromSavings(button) {
  const detail = state.group;
  if (!detail?.cycle) return;
  setBusy(button, true, 'Moving from stash');
  try {
    const data = await api(`/groups/${detail.group.id}/contributions/savings`, {
      method: 'POST',
      body: { cycleId: detail.cycle.id },
    });
    closeSheet();
    toast(data.alreadyPaid ? 'That turn was already paid.' : `${money(data.amountMinor)} paid from your stash.`, 'lime');
    const fresh = await loadGroupDetail({ silent: true });
    if (fresh && state.route.startsWith('/g')) renderCircle(fresh);
    else await refreshRoute();
  } catch (error) {
    setBusy(button, false);
    const form = dom.sheetBody?.querySelector('form');
    if (form) formError(form, error.message);
    toast(error.message, 'error');
  }
}

async function payContribution(button) {
  const detail = state.group;
  if (!detail?.cycle) return;
  setBusy(button, true, 'Opening Paysasa');
  try {
    const data = await api(`/groups/${detail.group.id}/contributions`, {
      method: 'POST',
      body: { cycleId: detail.cycle.id },
    });
    if (!data.checkoutUrl) throw new Error('The payment link was not returned.');
    closeSheet();
    location.assign(data.checkoutUrl);
  } catch (error) {
    setBusy(button, false);
    const form = dom.sheetBody?.querySelector('form');
    if (form) formError(form, error.message);
    toast(error.message, 'error');
  }
}

/* ---------------- open circles ---------------- */

const SEAT_REFUND_DAYS = 14;

function formingOpenGroups() {
  return (state.groups || []).filter((group) => group.visibility === 'open' && group.status === 'forming');
}

function seatStateOf(detail) {
  const me = detail?.me;
  if (!me) return null;
  if (me.role === 'organizer') return { key: 'organizer' };
  const key = ['paid', 'pending'].includes(me.seatStatus) ? me.seatStatus : 'none';
  return { key, paidMinor: me.seatPaidMinor || 0, expiresAt: me.seatExpiresAt || null };
}

async function viewOpenCircles(options = {}) {
  if (!state.me) { openAuth('start'); return; }
  if (!options.silent) renderLoading();
  const seq = ++state.renderSeq;
  try {
    const data = await api('/open-circles');
    if (seq !== state.renderSeq) return;
    state.openCircles = data.circles || [];
    const mine = formingOpenGroups().slice(0, 4);
    const details = await Promise.all(mine.map((group) => api(`/groups/${group.id}`).catch(() => null)));
    if (seq !== state.renderSeq) return;
    state.openSeats = details.filter(Boolean);
    syncChrome();
    renderDiscover();
  } catch (error) {
    renderError(error.message);
  }
}

function startOpenPoll() {
  clearTimeout(state.pollTimer);
  const watching = () => state.route === '/open' || (state.route === '/app' && !state.groups?.length);
  const tick = async () => {
    if (!watching() || document.hidden || !state.me) return;
    if (dom.sheet?.open || dom.authDialog?.open) {
      state.pollTimer = setTimeout(tick, 12000);
      return;
    }
    try {
      const data = await api('/open-circles', { timeout: 10000 });
      const before = JSON.stringify((state.openCircles || []).map((circle) => [circle.id, circle.memberCount]));
      const after = JSON.stringify((data.circles || []).map((circle) => [circle.id, circle.memberCount]));
      state.openCircles = data.circles || [];
      if (before !== after && watching()) renderDiscover();
    } catch { /* the list keeps its last good state */ }
    if (watching()) state.pollTimer = setTimeout(tick, 12000);
  };
  state.pollTimer = setTimeout(tick, 12000);
}

function seatDots(circle) {
  const total = Math.min(12, Math.max(5, Number(circle.maxMembers) || 5));
  const taken = Math.min(total, Number(circle.memberCount) || 0);
  return Array.from({ length: total }, (_, index) => (
    `<i class="${index < taken ? 'is-taken' : ''}${index === taken ? ' is-next' : ''}"></i>`
  )).join('');
}

function seatValue(circle) {
  const turns = Number(circle.maxMembers) || 5;
  return { turns, total: Number(circle.seatMinor) * turns };
}

function openCircleCard(circle) {
  const seatsLeft = Number(circle.seatsLeft) || 0;
  const { turns, total } = seatValue(circle);
  const trusted = Number(circle.organizerTrust) >= 60;
  return `
    <article class="oc-card${seatsLeft <= 1 ? ' is-nearly' : ''}">
      <div class="oc-card__top">
        <div class="oc-card__who">
          <span class="oc-card__avatar">${esc(initials(circle.organizerName))}</span>
          <div>
            <h3>${esc(circle.name)}</h3>
            <p>${esc(circle.organizerName)} · ${cadenceLabel(circle.cadence)} payouts</p>
          </div>
        </div>
        ${pill(seatsLeft === 1 ? '1 SEAT LEFT' : `${seatsLeft} SEATS LEFT`, seatsLeft === 1 ? 'amber' : '')}
      </div>
      <div class="oc-rail" role="img" aria-label="${circle.memberCount} of ${circle.maxMembers} seats taken">${seatDots(circle)}</div>
      <div class="oc-card__facts">
        <span><b>${money(circle.seatMinor)}</b><em>seat · turn 1 paid now</em></span>
        <span><b>${money(total)}</b><em>your total over ${turns} turns</em></span>
        <span><b>${Number(circle.verifiedMembers) || 0} verified</b><em>ID-checked members</em></span>
      </div>
      <div class="oc-card__tags">
        ${trusted ? `<span class="oc-tag oc-tag--lime">${icon('star')} Trusted host</span>` : `<span class="oc-tag">${icon('user')} ${tierName(circle.organizerTrust)} host</span>`}
        <span class="oc-tag">${icon('shield')} ID-verified seats</span>
        <span class="oc-tag">${icon('check')} No approval needed</span>
      </div>
      <p class="oc-card__assure">${icon('lock')} Turn 1 is prepaid. If the circle never starts, or you leave before it does, the seat returns to your wallet.</p>
      <div class="oc-card__foot">
        <span class="oc-card__seatno">Seat ${Number(circle.memberCount) + 1} of ${turns}</span>
        <button class="btn btn--lime btn--sm" type="button" data-action="seat-take" data-group="${esc(circle.id)}">Take seat · ${money(circle.seatMinor)} ${icon('arrow')}</button>
      </div>
    </article>
  `;
}

function openSeatRow(detail) {
  const state_ = seatStateOf(detail);
  if (!state_ || state_.key === 'none' || detail.cycle) return '';
  const { group, me } = detail;
  const members = (detail.members || []).filter((member) => member.status !== 'removed');
  const seat = members.find((member) => member.id === me.membershipId)?.seat || '—';
  const unpaid = detail.round?.seatsUnpaid || 0;
  const paidSeats = members.filter((member) => member.seatStatus === 'paid').length;
  if (state_.key === 'organizer') {
    return `
      <article class="oc-seat">
        <div class="oc-seat__status">${pill('HOST', 'lime')}</div>
        <div class="oc-seat__main"><b>${esc(group.name)}</b><span>Seat ${seat} · ${paidSeats} of ${group.memberCount} joining seats prepaid${unpaid ? ` · ${unpaid} still unpaid` : ' · every seat is paid'}</span></div>
        <div class="oc-seat__actions">
          ${unpaid ? `<span class="oc-seat__hint">${icon('clock')} Start waits for ${unpaid} unpaid seat${unpaid === 1 ? '' : 's'}</span>` : ''}
          <a class="btn btn--line btn--sm" href="#/g/${group.id}">Open circle ${icon('chevron')}</a>
        </div>
      </article>`;
  }
  if (state_.key === 'pending') {
    return `
      <article class="oc-seat is-pending">
        <div class="oc-seat__status">${pill('SEAT HELD', 'amber')}</div>
        <div class="oc-seat__main"><b>${esc(group.name)}</b><span>Seat ${seat} held · pay ${money(me.seatDueMinor || group.contributionMinor)} to keep it</span></div>
        <div class="oc-seat__actions">
          <span class="oc-seat__hold">HOLD <b data-countdown="${esc(me.seatExpiresAt || '')}" data-done="Released">—</b></span>
          <button class="btn btn--lime btn--sm" type="button" data-action="pay-seat" data-group="${esc(group.id)}">Pay seat ${icon('arrow')}</button>
          <button class="btn btn--quiet btn--sm" type="button" data-action="leave-seat" data-group="${esc(group.id)}">Leave</button>
        </div>
      </article>`;
  }
  return `
    <article class="oc-seat is-paid">
      <div class="oc-seat__status">${pill('TURN 1 PAID', 'lime')}</div>
      <div class="oc-seat__main"><b>${esc(group.name)}</b><span>Seat ${seat} · ${money(me.seatPaidMinor || group.contributionMinor)} prepaid · ${paidSeats} of ${group.memberCount} seats in</span></div>
      <div class="oc-seat__actions">
        <span class="oc-seat__hint">${icon('shield')} Refunded if it does not start in ${SEAT_REFUND_DAYS} days</span>
        <a class="btn btn--line btn--sm" href="#/g/${group.id}">Open circle ${icon('chevron')}</a>
        <button class="btn btn--quiet btn--sm" type="button" data-action="leave-seat" data-group="${esc(group.id)}">Leave</button>
      </div>
    </article>`;
}

function openFilters(circles, filter) {
  const counts = {
    all: circles.length,
    nearly: circles.filter((circle) => circle.seatsLeft <= 2).length,
    trusted: circles.filter((circle) => Number(circle.organizerTrust) >= 60).length,
    low: circles.length,
  };
  const labels = { all: 'All', nearly: 'Nearly full', trusted: 'Trusted hosts', low: 'Lowest seat' };
  return `<div class="oc-filters" role="group" aria-label="Filter open circles">
    ${Object.entries(labels).map(([key, label]) => `
      <button class="chip${filter === key ? ' chip--max' : ''}" type="button" data-action="open-filter" data-filter="${key}" aria-pressed="${filter === key}">${label} <b>${counts[key]}</b></button>
    `).join('')}
  </div>`;
}

function protectionPanel(detail) {
  const p = detail.protection || {};
  const cover = Number(p.coverMinor) || 0;
  const shortfall = Number(p.shortfallMinor) || 0;
  const coverage = Math.min(100, Number(p.coveragePct) || 0);
  return `
    <div class="protect">
      <div class="protect__main">
        <div class="protect__head">
          <div>
            <span class="protect__k">SHORTFALL COVER</span>
            <b class="protect__v">${money(cover)}</b>
            <em>against a ${money(shortfall)} missed-turn exposure · ${coverage}% covered</em>
          </div>
          <span class="protect__ring" style="--p:${coverage}%"><b>${coverage}%</b></span>
        </div>
        <div class="protect__meter" role="img" aria-label="${coverage}% covered"><i style="--p:${coverage}%"></i></div>
      </div>
      <ul class="protect__rows">
        <li>${icon('shield')}<span>Bonds held from winners</span><b>${money(p.bondPoolMinor || 0)}</b></li>
        <li>${icon('wallet')}<span>Guarantee fund</span><b>${money(p.fundBalanceMinor || 0)}</b></li>
        <li>${icon('check')}<span>ID-verified members</span><b>${Number(p.verifiedMembers) || 0} / ${Number(p.memberCount) || 0}</b></li>
        <li>${icon('clock')}<span>Late fee cap</span><b>${pct(p.lateCapBps || 1000)} after ${Number(p.graceHours) || 24}h</b></li>
      </ul>
      <p class="hint">A missed turn is covered in order: the member's own bond, their guarantor, then the guarantee fund. No member is ever asked to top up someone else's seat.</p>
    </div>
  `;
}

function openSeatBoard(detail) {
  const { group, members, me } = detail;
  const list = [...(members || [])].sort((a, b) => (a.seat || 0) - (b.seat || 0));
  const paidCount = list.filter((member) => member.seatStatus === 'paid' || member.role === 'organizer').length;
  const unpaid = detail.round?.seatsUnpaid || 0;
  const seatsOpen = Math.max(0, Number(group.maxMembers) - list.length);
  const full = seatsOpen === 0;
  const mine = seatStateOf(detail);
  const note = unpaid
    ? `${unpaid} joining seat${unpaid === 1 ? '' : 's'} still unpaid · the organizer cannot start yet`
    : seatsOpen
      ? `${seatsOpen} seat${seatsOpen === 1 ? '' : 's'} still open · each is taken by paying turn 1`
      : 'Every seat has joined and paid turn 1';
  return `
    <div class="seatprepay">
      <div class="seatprepay__head">
        <div>
          <span class="seatprepay__k">PREPAID SEATS</span>
          <b class="seatprepay__v">${paidCount} / ${group.maxMembers}</b>
          <em>${note}</em>
        </div>
        ${pill(unpaid ? 'WAITING ON SEATS' : full ? 'READY TO START' : 'SEATS OPEN', unpaid ? 'amber' : full ? 'lime' : '')}
      </div>
      <div class="seatprepay__board">
        ${list.map((member) => {
          const isMe = member.userId === me?.id;
          const paid = member.seatStatus === 'paid' || member.role === 'organizer';
          return `<div class="seatprepay__tile${paid ? ' is-paid' : ''}${isMe ? ' is-me' : ''}">
            <span class="seatprepay__no">SEAT ${Number(member.seat) || '—'}</span>
            <span class="seatprepay__name">${esc(String(member.name || '').split(/\s+/)[0])}</span>
            <span class="seatprepay__tag">${member.role === 'organizer' ? 'ORGANIZER' : paid ? 'PAID' : 'UNPAID'}</span>
          </div>`;
        }).join('')}
        ${Array.from({ length: seatsOpen }, (_, index) => `<a class="seatprepay__tile is-open" href="#/open">
          <span class="seatprepay__no">SEAT ${list.length + index + 1}</span>
          <span class="seatprepay__name">Open</span>
          <span class="seatprepay__tag">TAKE IT</span>
        </a>`).join('')}
      </div>
      ${mine?.key === 'pending' ? `
        <div class="seatprepay__mine">
          <div>${icon('clock')}<span>Your seat payment is still open. The hold releases in <b data-countdown="${esc(mine.expiresAt || '')}" data-done="released">—</b>.</span></div>
          <button class="btn btn--lime btn--sm" type="button" data-action="pay-seat" data-group="${esc(group.id)}">Pay seat ${money(detail.me.seatDueMinor || group.contributionMinor)} ${icon('arrow')}</button>
        </div>` : ''}
      ${mine?.key === 'paid' ? `<p class="hint seatprepay__note">${icon('check')} Your seat payment is credited to turn 1 when the circle starts, or refunded to your wallet if it never does.</p>` : ''}
      ${mine?.key === 'organizer' && unpaid ? `<p class="hint seatprepay__note">${icon('clock')} Wait for every joining seat before starting. A started circle can no longer take prepaid seats.</p>` : ''}
    </div>
  `;
}

function renderDiscover() {
  const circles = state.openCircles || [];
  const filter = state.openFilter || 'all';
  const seats = state.openSeats || [];
  const filtered = circles.filter((circle) => filter === 'nearly' ? circle.seatsLeft <= 2
    : filter === 'trusted' ? Number(circle.organizerTrust) >= 60
      : true);
  if (filter === 'low') filtered.sort((a, b) => a.seatMinor - b.seatMinor || b.memberCount - a.memberCount);
  const openSeats = circles.reduce((sum, circle) => sum + Number(circle.seatsLeft || 0), 0);
  const noCircle = !ensureActiveGroup();
  const privateCircles = (state.groups || []).filter((group) => group.visibility === 'private').slice(0, 3);
  setWorkspace(`
    <div class="page oc-page">
      ${pageHead({
        eyebrow: `OPEN CIRCLES · ${fmtDay(new Date())} · LIVE`,
        title: noCircle ? 'Find your circle.<br>Turn one is already paid.' : 'Open circles.<br>Take a seat today.',
        sub: openSeats === 0
          ? 'No open seat at this moment. Private circles still open by invite code, and this list refreshes live as seats free up.'
          : `Open seats skip the invite. Verify your ID once, pledge the rules, and prepay turn 1. ${openSeats} seat${openSeats === 1 ? '' : 's'} open across ${circles.length} circle${circles.length === 1 ? '' : 's'} · updates live`,
        actions: `<button class="btn btn--quiet btn--sm" type="button" data-action="refresh">${icon('spin')} Refresh</button><button class="btn btn--lime btn--sm" type="button" data-action="start-circle">${icon('plus')} Create ${icon('arrow')}</button>`,
      })}
      <div class="oc-live"><span class="live-dot"></span><b>${openSeats}</b> open seats<span class="oc-live__more"> · seats free up the moment someone leaves · EAT</span></div>
      ${seats.length ? `
        <section class="oc-mine">
          <div class="oc-mine__head"><h2 class="card__title">Your open seats</h2><span>${seats.length} forming circle${seats.length === 1 ? '' : 's'}</span></div>
          <div class="oc-mine__rows">${seats.map(openSeatRow).join('')}</div>
        </section>` : ''}
      <section class="oc-assure" aria-label="How an open seat is protected">
        <div class="oc-assure__step"><span>01</span><b>ID verified once</b><em>One ID, one account. A stranger cannot hold two seats at the same circle.</em></div>
        <div class="oc-assure__step"><span>02</span><b>Turn 1 prepaid</b><em>Your seat money becomes your first contribution the moment the circle starts.</em></div>
        <div class="oc-assure__step"><span>03</span><b>Refunded if it stalls</b><em>No start within ${SEAT_REFUND_DAYS} days, or you leave before the start: the seat returns to your wallet.</em></div>
      </section>
      <section class="card oc-list">
        <div class="card__head">
          <h2 class="card__title">Circles taking seats</h2>
          ${openFilters(circles, filter)}
        </div>
        ${filtered.length
          ? `<div class="oc-grid">${filtered.map(openCircleCard).join('')}</div>`
          : `<div class="oc-empty">
              <span class="oc-empty__art">${icon('users')}</span>
              <h3>${circles.length ? 'No circles match that filter.' : 'No open circles right now.'}</h3>
              <p>${circles.length ? 'Try another filter, or start your own circle and open it to new members.' : 'Open seats appear here as organizers open their circles. You can also start one and let people take the remaining seats themselves.'}</p>
              <div class="empty__actions">
                <button class="btn btn--lime" type="button" data-action="start-circle">Create a circle ${icon('arrow')}</button>
                <button class="btn btn--line" type="button" data-action="open-join">Join with a code</button>
              </div>
            </div>`}
      </section>
      <div class="oc-bottom">
        <section class="card oc-private">
          <div class="card__head"><h2 class="card__title">Private circle</h2>${pill('INVITE ONLY')}</div>
          ${privateCircles.length ? `<div class="oc-private__list" aria-label="Your private circles">
            ${privateCircles.map((group) => `<button class="oc-private__row" type="button" data-action="open-group" data-group="${esc(group.id)}">
              <span class="oc-card__avatar">${esc(initials(group.name))}</span>
              <span class="oc-private__copy"><b>${esc(group.name)}</b><em>${group.memberCount} of ${group.maxMembers} seats · ${group.status === 'forming' ? 'gathering' : group.status === 'completed' ? 'round closed' : `round ${group.circleNumber || 1}`}</em></span>
              ${icon('chevron')}
            </button>`).join('')}
          </div>` : `<p class="hint" style="margin:0">A private circle keeps its table closed. Members take seats with an invite code — the code is the door, and the table only opens for people you trust.</p>`}
          <form class="form oc-codeform" data-form="join-group" novalidate>
            <label class="field"><span>Invite code</span><input class="input mono" name="inviteCode" maxlength="12" autocomplete="off" spellcheck="false" placeholder="ENTER 6–7 CHARACTERS" required data-code-input></label>
            <span class="oc-codecheck" data-code-hint aria-live="polite">Enter the code from your organizer</span>
            <button class="btn btn--line" type="submit">Take my seat ${icon('arrow')}</button>
            <p class="error" data-form-error hidden></p>
          </form>
        </section>
        <section class="card oc-protectcard">
          <div class="card__head"><h2 class="card__title">Nobody loses quietly</h2>${icon('shield')}</div>
          <div class="protect__rows protect__rows--stack">
            <div><b>Bond before the pot.</b><span>Every winner's payout is held against a bond. The bond releases as later turns are funded, so a walk-away never leaves a hole.</span></div>
            <div><b>Guarantor on file.</b><span>Each seat names a guarantor inside the circle. A missed turn is chased before it is ever written off.</span></div>
            <div><b>The ledger is the truth.</b><span>Seat payments, contributions, fees and refunds are single ledger entries. Nothing can be edited after a turn settles.</span></div>
          </div>
          <a class="card__link" href="#rules">Read the Rulebook ${icon('chevron')}</a>
        </section>
      </div>
    </div>
  `);
  armCountdown();
  startOpenPoll();
}

function findOpenCircle(groupId) {
  return (state.openCircles || []).find((circle) => circle.id === groupId)
    || state.openSeats.find((detail) => detail.group.id === groupId)?.group
    || null;
}

function openSeatSheet(circle) {
  if (!state.me) { openAuth('start'); return; }
  if (!circle) return;
  state.openSelected = circle;
  const status = state.me.identityStatus || 'unverified';
  const verified = status === 'verified';
  const pendingId = status === 'pending';
  const { turns } = seatValue(circle);
  const seatNumber = Number(circle.memberCount || 0) + 1;
  openSheet({
    kicker: `OPEN CIRCLE · ${String(circle.name || '').toUpperCase()}`,
    title: `Take seat ${seatNumber} of ${turns}.`,
    body: `
      <div class="estimate">
        <div class="estimate__row"><span>Seat payment · turn 1</span><b>${money(circle.seatMinor)}</b></div>
        <div class="estimate__row"><span>What it covers</span><b>Your first contribution</b></div>
        <div class="estimate__row"><span>Every turn after</span><b>${money(circle.seatMinor)} when funded</b></div>
        <div class="estimate__row estimate__row--total"><span>Due now</span><b>${money(circle.seatMinor)}</b></div>
      </div>
      <div class="oc-identity${verified ? ' is-verified' : ''}">
        <span class="oc-identity__icon">${icon(verified ? 'shield' : pendingId ? 'clock' : 'key')}</span>
        <div>
          <b>${verified ? `ID verified · ${esc(state.me.name)} ····${esc(state.me.identityLast4 || '')}` : pendingId ? `ID in review · ····${esc(state.me.identityLast4 || '')}` : 'Type your ID to take an open seat'}</b>
          <span>${verified ? 'One account, one seat in this circle. The organizer never has to approve you.' : pendingId ? 'The review desk is checking the name, ID number and phone you typed. This seat opens when it clears.' : 'No photo. Type the ID number, the name on it and this phone once; a reviewer confirms the match.'}</span>
        </div>
        ${verified ? '' : `<button class="btn btn--line btn--sm" type="button" data-action="open-identity">${pendingId ? 'View' : 'Add ID'}</button>`}
      </div>
      <form class="form" data-form="seat" novalidate>
        <label class="pledge">
          <input type="checkbox" name="pledge" value="1">
          <span><b>I pledge the circle rules.</b> I fund every turn on time, settle disagreements inside the circle, and keep every payment in the ledger. I accept the fixed ${money(circle.seatMinor)} contribution, the 14-day seat refund window, and that a started circle's seats are final. I accept the <a href="terms.html" target="_blank" rel="noopener">Terms</a> and <a href="privacy.html" target="_blank" rel="noopener">Privacy Notice</a>.</span>
        </label>
        <div class="notice notice--cyan">${icon('lock')}<span>Refunded automatically if the circle does not start within ${SEAT_REFUND_DAYS} days, if you leave before the start, or if a payment lands after the seats close. The seat is only yours once the provider confirms.</span></div>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit" ${verified ? '' : 'disabled'}>Accept &amp; pay ${money(circle.seatMinor)} ${icon('arrow')}</button>
        <p class="hint">${verified ? 'You will be redirected to Paysasa to pay with M-PESA.' : pendingId ? 'This button activates when the review desk approves your typed ID.' : 'Type your ID above; this button activates after review.'}</p>
      </form>
    `,
    onClose: () => { if (state.openSelected === circle) state.openSelected = null; },
  });
}

function openIdentitySheet() {
  if (!state.me) { openAuth('start'); return; }
  const status = state.me.identityStatus || 'unverified';
  if (status === 'verified') { toast('Your ID is already verified.', 'lime'); return; }
  state.openSelected = null;
  const pending = status === 'pending';
  const rejected = status === 'rejected';
  const statusNote = pending
    ? `<div class="notice notice--cyan">${icon('shield')}<span><b>With the review desk.</b> ····${esc(state.me.identityLast4 || '')} ${state.me.identitySubmittedAt ? `submitted ${fmtDateTime(state.me.identitySubmittedAt)}` : 'submitted just now'}. You can replace the details below if you spotted a typo.</span></div>`
    : rejected
      ? `<div class="notice notice--amber">${icon('alert')}<span><b>Returned by the review desk.</b> ${esc(state.me.identityNote || 'Check the ID number, name and phone, then send them again.')}</span></div>`
      : '';
  const intro = rejected
    ? 'Correct the details and send them back. The check runs against the national register — your name, date of birth and phone must belong to the same person.'
    : pending
      ? 'Your first submission is already in the queue. Replacing it keeps the same account and phone — only the newest details are checked.'
      : 'No photo and no ID upload. Type your national ID, the name on it, your date of birth and the phone on this account. The register check runs automatically; when they all belong to the same person, you are verified on the spot.';
  openSheet({
    kicker: 'ID CHECK · NATIONAL REGISTER',
    title: pending ? 'Your ID is in review.' : rejected ? 'Fix your ID details.' : 'Verify your ID.',
    body: `
      <p class="hint">${esc(intro)}</p>
      ${statusNote}
      <form class="form" data-form="identity" novalidate>
        <label class="field"><span>Name on the ID</span><input class="input" name="legalName" maxlength="80" autocomplete="name" value="${esc(state.me.identityName || state.me.name || '')}" required></label>
        <p class="hint identity-match" data-idmatch hidden></p>
        <label class="field"><span>National ID number</span><input class="input mono" name="idNumber" inputmode="numeric" maxlength="8" autocomplete="off" spellcheck="false" placeholder="7 or 8 digits" required></label>
        <label class="field"><span>Date of birth</span><input class="input" name="dateOfBirth" type="date" autocomplete="bday" min="${oldestCutoff()}" max="${adultCutoff()}" value="${esc(state.me.dateOfBirth || '')}" required></label>
        <label class="field"><span>Phone on this account</span><input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(state.me.phone || '')}" required></label>
        <label class="pledge">
          <input type="checkbox" name="consent" value="1">
          <span><b>Check my record.</b> I agree that THE WHEEL and its identity partner may check this ID, my name, date of birth and phone against Kenya's national register.</span>
        </label>
        <div class="notice notice--cyan">${icon('lock')}<span>${state.config.identityProvider
          ? `A national-register check is connected${state.config.identityProviderSimulated ? ' <b>(sandbox mode — test records only)</b>' : ''}. Name, date of birth and phone must match the registered person, or the file goes to the review desk.`
          : 'No register is connected, so a reviewer checks the typed details. The name comparison below is a guide, not an approval.'} We store a hash of the ID number, its last four digits, and the name you typed. The full number is discarded after the check.</span></div>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">${pending ? 'Replace the details' : 'Verify my ID'} ${icon('arrow')}</button>
      </form>
    `,
  });
  const nameInput = dom.sheetBody?.querySelector('[name="legalName"]');
  const matchHint = dom.sheetBody?.querySelector('[data-idmatch]');
  if (nameInput && matchHint) {
    const accountTokens = identityTokens(state.me.name || '');
    const update = () => {
      const typedTokens = identityTokens(nameInput.value);
      matchHint.hidden = typedTokens.length === 0;
      const matched = typedTokens.length > 0
        && typedTokens.length === accountTokens.length
        && typedTokens.every((token, index) => token === accountTokens[index]);
      matchHint.textContent = matched
        ? `This matches your account name (${state.me.name}).`
        : `This differs from your account name (${state.me.name}). Spelling and order are normalised before the check.`;
      matchHint.classList.toggle('is-match', matched);
      matchHint.classList.toggle('is-diff', !matched);
    };
    nameInput.addEventListener('input', update);
    update();
  }
}

function identityTokens(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort();
}

async function submitIdentity(form) {
  const button = form.querySelector('[type="submit"]');
  formError(form, '');
  const legalName = String(form.legalName.value || '').trim();
  const idNumber = String(form.idNumber.value || '').replace(/\s/g, '');
  const phone = String(form.phone.value || '').trim();
  const dateOfBirth = String(form.dateOfBirth?.value || '');
  if (legalName.length < 3) { formError(form, 'Enter your full legal name.'); return; }
  if (!/^\d{7,8}$/.test(idNumber)) { formError(form, 'Enter the 7 or 8 digits of your national ID.'); return; }
  const age = ageFromDob(dateOfBirth);
  if (age === null) { formError(form, 'Add your date of birth.'); return; }
  if (age < 18) { formError(form, 'Seats are for members aged 18 and over.'); return; }
  if (phone.replace(/\D/g, '').length < 9) { formError(form, 'Enter the phone number on this account.'); return; }
  if (form.consent?.checked !== true) { formError(form, 'Tick the consent box so we can check your ID, name and phone against the national register.'); return; }
  setBusy(button, true, 'Checking');
  try {
    const data = await api('/account/identity', { method: 'POST', body: { legalName, idNumber, phone, dateOfBirth, verificationConsent: true } });
    await loadMe();
    closeSheet();
    if (data.identityStatus === 'verified') {
      toast('ID verified. Your seat is ready to pay.', 'lime');
      if (state.pendingSeatCircle) {
        const circle = state.pendingSeatCircle;
        state.pendingSeatCircle = null;
        openSeatSheet(circle);
      } else if (state.group) {
        await refreshRoute();
      }
      return;
    }
    state.pendingSeatCircle = null;
    toast('ID sent to the review desk. Open seats unlock when it clears.', 'lime');
    if (state.route === '/settings' || state.group) await refreshRoute();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitSeat(form) {
  const circle = state.openSelected;
  if (!circle) return;
  const button = form.querySelector('[type="submit"]');
  formError(form, '');
  if (state.me?.identityStatus !== 'verified') {
    state.pendingSeatCircle = circle;
    openIdentitySheet();
    return;
  }
  if (!form.pledge?.checked) { formError(form, 'Tick the pledge to take the seat.'); return; }
  setBusy(button, true, 'Opening Paysasa');
  try {
    const data = await api(`/groups/${circle.id}/seat-checkout`, { method: 'POST', body: { acceptRules: true } });
    if (!data.checkoutUrl) throw new Error('The payment link was not returned.');
    location.assign(data.checkoutUrl);
  } catch (error) {
    setBusy(button, false);
    if (error.code === 'identity_required') {
      state.pendingSeatCircle = circle;
      openIdentitySheet();
      return;
    }
    formError(form, error.message);
    if (['group_full', 'seats_closed', 'seat_already_paid'].includes(error.code)) {
      setTimeout(() => { closeSheet(); void viewOpenCircles({ silent: true }); }, 1800);
    }
  }
}

async function paySeat(groupId, button) {
  if (state.me?.identityStatus !== 'verified') { openIdentitySheet(); return; }
  setBusy(button, true, 'Opening Paysasa');
  try {
    const data = await api(`/groups/${groupId}/seat-checkout`, { method: 'POST', body: { acceptRules: true } });
    if (!data.checkoutUrl) throw new Error('The payment link was not returned.');
    closeSheet();
    location.assign(data.checkoutUrl);
  } catch (error) {
    setBusy(button, false);
    if (error.code === 'identity_required') { openIdentitySheet(); return; }
    apiToast(error);
    if (['group_full', 'seats_closed', 'seat_already_paid'].includes(error.code)) {
      await viewOpenCircles({ silent: true });
    }
  }
}

function openLeaveSeatSheet(detail) {
  if (!detail) return;
  const state_ = seatStateOf(detail);
  const paid = state_?.key === 'paid';
  openSheet({
    kicker: 'LEAVE OPEN CIRCLE',
    title: paid ? 'Leave and get your seat back.' : 'Release your held seat.',
    body: `
      <p class="hint">${paid
        ? `${money(detail.me.seatPaidMinor)} returns to your wallet immediately. The seat reopens for someone else.`
        : 'Nothing was paid. The seat returns to the open list now.'}</p>
      <div class="estimate">
        <div class="estimate__row"><span>Circle</span><b>${esc(detail.group.name)}</b></div>
        <div class="estimate__row"><span>Seat</span><b>${detail.members.find((member) => member.id === detail.me.membershipId)?.seat ?? '—'} of ${detail.group.maxMembers}</b></div>
        <div class="estimate__row estimate__row--total"><span>Refund to wallet</span><b class="lime">${money(paid ? detail.me.seatPaidMinor : 0)}</b></div>
      </div>
      <div class="notice notice--amber">${icon('alert')}<span>If this circle starts before you leave, the seat is locked and this option closes. Once the circle is active, leaving is handled as a dispute inside the circle.</span></div>
      <button class="btn btn--danger btn--block btn--lg" type="button" data-action="leave-circle-confirm" data-group="${esc(detail.group.id)}">${paid ? 'Leave · refund my seat' : 'Release seat'}</button>
    `,
    foot: '<button class="btn btn--line" type="button" data-action="close-sheet">Stay in the circle</button>',
  });
}

async function leaveOpenCircle(groupId, button) {
  setBusy(button, true, 'Releasing');
  try {
    const data = await api(`/groups/${groupId}/leave`, { method: 'POST', body: {} });
    closeSheet();
    toast(data.refundedMinor ? `${money(data.refundedMinor)} returned to your wallet.` : 'Seat released.', 'lime');
    state.activeGroupId = null;
    state.group = null;
    localStorage.removeItem('wheel.activeGroup');
    await loadMe();
    if (state.route.startsWith('/g')) navigate('/open', { replace: true });
    else await viewOpenCircles({ silent: true });
  } catch (error) {
    setBusy(button, false);
    toast(error.message, 'error');
  }
}

function openTopUpSheet() {
  const wallet = state.group?.wallet || state.wallet || {};
  const chips = state.config.topUpChipsMinor || [10000, 25000, 50000, 100000, 250000, 500000];
  openSheet({
    kicker: 'STASH',
    title: 'Put something aside.',
    body: `
      <p class="hint" style="margin-top:0">Your stash sits in your THE WHEEL wallet and covers a turn without a fresh M-PESA prompt. Top-ups are collected by Paysasa.</p>
      <div class="estimate"><div class="estimate__row"><span>In your stash now</span><b class="lime">${money(wallet.availableMinor || 0)}</b></div></div>
      <div class="topup-chips">
        ${chips.map((amount) => `<button class="btn btn--line" type="button" data-action="topup-start" data-amount="${amount}">${money(amount)}</button>`).join('')}
      </div>
      <p class="error" data-form-error hidden></p>
      <p class="hint">Minimum ${money(5000)} per top-up. The balance is marked saved only after Paysasa confirms the payment.</p>    `,
    foot: '<button class="btn btn--line" type="button" data-action="close-sheet">Close</button>',
  });
}

async function startWalletTopUp(button) {
  const amountMinor = Number(button.dataset.amount);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return;
  if (!state.config.paymentsConfigured) {
    toast(state.config.withdrawalBlocker || 'Top-ups open when the organizer connects the payment account.', 'error');
    return;
  }
  setBusy(button, true, 'Opening Paysasa');
  try {
    const data = await api('/wallet/topups', { method: 'POST', body: { amountMinor } });
    if (!data.checkoutUrl) throw new Error('The payment link was not returned.');
    if (data.sessionId) localStorage.setItem('wheel.topupSession', data.sessionId);
    closeSheet();
    location.assign(data.checkoutUrl);
  } catch (error) {
    setBusy(button, false);
    const form = dom.sheetBody?.querySelector('form');
    if (form) formError(form, error.message);
    toast(error.message, 'error');
  }
}

// A top-up returns from Paysasa before the webhook sometimes lands. Ask the
// server to reconcile once, then trust the ledger.
async function resumeWalletTopUp() {
  const sessionId = localStorage.getItem('wheel.topupSession');
  if (!sessionId) return;
  localStorage.removeItem('wheel.topupSession');
  try {
    const result = await api(`/payments/checkouts/${encodeURIComponent(sessionId)}/sync`, {
      method: 'POST', body: {},
    });
    if (result?.paid) {
      toast(result.testApproved ? 'Sandbox test approval: stash topped up. No money moved.' : 'Stash topped up.', 'lime');
      await loadMe();
      await refreshRoute();
    }
  } catch { /* the webhook is still the source of truth */ }
}

async function checkWalletTopUp(button) {
  const sessionId = localStorage.getItem('wheel.topupSession');
  if (!sessionId) { toast('No top-up is waiting to confirm.', 'error'); return; }
  setBusy(button, true, 'Checking Paysasa');
  try {
    const result = await api(`/payments/checkouts/${encodeURIComponent(sessionId)}/sync`, { method: 'POST', body: {} });
    setBusy(button, false);
    if (result?.paid) {
      localStorage.removeItem('wheel.topupSession');
      closeSheet();
      toast(result.testApproved
        ? 'Sandbox test approval: stash topped up. No money moved.'
        : 'Stash topped up. The balance is saved.', 'lime');
      await loadMe();
      await refreshRoute();
      return;
    }
    if (result?.closed) {
      localStorage.removeItem('wheel.topupSession');
      closeSheet();
      toast('That checkout closed without payment, so no money moved. Start a top-up again when you are ready.', '');
      await refreshRoute();
      return;
    }
    const testOn = state.config.testApprovals?.enabled;
    toast(testOn
      ? 'Paysasa has not confirmed it yet. Cancel the prompt (or wait for it to lapse) and check again — sandbox test approval will book it.'
      : 'Paysasa has not confirmed it yet. If you saw the M-PESA prompt, approve it and check again.', '');
  } catch (error) {
    setBusy(button, false);
    toast(error.message, 'error');
  }
}

function walletMovements(detail, topUps = []) {
  const rowsList = (detail?.ledger || [])
    .filter((entry) => Number(entry.walletEffect || 0) !== 0)
    .map((entry) => {
      const effect = Number(entry.walletEffect || 0);
      return {
        when: entry.createdAt,
        label: kindMeta(entry.kind)[0],
        meta: [fmtDateTime(entry.createdAt), entry.actorName].filter(Boolean).join(' · '),
        effect,
      };
    });
  for (const top of topUps) {
    const paid = top.status === 'paid';
    const waiting = top.status === 'pending';
    const testApproved = Boolean(top.test_approved);
    rowsList.push({
      when: top.paid_at || top.created_at,
      label: paid ? 'Stash top-up' : waiting ? 'Top-up in flight' : 'Top-up closed',
      meta: paid
        ? `${testApproved ? 'Sandbox test approval' : 'Cleared into your stash'} · ${fmtDateTime(top.paid_at || top.created_at)}`
        : waiting
          ? `Waiting for the M-PESA receipt · ${fmtDateTime(top.created_at)}`
          : `No money moved · ${fmtDateTime(top.created_at)}`,
      effect: paid ? Number(top.amount_minor || 0) : null,
      closed: !paid && !waiting,
    });
  }
  rowsList.sort((a, b) => Date.parse(b.when || 0) - Date.parse(a.when || 0));
  const list = rowsList.slice(0, 5);
  if (!list.length) return '<p class="wallet-sheet__empty">Your first movement lands here: a top-up, a contribution, a patience share, or a payout.</p>';
  return `<div class="wallet-sheet__rows">${list.map((row) => `<div class="wallet-sheet__row">
      <span class="wallet-sheet__row-main"><b>${esc(row.label)}</b><em>${esc(row.meta)}</em></span>
      <b class="${row.closed ? 'is-wait' : row.effect == null ? 'is-wait' : row.effect > 0 ? 'is-credit' : 'is-debit'}">${row.closed ? 'no charge' : row.effect == null ? 'clearing' : `${row.effect > 0 ? '+' : '−'} ${money(Math.abs(row.effect))}`}</b>
    </div>`).join('')}</div>`;
}

async function openWalletSheet() {
  const detail = state.group;
  const wallet = detail?.wallet || state.wallet || {};
  const available = Number(wallet.availableMinor || 0);
  const due = walletDue(detail);
  const turns = due ? Math.floor(available / due) : null;
  const coverPct = due ? Math.min(100, Math.round((available / due) * 100)) : 0;
  let topUps = [];
  let historyLoaded = false;
  try {
    const history = await api('/wallet/topups', { timeout: 6000 });
    topUps = Array.isArray(history?.topUps) ? history.topUps : [];
    historyLoaded = true;
  } catch { /* history is optional; the ledger still shows movements */ }
  const waitingTopUp = topUps.find((top) => top.status === 'pending');
  if (waitingTopUp) localStorage.setItem('wheel.topupSession', waitingTopUp.session_id || waitingTopUp.id);
  else if (historyLoaded) localStorage.removeItem('wheel.topupSession');
  const pendingTopUp = localStorage.getItem('wheel.topupSession');
  openSheet({
    kicker: 'STASH',
    title: 'Your money, in one place.',
    body: `
      <div class="wallet-sheet__plate">
        <span class="wallet-sheet__k">AVAILABLE NOW</span>
        <b class="wallet-sheet__v">${money(available)}</b>
        <div class="wallet-sheet__meta"><span>${wallet.pendingMinor ? `${money(wallet.pendingMinor)} clearing` : 'Nothing on hold'}</span><span>KENYAN SHILLINGS</span></div>
        ${due ? `<div class="wallet-sheet__cover">
          <div class="wallet-cover__line"><span>Turn ${detail.cycle.number} needs ${money(due)}</span><b class="${turns > 0 ? 'is-ok' : 'is-short'}">${turns > 0 ? `covers ${turns} turn${turns === 1 ? '' : 's'}` : 'short of one turn'}</b></div>
          <div class="wallet-cover__bar" role="img" aria-label="${coverPct}% of the next contribution covered"><i style="width:${coverPct}%"></i></div>
        </div>` : ''}
      </div>
      <div class="wallet-sheet__facts">
        <div><span>ON HOLD</span><b>${money(wallet.pendingMinor || 0)}</b></div>
        <div><span>BOND HELD</span><b>${money(wallet.bondHeldMinor || 0)}</b></div>
        <div><span>SHARES EARNED</span><b class="is-ok">${money(wallet.discountEarnedMinor || 0)}</b></div>
      </div>
      ${pendingTopUp ? `<div class="wallet-sheet__pending">
        ${icon('clock')}
        <span>A Paysasa top-up is still confirming. The balance moves only after the payment clears.${state.config.testApprovals?.enabled ? ' Sandbox test approvals are on: a cancelled or failed prompt still books the top-up for testing.' : ''}</span>
        <button class="btn btn--line btn--sm" type="button" data-action="wallet-check-topup">Check now</button>
      </div>` : ''}
      <h3 class="wallet-sheet__h">Recent wallet movements</h3>
      ${walletMovements(detail, topUps)}
      <p class="hint">Your stash pays a contribution in one tap, with no fresh M-PESA prompt. ${state.config.withdrawalsConfigured ? 'Withdrawals go to your M-PESA number.' : esc(state.config.withdrawalBlocker || 'M-PESA withdrawals are paused; your balance stays recorded in the ledger.')}</p>
    `,
    foot: `<button class="btn btn--line" type="button" data-action="go" data-path="/g/ledger">Ledger</button>${state.config.paymentsConfigured ? '<button class="btn btn--line" type="button" data-action="open-topup">Top up stash</button>' : ''}<button class="btn btn--lime" type="button" data-action="open-withdraw" ${!state.config.withdrawalsConfigured || !available ? 'disabled' : ''}>Withdraw</button>`,
  });
}

function openWithdrawSheet() {
  if (!state.config.withdrawalsConfigured) { toast(state.config.withdrawalBlocker || 'M-PESA withdrawals are paused. Your balance stays recorded.', 'error'); return; }
  const wallet = state.group?.wallet || state.wallet || {};
  if (!wallet.availableMinor) { toast('Nothing is available to withdraw yet.', 'error'); return; }
  openSheet({
    kicker: 'WITHDRAW',
    title: 'Send to M-PESA.',
    body: `
      <form class="form" data-form="withdraw" novalidate>
        <div class="estimate"><div class="estimate__row"><span>Available</span><b class="lime">${money(wallet.availableMinor)}</b></div></div>
        <label class="field"><span>Amount · KES</span><input class="input" name="amount" type="number" inputmode="decimal" min="1" max="${(wallet.availableMinor / MINOR).toFixed(2)}" step="1" value="${Math.floor(wallet.availableMinor / MINOR)}" required></label>
        <label class="field"><span>M-PESA phone</span><input class="input" name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(state.me?.phone || '')}" required></label>
        <div class="notice notice--cyan">${icon('phone')}<span>The withdrawal is sent to the M-PESA number after the server checks your available balance. A pending withdrawal blocks a second one.</span></div>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">Withdraw to M-PESA ${icon('arrow')}</button>
      </form>
    `,
  });
}

function openCoverSheet() {
  const detail = state.group;
  if (!detail?.cycle) return;
  const unpaid = (detail.members || []).filter((member) => !member.paidThisCycle);
  if (!unpaid.length) { toast('Everyone has funded this turn.', 'lime'); return; }
  openSheet({
    kicker: `TURN ${detail.cycle.number} · SHORTFALL`,
    title: 'Cover a shortfall.',
    body: `
      <p class="hint" style="margin-top:0">The auction cannot open until the pot is whole. Cover the missing contribution from the guarantee fund first; use the organizer's wallet only if the fund is short.</p>
      <form class="form" data-form="cover" novalidate>
        <label class="field"><span>Member</span><select class="select" name="membershipId">${unpaid.map((member) => `<option value="${esc(member.id)}">${esc(member.name)} · ${money(detail.cycle.contributionMinor)}</option>`).join('')}</select></label>
        <label class="field"><span>Cover from</span><select class="select" name="source"><option value="fund">Guarantee fund · ${money(detail.fund?.balanceMinor || 0)}</option><option value="wallet">My wallet · ${money(detail.wallet?.availableMinor || 0)}</option><option value="guarantor">Their guarantor</option></select></label>
        <div class="notice notice--amber">${icon('alert')}<span>Covering a contribution does not erase the debt. The member's late fee and guarantee record reflect the shortfall.</span></div>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--amber btn--block" type="submit">Cover the contribution ${icon('arrow')}</button>
      </form>
    `,
  });
}

function openVerifySheet(memberId) {
  const member = state.group?.members?.find((item) => item.id === memberId);
  if (!member) return;
  openSheet({
    kicker: 'MEMBER VERIFICATION',
    title: `Verify ${member.name.split(/\s+/)[0]}.`,
    body: `
      <div class="notice notice--amber">${icon('shield')}<span>Confirm that you have seen this person's phone number and identity in person. This unlocks their first payout.</span></div>
      <div class="estimate" style="margin-top:14px">
        <div class="estimate__row"><span>Member</span><b>${esc(member.name)}</b></div>
        <div class="estimate__row"><span>Phone</span><b>${esc(member.phoneMasked || '—')}</b></div>
        <div class="estimate__row"><span>Trust</span><b>${member.trustScore} · ${tierName(member.trustScore)}</b></div>
        <div class="estimate__row"><span>Bond band</span><b>${pct(member.bondBps)}</b></div>
      </div>
      <form class="form" data-form="verify" data-id="${esc(member.id)}" style="margin-top:14px">
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block" type="submit">Mark verified ${icon('check')}</button>
      </form>
    `,
  });
}

function openGuaranteeSheet(memberId) {
  const detail = state.group;
  const member = detail?.members?.find((item) => item.id === memberId);
  if (!member) return;
  const candidates = (detail.members || []).filter((item) => item.id !== memberId && item.id !== member.guarantor?.id && (item.guaranteeCount || 0) < 2);
  openSheet({
    kicker: 'GUARANTEE',
    title: `Guarantee ${member.name.split(/\s+/)[0]}.`,
    body: `
      <p class="hint" style="margin-top:0">A guarantor can cover up to two members. Each member has one guarantor. If the member misses a turn, the guarantor is called before the fund.</p>
      <div class="estimate" style="margin-bottom:14px">
        <div class="estimate__row"><span>Member</span><b>${esc(member.name)}</b></div>
        <div class="estimate__row"><span>Current guarantor</span><b>${member.guarantor ? esc(member.guarantor.name) : 'None'}</b></div>
        <div class="estimate__row"><span>Bond band</span><b>${pct(member.bondBps)}</b></div>
      </div>
      <form class="form" data-form="guarantee" data-id="${esc(member.id)}">
        <label class="field"><span>Guarantor</span><select class="select" name="guarantorId">${candidates.map((item) => `<option value="${esc(item.id)}">${esc(item.name)} · ${item.guaranteeCount || 0}/2 guarantees</option>`).join('')}</select></label>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block" type="submit" ${candidates.length ? '' : 'disabled'}>Set guarantor ${icon('shield')}</button>
      </form>
      ${candidates.length ? '' : '<p class="hint">No eligible guarantor is available. A guarantor can hold at most two guarantees.</p>'}
    `,
  });
}

function openDisputeSheet(memberId = '') {
  const member = memberId ? state.group?.members?.find((item) => item.id === memberId) : null;
  openSheet({
    kicker: 'REPORT AN ISSUE',
    title: 'Put it on the record.',
    body: `
      <p class="hint" style="margin-top:0">The circle organizer reviews disputes under the platform rules. Do not include your passkey, recovery codes, or M-PESA PIN.</p>
      <form class="form" data-form="dispute" ${member ? `data-id="${esc(member.id)}"` : ''}>
        <label class="field"><span>Issue</span><textarea class="input" name="reason" rows="4" maxlength="600" placeholder="What happened? Include the turn and the amount." required></textarea></label>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--amber btn--block" type="submit">${icon('flag')} Send to the organizer</button>
      </form>
    `,
  });
}

function openStartSheet() {
  const detail = state.group;
  if (!detail) return;
  const round = detail.round || { number: 1, acceptedCount: 0, memberCount: detail.group.memberCount, iAccepted: false };
  const count = detail.group.memberCount;
  const allAccepted = round.acceptedCount >= round.memberCount;
  const seatsUnpaid = round.seatsUnpaid || 0;
  const openCircle = detail.group.visibility === 'open';
  if (!detail.group.isOrganizer && round.iAccepted) { toast('You accepted this round. The organizer starts it once everyone accepts.'); return; }
  if (detail.group.isOrganizer && count < 5) { toast('A circle needs at least five members to start.', 'error'); return; }
  if (detail.group.isOrganizer && seatsUnpaid > 0) { toast(`${seatsUnpaid} joining seat${seatsUnpaid === 1 ? ' is' : 's are'} still unpaid. The start waits for every turn 1 payment.`, 'error'); return; }
  openSheet({
    kicker: `ROUND ${round.number}`,
    title: round.iAccepted ? `Open turn one with ${count} members.` : `Accept round ${round.number} terms.`,
    body: `
      <div class="estimate">
        <div class="estimate__row"><span>Members</span><b>${count} / ${detail.group.maxMembers}</b></div>
        <div class="estimate__row"><span>Contribution</span><b>${money(detail.group.contributionMinor)} each turn</b></div>
        ${openCircle ? `<div class="estimate__row"><span>Prepaid seats</span><b class="${seatsUnpaid ? 'amber' : 'lime'}">${seatsUnpaid ? `${seatsUnpaid} unpaid` : 'every joining seat paid'}</b></div>` : ''}
        <div class="estimate__row"><span>Payout period</span><b>${cadenceLabel(detail.group.cadence)}</b></div>
        <div class="estimate__row"><span>Your total commitment</span><b>${money(detail.group.contributionMinor * count)} over ${count} turns</b></div>
        <div class="estimate__row estimate__row--total"><span>Accepted</span><b>${round.acceptedCount} / ${round.memberCount}</b></div>
      </div>
      <div class="notice notice--amber" style="margin-top:14px">${icon('lock')}<span>Seats lock at start. Each pot is fully funded by members before bidding, and a funded pot waits for its scheduled date. Nobody tops up a short pot. The first payout is held for 48 hours and requires identity verification.</span></div>
      ${round.iAccepted ? '' : `<form class="form" data-form="accept-round" style="margin-top:14px"><p class="error" data-form-error hidden></p><button class="btn btn--lime btn--block btn--lg" type="submit">I accept round ${round.number} ${icon('check')}</button></form>`}
      ${detail.group.isOrganizer && round.iAccepted ? `<form class="form" data-form="start" style="margin-top:14px">
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit" ${allAccepted && !seatsUnpaid ? '' : 'disabled'}>Start round ${round.number} ${icon('arrow')}</button>
        ${allAccepted ? '' : '<p class="hint">Every member must accept personally before the round starts.</p>'}
        ${seatsUnpaid ? `<p class="hint">${seatsUnpaid} joining seat${seatsUnpaid === 1 ? ' is' : 's are'} still unpaid. Open circles start only after every turn 1 payment lands.</p>` : ''}
      </form>` : ''}
    `,
  });
}

function cadenceLabel(value) {
  return { weekly: 'Weekly', fortnightly: 'Every two weeks', monthly: 'Monthly' }[value] || 'Weekly';
}

function openProposeRoundSheet() {
  const detail = state.group;
  if (!detail?.round?.canPropose) return;
  openSheet({
    kicker: 'KEEP THE GROUP GOING',
    title: `Propose round ${detail.round.number + 1}.`,
    body: `
      <p class="hint">Same members, same contribution and ${cadenceLabel(detail.group.cadence).toLowerCase()} period. Every member accepts again before anyone contributes. Round ${detail.round.number} receipts stay in the ledger.</p>
      <form class="form" data-form="propose-round" style="margin-top:14px">
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">Propose round ${detail.round.number + 1} ${icon('arrow')}</button>
      </form>
    `,
  });
}

function openNextTurnSheet() {
  const detail = state.group;
  if (!detail) return;
  if (!detail.group.isOrganizer) { toast('Only the organizer can open the next turn.'); return; }
  const nextNumber = (detail.cycle?.number || 0) + 1;
  openSheet({
    kicker: `TURN ${nextNumber}`,
    title: 'Open the next turn.',
    body: `
      <div class="estimate">
        <div class="estimate__row"><span>Members</span><b>${detail.group.memberCount}</b></div>
        <div class="estimate__row"><span>Contribution</span><b>${money(detail.group.contributionMinor)} each</b></div>
        <div class="estimate__row estimate__row--total"><span>New pot</span><b>${money(detail.group.contributionMinor * detail.group.memberCount)}</b></div>
      </div>
      <p class="hint" style="margin-top:12px">The contribution window opens immediately. The auction opens only when every active member has funded the turn.${nextNumber >= (detail.circle?.turnsTotal || detail.group.memberCount) ? ' This is the final turn: the last member without a payout takes the pot at 0% and no bond.' : ''}</p>
      <form class="form" data-form="next" style="margin-top:14px">
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">Open turn ${nextNumber} ${icon('arrow')}</button>
      </form>
    `,
  });
}

function openSettleSheet() {
  const detail = state.group;
  const cycle = detail?.cycle;
  if (!cycle) return;
  const final = cycle.isFinal;
  openSheet({
    kicker: `TURN ${cycle.number} · SETTLE`,
    title: final ? 'Close the final turn.' : 'Turn the wheel.',
    body: `
      <div class="estimate">
        <div class="estimate__row"><span>Pot</span><b>${money(cycle.potCapturedMinor)}</b></div>
        <div class="estimate__row"><span>Sealed bids</span><b>${cycle.bidCount || 0}</b></div>
        <div class="estimate__row"><span>Patient seats</span><b>${cycle.waitersCount || 0}</b></div>
        <div class="estimate__row"><span>Discount cap</span><b>${pct(detail.rules?.maxDiscountBps || 2500)}</b></div>
      </div>
      <div class="notice notice--cyan" style="margin-top:14px">${icon('spin')}<span>${final ? 'The last member without a payout takes the pot at 0% discount and no bond.' : 'The highest sealed discount wins. Ties go to the earliest bid. With no bids, a random eligible member wins at 0%. Settlement is final once written.'}</span></div>
      <form class="form" data-form="settle" style="margin-top:14px">
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">${final ? 'Settle the final turn' : 'Settle this turn'} ${icon('arrow')}</button>
      </form>
    `,
  });
}

function openPasskeySheet() {
  openSheet({
    kicker: 'SECURITY',
    title: 'Add a passkey.',
    body: `
      <p class="hint" style="margin-top:0">Use a passkey on another device so a lost phone does not lock you out. The passkey never leaves the device.</p>
      <form class="form" data-form="add-passkey">
        <label class="field"><span>Device label</span><input class="input" name="label" maxlength="40" value="${esc(deviceLabel())}" required></label>
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--lime btn--block btn--lg" type="submit">${icon('key')} Create passkey</button>
      </form>
    `,
  });
}

function openRegenRecoverySheet() {
  openSheet({
    kicker: 'RECOVERY CODES',
    title: 'Replace your codes.',
    body: `
      <div class="notice notice--amber">${icon('alert')}<span>Generating a new set invalidates every unused recovery code. The ten new codes are shown once.</span></div>
      <form class="form" data-form="regen-recovery" style="margin-top:14px">
        <p class="error" data-form-error hidden></p>
        <button class="btn btn--amber btn--block" type="submit">Generate ten new codes ${icon('shield')}</button>
      </form>
    `,
  });
}

/* ---------------- actions ---------------- */

function downloadFile(name, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function copyText(value) {
  const text = String(value ?? '');
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.', 'lime');
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try { document.execCommand('copy'); toast('Copied.', 'lime'); }
    catch { toast('Copy did not work. Select it manually.', 'error'); }
    area.remove();
  }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadStatement() {
  const entries = state.ledger?.entries || state.group?.ledger || [];
  if (!entries.length) { toast('No ledger entries to export yet.'); return; }
  const header = 'date,kind,member,cycle,amount_minor,wallet_effect_minor,memo,reference\n';
  const rows = entries.map((entry) => [
    new Date(entry.createdAt).toISOString(),
    entry.kind,
    entry.actorName || '',
    entry.cycleNumber || '',
    entry.amountMinor,
    entry.walletEffect,
    entry.memo || '',
    entry.ref,
  ].map(csvCell).join(','));
  downloadFile(`the-wheel-statement-${new Date().toISOString().slice(0, 10)}.csv`, header + rows.join('\n'), 'text/csv');
}

function downloadReceipt() {
  const settlement = state.group?.settlement;
  if (!settlement) { toast('No settlement to download.'); return; }
  const lines = [
    'THE WHEEL — SETTLEMENT RECEIPT',
    `Circle: ${state.group.group.name}`,
    `Turn: ${state.group.cycle.number}`,
    `Winner: ${settlement.winnerName}`,
    `Pot: ${money(settlement.potMinor)}`,
    `Discount: ${pct(settlement.discountBps)} (${money(settlement.discountMinor)})`,
    `Patience shares: ${settlement.waiterCount} × ${money(settlement.waiterShareMinor)}`,
    `Platform fee: ${money(settlement.platformFeeMinor)}`,
    `Organizer fee: ${money(settlement.organizerFeeMinor)}${settlement.organizerFeeWaivedMinor ? ' (waived to fund)' : ''}`,
    `Guarantee fund: ${money(settlement.fundFeeMinor)}`,
    `Bond held: ${money(settlement.bondHoldMinor)}`,
    `Winner net: ${money(settlement.winnerNetMinor)}`,
    `Settlement: ${settlement.status}`,
    `Release: ${fmtDateTime(settlement.releaseAt)}`,
    `Recorded: ${fmtDateTime(settlement.createdAt)}`,
    '',
    'Recorded by THE WHEEL, a settlement service for private savings circles.',
  ];
  downloadFile(`the-wheel-receipt-turn-${state.group.cycle.number}.txt`, lines.join('\n'));
}

async function refreshRoute() {
  const route = routeFromHash();
  if (route === '/app') await viewDashboard();
  else if (route === '/open') await viewOpenCircles();
  else if (route === '/settings') await viewSettings();
  else {
    const groupPath = groupRoute(route);
    if (groupPath?.view === 'recap') await viewRecap(groupPath.turn);
    else if (groupPath?.view === 'ledger') await viewLedger();
    else if (groupPath?.view === 'members') await viewMembers();
    else if (groupPath?.view === 'turn' || groupPath?.view === 'auction' || route === '/g/auction') await viewAuction();
    else if (groupPath || route === '/g') await viewCircle();
  }
}

async function handleAction(action, button) {
  switch (action) {
    case 'open-auth': openAuth(button.dataset.mode || 'start'); break;
    case 'auth-passkey': await signInWithPasskey(button); break;
    case 'auth-register': renderAuth('register'); updateAuthAside('register'); break;
    case 'auth-recover': renderAuth('recover'); updateAuthAside('recover'); break;
    case 'auth-back': renderAuth('start'); updateAuthAside('start'); break;
    case 'id-peek': await peekIdentity(button); break;
    case 'install-app': await installApp(button); break;
    case 'close-auth':
      hideDialog(dom.authDialog);
      if (!state.me && needsAuth(routeFromHash() || '/')) navigate('/', { replace: true });
      break;
    case 'open-app': navigate(state.me ? '/app' : '/'); break;
    case 'open-account': if (state.me) navigate('/settings'); else openAuth('start'); break;
    case 'start-circle': if (!state.me) { state.afterAuth = 'create'; openAuth('register'); } else openCreateSheet(); break;
    case 'open-create': openCreateSheet(); break;
    case 'open-discover': navigate('/open'); break;
    case 'seat-take': openSeatSheet(findOpenCircle(button.dataset.group)); break;
    case 'pay-seat': await paySeat(button.dataset.group, button); break;
    case 'open-identity': if (state.openSelected) state.pendingSeatCircle = state.openSelected; openIdentitySheet(); break;
    case 'jarvis-open': openJarvis(); break;
    case 'jarvis-close': closeJarvis(); break;
    case 'jarvis-mic': startJarvisListening(); break;
    case 'open-admin': navigate('/admin'); break;
    case 'admin-lock':
      state.adminUnlocked = false;
      state.adminLatchOpen = false;
      document.body.dataset.admin = 'off';
      sound('latch', { pan: 0.2, gain: 0.9 });
      navigate('/app');
      break;
    case 'toggle-sound': globalThis.WheelSound?.toggle(); break;
    case 'admin-tab': state.adminView = button.dataset.tab === 'ids' ? 'ids' : 'overview'; await viewAdmin(); break;
    case 'admin-relatch': state.adminLatchOpen = false; await viewAdmin(); break;
    case 'admin-filter': state.adminFilter = button.dataset.filter || 'pending'; await viewAdmin(); break;
    case 'admin-refresh': await viewAdmin(); break;
    case 'admin-approve': await approveIdentity(button.dataset.id, button); break;
    case 'admin-reject': openRejectIdentitySheet(button.dataset.id, button.dataset.name || 'this member'); break;
    case 'leave-seat': openLeaveSeatSheet((state.openSeats || []).find((detail) => detail.group.id === button.dataset.group) || state.group); break;
    case 'leave-circle-confirm': await leaveOpenCircle(button.dataset.group, button); break;
    case 'open-filter': state.openFilter = button.dataset.filter || 'all'; renderDiscover(); break;
    case 'join-code': openJoinSheet(); break;
    case 'open-join': openJoinSheet(); break;
    case 'open-invite': openInviteSheet(); break;
    case 'open-contribute': openContributeSheet(); break;
    case 'pay-contribution': await payContribution(button); break;
    case 'pay-savings': await payFromSavings(button); break;
    case 'open-topup': openTopUpSheet(); break;
    case 'topup-start': await startWalletTopUp(button); break;
    case 'open-pot-guide': openPotGuide(); break;
    case 'open-wallet': await openWalletSheet(); break;
    case 'wallet-check-topup': await checkWalletTopUp(button); break;
    case 'rail-probe': await runRailProbe(button); break;
    case 'test-approvals-toggle': await toggleTestApprovals(button); break;
    case 'open-withdraw': openWithdrawSheet(); break;
    case 'open-cover': openCoverSheet(); break;
    case 'open-verify': openVerifySheet(button.dataset.member); break;
    case 'open-guarantee': openGuaranteeSheet(button.dataset.member); break;
    case 'open-dispute': openDisputeSheet(button.dataset.member || ''); break;
    case 'open-swap': openSwapSheet(button.dataset.member); break;
    case 'swap-accept': await respondSwap(button.dataset.swap, 'accept', button); break;
    case 'swap-decline': await respondSwap(button.dataset.swap, 'decline', button); break;
    case 'swap-cancel': await respondSwap(button.dataset.swap, 'cancel', button); break;
    case 'open-start': openStartSheet(); break;
    case 'open-propose-round': openProposeRoundSheet(); break;
    case 'open-next': openNextTurnSheet(); break;
    case 'open-settle': openSettleSheet(); break;
    case 'open-passkey': openPasskeySheet(); break;
    case 'regen-recovery': openRegenRecoverySheet(); break;
    case 'open-app-overview': navigate('/app'); break;
    case 'open-group': {
      const id = button.dataset.group;
      if (!id || !state.groups.some((group) => group.id === id)) break;
      state.activeGroupId = id;
      localStorage.setItem('wheel.activeGroup', id);
      state.group = null;
      state.ledger = null;
      navigate('/g');
      break;
    }
    case 'close-sheet': closeSheet(); break;
    case 'sign-out': await signOut(false); break;
    case 'sign-out-all': await signOut(true); break;
    case 'refresh': await refreshRoute(); break;
    case 'go': if (button.dataset.path) navigate(button.dataset.path); break;
    case 'seat': highlightSeat(button.dataset.seat); break;
    case 'recap-turn': {
      const recap = state.group?.recap;
      if (!recap) break;
      const index = recap.turns.findIndex((turn) => turn.number === Number(button.dataset.turn));
      if (index < 0) break;
      stopRecapPlayback();
      stopEngineVoice();
      recapUpdate(index);
      break;
    }
    case 'recap-step':
      stopRecapPlayback();
      stopEngineVoice();
      recapUpdate((state.recap.index || 0) + Number(button.dataset.delta || 0));
      break;
    case 'recap-play': {
      const recap = state.group?.recap;
      if (!recap?.turns?.length) break;
      stopRecapPlayback();
      stopEngineVoice();
      const last = recap.turns.length - 1;
      const next = state.recap.index >= last ? 0 : state.recap.index + 1;
      const speakTurn = (index) => {
        const turn = recap.turns[index];
        if (!turn) return;
        speakEngineText(recapSpeech(recap, turn), (reason) => {
          if (reason !== 'ended' && reason !== 'stopped') toast('Voice could not play on this device. The recap stays as text.');
        });
      };
      state.recap.index = next;
      if (next < last) {
        state.recap.timer = setInterval(() => {
          if (!state.group?.recap) { stopRecapPlayback(); return; }
          recapUpdate(state.recap.index + 1);
          speakTurn(state.recap.index);
        }, 2800);
      }
      recapUpdate(next);
      speakTurn(next);
      break;
    }
    case 'recap-stop':
      stopRecapPlayback();
      recapUpdate(state.recap.index || 0);
      break;
    case 'recap-speak': {
      const recap = state.group?.recap;
      const turn = recap?.turns?.[state.recap.index];
      if (!turn) break;
      stopEngineVoice();
      speakEngineText(recapSpeech(recap, turn), (reason) => {
        if (reason !== 'ended' && reason !== 'stopped') toast('Voice could not play on this device. The recap stays as text.');
      });
      break;
    }
    case 'copy': await copyText(button.dataset.copy); break;
    case 'share': {
      const url = button.dataset.url || '';
      const title = button.dataset.title || 'THE WHEEL';
      if (navigator.share) {
        try { await navigator.share({ title, text: 'Join my circle on THE WHEEL.', url }); }
        catch { /* user cancelled */ }
      } else await copyText(url);
      break;
    }
    case 'download-codes':
      if (state.recoveryCodes?.length) {
        downloadFile('the-wheel-recovery-codes.txt', `THE WHEEL — RECOVERY CODES\nKeep these offline. Each code works once.\n\n${state.recoveryCodes.join('\n')}\n\nGenerated ${new Date().toISOString()}\n`);
      }
      break;
    case 'recovery-done':
      closeSheet();
      toast('Keep the codes offline. Add another passkey from Account when you can.', 'lime');
      break;
    case 'statement': downloadStatement(); break;
    case 'download-receipt': downloadReceipt(); break;
    case 'filter-ledger':
      state.ledgerFilter = button.dataset.filter || 'all';
      if (state.group && state.ledger) renderLedger(state.group, state.ledger);
      break;
    case 'revoke-session': await revokeSession(button); break;
    case 'retry': await refreshRoute(); break;
    default: break;
  }
}

async function signOut(all) {
  try {
    await api(all ? '/auth/logout-all' : '/auth/logout', { method: 'POST', body: {} });
  } catch { /* clearing locally is still correct */ }
  signedOut();
  state.activeGroupId = null;
  state.groups = [];
  state.ledger = null;
  state.account = null;
  closeAllViews();
  navigate('/');
  toast(all ? 'Signed out on every device.' : 'Signed out.');
}

async function submitCreateGroup(form) {
  const button = form.querySelector('[type="submit"]');
  formError(form, '');
  const name = String(form.name.value || '').trim();
  const contributionMinor = parseKes(form.contribution.value);
  const maxMembers = Number(form.maxMembers.value);
  const organizerFeeBps = Number(form.organizerFee.value);
  if (name.length < 2) { formError(form, 'Give the circle a name.'); return; }
  if (contributionMinor < 200 * MINOR || contributionMinor > 5000 * MINOR) { formError(form, 'Contribution must be between KES 200 and KES 5,000.'); return; }
  if (!Number.isInteger(maxMembers) || maxMembers < 5 || maxMembers > 12) { formError(form, 'Choose between 5 and 12 members.'); return; }
  setBusy(button, true, 'Creating circle');
  try {
    const cadence = ['weekly', 'fortnightly', 'monthly'].includes(form.cadence?.value) ? form.cadence.value : 'weekly';
    const visibility = form.querySelector('input[name="visibility"]:checked')?.value === 'open' ? 'open' : 'private';
    const data = await api('/groups', { method: 'POST', body: { name, contributionMinor, maxMembers, organizerFeeBps, cadence, visibility } });
    if (data.group?.id) {
      state.activeGroupId = data.group.id;
      localStorage.setItem('wheel.activeGroup', data.group.id);
    }
    await loadMe();
    closeSheet();
    toast(visibility === 'open' ? 'Open circle created. Verified members can take the remaining seats.' : 'Circle created. Invite your first members.', 'lime');
    navigate('/g');
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitJoinGroup(form) {
  const button = form.querySelector('[type="submit"]');
  const code = String(form.inviteCode.value || '').trim().toUpperCase();
  if (!code) { formError(form, 'Enter the invite code.'); return; }
  setBusy(button, true, 'Joining');
  try {
    await joinGroup(code);
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitWithdraw(form) {
  const button = form.querySelector('[type="submit"]');
  formError(form, '');
  const amountMinor = parseKes(form.amount.value);
  const phone = String(form.phone.value || '').trim();
  if (!amountMinor) { formError(form, 'Enter an amount.'); return; }
  if (!phone) { formError(form, 'Enter the M-PESA phone number.'); return; }
  setBusy(button, true, 'Sending');
  try {
    const data = await api('/wallet/withdraw', { method: 'POST', body: { amountMinor, phone } });
    closeSheet();
    toast(data.message || 'Withdrawal submitted. M-PESA confirmation follows.', 'lime');
    await refreshRoute();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitCover(form) {
  const detail = state.group;
  if (!detail?.cycle) return;
  const button = form.querySelector('[type="submit"]');
  const membershipId = form.membershipId.value;
  const source = form.source.value;
  setBusy(button, true, 'Covering');
  try {
    await api(`/groups/${detail.group.id}/cycles/${detail.cycle.id}/cover`, {
      method: 'POST', body: { membershipId, source },
    });
    closeSheet();
    toast('Shortfall covered. The pot can move forward.', 'lime');
    await refreshRoute();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitGuarantee(form) {
  const detail = state.group;
  if (!detail) return;
  const button = form.querySelector('[type="submit"]');
  const membershipId = form.dataset.id;
  const guarantorId = form.guarantorId.value;
  setBusy(button, true, 'Setting');
  try {
    await api(`/groups/${detail.group.id}/guarantees`, { method: 'POST', body: { membershipId, guarantorId } });
    closeSheet();
    toast('Guarantor recorded.', 'lime');
    await viewMembers();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitDispute(form) {
  const detail = state.group;
  if (!detail) return;
  const button = form.querySelector('[type="submit"]');
  const reason = String(form.reason.value || '').trim();
  if (reason.length < 8) { formError(form, 'Describe the issue in a little more detail.'); return; }
  setBusy(button, true, 'Sending');
  try {
    await api(`/groups/${detail.group.id}/disputes`, {
      method: 'POST',
      body: { reason, againstMembershipId: form.dataset.id || undefined, cycleId: detail.cycle?.id },
    });
    closeSheet();
    toast('Issue sent to the organizer.', 'lime');
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitVerify(form) {
  const detail = state.group;
  if (!detail) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Verifying');
  try {
    await api(`/groups/${detail.group.id}/members/${form.dataset.id}/verify`, { method: 'POST', body: {} });
    closeSheet();
    toast('Member verified. Payouts can settle.', 'lime');
    await viewMembers();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitSettle(form) {
  const detail = state.group;
  if (!detail?.cycle) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Settling');
  try {
    await api(`/groups/${detail.group.id}/cycles/${detail.cycle.id}/close`, { method: 'POST', body: {} });
    closeSheet();
    state.wheelAnimatedCycleId = null;
    toast('Turn settled. Every figure is in the ledger.', 'lime');
    await viewAuction();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitStart(form) {
  const detail = state.group;
  if (!detail) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Starting');
  try {
    await api(`/groups/${detail.group.id}/start`, { method: 'POST', body: {} });
    closeSheet();
    toast(`Round ${detail.round?.number || 1} is open. Turn one pays the moment its pot is funded.`, 'lime');
    navigate('/g');
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitAcceptRound(form) {
  const detail = state.group;
  if (!detail?.round) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Accepting');
  try {
    await api(`/groups/${detail.group.id}/round/accept`, { method: 'POST', body: { roundNumber: detail.round.number } });
    closeSheet();
    toast(`You accepted round ${detail.round.number}.`, 'lime');
    await refreshRoute();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitProposeRound(form) {
  const detail = state.group;
  if (!detail?.round?.previousCircleId) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Proposing');
  try {
    await api(`/groups/${detail.group.id}/rounds`, { method: 'POST', body: { previousCircleId: detail.round.previousCircleId } });
    closeSheet();
    toast('New round proposed. Every member now accepts before contributions restart.', 'lime');
    navigate('/g');
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitNext(form) {
  const detail = state.group;
  if (!detail) return;
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Opening');
  try {
    await api(`/groups/${detail.group.id}/cycles`, { method: 'POST', body: {} });
    closeSheet();
    toast('The next turn is open. It settles on its scheduled date once every member funds it.', 'lime');
    navigate('/g');
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitAddPasskey(form) {
  const button = form.querySelector('[type="submit"]');
  formError(form, '');
  if (!globalThis.__wheelCaps?.webauthn) { formError(form, 'This browser cannot create a passkey.'); return; }
  const label = String(form.label.value || '').trim() || deviceLabel();
  setBusy(button, true);
  try {
    const options = await api('/auth/passkeys/options', { method: 'POST', body: { label } });
    const publicKey = {
      ...options.publicKey,
      challenge: b64uDecode(options.publicKey.challenge),
      user: { ...options.publicKey.user, id: b64uDecode(options.publicKey.user.id) },
      excludeCredentials: (options.publicKey.excludeCredentials || []).map((item) => ({ ...item, id: b64uDecode(item.id) })),
    };
    let credential;
    try { credential = await navigator.credentials.create({ publicKey }); }
    catch (error) {
      if (error?.name === 'NotAllowedError') throw new Error('The passkey prompt was closed.');
      throw error;
    }
    if (!credential) throw new Error('The passkey was not created.');
    const response = credential.response;
    await api('/auth/passkeys/verify', {
      method: 'POST',
      body: {
        challengeId: options.challengeId,
        credential: {
          id: credential.id,
          rawId: b64uEncode(credential.rawId),
          type: credential.type,
          response: {
            clientDataJSON: b64uEncode(response.clientDataJSON),
            attestationObject: b64uEncode(response.attestationObject),
            transports: response.getTransports?.() || [],
          },
          clientExtensionResults: credential.getClientExtensionResults?.() || {},
        },
      },
    });
    closeSheet();
    toast('Passkey added.', 'lime');
    await viewSettings();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

async function submitRegenRecovery(form) {
  const button = form.querySelector('[type="submit"]');
  setBusy(button, true, 'Generating');
  try {
    const data = await api('/auth/recovery/regenerate', { method: 'POST', body: {} });
    closeSheet();
    state.recoveryCodes = data.codes || [];
    showRecoveryCodes(data.codes || []);
    await viewSettings();
  } catch (error) {
    setBusy(button, false);
    formError(form, error.message);
  }
}

/* ---------------- init ---------------- */

const FORM_HANDLERS = {
  'auth-register': registerPasskey,
  'auth-recover': recoverAccount,
  identity: submitIdentity,
  'admin-reject': submitRejectIdentity,
  'admin-unlock': submitAdminUnlock,
  'jarvis-ask': submitJarvis,
  seat: submitSeat,
  'create-group': submitCreateGroup,
  'join-group': submitJoinGroup,
  withdraw: submitWithdraw,
  cover: submitCover,
  guarantee: submitGuarantee,
  dispute: submitDispute,
  swap: submitSwapOffer,
  verify: submitVerify,
  settle: submitSettle,
  start: submitStart,
  'accept-round': submitAcceptRound,
  'propose-round': submitProposeRound,
  next: submitNext,
  'add-passkey': submitAddPasskey,
  'regen-recovery': submitRegenRecovery,
};

function handleForm(form) {
  const handler = FORM_HANDLERS[form.dataset.form];
  return handler ? handler(form) : undefined;
}

function bindGlobalEvents() {
  // A single cast-metal click under every real control. Engine controls carry
  // their own mechanical score, and the sound rocker announces itself.
  document.addEventListener('click', (event) => {
    const control = event.target.closest?.('button, .chip, .rail__nav a, .tabbar a');
    if (!control || control.disabled) return;
    if (control.dataset.silent !== undefined) return;
    if (control.dataset.action === 'toggle-sound') return;
    if (control.closest('.wheel-engine')) return;
    soundAt(control.dataset.action ? 'click' : 'tick', control);
  }, true);

  document.addEventListener('input', (event) => {
    const field = event.target.closest?.('#authBody .input, #authBody input');
    if (!field) return;
    if (field.type === 'date' || field.type === 'checkbox') return;
    soundAt('key', field, { pitch: String(field.value || '').length % 7, gain: 0.5 });
  });

  document.addEventListener('click', (event) => {
    const actionEl = event.target.closest('[data-action]');
    if (!actionEl || actionEl.disabled) return;
    const action = actionEl.dataset.action;
    if (!action) return;
    // Button default inside forms can submit unexpectedly; every action button is explicitly type=button.
    event.preventDefault();
    void handleAction(action, actionEl);
  });

  document.addEventListener('pointerover', (event) => {
    const seat = event.target.closest?.('.seatwheel .seat');
    if (seat) seatHover(seat);
  });

  document.addEventListener('focusin', (event) => {
    const seat = event.target.closest?.('.seatwheel .seat');
    if (seat) seatHover(seat);
  });

  document.addEventListener('click', (event) => {
    const seat = event.target.closest?.('.seatwheel .seat');
    if (seat) seatHover(seat);
  });

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (!form.dataset.form) return;
    event.preventDefault();
    void handleForm(form);
  });

  document.addEventListener('input', (event) => {
    const input = event.target.closest?.('[data-code-input]');
    if (!input) return;
    const hint = input.form?.querySelector('[data-code-hint]');
    if (!hint) return;
    const code = String(input.value || '').trim().toUpperCase();
    if (!code) {
      hint.className = 'oc-codecheck';
      hint.textContent = 'Enter the code from your organizer';
    } else if (code.length < 6) {
      hint.className = 'oc-codecheck is-short';
      hint.innerHTML = `${icon('clock')} ${6 - code.length} more character${6 - code.length === 1 ? '' : 's'}`;
    } else {
      hint.className = 'oc-codecheck is-ready';
      hint.innerHTML = `${icon('check')} Format looks right — take your seat`;
    }
  });

  dom.authDialog?.addEventListener('click', (event) => {
    if (event.target === dom.authDialog) hideDialog(dom.authDialog);
  });
  dom.authDialog?.addEventListener('close', () => {
    if (!state.me && !dom.authDialog.open && needsAuth(routeFromHash() || '/')) navigate('/', { replace: true });
  });
  dom.sheet?.addEventListener('click', (event) => {
    if (event.target === dom.sheet) closeSheet();
  });
  dom.sheet?.addEventListener('close', () => {
    // A replaced sheet fires its close event after the next sheet is already open.
    if (dom.sheet.open) return;
    const callback = state.sheetOnClose;
    state.sheetOnClose = null;
    state.sheetOnMount = null;
    if (callback) callback();
  });

  window.addEventListener('hashchange', () => {
    renderRoute();
  });
  window.addEventListener('online', () => { state.online = true; toast('Back online.', 'lime'); });
  window.addEventListener('offline', () => { state.online = false; toast('You are offline. Actions will need a connection.', 'error'); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const view = groupRoute(state.route)?.view;
    if (view === 'turn' || view === 'auction') startAuctionPoll();
    else if (state.route === '/app' || !view) {
      if (state.group?.group?.status === 'forming') startFormingPoll();
      else if (state.route !== '/app' && state.group?.cycle) startCircleLivePoll();
    }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.closest?.('.seatwheel .seat')) {
      event.preventDefault();
      seatHover(event.target.closest('.seatwheel .seat'));
    }
    if (event.key === 'Escape' && dom.sheet?.open) closeSheet();
  });
}

/* The operator latch: press and hold for 900ms. The arc fills while the
   handle is held; releasing early lets the spring pull it back. */
function initAdminLatch() {
  const HOLD_MS = 900;
  let timer = null;
  let raf = 0;
  let active = null;

  const release = () => {
    if (!active) return;
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    active.classList.remove('is-holding');
    active.style.removeProperty('--hold');
    active.dataset.holding = '';
    active = null;
  };

  const fill = (latch, start) => {
    const ratio = Math.min(1, (performance.now() - start) / HOLD_MS);
    latch.style.setProperty('--hold', ratio.toFixed(3));
    if (ratio < 1 && active === latch) raf = requestAnimationFrame(() => fill(latch, start));
  };

  const begin = (latch) => {
    if (active || latch.dataset.holding === '1') return;
    if (!state.me?.isAdmin) return;
    latch.dataset.holding = '1';
    active = latch;
    latch.classList.add('is-holding');
    soundAt('servo', latch, { dur: HOLD_MS / 1000, gain: 0.55 });
    const start = performance.now();
    fill(latch, start);
    timer = setTimeout(() => {
      const released = latch;
      release();
      if (!state.me?.isAdmin) return;
      state.adminLatchOpen = true;
      soundAt('open', released);
      navigate('/admin');
    }, HOLD_MS);
  };

  document.addEventListener('pointerdown', (event) => {
    const latch = event.target.closest?.('[data-latch]');
    if (!latch) return;
    event.preventDefault();
    begin(latch);
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => {
    document.addEventListener(type, (event) => {
      if (event.target.closest?.('[data-latch]')) release();
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const latch = event.target.closest?.('[data-latch]');
    if (!latch) return;
    event.preventDefault();
    begin(latch);
  });
  document.addEventListener('keyup', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest?.('[data-latch]')) release();
  });
}

function initLobbyScene() {
  const stage = document.getElementById('lobbyStage');
  if (!stage || state.reducedMotion) return;
  if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
  stage.addEventListener('pointermove', (event) => {
    const rect = stage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    stage.style.setProperty('--tilt-y', `${(x * 7).toFixed(2)}deg`);
    stage.style.setProperty('--tilt-x', `${(-y * 5).toFixed(2)}deg`);
  });
  stage.addEventListener('pointerleave', () => {
    stage.style.setProperty('--tilt-y', '0deg');
    stage.style.setProperty('--tilt-x', '0deg');
  });
}

function initLobbyGuide() {
  const root = document.getElementById('lobbyGuide');
  if (!root) return;
  const guide = { seats: 6, contribution: 2000 * MINOR, bidBps: 850, step: 0 };
  const $ = (id) => document.getElementById(id);
  const pctLabel = (bps) => `${Number((bps / 100).toFixed(2))}%`;
  const stage = document.getElementById('lobbyStage');
  const orbit = $('lobbyOrbit');

  const renderOrbit = () => {
    if (!orbit) return;
    if (Number(orbit.dataset.count) !== guide.seats) {
      orbit.dataset.count = String(guide.seats);
      const step = 360 / guide.seats;
      orbit.innerHTML = Array.from({ length: guide.seats }, (_, index) => `<span class="wheel-orbit__seat" style="--a:${(index * step).toFixed(2)}deg" data-label="${index + 1}"></span>`).join('');
    }
    // A bolder bid spins the seats faster; the wheel reads as pressure, not decoration.
    orbit.style.setProperty('--orbit-dur', `${(54 - (guide.bidBps / 100 - 1) * 1.1).toFixed(1)}s`);
  };

  const flash = () => {
    ['floatBid', 'floatShare', 'floatPot', 'hubPot'].forEach((id) => {
      const node = $(id);
      if (!node) return;
      node.classList.remove('is-bumped');
      void node.offsetWidth;
      node.classList.add('is-bumped');
    });
  };

  const render = (animate = false) => {
    // Mirrors settlementMath in functions/lib/rules.mjs so the preview never drifts from settlement.
    const pot = guide.seats * guide.contribution;
    const waiters = Math.max(0, guide.seats - 1);
    const discount = Math.floor((pot * guide.bidBps) / 10000);
    const share = waiters > 0 ? Math.floor(discount / waiters) : 0;
    const remainder = waiters > 0 ? discount - share * waiters : 0;
    const platform = Math.floor(pot / 100);
    const organizer = Math.floor(pot / 100);
    const fund = Math.floor(pot / 100);
    const bond = Math.round(pot * 0.2);
    const fees = platform + organizer + fund;
    const net = Math.max(0, pot - discount - fees - bond);
    const takeNow = pot - discount - fees;
    const bid = pctLabel(guide.bidBps);

    const set = (id, text) => { const node = $(id); if (node) node.textContent = text; };
    set('guideSeats', String(guide.seats));
    set('guidePot', money(pot));
    set('guidePotMeta', `${guide.seats} seats × ${money(guide.contribution)} each`);
    set('guideBidOut', bid);
    const slider = $('guideBid');
    if (slider && Number(slider.value) !== guide.bidBps / 100) slider.value = String(guide.bidBps / 100);
    set('guideTakeNow', money(takeNow));
    set('guideTakeNowMeta', 'pot minus your discount and fees, before the bond');
    set('guideShare', money(share));
    set('guideShareMeta', `your discount split across ${waiters} waiting seat${waiters === 1 ? '' : 's'}`);
    set('rcSeats', String(guide.seats));
    set('rcPot', money(pot));
    set('rcBid', bid);
    set('rcDiscount', `− ${money(discount)}`);
    set('rcWaiters', String(waiters));
    set('rcShare', `+ ${money(share)} each`);
    set('rcPlatform', `− ${money(platform)}`);
    set('rcOrganizer', `− ${money(organizer)}`);
    set('rcFund', `− ${money(fund)}`);
    set('rcBond', `− ${money(bond)}`);
    set('rcNet', money(net));
    set('rcFoot', remainder > 0
      ? `The bond returns as the winner pays their remaining turns. ${money(remainder)} of rounding goes to the guarantee fund. Patience shares are spendable immediately.`
      : 'The bond returns as the winner pays their remaining turns. Patience shares are spendable immediately.');
    set('wfHead', `${guide.seats} SEATS · ONE TURN`);
    set('wfPot', money(pot));
    set('wfBid', bid);
    set('wfDiscount', `− ${money(discount)}`);
    set('wfWaiters', String(waiters));
    set('wfShare', `+ ${money(share)} each`);
    set('wfPlatform', `− ${money(platform)}`);
    set('wfOrganizer', `− ${money(organizer)}`);
    set('wfFund', `− ${money(fund)}`);
    set('wfBond', `− ${money(bond)}`);
    set('wfNet', money(net));
    set('hubPot', money(pot));
    set('hubMeta', `${guide.seats} members · every turn`);
    set('floatBid', bid);
    set('floatShare', `+${money(Math.floor(share / 100) * 100)}`);
    set('floatPot', money(pot));
    const bar = $('floatBidBar');
    if (bar) bar.style.setProperty('--w', `${Math.max(0, Math.min(100, ((guide.bidBps - 100) / 2400) * 100)).toFixed(1)}%`);
    if (stage) stage.style.setProperty('--pot-p', (Math.max(0, Math.min(1, (pot - 100000) / 5900000))).toFixed(3));
    renderOrbit();
    if (animate) flash();
    root.querySelectorAll('[data-contrib]').forEach((chip) => {
      chip.classList.toggle('is-on', Number(chip.dataset.contrib) * MINOR === guide.contribution);
    });
  };

  const showStep = (step) => {
    guide.step = Math.max(0, Math.min(2, step));
    root.querySelectorAll('[data-guide-panel]').forEach((panel) => {
      const on = Number(panel.dataset.guidePanel) === guide.step;
      panel.hidden = !on;
      panel.classList.toggle('is-on', on);
    });
    root.querySelectorAll('[data-guide-step]').forEach((tab) => {
      const on = Number(tab.dataset.guideStep) === guide.step;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', String(on));
    });
    root.querySelectorAll('.guide__dots i').forEach((dot, index) => dot.classList.toggle('is-on', index === guide.step));
    const back = root.querySelector('[data-guide-dir="-1"]');
    const next = root.querySelector('[data-guide-dir="1"]');
    if (back) back.hidden = guide.step === 0;
    if (next) {
      next.hidden = guide.step === 2;
      next.innerHTML = `${guide.step === 1 ? 'Next: settlement' : 'Next: the auction'} ${icon('arrow')}`;
    }
  };

  root.addEventListener('click', (event) => {
    const seatButton = event.target.closest('[data-guide-seats]');
    if (seatButton) {
      guide.seats = Math.max(5, Math.min(12, guide.seats + Number(seatButton.dataset.guideSeats)));
      render(true);
      return;
    }
    const chip = event.target.closest('[data-contrib]');
    if (chip) {
      guide.contribution = Number(chip.dataset.contrib) * MINOR;
      render(true);
      return;
    }
    const tab = event.target.closest('[data-guide-step]');
    if (tab) { showStep(Number(tab.dataset.guideStep)); return; }
    const dir = event.target.closest('[data-guide-dir]');
    if (dir) { showStep(guide.step + Number(dir.dataset.guideDir)); }
  });

  root.addEventListener('input', (event) => {
    if (event.target.id !== 'guideBid') return;
    guide.bidBps = Math.round(Number(event.target.value) * 100);
    render(true);
  });

  render();
  showStep(0);
}

function cacheDom() {
  Object.assign(dom, {
    boot: document.getElementById('boot'),
    lobbyView: document.getElementById('lobbyView'),
    appView: document.getElementById('appView'),
    workspace: document.getElementById('workspace'),
    railName: document.getElementById('railName'),
    railAvatar: document.getElementById('railAvatar'),
    mobileAvatar: document.getElementById('mobileAvatar'),
    mobileWallet: document.getElementById('mobileWallet'),
    railGroup: document.getElementById('railGroup'),
    navLive: document.getElementById('navLive'),
    navOpen: document.getElementById('navOpen'),
    authDialog: document.getElementById('authDialog'),
    authBody: document.getElementById('authBody'),
    authAsideTitle: document.getElementById('authAsideTitle'),
    authAsideCopy: document.getElementById('authAsideCopy'),
    sheet: document.getElementById('sheet'),
    sheetKicker: document.getElementById('sheetKicker'),
    sheetTitle: document.getElementById('sheetTitle'),
    sheetBody: document.getElementById('sheetBody'),
    sheetFoot: document.getElementById('sheetFoot'),
    toast: document.getElementById('toast'),
  });
}

/* ---------------- NURU: on call only when invoked ---------------- */

const jarvisState = { recognition: null, listening: false, greeted: false };

const NURU_HELP = 'I can check your balance, the open turn and its seat price, your invite code, your standing, seat swaps, the fees on a pot, your result when a round closes, or your ID review. I can also open the payment, withdraw, invite, join, swap and review-desk screens. Money never moves until you confirm it.';

function jarvisNodes() {
  return {
    root: document.getElementById('jarvisRoot'),
    panel: document.getElementById('jarvisPanel'),
    log: document.getElementById('jarvisLog'),
    hint: document.getElementById('jarvisHint'),
    input: document.querySelector('#jarvisPanel input[name="ask"]'),
    orb: document.getElementById('jarvisOrb'),
    mic: document.getElementById('jarvisMic'),
  };
}

function jarvisLine(role, text) {
  const { log } = jarvisNodes();
  if (!log) return;
  const bubble = document.createElement('div');
  bubble.className = `jarvis__msg jarvis__msg--${role}`;
  bubble.textContent = text;
  log.append(bubble);
  log.scrollTop = log.scrollHeight;
}

function jarvisReply(text, { speak = true } = {}) {
  jarvisLine('bot', text);
  soundAt('chime', document.getElementById('jarvisOrb'), { gain: 0.7 });
  if (!speak) return;
  try { speakEngineText(text, () => {}); } catch { /* voice is optional */ }
}

function setJarvisListening(listening) {
  jarvisState.listening = listening;
  const { root, mic, hint } = jarvisNodes();
  root?.classList.toggle('is-listening', listening);
  if (listening) soundAt('listen', root?.querySelector('.jarvis__orb'));
  mic?.setAttribute('aria-pressed', listening ? 'true' : 'false');
  if (hint) {
    hint.textContent = listening
      ? 'Listening… tap the mic again to stop.'
      : 'I listen only while the mic is open. Money always waits for your confirmation.';
  }
}

function openJarvis() {
  if (!state.me) { openAuth('start'); return; }
  const { root, panel, orb, input } = jarvisNodes();
  if (!panel) return;
  document.body.classList.add('jarvis-open');
  panel.hidden = false;
  orb?.setAttribute('aria-expanded', 'true');
  soundAt('consult', orb);
  if (!jarvisState.greeted) {
    jarvisState.greeted = true;
    jarvisLine('bot', `On call, ${String(state.me.name || '').split(' ')[0] || 'there'}. Ask for your balance, the next turn, your invite code, or say “pay my contribution”.`);
  }
  input?.focus({ preventScroll: true });
}

function closeJarvis() {
  const { root, panel, orb } = jarvisNodes();
  stopJarvisRecognition();
  stopEngineVoice();
  document.body.classList.remove('jarvis-open');
  soundAt('servo', orb, { dir: -1, dur: 0.22, gain: 0.6 });
  if (panel) panel.hidden = true;
  orb?.setAttribute('aria-expanded', 'false');
  root?.classList.remove('is-listening');
}

function stopJarvisRecognition() {
  if (jarvisState.recognition) {
    try { jarvisState.recognition.abort(); } catch { /* already stopped */ }
    jarvisState.recognition = null;
  }
  setJarvisListening(false);
}

function startJarvisListening() {
  if (!state.me) { openAuth('start'); return; }
  openJarvis();
  if (jarvisState.listening) { stopJarvisRecognition(); return; }
  const Ctor = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Ctor) {
    jarvisReply('Voice input is not available in this browser. Type the request instead.', { speak: false });
    return;
  }
  const recognition = new Ctor();
  recognition.lang = 'en-KE';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  jarvisState.recognition = recognition;
  setJarvisListening(true);
  recognition.onresult = (event) => {
    let interim = '';
    let final = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0].transcript;
      if (event.results[index].isFinal) final += transcript;
      else interim += transcript;
    }
    const { input } = jarvisNodes();
    if (interim && input) input.value = interim;
    if (final) {
      if (input) input.value = '';
      void jarvisAsk(final);
    }
  };
  recognition.onerror = (event) => {
    setJarvisListening(false);
    jarvisState.recognition = null;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      jarvisReply('The microphone is blocked. Type the request instead.', { speak: false });
    } else if (event.error === 'no-speech') {
      jarvisReply('I did not catch that. Tap the mic again, or type it.', { speak: false });
    }
  };
  recognition.onend = () => {
    jarvisState.recognition = null;
    setJarvisListening(false);
  };
  try { recognition.start(); } catch {
    jarvisState.recognition = null;
    setJarvisListening(false);
    jarvisReply('The mic could not start. Type the request instead.', { speak: false });
  }
}

function submitJarvis(form) {
  const text = String(form.ask.value || '').trim();
  form.ask.value = '';
  if (text) void jarvisAsk(text);
}

async function jarvisDetail() {
  if (state.group?.group) return state.group;
  if (!ensureActiveGroup()) return null;
  try {
    const detail = await api(`/groups/${state.activeGroupId}`, { timeout: 8000 });
    state.group = detail;
    if (detail.wallet) state.wallet = detail.wallet;
    return detail;
  } catch { return null; }
}

async function jarvisAsk(raw) {
  const text = String(raw || '').trim().slice(0, 200);
  if (!text) return;
  jarvisLine('user', text);
  try {
    await jarvisRespond(text);
  } catch (error) {
    jarvisReply(`That one failed: ${error.message || 'the service did not answer'}.`, { speak: false });
  }
}

async function jarvisRespond(text) {
  const said = text.toLowerCase();
  const wallet = state.wallet || {};

  if (/^(hi|hey|hello|yo|jarvis)\b/.test(said) && said.split(/\s+/).length <= 3) {
    jarvisReply('On call. What do you need?');
    return;
  }
  if (/(stop|close|goodbye|bye|thank you|thanks|that.s all)/.test(said) && said.split(/\s+/).length <= 4) {
    jarvisReply('Standing by. Call me when you need me.');
    setTimeout(closeJarvis, 900);
    return;
  }
  if (/(what time|what date|today.s date|current time|time is it)/.test(said)) {
    jarvisReply(`It is ${fmtDateTime(new Date())} EAT.`);
    return;
  }
  if (/(how are you|how.s it going|who are you|your name|are you (an? )?(ai|robot|bot|human))/.test(said)) {
    jarvisReply('NURU, on call. I read the circle record and answer from it — I never move money without your confirmation. Say “nuru” to wake me.');
    return;
  }
  if (/(help|what can you do|commands|options)/.test(said)) {
    jarvisReply(NURU_HELP, { speak: false });
    return;
  }
  if (/(fees?|charges?|percent|commission|what do you take|how much does the wheel take)/.test(said)) {
    const detail = await jarvisDetail();
    const rules = detail?.rules || {};
    const platform = Number(rules.platformBps ?? 100) / 100;
    const fund = Number(rules.fundBps ?? 100) / 100;
    const organizerBps = Number(detail?.group?.organizerFeeBps ?? 100);
    const organizer = organizerBps / 100;
    const contribution = Number(detail?.group?.contributionMinor || 0);
    const seats = Number(detail?.group?.maxMembers || 0);
    const pot = contribution * seats;
    const perPot = pot ? Math.round((pot * (platform + fund + organizer)) / 100) : 0;
    jarvisReply(`Fees come out of each pot, never on top of it. Per pot: platform ${platform}% to run the service and cover the M-PESA provider cost, guarantee fund ${fund}% held for cover, and organizer ${organizer}% (waived into the fund when the organizer wins).${pot ? ` On a ${money(pot)} pot that is about ${money(perPot)} in total.` : ''} The seat price is not a fee — it is an early-payout discount paid to the seats that wait. Payout fees stay closed until the provider confirms the exact cost, so no hidden charge can eat your balance.`);
    return;
  }
  if (/(my result|how did i do|did i (gain|benefit|profit)|what did i (gain|earn)|my (net|gain|profit)|benefit after|worth it)/.test(said)) {
    const detail = await jarvisDetail();
    const recap = detail?.recap;
    const mine = recap?.members?.find((member) => member.id === recap.me?.id);
    if (mine) {
      const net = Number(mine.netMinor) || 0;
      jarvisReply(`Round ${recap.circleNumber}: you paid in ${money(mine.paidMinor)}${Number(mine.lateFeesMinor) ? ` (including ${money(mine.lateFeesMinor)} late)` : ''}, took ${mine.receivedTurn ? `${money(mine.receivedMinor)} on turn ${mine.receivedTurn}` : 'no pot'}, earned ${money(mine.discountsMinor)} in patience shares, and got ${money(mine.bondReturnedMinor)} of bond back${Number(mine.fundSplitMinor) ? ` plus ${money(mine.fundSplitMinor)} fund split` : ''}. That is ${net >= 0 ? 'a net gain of' : 'a net cost of'} ${money(Math.abs(net))}. The celebration card shows every seat beside you.`);
      return;
    }
    const group = detail?.group;
    const contribution = Number(group?.contributionMinor || 0);
    const seats = Number(group?.maxMembers || 0);
    if (contribution && seats) {
      jarvisReply(`Over a full round each seat pays ${seats} × ${money(contribution)} in and takes one pot. The pot carries about 2.5–3.5% in fees, and an early pot carries a seat price that goes to the seats still waiting. So the wheel is not a profit scheme: waiting longer earns you shares, and taking the pot early buys you time. Your exact net appears here the moment the round closes.`);
      return;
    }
    jarvisReply('When a round closes I will read your exact net straight off the ledger — paid in, pot taken, patience shares, bond back and fees. No estimates.');
    return;
  }
  if (/(what happens (at the end|after|when)|end of (the )?round|when (the )?(circle|round) (ends|finishes|closes)|after the (circle|round)|celebration)/.test(said)) {
    jarvisReply('The last pot settles at 0% with no bond. Then the round closes: a celebration card shows every seat\'s pot, patience shares, bond back and net, and the ledger freezes as the record. The organizer can start the next round, but every member re-accepts fresh terms first. Nothing starts automatically.');
    return;
  }
  if (/(step by step|guide me|walk me|how does (this|the wheel) work|how do i start|first steps|where do i begin)/.test(said)) {
    jarvisReply('Three steps. One: create a circle or take an open seat. Two: fund turn one — your seat payment becomes your first contribution. Three: open the wheel; each turn funds the pot and one seat gets paid. After that it is just your turn, on time, until your seat takes the pot.');
    return;
  }
  if (/(review desk|admin|approve|id queue)/.test(said)) {
    if (!state.me?.isAdmin) { jarvisReply('The review desk is for ID reviewers only.'); return; }
    jarvisReply('Opening the review desk.');
    navigate('/admin');
    closeJarvis();
    return;
  }
  if (/(my id|identity|kyc|verify|id check)/.test(said)) {
    const status = state.me?.identityStatus || 'unverified';
    if (status === 'verified') {
      jarvisReply(`Your ID is verified, ending ${state.me.identityLast4}. Open seats and payouts are unlocked.`);
    } else if (status === 'pending') {
      jarvisReply(`Your typed ID is with the review desk, ending ${state.me.identityLast4 || '—'}. It unlocks open seats when approved.`);
      openIdentitySheet();
    } else if (status === 'rejected') {
      jarvisReply(`Your ID came back: ${state.me.identityNote || 'the details need correcting'}. I opened the form so you can resend it.`);
      openIdentitySheet();
    } else {
      jarvisReply('No ID is on this account yet. Type the number, the name on it and this phone once — no photo. Opening the form.');
      openIdentitySheet();
    }
    return;
  }
  if (/(invite|share|code)/.test(said)) {
    const detail = await jarvisDetail();
    const code = detail?.group?.inviteCode;
    if (!code) { jarvisReply('You have no circle yet. Create one and I will hand you the invite code.'); return; }
    jarvisReply(`Your invite code is ${code}. I opened the invite card so you can share it.`);
    openInviteSheet();
    return;
  }
  if (/(swap|trade seats?|trade my seat|switch seats?)/.test(said)) {
    if (!ensureActiveGroup()) { jarvisReply('No circle yet, so there are no seats to swap.'); return; }
    const detail = await jarvisDetail();
    if (!detail?.swaps?.open) {
      jarvisReply(detail?.swaps?.reason || 'Seat swaps are closed while the round runs.');
      return;
    }
    const incoming = detail.swaps.incoming || [];
    if (incoming.length) {
      const offer = incoming[0];
      jarvisReply(`${offer.fromName} offered a seat swap: seat ${offer.fromSeat} for your seat ${offer.toSeat}. Opening the member table so you can accept or decline.`);
    } else {
      jarvisReply(`You hold seat ${detail.me?.seat ?? '—'}. Open the member table and tap Swap on a member. They get the offer, and both of you must agree before seats move.`);
    }
    navigate('/g/members');
    closeJarvis();
    return;
  }
  if (/(balance|wallet|available|how much do i have|money do i have)/.test(said)) {
    jarvisReply(`You have ${money(wallet.availableMinor || 0)} available and ${money(wallet.pendingMinor || 0)} on hold for bonds or first payouts.`);
    return;
  }
  if (/(pay|contribute|fund|my share|amount due|how much do i pay)/.test(said)) {
    const detail = await jarvisDetail();
    if (!detail?.cycle) { jarvisReply('There is no open turn to fund yet. Once the circle starts I will walk you to it.'); return; }
    const cycle = detail.cycle;
    if (cycle.myContribution?.status === 'paid') {
      jarvisReply(`Your share for turn ${cycle.number} is already in. Nothing is due from you right now.`);
      return;
    }
    jarvisReply(`Turn ${cycle.number}. Your share is ${money(cycle.amountDueMinor)}${cycle.lateFeeMinor ? ` including a ${money(cycle.lateFeeMinor)} late fee` : ''}. Opening the payment sheet — confirm it there and I will never move money on my own.`);
    openContributeSheet();
    return;
  }
  if (/(withdraw|cash out|send to m-?pesa)/.test(said)) {
    if (!state.config.withdrawalsConfigured) {
      jarvisReply(`Withdrawals are paused on purpose. The sandbox confirms collections, but it has not confirmed the exact M-PESA payout cost, its units, or how a failed payout is refunded. Until it does, ${money(wallet.availableMinor || 0)} stays safely recorded in your wallet and nothing is submitted.`);
      return;
    }
    if (!wallet.availableMinor) { jarvisReply('Nothing is available to withdraw yet. Bonds and the first-payout hold still need to clear.'); return; }
    jarvisReply(`You can withdraw ${money(wallet.availableMinor)}. Opening the M-PESA sheet — confirm it there.`);
    openWithdrawSheet();
    return;
  }
  if (/(next turn|who gets|who wins|pot|payout|seat price|which turn)/.test(said)) {
    const detail = await jarvisDetail();
    if (!detail?.cycle) {
      jarvisReply(detail?.group ? `No turn is open. The circle is ${detail.group.status}.` : 'You are not in a circle yet. Join an open one and I can track the turn for you.');
      return;
    }
    const cycle = detail.cycle;
    const owner = cycle.turnOwner?.name || 'the next member';
    const seat = cycle.turnOwner?.seatNo || cycle.number;
    jarvisReply(`Turn ${cycle.number} is seat ${seat}: ${owner} takes the pot at the posted ${(cycle.ladderMinor?.[seat - 1] ?? 0) / 100}% seat price, about ${money(cycle.payoutNow || 0)} net. ${cycle.paidCount} of ${cycle.memberCount} members have funded; the pot is ${money(cycle.potCapturedMinor)} of ${money(cycle.potExpectedMinor)} and settles the moment it is whole.`);
    return;
  }
  if (/(standing|trust|bond|score)/.test(said)) {
    const detail = await jarvisDetail();
    const trust = detail?.me?.trustScore ?? state.me?.trustScore ?? 50;
    const bond = detail?.me?.bondBps;
    jarvisReply(`Your trust score is ${trust} out of 99${bond ? `, so your bond band is ${bond / 100}% of the pot` : ''}. It rises when you fund every turn before the due time.`);
    return;
  }
  if (/(members|who is in|who's in|roster)/.test(said)) {
    if (!ensureActiveGroup()) { jarvisReply('No circle yet. Open circles are one tap away; say “find an open circle”.'); return; }
    jarvisReply('Opening the member table.');
    navigate('/g/members');
    closeJarvis();
    return;
  }
  if (/(ledger|history|transactions|receipts)/.test(said)) {
    if (!ensureActiveGroup()) { jarvisReply('No circle yet, so there is no ledger to show.'); return; }
    jarvisReply('Opening the ledger. Every seat, contribution and payout is one entry.');
    navigate('/g/ledger');
    closeJarvis();
    return;
  }
  if (/(payout page|wheel|auction|turn page|pot page)/.test(said)) {
    if (!ensureActiveGroup()) { jarvisReply('No circle yet. Find an open seat first.'); return; }
    jarvisReply('Opening the payout page.');
    navigate('/g/auction');
    closeJarvis();
    return;
  }
  if (/(open circle|find a circle|find a seat|discover)/.test(said)) {
    jarvisReply('Opening open circles. Seats show their posted price before you pledge.');
    navigate('/open');
    closeJarvis();
    return;
  }
  if (/(create|new circle|start a circle)/.test(said)) {
    jarvisReply('Opening a new circle. Name it, set the contribution, and I will hold the invite code.');
    openCreateSheet();
    return;
  }
  if (/(start the circle|start the turn|begin)/.test(said)) {
    const detail = await jarvisDetail();
    if (!detail) { jarvisReply('No circle yet. Create one first.'); return; }
    if (detail.me?.role !== 'organizer') { jarvisReply('Only the organizer can start the turn. Ask them to open it.'); return; }
    if (detail.group?.status !== 'forming') { jarvisReply(`The circle is already ${detail.group.status}. No start is needed.`); return; }
    jarvisReply('Opening the start card. It only fires once every seat is funded and every member accepts the turn.');
    openStartSheet();
    return;
  }
  if (/join/.test(said)) {
    const code = (text.match(/\b([A-Za-z2-9]{5,10})\b/g) || [])
      .map((token) => token.toUpperCase())
      .find((token) => !['JOIN', 'CIRCLE', 'PLEASE', 'WHEEL', 'WITH'].includes(token));
    jarvisReply(code ? `Opening the join sheet with ${code}.` : 'Opening the join sheet. Type the invite code there.');
    openJoinSheet(code || '');
    return;
  }
  jarvisReply(`I did not catch a request in that. ${NURU_HELP}`, { speak: false });
}

function initJarvis() {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('jarvis-open')) closeJarvis();
  });
}

export function start() {
  boot();
}

async function initializeAccount() {
  if (accountLoading) return;
  accountLoading = true;
  try {
    if (await routeToDevService()) return;
    try {
      state.activeGroupId = localStorage.getItem('wheel.activeGroup') || null;
      state.pendingJoin = sessionStorage.getItem('wheel.pendingJoin') || null;
    } catch { /* Private browsing may disable storage. */ }
    await Promise.allSettled([loadConfig(), loadMe()]);
  } finally {
    accountReady = true;
    accountLoading = false;
    renderRoute();
    document.body.classList.add('is-ready');
  }
}

function boot() {
  cacheDom();
  ensureRouteProgress();
  bindGlobalEvents();
  initJarvis();
  initAdminLatch();
  initLobbyScene();
  initLobbyGuide();
  initInstall();
  renderRoute();
  if (isPracticeRoute(routeFromHash())) document.body.classList.add('is-ready');
}

function initInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installEvent = event;
    if (state.route === '/settings') void viewSettings({ silent: true });
  });
  window.addEventListener('appinstalled', () => {
    state.installEvent = null;
    toast('THE WHEEL is installed. Open it from your home screen.', 'lime');
  });
}

function installRow() {
  if (document.documentElement.dataset.display === 'standalone') return '';
  if (state.installEvent) {
    return `<div class="setting"><div class="setting__copy"><b>Install THE WHEEL</b><span>One tap adds the app to your home screen and opens it full screen.</span></div><button class="btn btn--lime btn--sm" type="button" data-action="install-app">Install</button></div>`;
  }
  const platform = document.documentElement.dataset.platform;
  if (platform === 'ios') {
    return `<div class="setting"><div class="setting__copy"><b>Install on iPhone</b><span>In Safari: Share, then Add to Home Screen. It opens full screen like an app.</span></div><span class="setting__v">Safari menu</span></div>`;
  }
  if (platform === 'android') {
    return `<div class="setting"><div class="setting__copy"><b>Install on Android</b><span>In Chrome: menu, then Install app. It opens full screen like an app.</span></div><span class="setting__v">Chrome menu</span></div>`;
  }
  return '';
}

async function installApp(button) {
  const event = state.installEvent;
  if (!event) return;
  state.installEvent = null;
  setBusy(button, true, 'Opening');
  try {
    await event.prompt();
    const choice = await event.userChoice.catch(() => null);
    if (choice?.outcome === 'accepted') toast('Installing THE WHEEL.', 'lime');
  } finally {
    setBusy(button, false);
  }
}
