import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const base = process.env.PUBLIC_ORIGIN || 'http://localhost:8099';
const debug = 'http://127.0.0.1:9333';
const version = await (await fetch(`${debug}/json/version`)).json();
assert.match(version['User-Agent'], /HeadlessChrome/, 'Use only the isolated project test browser');
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let serial = 0;
const pending = new Map();
const errors = [];
const requests = [];
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
};
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const { browserContextId } = await send('Target.createBrowserContext');
const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
async function evaluate(expression) {
  const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function wait(expression) {
  return evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+12000;function check(){try{if(${expression})return resolve(true)}catch{}if(Date.now()>end)return reject(Error('Timed out: '+${JSON.stringify(expression)}));setTimeout(check,50)}check()})`);
}
async function click(selector) {
  await evaluate(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(x=>x.getClientRects().length&&!x.disabled);if(!el)throw Error('Missing or disabled control: '+${JSON.stringify(selector)});el.scrollIntoView({block:'center'});el.click()})()`);
}
const action = (name, suffix = '') => click(`[data-practice="${name}"]${suffix}`);
async function seat(id) {
  await evaluate(`(()=>{const s=document.querySelector('[data-practice-member]');if(![...s.options].some(o=>o.value===${JSON.stringify(id)}))throw Error('Missing seat');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
}
const state = () => evaluate(`JSON.parse(localStorage.getItem('wheel.practice.v3'))`);
async function route(name) {
  await evaluate(`location.hash=${JSON.stringify(`#/practice/${name}`)}`);
  await wait(`document.querySelector('#practiceView').dataset.page===${JSON.stringify(name)}`);
}
async function size(width, height = 900) {
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
}
async function layout(label) {
  const data = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth,dialog:document.querySelector('#authDialog').open?(()=>{const d=document.querySelector('#authDialog');return{width:d.clientWidth,scroll:d.scrollWidth,height:d.clientHeight,scrollHeight:d.scrollHeight}})():null})`);
  if (data.scroll > data.width + 1) data.overflow = await evaluate(`Array.from(document.querySelectorAll('body *')).filter(e=>e.getClientRects().length && e.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(e=>({tag:e.tagName,cls:typeof e.className==='string'?e.className:'SVG',right:e.getBoundingClientRect().right}))`);
  assert.ok(data.scroll <= data.width + 1, `${label} horizontal overflow: ${JSON.stringify(data)}`);
  if (data.dialog) assert.ok(data.dialog.scroll <= data.dialog.width + 1, `${label} dialog overflow`);
  return data;
}
async function shot(name) {
  const { data } = await page('Page.captureScreenshot', { format: 'png' });
  await writeFile(new URL(`${name}.png`, import.meta.url), Buffer.from(data, 'base64'));
}
const results = [];
try {
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Network.enable');
  await size(1440);
  await page('Page.navigate', { url: `${base}/#/practice` });
  await wait(`document.querySelector('.practice-guide')!==null`);
  assert.equal(await evaluate(`document.querySelector('#authDialog').open`), false);
  assert.equal(await evaluate(`document.querySelector('#devDock')!==null`), false);
  assert.equal(requests.filter((u) => u.includes('/functions/') || u.includes('/dev/')).length, 0, 'Cold practice must not contact real accounts or payments');
  for (let i = 0; i < 5; i++) await action('join');
  assert.equal((await state()).members.length, 6);
  for (const width of [320, 390, 768, 1440]) {
    await size(width);
    results.push({ view: 'circle', ...(await layout(`circle ${width}`)) });
    await evaluate('window.scrollTo(0,0)');
    if (width !== 768) await shot(`practice-circle-${width}`);
  }
  for (let i = 1; i <= 6; i++) {
    await seat(`p${i}`);
    assert.equal((await state()).activeMemberId, `p${i}`);
  }
  assert.equal(await evaluate(`document.querySelector('[data-practice="start"]').disabled`), true, 'Member cannot start');
  await seat('p1');
  assert.equal(await evaluate(`document.querySelector('[data-practice="start"]').disabled`), true, 'Start waits for every acceptance');
  await evaluate(`(()=>{const s=document.querySelector('[data-practice-cadence]');s.value='fortnightly';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  assert.equal((await state()).group.cadence, 'fortnightly');
  await evaluate(`(()=>{const s=document.querySelector('[data-practice-cadence]');s.value='weekly';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await action('accept');
  await action('accept-others');
  assert.ok((await state()).members.every((m) => m.acceptedRound === 1));
  await action('start');
  await wait(`location.hash==='#/practice/turn' && document.querySelector('.practice-pot')!==null`);
  const winners = [];
  for (let turn = 1; turn <= 6; turn++) {
    if (turn > 1) {
      await seat('p1');
      await action('next');
    }
    assert.equal(await evaluate(`document.querySelector('[data-practice-bid]')!==null`), false, 'Bidding is retired');
    assert.match(await evaluate(`document.querySelector('.round-schedule').textContent`), /No bids, no window/);
    if (turn > 1) {
      await seat(winners[0]);
      assert.match(await evaluate(`document.querySelector('.practice-person__status').textContent`), /Paid on turn 1/);
      assert.equal(await evaluate(`document.querySelector('[data-practice="claim"]')!==null`), false, 'A claimed payout offers no second claim');
      await seat(`p${turn}`);
    }
    await action('pay');
    await action('fund-others');
    // Other seats arrive one at a time, like real contributions.
    await wait(`JSON.parse(localStorage.getItem('wheel.practice.v3')).cycle?.status==='settled'`);
    const settled = await state();
    assert.equal(settled.cycle.status, 'settled', 'The pot pays its seat the moment it is whole');
    await wait(`document.querySelector('.wheel-engine[data-engine-phase="settled"][data-engine-result="true"]')!==null`);
    const receipt = settled.receipts.at(-1);
    assert.equal(receipt.winnerId, `p${turn}`, `Turn ${turn} belongs to seat ${turn}`);
    assert.equal(receipt.reason, turn === 6 ? 'final' : 'seat');
    assert.equal(receipt.math.totalAllocated, 300000);
    assert.equal(winners.includes(receipt.winnerId), false);
    winners.push(receipt.winnerId);
    await seat('p1');
    await route('circle');
    await action('verify', `[data-member="${receipt.winnerId}"]`);
    await seat(receipt.winnerId);
    if (turn === 1) {
      assert.equal(await evaluate(`document.querySelector('[data-practice="claim"]').disabled`), true);
      await action('hold');
    }
    await action('claim');
    assert.equal((await state()).receipts.at(-1).claimed, true);
    await route('turn');
    if (turn === 1) {
      await click('.practice-proof summary');
      assert.equal(await evaluate(`document.querySelector('.practice-proof').open`), true);
      for (const width of [320, 390, 1440]) {
        await size(width);
        results.push({ view: 'receipt', ...(await layout(`receipt ${width}`)) });
        await evaluate('window.scrollTo(0,0)');
        await shot(`practice-receipt-${width}`);
      }
    }
  }
  const completed = await state();
  assert.equal(completed.group.status, 'completed');
  assert.equal(completed.receipts.at(-1).math.bondHoldMinor, 0);
  assert.equal(completed.receipts.at(-1).math.discountBps, 0);
  assert.ok(completed.members.every((m) => m.bondMinor === 0));
  await seat('p1');
  await route('circle');
  await action('renew');
  const renewed = await state();
  assert.equal(renewed.round, 2);
  assert.equal(renewed.group.status, 'forming');
  assert.equal(renewed.members.length, 6, 'Repeat round keeps the roster');
  assert.equal(renewed.receipts.length, 6, 'Round 1 receipts stay recorded');
  assert.equal(await evaluate(`document.querySelector('[data-practice="start"]').disabled`), true, 'Round 2 needs fresh acceptances');
  await action('accept');
  await action('accept-others');
  await action('start');
  await wait(`document.querySelector('#practiceView').dataset.page==='turn'`);
  assert.match(await evaluate(`document.querySelector('.practice-turn .card__title').textContent`), /Round 2 · turn 1/);
  assert.ok((await state()).members.every((m) => !m.hasWon));
  await route('ledger');
  await size(390);
  results.push({ view: 'ledger', ...(await layout('complete ledger')) });
  await page('Page.reload');
  await wait(`document.querySelector('.practice-history')!==null`);
  assert.equal((await state()).receipts.length, 6, 'Practice progress survives refresh');
  assert.equal(requests.filter((u) => u.includes('/functions/') || u.includes('/dev/')).length, 0, 'Entire practice must remain network-isolated');
  await action('reset-prompt');
  await action('reset-cancel');
  assert.equal((await state()).receipts.length, 6);
  await action('reset-prompt');
  await action('reset');
  await wait(`document.querySelector('#practiceView').dataset.page==='circle'`);
  for (let i = 0; i < 4; i++) await action('join');
  await action('accept');
  await action('accept-others');
  await action('start');
  await wait(`document.querySelector('#practiceView').dataset.page==='turn'`);
  await action('pay');
  await action('fund-others');
  await wait(`JSON.parse(localStorage.getItem('wheel.practice.v3')).cycle?.status==='settled'`);
  assert.equal((await state()).cycle.status, 'settled', 'Practice settles inline once every seat has funded');
  assert.equal((await state()).receipts[0].reason, 'seat');
  assert.equal('bids' in (await state()).receipts[0], false);
  await click('[data-question="money"]');
  assert.match(await evaluate(`document.querySelector('[data-guide-answer]').textContent`), /virtual/);
  await evaluate(`localStorage.setItem('wheel.practice.v3','broken-json')`);
  await page('Page.reload');
  await wait(`document.querySelector('.practice-guide')!==null`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-practice-member] option').length`), 1, 'Corrupt practice storage resets safely');
  await evaluate(`location.hash='#/app'`);
  await wait(`document.querySelector('#authDialog').open`);
  for (const width of [320, 390, 768, 1440]) {
    await size(width, width === 320 ? 568 : 900);
    results.push({ view: 'auth', ...(await layout(`auth ${width}`)) });
    await evaluate(`document.querySelector('#authDialog').scrollTop=0`);
    if (width !== 768) await shot(`auth-updated-${width}`);
  }
  await click('[data-action="auth-register"]');
  await wait(`document.querySelector('[data-form="auth-register"]')!==null`);
  await size(320, 568);
  results.push({ view: 'register', ...(await layout('register 320')) });
  await click('[data-form="auth-register"] button[type="submit"]');
  await wait(`!document.querySelector('[data-form="auth-register"] [data-form-error]').hidden`);
  await click('[data-action="auth-back"]');
  await click('[data-action="auth-recover"]');
  await wait(`document.querySelector('[data-form="auth-recover"]')!==null`);
  results.push({ view: 'recovery', ...(await layout('recovery 320')) });
  await click('[data-form="auth-recover"] button[type="submit"]');
  await wait(`!document.querySelector('[data-form="auth-recover"] [data-form-error]').hidden`);
  await click('.auth-practice');
  await wait(`!document.querySelector('#practiceView').hidden && !document.querySelector('#authDialog').open`);
  await size(1440);
  await page('WebAuthn.enable', { enableUI: false });
  await page('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await evaluate(`location.hash='#/app'`);
  await wait(`document.querySelector('#authDialog').open`);
  await click('[data-action="auth-register"]');
  const testPhone = `070${String(Date.now()).slice(-7)}`;
  const testId = `4${String(Date.now()).slice(-6)}`;
  await evaluate(`(()=>{const f=document.querySelector('[data-form="auth-register"]');f.elements.name.value='Interface QA';f.elements.phone.value=${JSON.stringify(testPhone)};f.elements.idNumber.value=${JSON.stringify(testId)};f.elements.dateOfBirth.value='1998-05-12';f.elements.consent.checked=true;f.elements.terms.checked=true;f.requestSubmit()})()`);
  await wait(`document.querySelectorAll('#sheet[open] .codegrid .code').length===10`);
  await click('[data-action="recovery-done"]');
  await wait(`document.querySelector('#railName').textContent==='Interface QA' && !document.querySelector('#appView').hidden`);
  await page('Page.reload');
  await wait(`document.body.classList.contains('is-ready') && document.querySelector('#railName').textContent==='Interface QA'`);
  const accountRequestsBefore = requests.length;
  await click('.rail__nav a[href="#/practice"]');
  await wait(`!document.querySelector('#practiceView').hidden`);
  await action('join');
  assert.equal(requests.slice(accountRequestsBefore).filter((u) => u.includes('/functions/')).length, 0);
  await click('.practice-header a[href="#/app"]');
  await wait(`!document.querySelector('#appView').hidden`);
  assert.equal(await evaluate(`document.querySelector('#railName').textContent`), 'Interface QA', 'Practice must preserve the real account');
  await click('[data-action="sign-out"]');
  await wait(`location.hash==='#/'`);
  await click('[data-action="open-auth"][data-mode="start"]');
  await wait(`document.querySelector('#authDialog').open`);
  await click('[data-action="auth-passkey"]');
  await wait(`!document.querySelector('#appView').hidden && document.querySelector('#railName').textContent==='Interface QA'`);
  results.push({ view: 'passkey registration, reload, account isolation and sign-in', passed: true });
  await wait(`[...document.querySelectorAll('[data-action="start-circle"]')].some((el)=>el.getClientRects().length && !el.disabled)`);
  await click('[data-action="start-circle"]');
  await wait(`document.querySelector('[data-form="create-group"]')!==null`);
  await evaluate(`(()=>{const f=document.querySelector('[data-form="create-group"]');f.elements.name.value='Interface QA Circle';f.elements.contribution.value='500';f.elements.maxMembers.value='6';f.requestSubmit()})()`);
  await wait(`!document.querySelector('#appView').hidden && document.querySelector('.fairness-strip')!==null`);
  await click('.fairness-strip summary');
  assert.match(await evaluate(`document.querySelector('.fairness-strip').textContent`), /0\/1 received/);
  for (const width of [320,390,1440]) { await size(width); results.push({view:'real circle',...(await layout(`real circle ${width}`))}); }
  await click('.fairness-strip a[href="#/practice"]');
  await wait(`!document.querySelector('#practiceView').hidden`);
  await click('[data-practice="speak"]');
  await evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const voiceLabel = await evaluate(`document.querySelector('[data-practice="speak"]').textContent`);
  if (voiceLabel === 'Stop reading') await click('[data-practice="speak"]');
  results.push({view:'voice control or text fallback',passed:true});
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, winners, checks: ['all six personas', 'full lifecycle', 'seat order', 'instant settlement', 'no bids', 'KYC and hold', 'claims and bond release', 'refresh/reset', 'zero practice API calls', 'auth navigation and validation'], layouts: results }, null, 2));
} finally {
  await send('Target.disposeBrowserContext', { browserContextId });
  ws.close();
}
