import test from 'node:test';
import assert from 'node:assert/strict';
import { engineMarkup } from '../web/engine.js';

const model = {
  key: 'circle-1:turn-2', phase: 'contributing', paid: 3, total: 6,
  potMinor: 300000, round: 1, turn: 2,
};
const render = (overrides = {}) => engineMarkup({ ...model, ...overrides });

// engineMarkup is a DOM-independent public export. These tests intentionally
// require neither a browser nor speech synthesis; integration tests live outside
// this asset task.
test('renders an accessible funding meter and supplied labels', () => {
  const html = render();
  assert.match(html, /class="wheel-engine"/);
  assert.match(html, /role="progressbar"[^>]*aria-valuenow="50"/);
  assert.match(html, /aria-valuetext="3 of 6 members funded"/);
  assert.match(html, /<dt>Round<\/dt><dd>1<\/dd>/);
  assert.match(html, /<dt>Turn<\/dt><dd>2<\/dd>/);
  assert.match(html, /Turn pot<\/span><strong>KES 3,000\.00/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /It never selects a recipient/);
});

test('funding counts never promote the authoritative phase or reveal a winner', () => {
  for (const phase of ['forming', 'contributing', 'funded']) {
    const html = render({ phase, paid: 6, winnerName: 'Hidden recipient', winnerNetMinor: 178901 });
    assert.match(html, new RegExp(`data-engine-phase="${phase}"`));
    assert.match(html, /data-engine-result="false"/);
    assert.doesNotMatch(html, /Hidden recipient|1,789\.01|Turn allocated to|Allocation locked/);
  }
});

test('a confirmed settlement locks its recipient and shows only supplied net as allocation', () => {
  const html = render({ phase: 'settled', winnerName: 'Amina', winnerNetMinor: 178901 });
  assert.match(html, /data-engine-result="true"/);
  assert.match(html, /Allocation locked/);
  assert.match(html, /Turn allocated to Amina\. KES 1,789\.01 net allocated\./);
  assert.match(html, /Allocation is not proof of an external transfer/);
  assert.doesNotMatch(html, /3,000\.00 net|Money sent|money sent/);
});

test('settled without a nonblank name has no allocation announcement', () => {
  for (const winnerName of [undefined, null, '', '   ', 7]) {
    const html = render({ phase: 'settled', winnerName, winnerNetMinor: 12345 });
    assert.match(html, /data-engine-result="false"/);
    assert.match(html, /Waiting for the confirmed recipient/);
    assert.doesNotMatch(html, /123\.45|Turn allocated to|Allocation locked/);
  }
});

test('escapes names and keys, including attribute-breaking input', () => {
  const attack = '\"><img src=x onerror="alert(1)"> & \'Name\'';
  const html = render({ key: attack, phase: 'settled', winnerName: attack, winnerNetMinor: 1 });
  assert.doesNotMatch(html, /<img|<script|key=""><|<\/section><script/);
  assert.match(html, /data-engine-key="&quot;&gt;&lt;img/);
  assert.match(html, /&amp; &#39;Name&#39;/);
  assert.match(html, /KES 0\.01 net allocated/);
});

test('invalid phases and numeric inputs cannot become markup or styles', () => {
  const html = render({ phase: '"><script>x</script>', paid: '" onmouseover="x',
    total: Infinity, round: '<b>4</b>', turn: NaN, potMinor: '<img>', winnerName: 'Hidden' });
  assert.match(html, /data-engine-phase="forming"/);
  assert.match(html, /aria-valuenow="0"/);
  assert.match(html, /<dt>Round<\/dt><dd>—<\/dd>/);
  assert.match(html, /<dt>Turn<\/dt><dd>—<\/dd>/);
  assert.doesNotMatch(html, /<script|<img|onmouseover|NaN|Infinity|Hidden/);
});

test('progress remains bounded without rounding incomplete funding to full', () => {
  for (const [paid, total, percent] of [[0, 0, 0], [3, 6, 50], [9, 6, 100], [-1, 6, 0],
    [2.5, 6, 0], [NaN, 6, 0], [6, -3, 0], [1999, 2000, 99.9], [6, 6, 100]]) {
    const html = render({ paid, total });
    assert.match(html, new RegExp(`aria-valuenow="${percent}"`));
    assert.match(html, new RegExp(`style="width:${percent}%"`));
    assert.match(html, /data-engine-phase="contributing"/);
  }
});

test('missing or invalid money never turns into a fabricated zero allocation', () => {
  for (const value of [undefined, null, -10, NaN, Infinity, 1.5, '500', Number.MAX_SAFE_INTEGER + 1]) {
    const html = render({ potMinor: value, phase: 'settled', winnerName: 'Amina', winnerNetMinor: value });
    assert.match(html, /Net amount not available/);
    assert.match(html, /Turn pot<\/span><strong>Not available/);
    assert.doesNotMatch(html, /KES|NaN|Infinity/);
  }
});

test('zero and safe integer minor amounts preserve exact cents', () => {
  assert.match(render({ phase: 'settled', winnerName: 'Amina', winnerNetMinor: 0 }), /KES 0\.00 net allocated/);
  assert.match(render({ phase: 'settled', winnerName: 'Amina', winnerNetMinor: Number.MAX_SAFE_INTEGER }),
    /KES 90,071,992,547,409\.91 net allocated/);
});

test('practice marks amounts and allocation as virtual, not a real transfer', () => {
  const html = render({ virtual: true, phase: 'settled', winnerName: 'Amina', winnerNetMinor: 10001 });
  assert.match(html, /Turn pot · virtual/);
  assert.match(html, /KES 100\.01 net allocated · virtual/);
  assert.match(html, /Practice only\. No real money moves/);
  assert.match(render({ virtual: true }), /all amounts are virtual/);
  assert.doesNotMatch(render({ virtual: 'true' }), /· virtual/);
});

test('voice defaults to off, with labelled native controls and text fallback', () => {
  const html = render();
  assert.match(html, /<details class="wheel-engine__settings">/);
  assert.match(html, /<input type="checkbox" data-engine-enabled disabled>/);
  assert.doesNotMatch(html, /\schecked(?:\s|>)/);
  for (const tone of ['calm', 'friendly', 'energetic']) assert.match(html, new RegExp(`<option value="${tone}">`));
  for (const selector of ['data-engine-tone', 'data-engine-voice', 'data-engine-motion',
    'data-engine-action="announce"', 'data-engine-action="stop"', 'data-engine-readout', 'data-engine-status']) {
    assert.ok(html.includes(selector), `Missing ${selector}`);
  }
  assert.match(html, /Voice is off\. All updates remain visible as text/);
  assert.match(html, /No microphone is used/);
});

test('mechanical sound is opt-out and funding counts expose only bounded progress', () => {
  const html = render();
  assert.match(html, /<input type="checkbox" data-engine-sound>/);
  assert.doesNotMatch(html, /data-engine-sound[^>]*disabled/);
  assert.match(html, /data-engine-funded="3" data-engine-members="6"/);
  assert.match(render({ paid: 9, total: 6 }), /data-engine-funded="6" data-engine-members="6"/);
  assert.match(render({ paid: '3', total: 6 }), /data-engine-funded="0"/);
});

test('rendering is deterministic and does not require global browser APIs', () => {
  assert.equal(render(), render());
  assert.match(engineMarkup(), /data-engine-phase="forming"/);
  assert.match(engineMarkup(), /Turn pot<\/span><strong>Not available/);
});
