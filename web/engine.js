/* Display-only funding engine. The caller supplies the authoritative phase/result.
 * API: engineMarkup(model) -> HTML; mountEngines(root) -> void;
 * speakEngineText(text, onDone?) -> boolean; stopEngineVoice() -> void.
 * onDone(reason) runs once, including failure: ended, stopped, error,
 * unsupported, busy, or empty. Read actions never enable announcements.
 * Call stopEngineVoice() before leaving the route: it also unbinds controls.
 */

const STORE = 'wheel.voice.v1';
const TONES = Object.freeze({
  calm: { rate: 0.92, pitch: 0.98 },
  friendly: { rate: 1, pitch: 1.04 },
  energetic: { rate: 1.08, pitch: 1.08 },
});
const PHASES = ['forming', 'contributing', 'funded', 'settled'];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const ordinal = (value) => nonnegative(value) && value > 0 ? String(value) : '—';
const money = (value) => nonnegative(value)
  ? `KES ${Math.floor(value / 100).toLocaleString('en-KE')}.${String(value % 100).padStart(2, '0')}`
  : 'Not available';

/** Pure HTML renderer: no storage, speech, timers, selection, or financial writes. */
export function engineMarkup({ key, phase, paid, total, potMinor, round, turn,
  winnerName, winnerNetMinor, virtual = false } = {}) {
  const state = PHASES.includes(phase) ? phase : 'forming';
  const members = nonnegative(total) ? total : 0;
  const funded = nonnegative(paid) ? Math.min(paid, members) : 0;
  const percent = members ? Math.floor(funded / members * 1000) / 10 : 0;
  const name = typeof winnerName === 'string' ? winnerName.trim() : '';
  const settled = state === 'settled' && !!name;
  const practice = virtual === true;
  const suffix = practice ? ' · virtual' : '';
  const titles = {
    forming: 'Gathering the circle', contributing: 'Funding in progress',
    funded: 'Funding confirmed', settled: settled ? 'Turn allocated' : 'Settlement recorded',
  };
  const transfer = practice
    ? 'Practice only. No real money moves.'
    : 'Allocation is not proof of an external transfer.';
  const net = nonnegative(winnerNetMinor)
    ? `${money(winnerNetMinor)} net allocated${suffix}.`
    : `Net amount not available${suffix}.`;
  const descriptions = {
    forming: 'Gathering members. Funding starts when the turn opens.',
    contributing: `${funded} of ${members} members have funded this turn. Waiting for confirmed settlement.`,
    funded: 'The pot is funded. Waiting for a confirmed allocation; no recipient is shown yet.',
    settled: settled ? `Turn allocated to ${name}. ${net} ${transfer}`
      : 'Settlement recorded. Waiting for the confirmed recipient.',
  };
  const readout = settled ? descriptions[state] : `${descriptions[state]}${practice ? ' Practice only; all amounts are virtual.' : ''}`;
  const safeKey = typeof key === 'string' || typeof key === 'number' && Number.isFinite(key) ? String(key) : '';

  const ratio = members ? funded / members : 0;
  const blades = Array.from({ length: 16 }, (_, i) => `<g class="we-blade" style="--a:${(i * 22.5).toFixed(1)}deg"><rect x="-3.5" y="20" width="7" height="36" rx="2.5" /></g>`).join('');
  const pistons = Array.from({ length: 8 }, (_, i) => `<g class="we-piston" style="--a:${i * 45}deg;--i:${i}"><g class="we-ram"><rect x="-1.5" y="62" width="3" height="22" rx="1.5" /></g></g>`).join('');

  return `<section class="wheel-engine${settled ? ' is-locked' : ''}" data-engine-key="${esc(safeKey)}" data-engine-phase="${state}" data-engine-result="${settled}" data-engine-funded="${funded}" data-engine-members="${members}" aria-label="Funding engine${suffix}">
    <header class="wheel-engine__header"><h2>Funding engine</h2><span class="wheel-engine__phase">${esc(titles[state])}${suffix}</span></header>
    <div class="wheel-engine__body">
      <div class="wheel-engine__mechanism" data-engine-mech style="--p:${ratio.toFixed(3)}">
        <span class="we-screw we-screw--tl" aria-hidden="true"></span><span class="we-screw we-screw--tr" aria-hidden="true"></span><span class="we-screw we-screw--bl" aria-hidden="true"></span><span class="we-screw we-screw--br" aria-hidden="true"></span>
        <svg class="wheel-engine__rings" viewBox="0 0 240 240" aria-hidden="true" focusable="false">
          <circle class="wheel-engine__rim" cx="120" cy="120" r="117" />
          <circle class="wheel-engine__ticks" cx="120" cy="120" r="110" pathLength="100" stroke-dasharray="0.6 2.7333" />
          <g class="we-gear"><g class="we-gear__spin">
            <circle cx="120" cy="120" r="106" pathLength="100" stroke-dasharray="2.2 1.7" />
            <circle cx="120" cy="120" r="102" pathLength="100" stroke-dasharray="0.9 1.55" />
          </g></g>
          <g class="we-iris"><g class="we-iris__breathe">${blades}</g></g>
          <g class="we-pistons">${pistons}</g>
          <circle class="we-membrane" cx="120" cy="120" r="70" />
          <circle class="wheel-engine__track" cx="120" cy="120" r="99" />
          <circle class="wheel-engine__charge" cx="120" cy="120" r="99" pathLength="100" stroke-dasharray="${percent} 100" transform="rotate(-90 120 120)" />
          <g class="we-comet" aria-hidden="true"><circle cx="120" cy="21" r="2.4" /><circle cx="120" cy="21" r="6" class="we-comet__halo" /></g>
          <g class="wheel-engine__pins"><circle cx="120" cy="3" r="2"/><circle cx="237" cy="120" r="2"/><circle cx="120" cy="237" r="2"/><circle cx="3" cy="120" r="2"/></g>
        </svg>
        <div class="we-hub wheel-engine__hub">
          <span>${settled ? 'Allocation locked' : 'Funding meter'}</span>
          ${settled ? `<svg class="wheel-engine__lock" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M6 8V6a4 4 0 0 1 8 0v2M5 8h10v9H5zM10 11v3" /></svg><strong class="wheel-engine__name">${esc(name)}</strong><small>${esc(money(winnerNetMinor))}<br>net${suffix}</small>`
    : `<strong class="wheel-engine__percent">${percent}<span>%</span></strong><small>${funded} / ${members} members funded${suffix}</small>`}
        </div>
        <span class="we-engrave">POT PRESSURE</span>
        <span class="we-grip" aria-hidden="true">DRAG TO TURN</span>
      </div>
      <div class="wheel-engine__context">
        <dl class="wheel-engine__metrics"><div><dt>Members funded</dt><dd>${funded} / ${members}</dd></div><div><dt>Round</dt><dd>${ordinal(round)}</dd></div><div><dt>Turn</dt><dd>${ordinal(turn)}</dd></div></dl>
        <div class="wheel-engine__meter" role="progressbar" aria-label="Members funding this turn" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${funded} of ${members} members funded"><span style="width:${percent}%"></span></div>
        <p class="wheel-engine__pot"><span>Turn pot${suffix}</span><strong>${esc(money(potMinor))}</strong></p>
        <p class="wheel-engine__readout" data-engine-readout>${esc(readout)}</p>
        <p class="wheel-engine__note">Funding powers the ring. It never selects a recipient.</p>
      </div>
    </div>
    <details class="wheel-engine__settings">
      <summary>Voice, sound &amp; motion <span>Optional · on this device</span></summary>
      <div class="wheel-engine__settings-body">
        <label class="wheel-engine__check"><input type="checkbox" data-engine-enabled disabled><span>Announce new confirmed allocations</span></label>
        <label class="wheel-engine__check"><input type="checkbox" data-engine-sound><span>Mechanical sound for funding and results</span></label>
        <div class="wheel-engine__selects">
          <label><span>Speaking tone</span><select data-engine-tone disabled><option value="calm">Calm</option><option value="friendly">Friendly</option><option value="energetic">Energetic</option></select></label>
          <label><span>Device voice</span><select data-engine-voice disabled><option value="">Browser default</option></select></label>
        </div>
        <p class="wheel-engine__note" data-engine-voice-note>Voice choices come from your browser. No microphone is used; some voices may need a connection.</p>
        <div class="wheel-engine__actions"><button type="button" data-engine-action="announce" disabled>${settled ? 'Read allocation' : 'Read status'}</button><button type="button" data-engine-action="stop" disabled>Stop voice</button></div>
        <label class="wheel-engine__check"><input type="checkbox" data-engine-motion><span>Pause engine motion</span></label>
      </div>
    </details>
    <p class="wheel-engine__status" data-engine-status role="status" aria-live="polite" aria-atomic="true">Voice is off. All updates remain visible as text.</p>
  </section>`;
}

let preferences;
let sessionGesture = false;
let activeSpeech = null;
let voiceListener = null;
const bindings = new Map();
// Memory only: no names, amounts, or result IDs are written to storage. A reload
// needs another gesture; already-rendered settlements are never read retroactively.
const seenSettlements = new Set();
const announcedKeys = new Set();
// Last seen funding state per engine, so only real progress makes a sound.
const engineStates = new Map();
let audioContext = null;
let audioUnlockBound = false;

function soundContext() {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) return null;
  if (audioContext === null) {
    try { audioContext = new Ctx(); } catch { audioContext = undefined; return null; }
  }
  if (!audioContext) return null;
  if (audioContext.state !== 'running') {
    try { audioContext.resume().catch(() => { /* Silent until a gesture allows it. */ }); } catch { /* Optional API. */ }
  }
  return audioContext;
}

// Browsers only start audio inside a gesture. The first tap or keypress anywhere
// unlocks later engine sounds; nothing plays before the user touches the page.
function bindAudioUnlock() {
  const doc = globalThis.document;
  if (audioUnlockBound || !doc?.addEventListener) return;
  audioUnlockBound = true;
  const unlock = () => soundContext();
  doc.addEventListener('pointerdown', unlock, { passive: true });
  doc.addEventListener('keydown', unlock);
}

function blip(ctx, { type = 'square', from, to = from, dur = 0.05, gain = 0.04, at = 0, pan = 0 } = {}) {
  try {
    const start = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + dur);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(amp);
    // Each blip sits where its part of the ring is: left seats sound left.
    if (typeof ctx.createStereoPanner === 'function') {
      const place = ctx.createStereoPanner();
      place.pan.value = Math.max(-1, Math.min(1, Number(pan) || 0));
      amp.connect(place).connect(ctx.destination);
    } else {
      amp.connect(ctx.destination);
    }
    osc.start(start);
    osc.stop(start + dur + 0.02);
  } catch { /* Sound is decorative; never break the engine. */ }
}

const panAt = (ratio) => Math.max(-0.8, Math.min(0.8, (Math.max(0, Math.min(1, ratio)) * 2 - 1) * 0.8));

// Ticks walk the charge arc from where funding was to where it landed, timed
// to the .9s iris slide so the sound and the metal move as one part.
function playTicks(count, { from = 0.4, to = 0.6 } = {}) {
  if (!prefs().sound) return;
  const ctx = soundContext();
  if (!ctx || ctx.state !== 'running') return;
  const total = Math.max(1, Math.min(Number(count) || 1, 8));
  const startRatio = Math.max(0, Math.min(1, Number(from) || 0));
  const endRatio = Math.max(startRatio, Math.min(1, Number(to) || 0));
  for (let i = 0; i < total; i += 1) {
    const t = total === 1 ? 1 : i / (total - 1);
    blip(ctx, {
      from: 640, to: 520, dur: 0.035, gain: 0.03,
      at: t * 0.78, pan: panAt(startRatio + (endRatio - startRatio) * t),
    });
  }
}

function playEngage() {
  if (!prefs().sound) return;
  const ctx = soundContext();
  if (!ctx || ctx.state !== 'running') return;
  blip(ctx, { type: 'sine', from: 190, to: 110, dur: 0.1, gain: 0.06 });
  blip(ctx, { from: 760, to: 660, dur: 0.03, gain: 0.03, at: 0.11 });
}

function playRatchet() {
  if (!prefs().sound) return;
  const ctx = soundContext();
  if (!ctx || ctx.state !== 'running') return;
  blip(ctx, { from: 360, to: 200, dur: 0.026, gain: 0.022 });
}

function playSettle() {
  if (!prefs().sound) return;
  const ctx = soundContext();
  if (!ctx || ctx.state !== 'running') return;
  blip(ctx, { type: 'sine', from: 130, to: 52, dur: 0.24, gain: 0.08 });
  blip(ctx, { from: 420, to: 380, dur: 0.04, gain: 0.028, at: 0.02 });
  blip(ctx, { type: 'sine', from: 523.25, dur: 0.16, gain: 0.05, at: 0.2 });
  blip(ctx, { type: 'sine', from: 783.99, dur: 0.28, gain: 0.045, at: 0.32 });
}

function motionReduced() {
  if (prefs().motionPaused) return true;
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true; }
  catch { return false; }
}

// Types the result into the readout like a terminal log. Progress is kept per
// engine key so a rerender resumes the sentence instead of skipping it. Speech
// stays separate; typing is visual only and finishes instantly when paused.
const typedProgress = new Map();

function typeReadout(record, key) {
  const node = record.readout;
  if (!node) return;
  let progress = typedProgress.get(key);
  if (!progress) {
    if (typedProgress.size > 200) typedProgress.delete(typedProgress.values().next().value);
    progress = { text: node.textContent, shown: 0 };
    typedProgress.set(key, progress);
  }
  const text = progress.text;
  if (progress.shown >= text.length) { node.textContent = text; return; }
  if (motionReduced() || typeof globalThis.requestAnimationFrame !== 'function') {
    progress.shown = text.length;
    node.textContent = text;
    return;
  }
  node.textContent = text.slice(0, progress.shown);
  node.classList.add('is-typing');
  const step = () => {
    record.typeFrame = null;
    if (!node.isConnected) return;
    progress.shown = Math.min(text.length, progress.shown + 2);
    node.textContent = text.slice(0, progress.shown);
    if (progress.shown < text.length) record.typeFrame = globalThis.requestAnimationFrame(step);
    else node.classList.remove('is-typing');
  };
  record.typeFrame = globalThis.requestAnimationFrame(step);
}

function prefs() {
  if (preferences) return preferences;
  preferences = { version: 1, tone: 'calm', voiceURI: '', enabled: false, motionPaused: false, sound: true };
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORE) || 'null');
    if (saved?.version === 1) {
      if (Object.hasOwn(TONES, saved.tone)) preferences.tone = saved.tone;
      if (typeof saved.voiceURI === 'string' && saved.voiceURI.length <= 512) preferences.voiceURI = saved.voiceURI;
      if (typeof saved.enabled === 'boolean') preferences.enabled = saved.enabled;
      if (typeof saved.motionPaused === 'boolean') preferences.motionPaused = saved.motionPaused;
      if (typeof saved.sound === 'boolean') preferences.sound = saved.sound;
    }
  } catch { /* Storage can be blocked. Session controls still work. */ }
  return preferences;
}

function persistPrefs() {
  try { globalThis.localStorage?.setItem(STORE, JSON.stringify(prefs())); }
  catch { /* Never store financial state or require storage to use the controls. */ }
}

function speechAPI() {
  try {
    const synth = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    return synth && typeof synth.speak === 'function' && typeof synth.cancel === 'function'
      && typeof Utterance === 'function' ? { synth, Utterance } : null;
  } catch { return null; }
}

function deviceVoices(api) {
  try {
    return Array.from(api?.synth.getVoices() || []).filter((voice) => voice
      && typeof voice.name === 'string' && typeof voice.voiceURI === 'string'
      && voice.voiceURI.length > 0 && voice.voiceURI.length <= 512);
  } catch { return []; }
}

/* House voice: prefer a Kenyan or wider African English/Swahili voice so the
   circle sounds local, then fall back to the device default. */
const HOUSE_VOICE_ORDER = ["sw-KE", "en-KE", "sw-TZ", "sw", "en-NG", "en-ZA", "en-GB"];

function houseVoice(voices) {
  for (const lang of HOUSE_VOICE_ORDER) {
    const prefix = lang.toLowerCase();
    const hit = voices.find((voice) => String(voice.lang || "").toLowerCase().startsWith(prefix));
    if (hit) return hit;
  }
  return null;
}

function statusText(record, text) {
  if (record?.status) record.status.textContent = text;
}

function idleStatus(record, supported) {
  if (!supported) return statusText(record, 'Device speech is unavailable in this browser. All updates remain visible as text.');
  statusText(record, !prefs().enabled ? 'Voice is off. Read aloud once without enabling announcements.'
    : sessionGesture ? 'Voice is on for new confirmed allocations. Existing results stay quiet unless you read them.'
      : 'Voice preference restored, but automatic speech is paused. Read aloud or switch voice off and on to activate it for this page.');
}

function updateStopButtons() {
  for (const record of bindings.values()) {
    record.stop.disabled = !activeSpeech;
  }
}

function notifyDone(callback, reason) {
  try { if (typeof callback === 'function') callback(reason); }
  catch { /* Caller UI errors must not break speech cleanup. */ }
}

function finishSpeech(speech, reason) {
  if (speech.finished) return;
  speech.finished = true;
  speech.utterance.onend = null;
  speech.utterance.onerror = null;
  if (activeSpeech === speech) activeSpeech = null;
  statusText(speech.owner, reason === 'ended' ? 'Finished reading. The text remains available.'
    : reason === 'stopped' ? 'Voice stopped. The text remains available.'
      : 'Device speech could not finish. Please use the visible text or try again.');
  updateStopButtons();
  notifyDone(speech.onDone, reason);
}

function cancelOwnedSpeech() {
  const speech = activeSpeech;
  if (!speech) return;
  // Web Speech has only a global cancel(). Never call it without an owned
  // utterance, and never queue engine speech behind another feature's speech.
  speech.utterance.onend = null;
  speech.utterance.onerror = null;
  try { speech.synth.cancel(); } catch { /* Text and settings remain usable. */ }
  finishSpeech(speech, 'stopped');
}

function startSpeech(text, onDone, owner = null) {
  const fail = (reason, message) => {
    statusText(owner, message);
    notifyDone(onDone, reason);
    return false;
  };
  if (typeof text !== 'string' || !text.trim()) return fail('empty', 'There is no text to read yet.');
  const api = speechAPI();
  if (!api) return fail('unsupported', 'Device speech is unavailable. Please use the visible text.');
  cancelOwnedSpeech();
  let speech;
  try {
    if (api.synth.speaking || api.synth.pending) return fail('busy', 'Another voice is using the browser. Try reading again when it finishes.');
    const utterance = new api.Utterance(text.trim());
    const settings = prefs();
    const voices = deviceVoices(api);
    const selected = voices.find((voice) => voice.voiceURI === settings.voiceURI) || houseVoice(voices);
    if (selected) {
      utterance.voice = selected;
      if (typeof selected.lang === 'string' && selected.lang) utterance.lang = selected.lang;
    }
    utterance.rate = TONES[settings.tone].rate;
    utterance.pitch = TONES[settings.tone].pitch;
    utterance.volume = 1;
    speech = { synth: api.synth, utterance, owner, onDone, finished: false };
    utterance.onend = () => finishSpeech(speech, 'ended');
    utterance.onerror = () => finishSpeech(speech, 'error');
    activeSpeech = speech;
    statusText(owner, 'Reading aloud. The text remains available.');
    updateStopButtons();
    api.synth.speak(utterance);
    return !speech.finished;
  } catch {
    if (speech) {
      // A browser may throw after accepting an utterance. Clear our ownership
      // and handlers as well as any partially started engine speech.
      speech.utterance.onend = null;
      speech.utterance.onerror = null;
      try { api.synth.cancel(); } catch { /* No further recovery API exists. */ }
      finishSpeech(speech, 'error');
      return false;
    }
    return fail('error', 'Device speech could not start. Please use the visible text.');
  }
}

/** Call directly from a user gesture. Does NOT enable automatic announcements. */
export function speakEngineText(text, onDone) {
  return startSpeech(text, onDone);
}

function fillVoices(record, api, voices) {
  const select = record.voice;
  const doc = select.ownerDocument;
  const defaultOption = doc.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'Browser default';
  select.replaceChildren(defaultOption);
  const uris = new Set();
  for (const voice of voices) {
    if (uris.has(voice.voiceURI)) continue;
    uris.add(voice.voiceURI);
    const option = doc.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = `${voice.name}${voice.lang ? ` · ${voice.lang}` : ''}${voice.default ? ' · default' : ''}`;
    select.append(option);
  }
  select.value = uris.has(prefs().voiceURI) ? prefs().voiceURI : '';
  record.voiceNote.textContent = !api ? 'No microphone is used. Speech is unavailable here.'
    : prefs().voiceURI && !uris.has(prefs().voiceURI)
      ? 'The saved voice is not currently listed; the browser default will be used. No microphone is used.'
      : !voices.length ? 'No voices are listed yet. The browser default may still work. No microphone is used.'
        : 'These are voices reported by your browser. No microphone is used; some voices may need a connection.';
}

function syncControls(refreshVoices = false) {
  const api = speechAPI();
  const settings = prefs();
  const voices = refreshVoices ? deviceVoices(api) : [];
  for (const record of bindings.values()) {
    record.tone.value = settings.tone;
    record.enabled.checked = settings.enabled;
    record.motion.checked = settings.motionPaused;
    record.sound.checked = settings.sound;
    record.element.dataset.enginePaused = String(settings.motionPaused);
    for (const control of [record.tone, record.voice, record.enabled, record.announce]) control.disabled = !api;
    if (refreshVoices) fillVoices(record, api, voices);
    else record.voice.value = Array.from(record.voice.options).some((option) => option.value === settings.voiceURI) ? settings.voiceURI : '';
  }
  updateStopButtons();
}

function removeVoiceListener() {
  if (!voiceListener) return;
  const { synth, handler } = voiceListener;
  try { synth.removeEventListener('voiceschanged', handler); } catch { /* Optional browser API. */ }
  voiceListener = null;
}

function listenForVoices() {
  const api = speechAPI();
  if (voiceListener?.synth === api?.synth) return;
  removeVoiceListener();
  if (!api || !bindings.size) return;
  const handler = () => syncControls(true);
  try {
    api.synth.addEventListener('voiceschanged', handler);
    voiceListener = { synth: api.synth, handler };
  } catch { /* Voices still refresh on every mount; don't overwrite onvoiceschanged. */ }
}

function unbind(record) {
  record.element.removeEventListener('click', record.onClick);
  record.element.removeEventListener('change', record.onChange);
  if (record.mech && record.onMechDown) {
    record.mech.removeEventListener('pointerdown', record.onMechDown);
    record.mech.removeEventListener('pointermove', record.onMechMove);
    record.mech.removeEventListener('pointerup', record.onMechUp);
    record.mech.removeEventListener('pointercancel', record.onMechUp);
    record.mech.removeEventListener('pointerleave', record.onMechLeave);
    record.onMechDown = record.onMechMove = record.onMechUp = record.onMechLeave = null;
  }
  if (record.typeFrame) {
    try { globalThis.cancelAnimationFrame(record.typeFrame); } catch { /* Optional API. */ }
    record.typeFrame = null;
    record.readout?.classList.remove('is-typing');
  }
  bindings.delete(record.element);
  if (activeSpeech?.owner === record) cancelOwnedSpeech();
}

function readRecord(record) {
  if (record.typeFrame) {
    try { globalThis.cancelAnimationFrame(record.typeFrame); } catch { /* Optional API. */ }
    record.typeFrame = null;
    const key = record.element.dataset.engineKey || '';
    const progress = typedProgress.get(key);
    if (progress) {
      progress.shown = progress.text.length;
      record.readout.textContent = progress.text;
    }
    record.readout.classList.remove('is-typing');
  }
  if (record.element.dataset.engineResult === 'true' && record.element.dataset.engineKey) {
    announcedKeys.add(record.element.dataset.engineKey);
  }
  return startSpeech(record.readout.textContent, undefined, record);
}

/** Rebind only engines in root (root itself may be an engine). Safe after rerender. */
export function mountEngines(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const elements = [...root.querySelectorAll('.wheel-engine')];
  if (root.matches?.('.wheel-engine')) elements.unshift(root);
  for (const record of [...bindings.values()]) {
    if (!record.element.isConnected || elements.includes(record.element)) unbind(record);
  }
  const autoCandidates = [];
  for (const element of elements) {
    const control = (selector) => element.querySelector(selector);
    const record = { element,
      tone: control('[data-engine-tone]'), voice: control('[data-engine-voice]'),
      enabled: control('[data-engine-enabled]'), motion: control('[data-engine-motion]'),
      sound: control('[data-engine-sound]'),
      announce: control('[data-engine-action="announce"]'), stop: control('[data-engine-action="stop"]'),
      status: control('[data-engine-status]'), voiceNote: control('[data-engine-voice-note]'),
      readout: control('[data-engine-readout]'),
    };
    if (Object.values(record).some((value) => !value)) continue;
    record.typeFrame = null;
    record.mech = control('[data-engine-mech]');
    if (record.mech) {
      // The gearing can be spun by hand. It is decoration: never reads or moves money.
      let twist = 0;
      let dragging = false;
      let lastX = 0;
      let travel = 0;
      const aim = (event) => {
        const rect = record.mech.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const nx = Math.max(-0.5, Math.min(0.5, (event.clientX - rect.left) / rect.width - 0.5));
        const ny = Math.max(-0.5, Math.min(0.5, (event.clientY - rect.top) / rect.height - 0.5));
        record.mech.style.setProperty('--tilt-x', nx.toFixed(3));
        record.mech.style.setProperty('--tilt-y', ny.toFixed(3));
        record.mech.style.setProperty('--mx', `${((nx + 0.5) * 100).toFixed(1)}%`);
        record.mech.style.setProperty('--my', `${((ny + 0.5) * 100).toFixed(1)}%`);
      };
      const relax = () => {
        record.mech.style.setProperty('--tilt-x', '0');
        record.mech.style.setProperty('--tilt-y', '0');
        record.mech.style.setProperty('--mx', '50%');
        record.mech.style.setProperty('--my', '44%');
      };
      record.onMechDown = (event) => {
        dragging = true;
        lastX = event.clientX;
        record.mech.classList.add('is-grabbing');
        aim(event);
        try { record.mech.setPointerCapture?.(event.pointerId); } catch { /* Optional API. */ }
      };
      record.onMechMove = (event) => {
        aim(event);
        if (!dragging) return;
        const dx = event.clientX - lastX;
        lastX = event.clientX;
        twist += dx * 0.7;
        travel += Math.abs(dx);
        record.mech.style.setProperty('--twist', `${twist.toFixed(1)}deg`);
        if (travel > 34) { travel = 0; playRatchet(); }
      };
      record.onMechUp = () => {
        dragging = false;
        record.mech.classList.remove('is-grabbing');
      };
      record.onMechLeave = () => { if (!dragging) relax(); };
      record.mech.addEventListener('pointerdown', record.onMechDown);
      record.mech.addEventListener('pointermove', record.onMechMove);
      record.mech.addEventListener('pointerup', record.onMechUp);
      record.mech.addEventListener('pointercancel', record.onMechUp);
      record.mech.addEventListener('pointerleave', record.onMechLeave);
    }
    record.onClick = (event) => {
      const button = event.target.closest?.('[data-engine-action]');
      if (!button || button.closest('.wheel-engine') !== element || button.disabled) return;
      if (button.dataset.engineAction === 'stop') cancelOwnedSpeech();
      if (button.dataset.engineAction === 'announce' && event.isTrusted) {
        sessionGesture = prefs().enabled;
        readRecord(record);
        for (const mounted of bindings.values()) {
          if (mounted !== record) idleStatus(mounted, !!speechAPI());
        }
      }
    };
    record.onChange = (event) => {
      const target = event.target;
      const settings = prefs();
      if (target === record.tone && Object.hasOwn(TONES, target.value)) settings.tone = target.value;
      else if (target === record.voice) settings.voiceURI = deviceVoices(speechAPI()).some((voice) => voice.voiceURI === target.value) ? target.value : '';
      else if (target === record.enabled) {
        settings.enabled = target.checked;
        if (settings.enabled && event.isTrusted) sessionGesture = true;
        if (!settings.enabled) {
          sessionGesture = false;
          cancelOwnedSpeech();
        }
      } else if (target === record.motion) settings.motionPaused = target.checked;
      else if (target === record.sound) settings.sound = target.checked;
      else return;
      persistPrefs();
      syncControls(true);
      for (const mounted of bindings.values()) {
        if (activeSpeech?.owner !== mounted) idleStatus(mounted, !!speechAPI());
      }
    };
    element.addEventListener('click', record.onClick);
    element.addEventListener('change', record.onChange);
    bindings.set(element, record);
    idleStatus(record, !!speechAPI());
    const key = element.dataset.engineKey;
    if (key && element.dataset.enginePhase === 'settled' && element.dataset.engineResult === 'true') {
      if (!seenSettlements.has(key) && !announcedKeys.has(key)) autoCandidates.push(record);
      seenSettlements.add(key);
    }
  }
  syncControls(true);
  listenForVoices();
  if (!bindings.size) removeVoiceListener();
  bindAudioUnlock();
  for (const element of elements) element.dataset.engineMounted = 'true';
  // Silence on first sight; only real progress or a phase change plays a sound.
  for (const element of elements) {
    const record = bindings.get(element);
    if (!record) continue;
    const key = element.dataset.engineKey || '';
    const phase = element.dataset.enginePhase || '';
    const funded = Math.max(0, Number(element.dataset.engineFunded) || 0);
    const members = Math.max(0, Number(element.dataset.engineMembers) || 0);
    const ratio = members ? Math.min(1, funded / members) : 0;
    const prev = engineStates.get(key);
    engineStates.set(key, { phase, funded, members });
    if (engineStates.size > 200) engineStates.delete(engineStates.keys().next().value);
    const mech = record.mech;
    if (mech) {
      // The iris closes as seats fund. Read the previous state so a poll rerender
      // animates from where the mechanism was instead of snapping.
      const prevRatio = prev && prev.members ? Math.min(1, prev.funded / prev.members) : null;
      const from = prevRatio ?? Math.max(0, ratio - 0.35);
      if (motionReduced() || from === ratio) mech.style.setProperty('--p', ratio.toFixed(3));
      else {
        mech.style.setProperty('--p', from.toFixed(3));
        globalThis.requestAnimationFrame(() => {
          globalThis.requestAnimationFrame(() => {
            if (mech.isConnected) mech.style.setProperty('--p', ratio.toFixed(3));
          });
        });
      }
    }
    if (!prev) continue;
    if (funded > prev.funded) {
      const before = prev.members ? Math.min(1, prev.funded / prev.members) : 0;
      playTicks(funded - prev.funded, { from: before, to: ratio });
    }
    if (phase === 'funded' && prev.phase !== 'funded') playEngage();
    if (phase === 'settled') {
      const progress = key ? typedProgress.get(key) : null;
      if (prev.phase !== 'settled') {
        playSettle();
        if (key) typeReadout(record, key);
      } else if (progress && progress.shown < progress.text.length) {
        // A rerender replaced the node mid-sentence; keep typing from there.
        typeReadout(record, key);
      }
    }
  }
  // One fresh result at most: mounting a history must not produce a speech queue.
  // Enabling voice never reads already-mounted results or changes settlement data.
  if (prefs().enabled && sessionGesture && !activeSpeech && autoCandidates.length === 1) readRecord(autoCandidates[0]);
}

/** Route-exit cleanup. Never cancels speech when the engine owns no utterance. */
export function stopEngineVoice() {
  cancelOwnedSpeech();
  for (const record of [...bindings.values()]) unbind(record);
  removeVoiceListener();
}
