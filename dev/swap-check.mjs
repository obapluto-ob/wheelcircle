// Seat swap browser/API check. Needs the dev server on 8099 and Chrome CDP on 9333.
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
async function waitUntil(expression, timeout = 20000) {
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

const host = await login('Swap Host', '0700000011');
const one = await login('Joiner One', '0700000012');
const two = await login('Joiner Two', '0700000013');

const created = await call(host, '/groups', {
  method: 'POST',
  body: { name: 'Swap Table', contributionMinor: 25000, maxMembers: 5, organizerFeeBps: 100 },
});
if (created.status !== 201) throw new Error(`create → ${created.status}`);
const gid = created.data.group.id;
const code = created.data.group.inviteCode;
for (const joiner of [one, two]) {
  const joined = await call(joiner, '/groups/join', { method: 'POST', body: { inviteCode: code } });
  if (joined.status !== 201) throw new Error(`join → ${joined.status} ${JSON.stringify(joined.data)}`);
}
step('a forming private circle holds three seats');

const walletBefore = (await call(host, '/auth/me')).data.wallet.availableMinor;

await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('Swap Host')}&phone=0700000011` });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate("location.hash = '#/g/members'");
await waitUntil('document.querySelectorAll(".member-card").length === 3', 25000);
await waitUntil('document.body.textContent.includes("Swap") && document.querySelector(\'[data-action="open-swap"]\') !== null');
step('the member table offers a Swap action while the circle forms');

await evaluate(`(() => {
  const card = [...document.querySelectorAll('.member-card')].find((el) => el.textContent.includes('Joiner One'));
  card.querySelector('[data-action="open-swap"]').click();
})()`);
await waitUntil('document.querySelector(\'form[data-form="swap"]\') !== null');
const sheetText = await evaluate('document.querySelector("dialog[open]").textContent.replace(/\\s+/g, " ").trim()');
if (!sheetText.includes('Seat 1') || !sheetText.includes('Seat 2') || !sheetText.includes('48 hours')) {
  throw new Error(`swap sheet missing seat facts: ${sheetText.slice(0, 300)}`);
}
await evaluate(`(() => {
  const form = document.querySelector('form[data-form="swap"]');
  form.note.value = 'I need the pot earlier this month';
  form.requestSubmit();
})()`);
await waitUntil('document.body.textContent.includes("Waiting on Joiner One")', 25000);
step('the offer shows the real seats, a 48 hour life, and waits on the target');

await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('Joiner One')}&phone=0700000012` });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate("location.hash = '#/g/members'");
await waitUntil('document.querySelector(".swap-row.is-incoming") !== null', 25000);
const incomingText = await evaluate('document.querySelector(".swap-row.is-incoming").textContent.replace(/\\s+/g, " ").trim()');
if (!incomingText.includes('Swap Host') || !incomingText.includes('need the pot earlier')) {
  throw new Error(`incoming offer lost the note: ${incomingText}`);
}
await evaluate('document.querySelector(\'[data-action="swap-accept"]\').click()');
await waitUntil('document.body.textContent.includes("You hold seat 1")', 25000).catch(() => {});
await waitUntil('document.querySelector(".swap-row.is-incoming") === null', 25000);
const joinerSeat = await evaluate(`(() => {
  const card = [...document.querySelectorAll('.member-card')].find((el) => el.textContent.includes('Joiner One'));
  return card.querySelector('.member-card__seat').textContent.trim();
})()`);
if (joinerSeat !== 'SEAT 01') throw new Error(`joiner card still shows ${joinerSeat}`);
step('the target accepts from the member table and the seat labels follow');

const joinerDetail = await call(one, `/groups/${gid}`);
if (joinerDetail.data.me?.seat !== 1) throw new Error(`joiner seat is ${joinerDetail.data.me?.seat}`);
if (joinerDetail.data.swaps.incoming.length || joinerDetail.data.swaps.outgoing.length) {
  throw new Error('a resolved offer is still listed');
}
const hostDetail = await call(host, `/groups/${gid}`);
if (hostDetail.data.me?.seat !== 2) throw new Error(`host seat is ${hostDetail.data.me?.seat}`);
const walletAfter = (await call(host, '/auth/me')).data.wallet.availableMinor;
if (walletAfter !== walletBefore) throw new Error('a swap moved money');
const seats = hostDetail.data.members.map((member) => member.seat).sort((a, b) => a - b);
if (JSON.stringify(seats) !== JSON.stringify([1, 2, 3])) throw new Error(`seat ladder broke: ${JSON.stringify(seats)}`);
step('seat numbers swap with no money moved and no duplicate seats');

const again = await call(host, `/groups/${gid}/seat-swaps`, {
  method: 'POST', body: { targetMembershipId: joinerDetail.data.members.find((m) => m.name === 'Joiner Two').id },
});
if (again.status !== 201) throw new Error(`second offer → ${again.status}`);
const back = await call(two, `/groups/${gid}/seat-swaps`, {
  method: 'POST', body: { targetMembershipId: joinerDetail.data.members.find((m) => m.name === 'Joiner One').id, note: 'Trade back?' },
});
if (back.status !== 201) throw new Error(`third offer → ${back.status} ${JSON.stringify(back.data)}`);

await send('Page.reload');
await waitUntil('document.body.classList.contains("is-ready")');
await waitUntil('document.querySelector(".swap-row.is-incoming") !== null', 20000);
await evaluate('document.querySelector(\'[data-action="jarvis-open"]\').click()');
await waitUntil('document.body.classList.contains("jarvis-open")');
await evaluate(`(() => {
  const form = document.querySelector('form[data-form="jarvis-ask"]');
  form.ask.value = 'swap seats';
  form.requestSubmit();
})()`);
await waitUntil('document.querySelector("#jarvisLog").textContent.includes("Joiner Two offered a seat swap")', 20000);
await waitUntil('!document.body.classList.contains("jarvis-open")', 10000);
if (await evaluate("location.hash !== '#/g/members'")) throw new Error('Jarvis did not keep the member table open');
step('Jarvis reads the incoming swap and walks the member to the member table');

await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('Joiner One')}&phone=0700000012` });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate("location.hash = '#/g/members'");
await send('Page.reload');
await waitUntil('document.body.classList.contains("is-ready")');
await waitUntil('document.querySelectorAll(".member-card").length === 3', 25000);
await waitUntil('document.querySelector(".swap-row.is-incoming") !== null', 20000);
const overflow = await evaluate('document.documentElement.scrollWidth');
if (overflow > 322) throw new Error(`the member table overflows a 320px screen: ${overflow}px`);
step('the member table and swap rows hold at 320px');

const measured = { 320: overflow };
for (const width of [390, 1440]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
  await send('Page.reload');
  await waitUntil('document.body.classList.contains("is-ready")');
  await waitUntil('document.querySelector(".swap-row.is-incoming") !== null', 20000);
  const scroll = await evaluate('document.documentElement.scrollWidth');
  if (scroll > width + 2) throw new Error(`the member table overflows ${width}px: ${scroll}px`);
  measured[width] = scroll;
}
step('the same table holds at 390px and 1440px');

const summary = { steps, widths: measured, incomingText: incomingText.slice(0, 200), sheetText: sheetText.slice(0, 200), problems };
console.log(JSON.stringify(summary, null, 2));
await send('Target.closeTarget', { targetId: target.id });
if (problems.length) process.exitCode = 1;
