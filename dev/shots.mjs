// Drives the local app in headless Chrome over CDP for layout checks and screenshots.
// Usage: node dev/shots.mjs [phone]
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 8099}`;
const phone = process.argv[2] || '0700000001';
const outDir = process.env.SHOTS_DIR || path.join(process.env.TEMP || '.', 'wheel-shots');
const DEBUG = 'http://127.0.0.1:9333';

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
    if (message.error) reject(new Error(`${message.error.message} ${message.error.data || ''}`));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text}`);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    problems.push(`console: ${message.params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    problems.push(`log: ${message.params.entry.text}`);
  }
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(expression, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(expression)) return true; } catch { /* page may be loading */ }
    await sleep(120);
  }
  throw new Error(`timeout waiting for: ${expression}`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${base}/dev/login?name=Amina%20Wanjiru&phone=${encodeURIComponent(phone)}` });
await waitUntil('document.body.classList.contains("is-ready")');
await sleep(500);

await mkdir(outDir, { recursive: true });
const shots = [];

async function capture(width, height, route, name, prepare) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: width < 700, screenWidth: width, screenHeight: height,
  });
  await evaluate('window.scrollTo(0, 0)');
  await evaluate(route === '/'
    ? "location.hash = ''; location.reload()"
    : `location.hash = ${JSON.stringify(`#${route}`)}`);
  if (route === '/') {
    await waitUntil('document.body.classList.contains("is-ready")');
    await waitUntil('!document.getElementById("lobbyView").hidden');
  } else {
    await waitUntil('!document.getElementById("appView").hidden');
    await waitUntil('document.querySelector("#workspace .page") !== null');
  }
  await sleep(700);
  if (prepare) { await evaluate(prepare); await sleep(600); }
  const metrics = await evaluate(`(() => {
    window.scrollTo(120, window.scrollY);
    const scrollableX = window.scrollX;
    window.scrollTo(0, window.scrollY);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      scrollHeight: document.documentElement.scrollHeight,
      scrollableX,
    };
  })()`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(outDir, `${width}-${name}.png`);
  await writeFile(file, Buffer.from(shot.data, 'base64'));
  shots.push({ file, width, route, overflow: metrics.scrollWidth - metrics.innerWidth, scrollableX: metrics.scrollableX, height: metrics.scrollHeight });
}

const plans = [
  [1440, 940, '/', 'lobby'],
  [1440, 940, '/app', 'dashboard'],
  [1440, 940, '/g', 'circle'],
  [1440, 940, '/g/auction', 'auction'],
  [1440, 940, '/g/ledger', 'ledger'],
  [1440, 940, '/g/members', 'members'],
  [1440, 940, '/settings', 'settings'],
  [390, 844, '/', 'lobby'],
  [390, 844, '/app', 'dashboard'],
  [390, 844, '/g', 'circle'],
  [390, 844, '/g/auction', 'auction'],
  [390, 844, '/g/ledger', 'ledger'],
  [390, 844, '/settings', 'settings'],
  [320, 700, '/', 'lobby'],
  [320, 700, '/app', 'dashboard'],
  [320, 700, '/g/auction', 'auction'],
];

for (const [width, height, route, name] of plans) {
  await capture(width, height, route, name);
}

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
await send('Network.clearBrowserCookies');
await send('Page.navigate', { url: `${base}/` });
await waitUntil('document.body.classList.contains("is-ready")');
await waitUntil('!document.getElementById("lobbyView").hidden');
await evaluate('document.querySelector(\'#lobbyView [data-action="open-auth"][data-mode="register"]\').click()');
await waitUntil('document.getElementById("authDialog").open');
await sleep(500);
await writeFile(path.join(outDir, '1440-auth.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
await sleep(400);
await writeFile(path.join(outDir, '390-auth.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));

await send('Target.closeTarget', { targetId: target.id });
console.log(JSON.stringify({ outDir, shots, problems }, null, 2));
