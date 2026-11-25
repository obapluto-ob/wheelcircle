// Typed KYC + review desk browser/API check. Needs the dev server on 8099 and Chrome CDP on 9333.
const base = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 8099}`;
const DEBUG = 'http://127.0.0.1:9333';

function jar() {
  const cookies = new Map();
  return {
    absorb(response) {
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const at = pair.indexOf('=');
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
    },
    header() { return [...cookies].map(([key, value]) => `${key}=${value}`).join('; '); },
    value(name) { return cookies.get(name); },
  };
}

async function login(name, phone) {
  const session = { jar: jar() };
  session.jar.absorb(await fetch(`${base}/dev/login?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`, { redirect: 'manual' }));
  return session;
}

async function call(session, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}/functions/v1/app${route}`, {
    method,
    headers: {
      cookie: session.jar.header(),
      origin: base,
      ...(body ? { 'content-type': 'application/json', 'x-csrf-token': session.jar.value('wheel_csrf') } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

const target = await (await fetch(`${DEBUG}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
const problems = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    problems.push(`console: ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
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
async function waitUntil(expression, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(expression)) return; } catch { /* mid-render */ }
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}
const steps = [];
const step = (name) => steps.push(name);

await fetch(`${base}/dev/reset`, { method: 'POST' });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const admin = await login('Review Desk', '0700000001');
const joiner = await login('Kyc Member', '0700000002');

const me = await call(admin, '/auth/me');
if (!me.data.user?.isAdmin) throw new Error('dev admin is not flagged isAdmin');
const created = await call(admin, '/groups', {
  method: 'POST',
  body: { name: 'KYC Circle', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100, visibility: 'open' },
});
if (created.status !== 201) throw new Error(`create circle → ${created.status}`);
const gid = created.data.group.id;
step('admin created an open circle');

const wrongPhone = await call(joiner, '/account/identity', {
  method: 'POST', body: { legalName: 'Kyc Member', idNumber: '32111223', phone: '0700000099' },
});
if (wrongPhone.status !== 400 || wrongPhone.data.error !== 'phone_mismatch') {
  throw new Error(`phone mismatch not refused: ${wrongPhone.status} ${JSON.stringify(wrongPhone.data)}`);
}
step('a phone that does not match the account is refused');

const mismatchName = await call(joiner, '/account/identity', {
  method: 'POST', body: { legalName: 'Someone Else', idNumber: '32111223', phone: '0700000002' },
});
if (mismatchName.status !== 200 || mismatchName.data.identityStatus !== 'pending' || mismatchName.data.nameMismatch !== true) {
  throw new Error(`name mismatch not flagged: ${JSON.stringify(mismatchName.data)}`);
}
step('typed ID with a different name waits for review and is flagged');

const submitted = await call(joiner, '/account/identity', {
  method: 'POST', body: { legalName: 'Kyc Member', idNumber: '32111223', phone: '0700000002' },
});
if (submitted.status !== 200 || submitted.data.identityStatus !== 'pending' || submitted.data.nameMismatch !== false) {
  throw new Error(`resubmit failed: ${JSON.stringify(submitted.data)}`);
}
const gate = await call(joiner, `/groups/${gid}/seat-checkout`, { method: 'POST', body: { acceptRules: true } });
if (gate.status !== 403 || gate.data.error !== 'identity_pending') {
  throw new Error(`pending ID was not gated: ${gate.status} ${JSON.stringify(gate.data)}`);
}
step('pending ID is blocked from open seats');

// Joiner sees the review state in Account.
await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('Kyc Member')}&phone=0700000002` });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate("location.hash = '#/settings'");
await waitUntil('document.body.textContent.includes("KYC MEMBER") || document.body.textContent.includes("Kyc Member")');
await waitUntil('document.body.textContent.includes("In review")', 20000);
if (await evaluate('document.getElementById("navAdmin") && !document.getElementById("navAdmin").hidden')) {
  throw new Error('the review desk link must stay hidden for non-admins');
}
step('joiner Account shows the ID in review and no review desk link');

// Admin approves through the review desk UI.
await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('Review Desk')}&phone=0700000001` });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate("location.hash = '#/admin'");
await waitUntil('document.body.textContent.includes("Review Desk") && document.querySelector(".admin-review") !== null', 20000);
const queueText = await evaluate('document.querySelector(".admin-review").textContent.replace(/\\s+/g, " ").trim()');
if (!queueText.includes('Kyc Member') || !queueText.includes('···· 1223')) {
  throw new Error(`review card missing typed facts: ${queueText}`);
}
await evaluate('document.querySelector(\'[data-action="admin-approve"]\').click()');
await waitUntil('document.body.textContent.includes("Queue clear")', 20000);
await waitUntil('document.body.textContent.includes("KYC MEMBER") || document.body.textContent.includes("Kyc Member")', 20000);
step('review desk approves the typed ID from the UI');

const verified = await call(joiner, '/auth/me');
if (verified.data.user?.identityStatus !== 'verified') throw new Error(`joiner not verified: ${verified.data.user?.identityStatus}`);
const checkout = await call(joiner, `/groups/${gid}/seat-checkout`, { method: 'POST', body: { acceptRules: true } });
if (checkout.status !== 201) throw new Error(`approved ID still blocked: ${checkout.status} ${JSON.stringify(checkout.data)}`);
step('approved ID unlocks the open seat');

await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('Kyc Member')}&phone=0700000002` });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate("location.hash = '#/settings'");
await waitUntil('document.body.textContent.includes("Verified · ····1223")', 20000);
step('joiner Account shows the verified last four digits');

// A rejection returns the note to the member.
const third = await login('Returned Member', '0700000003');
await call(third, '/account/identity', {
  method: 'POST', body: { legalName: 'Returned Member', idNumber: '32111224', phone: '0700000003' },
});
const rejected = await call(admin, `/admin/identity/${(await call(third, '/auth/me')).data.user.id}`, {
  method: 'POST', body: { action: 'reject', note: 'Check the ID number and resend.' },
});
if (rejected.status !== 200 || rejected.data.identityStatus !== 'rejected') throw new Error('reject failed');
const afterReject = await call(third, '/auth/me');
if (afterReject.data.user?.identityNote !== 'Check the ID number and resend.') throw new Error('rejection note missing');
const audit = await call(admin, '/admin/identity?status=reviewed');
if (!(audit.data.recent || []).some((entry) => entry.action === 'identity_rejected' && entry.note)) {
  throw new Error('audit trail missing the rejection');
}
step('rejection carries a note back to the member and into the audit trail');

const summary = { steps, queueText: queueText.slice(0, 200), problems };
console.log(JSON.stringify(summary, null, 2));
await send('Target.closeTarget', { targetId: target.id });
if (problems.length) process.exitCode = 1;
