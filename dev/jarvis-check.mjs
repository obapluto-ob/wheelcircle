// Jarvis on-demand check: opens only when called, answers from real circle data, opens payment sheets, never pays.
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
  return { status: response.status, data: await response.json().catch(() => null) };
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
  if (message.method === 'Runtime.exceptionThrown') problems.push(`exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(`console: ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
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
  throw new Error(`timeout: ${expression}`);
}
const ask = async (text) => {
  await evaluate(`(() => { const form = document.querySelector('form[data-form="jarvis-ask"]'); form.ask.value = ${JSON.stringify(text)}; form.requestSubmit(); })()`);
  await sleep(450);
};
const lastBot = () => evaluate(`(() => { const nodes = [...document.querySelectorAll('.jarvis__msg--bot')]; return nodes.at(-1)?.textContent || ''; })()`);
const steps = [];
const step = (name) => steps.push(name);

await fetch(`${base}/dev/reset`, { method: 'POST' });
const admin = await login('Jarvis Host', '0700000001');
const created = await call(admin, '/groups', {
  method: 'POST',
  body: { name: 'Jarvis Circle', contributionMinor: 50000, maxMembers: 5, organizerFeeBps: 100 },
});
if (created.status !== 201) throw new Error(`create group → ${created.status}`);
const gid = created.data.group.id;
for (let index = 0; index < 4; index += 1) {
  const added = await fetch(`${base}/dev/advance?group=${gid}&step=member`, { method: 'POST' });
  if (!added.ok) throw new Error(`add member → ${added.status} ${await added.text()}`);
}
const started = await fetch(`${base}/dev/advance?group=${gid}&step=start`, { method: 'POST' });
if (!started.ok) throw new Error(`start → ${started.status} ${await started.text()}`);
const detail = await call(admin, `/groups/${gid}`);
if (!detail.data?.cycle?.id) throw new Error('cycle missing after start');
step('seeded a five-seat circle on turn one');

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${base}/dev/login?name=${encodeURIComponent('Jarvis Host')}&phone=0700000001` });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate("location.hash = '#/app'");
await waitUntil('document.body.textContent.includes("JARVIS CIRCLE") || document.body.textContent.includes("Jarvis Circle")', 20000);
if (!(await evaluate('document.getElementById("jarvisPanel").hidden'))) throw new Error('Jarvis must stay closed until called');
if (await evaluate('document.body.classList.contains("jarvis-open")')) throw new Error('Jarvis body state leaked before invocation');
step('Jarvis stays closed on load');

await evaluate('document.getElementById("jarvisOrb").click()');
await waitUntil('document.getElementById("jarvisPanel").hidden === false');
await waitUntil('document.getElementById("jarvisLog").textContent.includes("On call")');
step('calling Jarvis opens the panel and greets the member');

await ask('what is my balance');
if (!/available/i.test(await lastBot())) throw new Error(`balance answer missing: ${await lastBot()}`);
await ask('next turn');
const turnText = await lastBot();
if (!/Turn 1/.test(turnText) || !/seat 1/i.test(turnText)) throw new Error(`turn answer missing: ${turnText}`);
step('Jarvis answers balance and next turn from live data');

await ask('invite code');
await waitUntil('document.getElementById("sheet").open === true');
const inviteText = await lastBot();
if (!/[A-Z2-9]{5,}/.test(inviteText)) throw new Error(`invite code missing: ${inviteText}`);
await evaluate('document.querySelector(\'#sheet [data-action="close-sheet"]\').click()');
await sleep(250);
step('invite intent returns the real code and opens the invite card');

await ask('pay my contribution');
await waitUntil('document.getElementById("sheet").open === true');
const payText = await lastBot();
if (!/confirm/i.test(payText) || !/payment sheet/i.test(payText)) throw new Error(`pay response must ask for confirmation: ${payText}`);
const afterSheet = await call(admin, `/groups/${gid}`);
if (afterSheet.data.cycle.myContribution.status === 'paid') throw new Error('Jarvis must never pay without confirmation');
if (!(await evaluate('document.querySelector(\'#sheet [data-action="pay-contribution"]\') !== null'))) throw new Error('payment sheet did not open');
await evaluate('document.querySelector(\'#sheet [data-action="close-sheet"]\').click()');
step('payment intent opens the confirm sheet and moves no money');

await ask('help');
if (!/balance/i.test(await lastBot()) || !/confirm/i.test(await lastBot())) throw new Error('help answer missing capabilities');

await evaluate('document.getElementById("jarvisMic").click()');
await sleep(900);
const listening = await evaluate('document.body.classList.contains("jarvis-open") && document.getElementById("jarvisPanel").hidden === false');
if (!listening) throw new Error('mic tap must leave the panel open');
await evaluate('document.getElementById("jarvisMic").click()');
await sleep(250);
step('mic tap engages listening without leaving the panel');

await ask('find an open circle');
await waitUntil('location.hash === "#/open"', 15000);
await waitUntil('document.body.classList.contains("jarvis-open") === false', 15000);
step('navigation intents move the app and close Jarvis');

const summary = { steps, lastTurn: turnText, lastPay: payText, problems };
console.log(JSON.stringify(summary, null, 2));
await send('Target.closeTarget', { targetId: target.id });
if (problems.length) process.exitCode = 1;
