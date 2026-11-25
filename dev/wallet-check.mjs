// Savings wallet + live strip walkthrough in headless Chrome.
// Depends on the dev server (PORT=8099) and Chrome CDP on 9333.
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

async function httpLogin(name, phone) {
  const session = { jar: jar() };
  const response = await fetch(`${base}/dev/login?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`, { redirect: 'manual' });
  session.jar.absorb(response);
  return session;
}

async function httpPost(session, route, body = {}) {
  const response = await fetch(`${base}/functions/v1/app${route}`, {
    method: 'POST',
    headers: {
      cookie: session.jar.header(),
      origin: base,
      'x-csrf-token': session.jar.value('wheel_csrf'),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} → ${response.status} ${await response.text()}`);
  return response.json().catch(() => null);
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
async function waitUntil(expression, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(expression)) return; } catch { /* page mid-render or navigating */ }
    await sleep(150);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}
const steps = [];
const step = (name) => { steps.push(name); };

await fetch(`${base}/dev/reset`, { method: 'POST' });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

const phone = '0700000901';
await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('Savings Tester')}&phone=${phone}` });
await waitUntil('document.body.classList.contains("is-ready")');

const session = await httpLogin('Savings Tester', phone);
const created = await httpPost(session, '/groups', {
  name: 'Savings Circle', contributionMinor: 20000, maxMembers: 5, organizerFeeBps: 100,
});
const group = created.group;
const sessions = [session];
for (const [name, memberPhone] of [
  ['Member Two', '0700000902'],
  ['Member Three', '0700000903'],
  ['Member Four', '0700000904'],
  ['Member Five', '0700000905'],
]) {
  const member = await httpLogin(name, memberPhone);
  sessions.push(member);
  await httpPost(member, '/groups/join', { inviteCode: group.inviteCode });
}
for (const member of sessions) await httpPost(member, `/groups/${group.id}/round/accept`, { roundNumber: 1 });
await httpPost(session, `/groups/${group.id}/start`, {});
step('circle started with five seats');

await evaluate(`localStorage.setItem('wheel.activeGroup', '${group.id}'); location.hash = '#/g'; location.reload()`);
await waitUntil('document.querySelector("[data-live-strip]") !== null');
const stripStart = await evaluate('document.querySelector("[data-live-strip]").innerText.replace(/\\s+/g, " ")');
if (!stripStart.includes('FUNDING LIVE')) throw new Error(`live strip missing: ${stripStart}`);
if (!stripStart.includes('0/5')) throw new Error(`live strip should start at 0/5: ${stripStart}`);
step('live funding strip renders from the turn');

await evaluate('document.querySelector(\'[data-action="open-contribute"]\').click()');
await waitUntil('document.querySelector(\'#sheet[open] [data-action="open-topup"]\') !== null');
await evaluate('document.querySelector(\'#sheet [data-action="open-topup"]\').click()');
await waitUntil('document.querySelectorAll(\'#sheet .topup-chips [data-action="topup-start"]\').length >= 5');
step('contribute sheet offers the stash');

await evaluate('document.querySelector(\'#sheet .topup-chips [data-action="topup-start"][data-amount="100000"]\').click()');
await waitUntil(`fetch('/functions/v1/app/wallet/topups').then((r) => r.json()).then((d) => d.savedMinor === 100000)`, 30000);
await waitUntil('document.body.classList.contains("is-ready")', 30000);
const saved = await evaluate(`fetch('/functions/v1/app/wallet/topups').then((r) => r.json()).then((d) => d.savedMinor)`);
if (saved !== 100000) throw new Error(`top-up should credit KES 1,000, got ${saved}`);
step('stash top-up paid and credited');

await evaluate("location.hash = '#/g'");
await waitUntil('document.querySelector(\'[data-action="open-contribute"]\') !== null');
await evaluate('document.querySelector(\'[data-action="open-contribute"]\').click()');
await waitUntil('document.querySelector(\'#sheet [data-action="pay-savings"]\') !== null');
const sheetText = await evaluate('document.querySelector("#sheet").innerText.replace(/\\s+/g, " ")');
if (!sheetText.includes('In your stash')) throw new Error(`savings row missing: ${sheetText}`);
await evaluate('document.querySelector(\'#sheet [data-action="pay-savings"]\').click()');
await waitUntil('document.querySelector(\'#sheet[open]\') === null', 20000);
await waitUntil(`fetch('/functions/v1/app/groups/${group.id}').then((r) => r.json()).then((d) => d.cycle.paidCount === 1)`, 20000);
step('a turn paid from the stash');

const after = await evaluate(`fetch('/functions/v1/app/groups/${group.id}').then((r) => r.json())`);
if (after.cycle.savedMinor !== 80000) throw new Error(`savings after paying should be KES 800, got ${after.cycle.savedMinor}`);
if (after.wallet.availableMinor !== 80000) throw new Error(`wallet should hold KES 800, got ${after.wallet.availableMinor}`);
await waitUntil('document.querySelector("[data-live-strip]").innerText.includes("1/5")', 20000);
const stripNow = await evaluate('document.querySelector("[data-live-strip]").innerText.replace(/\\s+/g, " ")');
if (!stripNow.includes('KES 200') && !stripNow.includes('200 of')) throw new Error(`captured pot not shown: ${stripNow}`);
step('live strip updates to 1/5 and the captured pot');

const widths = {};
for (const width of [320, 390, 1440]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
  await evaluate('location.reload()');
  await waitUntil('document.querySelector("[data-live-strip]") !== null');
  const metrics = await evaluate(`({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    strip: Boolean(document.querySelector('[data-live-strip]')),
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  })`);
  widths[width] = metrics;
  if (metrics.overflow || !metrics.strip) throw new Error(`layout breaks at ${width}px: ${JSON.stringify(metrics)}`);
}
step('live strip holds at 320px, 390px and 1440px');

console.log(JSON.stringify({
  groupId: group.id,
  steps,
  stripStart,
  stripNow,
  savedAfterTopUp: saved,
  walletAfterPaying: after.wallet.availableMinor,
  widths,
  problems,
}, null, 2));
ws.close();
