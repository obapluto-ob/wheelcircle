// Lists elements that exceed the viewport at a given width. Usage: node dev/probe.mjs 1440 / 
const base = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 8099}`;
const width = Number(process.argv[2] || 1440);
const route = process.argv[3] || '/';
const DEBUG = 'http://127.0.0.1:9333';

const target = await (await fetch(`${DEBUG}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(expression, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await evaluate(expression)) return; } catch { /* loading */ }
    await sleep(120);
  }
  throw new Error(`timeout: ${expression}`);
}

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
await send('Page.navigate', { url: `${base}/dev/login?name=Amina%20Wanjiru&phone=0700000001` });
await waitUntil('document.body.classList.contains("is-ready")');
await evaluate(route === '/' ? "location.hash = ''; location.reload()" : `location.hash = ${JSON.stringify(`#${route}`)}`);
await waitUntil('document.body.classList.contains("is-ready")');
await sleep(800);

const report = await evaluate(`(() => {
  const vw = window.innerWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right > vw + 0.5 || rect.left < -0.5) {
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className?.baseVal ?? el.className ?? '').slice(0, 80),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }
  return { vw, sw: document.documentElement.scrollWidth, list: out.slice(0, 25) };
})()`);
console.log(JSON.stringify(report, null, 2));
await send('Target.closeTarget', { targetId: target.id });
