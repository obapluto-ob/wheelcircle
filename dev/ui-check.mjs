// Clicks through the product in headless Chrome: create, join, start, fund, bid, settle.
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

const joinCircle = (session, inviteCode) => httpPost(session, '/groups/join', { inviteCode });

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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(expression, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(expression)) return; } catch { /* page mid-render */ }
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

const phone = '0700000099';
await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('UI Tester')}&phone=${phone}` });
await waitUntil('document.body.classList.contains("is-ready")');

await evaluate("location.hash = '#/app'");
await waitUntil('document.querySelector(\'[data-action="start-circle"]\') !== null');
step('empty workspace');

await evaluate('document.querySelector(\'[data-action="start-circle"]\').click()');
await waitUntil('document.querySelector(\'#sheet[open] form[data-form="create-group"]\') !== null');
await evaluate(`(() => {
  const form = document.querySelector('#sheet form[data-form="create-group"]');
  form.querySelector('input[name="name"]').value = 'Jua Circle';
  form.querySelector('input[name="contribution"]').value = '500';
  form.querySelector('select[name="maxMembers"]').value = '5';
  form.requestSubmit();
})()`);
await waitUntil('document.body.textContent.includes("Jua Circle")', 20000);
step('created circle');

const group = await evaluate(`fetch('/functions/v1/app/auth/me').then((response) => response.json()).then((data) => data.groups[0])`);
if (!group?.inviteCode) throw new Error('invite code missing after create');
const sessions = [await httpLogin('UI Tester', phone)];
for (const [name, memberPhone] of [
  ['Member Two', '0700000098'],
  ['Member Three', '0700000097'],
  ['Member Four', '0700000096'],
  ['Member Five', '0700000095'],
]) {
  const session = await httpLogin(name, memberPhone);
  sessions.push(session);
  await joinCircle(session, group.inviteCode);
}
step('four members joined');

for (const session of sessions) await httpPost(session, `/groups/${group.id}/round/accept`, { roundNumber: 1 });

await evaluate('location.reload()');
await waitUntil('document.body.classList.contains("is-ready")');
await waitUntil('document.querySelector(\'[data-action="open-start"]:not([disabled])\') !== null', 20000);
await evaluate('document.querySelector(\'[data-action="open-start"]\').click()');
await waitUntil('document.querySelector(\'#sheet[open] form[data-form="start"]\') !== null');
await evaluate('document.querySelector(\'#sheet form[data-form="start"]\').requestSubmit()');
await waitUntil('document.querySelector(\'#sheet[open]\') === null');
await waitUntil('document.body.textContent.includes("TURN 1")', 20000);
step('started turn one');

const detail = await evaluate(`fetch('/functions/v1/app/groups/${group.id}').then((response) => response.json())`);
if (!detail.cycle?.id) throw new Error('cycle missing after start');
if (detail.cycle.turnOwner?.seatNo !== 1) throw new Error('turn one must belong to seat one');
const paid = await fetch(`${base}/dev/pay-all?cycle=${detail.cycle.id}`, { method: 'POST' });
if (!paid.ok) throw new Error(`pay-all → ${paid.status}`);
const settledDetail = await evaluate(`fetch('/functions/v1/app/groups/${group.id}').then((response) => response.json())`);
if (settledDetail.cycle?.status !== 'settled') throw new Error(`turn did not settle inline: ${settledDetail.cycle?.status}`);
step('pot funded and settled inline');

await evaluate('location.reload()');
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate("location.hash = '#/g/auction'");
await waitUntil('document.querySelector(".receipt__total") !== null', 20000);
const receipt = await evaluate('document.querySelector(".receipt").innerText');
const ladder = await evaluate(`[...document.querySelectorAll('.ladder__seat')].map((el) => el.textContent.replace(/\s+/g, ' ').trim())`);
if (ladder.length !== 5 || !/10|10%/.test(ladder[0]) || !ladder[4].includes('0%')) throw new Error(`seat ladder wrong: ${JSON.stringify(ladder)}`);
if (await evaluate(`document.querySelector('[data-bid-form]') !== null`)) throw new Error('bidding UI must not exist');
step('receipt shows the posted seat price');

await evaluate("location.hash = '#/g/ledger'");
await waitUntil('document.querySelectorAll(".ledger .ledger__row").length >= 6', 20000);
const ledgerCount = await evaluate('document.querySelectorAll(".ledger .ledger__row").length');
step('ledger rendered');

const summary = {
  groupId: group.id,
  steps,
  receipt: receipt.replace(/\s+/g, ' ').slice(0, 240),
  ledgerCount,
  problems,
};
console.log(JSON.stringify(summary, null, 2));
await send('Target.closeTarget', { targetId: target.id });
if (problems.length) process.exitCode = 1;
