// End-to-end passkey check: register, save recovery codes, reload, sign out, sign in again.
const base = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 8099}`;
const DEBUG = 'http://127.0.0.1:9333';

const target = await (await fetch(`${DEBUG}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
const log = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    log.push(`exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    log.push(`console: ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
  }
  if (message.method === 'Network.responseReceived' && message.params.response.url.includes('/functions/v1/app/auth/')) {
    log.push(`response ${message.params.response.status} ${message.params.response.url.split('/app')[1]}`);
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
  let snapshot = null;
  try {
    snapshot = await evaluate(`({
      href: location.href,
      ready: document.body.classList.contains('is-ready'),
      dialog: document.querySelector('#authDialog')?.open || false,
      error: document.querySelector('#authDialog [data-form-error]')?.textContent || '',
      cockpit: document.querySelector('#railName')?.textContent || '',
      cookies: document.cookie,
    })`);
  } catch { /* page mid-navigation */ }
  throw new Error(`timeout waiting for: ${expression}\nsnapshot: ${JSON.stringify(snapshot)}\nlog: ${JSON.stringify(log)}`);
}

await fetch(`${base}/dev/reset`, { method: 'POST' });
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('WebAuthn.enable', { enableUI: false });
await send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
});

await send('Page.navigate', { url: base });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate('document.querySelector(\'[data-action="open-auth"][data-mode="register"]\').click()');
await waitUntil('document.querySelector(\'#authDialog[open] form[data-form="auth-register"]\') !== null');
await evaluate(`(() => {
  const form = document.querySelector('#authDialog form[data-form="auth-register"]');
  form.querySelector('input[name="name"]').value = 'Obed Emoni';
  form.querySelector('input[name="phone"]').value = '0729237059';
  form.requestSubmit();
})()`);
await waitUntil('document.querySelector(\'#sheet[open] .codegrid .code\') !== null');
const codes = await evaluate('document.querySelectorAll("#sheet[open] .codegrid .code").length');
if (codes !== 10) throw new Error(`expected 10 recovery codes, found ${codes}`);
await evaluate('document.querySelector(\'#sheet [data-action="recovery-done"]\').click()');
await waitUntil('location.hash === "#/app" && !document.querySelector("#authDialog[open]")');

await send('Page.reload');
await waitUntil('document.body.classList.contains("is-ready") && !document.querySelector("#authDialog[open]")');
const afterReload = await evaluate(`({
  signedIn: document.querySelector('#railName')?.textContent || '',
  lobbyHidden: document.querySelector('#lobbyView')?.hidden === true,
})`);
if (afterReload.signedIn !== 'Obed Emoni') throw new Error(`session lost on reload: ${JSON.stringify(afterReload)}`);

const csrf = await evaluate(`document.cookie.split('; ').find((part) => part.startsWith('wheel_csrf='))?.split('=')[1]`);
await evaluate(`fetch('/functions/v1/app/auth/logout', {
  method: 'POST',
  headers: { 'x-csrf-token': decodeURIComponent('${csrf || ''}') },
})`);
await send('Page.reload');
await waitUntil('document.body.classList.contains("is-ready") && document.querySelector(\'#authDialog[open] [data-action="auth-passkey"]\') !== null');
await evaluate('document.querySelector(\'[data-action="auth-passkey"]\').click()');
await waitUntil('location.hash === "#/app" && !document.querySelector("#authDialog[open]")', 25000);
const afterSignIn = await evaluate(`({
  signedIn: document.querySelector('#railName')?.textContent || '',
  error: document.querySelector('#authDialog [data-form-error]')?.textContent || '',
})`);
if (afterSignIn.signedIn !== 'Obed Emoni') throw new Error(`passkey sign-in failed: ${JSON.stringify(afterSignIn)}`);

const state = await (await fetch(`${base}/dev/state`)).json();
console.log(JSON.stringify({
  codes,
  afterReload,
  afterSignIn,
  users: state.users,
  sessions: (state.users || []).length,
  log,
}, null, 2));
await fetch(`${DEBUG}/json/close/${target.id}`);
