// Consent + legal-page check. Runs against an isolated dev server (port 8097 by
// default) so the working demo ledger is never touched. Needs Chrome's CDP.
const base = process.env.CHECK_ORIGIN || `http://localhost:${process.env.CHECK_PORT || 8099}`;
const DEBUG = 'http://127.0.0.1:9333';

const target = await (await fetch(`${DEBUG}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
const failures = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    failures.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(expression, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(expression)) return; } catch { /* mid-render */ }
    await sleep(150);
  }
  let snapshot = 'unavailable';
  try {
    snapshot = await evaluate(`JSON.stringify({
      href: location.href,
      readyState: document.readyState,
      ready: document.body?.classList.contains('is-ready') || false,
      dialogs: Array.from(document.querySelectorAll('dialog')).map((d) => ({ id: d.id, open: d.open })),
    })`);
  } catch { /* page mid-navigation */ }
  throw new Error(`timeout waiting for: ${expression}\nsnapshot: ${snapshot}`);
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(new URL(`../dev/${name}.png`, import.meta.url), Buffer.from(data, 'base64'));
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('WebAuthn.enable', { enableUI: false });
await send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  },
});

await send('Page.navigate', { url: base });
await waitUntil('document.body.classList.contains("is-ready")');
await fetch(`${base}/dev/reset`, { method: 'POST' });
await send('Page.reload');
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate(`document.querySelector('[data-action="open-auth"][data-mode="register"]').click()`);
await waitUntil(`document.querySelector('#authDialog[open] form[data-form="auth-register"]') !== null`);

const form = `document.querySelector('#authDialog form[data-form="auth-register"]')`;
await evaluate(`(() => {
  const form = ${form};
  const set = (name, value) => {
    form.querySelector('input[name="' + name + '"]').value = value;
  };
  set('name', 'Consent Bot');
  set('phone', '0711222333');
  set('idNumber', '12345678');
  form.requestSubmit();
})()`);
await waitUntil(`document.querySelector('#authDialog [data-form-error]:not([hidden])') !== null`);
const gateError = await evaluate(`document.querySelector('#authDialog [data-form-error]').textContent.trim()`);
if (!/accept the terms/i.test(gateError)) throw new Error(`unexpected gate message: ${gateError}`);

const before = await (await fetch(`${base}/dev/state`)).json();
if ((before.users || []).length !== 0) throw new Error('an account was created before consent');

await shot('consent-gate-390');

const links = await evaluate(`Array.from(document.querySelectorAll('#authDialog form a[href$=".html"]')).map((a) => ({
  href: a.getAttribute('href'), resolved: a.href, target: a.target,
}))`);
if (links.length !== 2) throw new Error(`expected Terms and Privacy links, found ${links.length}`);

await evaluate(`(() => {
  const form = ${form};
  form.querySelector('input[name="terms"]').click();
  form.requestSubmit();
})()`);
await waitUntil(`document.querySelector('#sheet[open] .codegrid .code') !== null`, 25000);
const codes = await evaluate(`document.querySelectorAll('#sheet[open] .codegrid .code').length`);
if (codes !== 10) throw new Error(`expected 10 recovery codes, found ${codes}`);
await evaluate(`document.querySelector('#sheet [data-action="recovery-done"]').click()`);
await waitUntil('location.hash === "#/app" && !document.querySelector("#authDialog[open]")', 25000);

const after = await (await fetch(`${base}/dev/state`)).json();
const user = (after.users || [])[0];
if (!user) throw new Error('the consented account was not created');
const consent = {
  termsVersion: user.terms_version,
  acceptedAt: user.terms_accepted_at,
  acceptedOrigin: user.terms_accepted_origin,
  identityLast4: user.identity_last4,
  pendingRawIdHeld: (after.pendingRegistrations || [])[0]?.rawIdHeld,
};
if (consent.termsVersion !== '2026-11-18') throw new Error(`terms version not recorded: ${JSON.stringify(consent)}`);
if (!consent.acceptedAt || !consent.acceptedOrigin) throw new Error(`consent timestamp/origin missing: ${JSON.stringify(consent)}`);
if (consent.identityLast4 !== '5678') throw new Error(`identity last4 wrong: ${JSON.stringify(consent)}`);
if (consent.pendingRawIdHeld !== false) throw new Error(`raw ID digits were retained: ${JSON.stringify(consent)}`);

await send('Page.navigate', { url: `${base}/terms.html` });
await waitUntil(`document.readyState === 'complete' && !!document.querySelector('.legal__page h1')`);
const terms = await evaluate(`({
  title: document.title,
  heading: document.querySelector('.legal__page h1').textContent.trim(),
  sections: document.querySelectorAll('.legal__page section').length,
  scripts: document.scripts.length,
  fees: /1% platform fee/.test(document.body.textContent),
  recordKeeper: /not a bank/i.test(document.body.textContent),
})`);
if (terms.scripts !== 0) throw new Error('legal page should not run scripts');
if (!terms.fees || !terms.recordKeeper) throw new Error(`terms content missing rules: ${JSON.stringify(terms)}`);
await shot('consent-terms-390');

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${base}/privacy.html` });
await waitUntil(`document.readyState === 'complete' && !!document.querySelector('.legal__page h1')`);
const privacy = await evaluate(`({
  title: document.title,
  hashed: /SHA-256/.test(document.body.textContent),
  sections: document.querySelectorAll('.legal__page section').length,
  links: Array.from(document.querySelectorAll('.legal__nav a')).map((a) => a.getAttribute('href')),
})`);
if (!privacy.hashed) throw new Error('privacy notice must state the hashed identity storage');
await shot('consent-privacy-1440');

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
if (process.env.TUNNEL_ORIGIN) {
  await send('Page.navigate', { url: process.env.TUNNEL_ORIGIN });
  await waitUntil('document.body.classList.contains("is-ready")', 30000);
  await evaluate(`document.querySelector('[data-action="open-auth"][data-mode="register"]').click()`);
  await waitUntil(`document.querySelector('#authDialog[open] form[data-form="auth-register"]') !== null`);
  const tunnelLinks = await evaluate(`Array.from(document.querySelectorAll('#authDialog form a[href$=".html"]')).map((a) => a.href)`);
  if (!tunnelLinks.every((href) => href.startsWith(process.env.TUNNEL_ORIGIN))) {
    throw new Error(`legal links must stay on the tunnel origin: ${JSON.stringify(tunnelLinks)}`);
  }
  const tunnelTerms = await fetch(`${process.env.TUNNEL_ORIGIN}/terms.html`);
  if (tunnelTerms.status !== 200) throw new Error(`tunnel terms page returned ${tunnelTerms.status}`);
  await shot('consent-tunnel-390');
}

console.log(JSON.stringify({ codes, gateError, links, consent, terms, privacy, failures }, null, 2));
await fetch(`${DEBUG}/json/close/${target.id}`);
