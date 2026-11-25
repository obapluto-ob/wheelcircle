/* THE WHEEL — machine room.
   Procedural, diegetic sound: every cue is synthesised at runtime from
   oscillators and noise, panned in the stereo field to where it happens
   on screen. No audio files, no network. The room stays silent until the
   first real gesture, and the switch is remembered per device. */
(() => {
  const STORE_KEY = 'wheel.sound.v1';
  const MASTER = 0.5;

  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let enabled = read();
  let gestureSeen = false;

  function read() {
    try { return localStorage.getItem(STORE_KEY) !== 'off'; } catch { return true; }
  }

  function write(value) {
    try { localStorage.setItem(STORE_KEY, value ? 'on' : 'off'); } catch { /* private mode */ }
  }

  function ensure() {
    if (ctx) return ctx;
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    try {
      ctx = new Ctx();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20;
      comp.knee.value = 18;
      comp.ratio.value = 5;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      master = ctx.createGain();
      master.gain.value = MASTER;
      master.connect(comp).connect(ctx.destination);
      const length = Math.floor(ctx.sampleRate * 1.2);
      noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      let last = 0;
      for (let i = 0; i < length; i += 1) {
        const white = Math.random() * 2 - 1;
        last = 0.86 * last + 0.14 * white;
        data[i] = last;
      }
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function unlock() {
    const c = ensure();
    if (!c) return false;
    if (c.state !== 'running' && c.state !== 'closed') c.resume?.().catch(() => {});
    return true;
  }

  function bindGesture() {
    if (gestureSeen) return;
    gestureSeen = true;
    const first = () => {
      unlock();
      if (enabled) play('servo', { pan: -0.2, dir: 1, gain: 0.5 });
    };
    document.addEventListener('pointerdown', first, { once: true, passive: true });
    document.addEventListener('keydown', first, { once: true });
  }

  function live() {
    if (!enabled) return null;
    const c = ensure();
    if (!c || c.state !== 'running') return null;
    return c;
  }

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function panner(c, pan) {
    const node = c.createStereoPanner();
    node.pan.value = clamp(Number(pan) || 0, -1, 1);
    node.connect(master);
    return node;
  }

  function tone(c, opts) {
    const {
      freq = 440, to = null, type = 'sine', dur = 0.15, gain = 0.2,
      at = 0, pan = 0, attack = 0.004, glide = 0.12,
    } = opts;
    const start = c.currentTime + at;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + glide);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(amp).connect(panner(c, pan));
    osc.start(start);
    osc.stop(start + dur + 0.03);
  }

  function noise(c, opts) {
    const {
      dur = 0.09, gain = 0.2, at = 0, pan = 0, hz = 2400, q = 1.1,
      type = 'bandpass', sweepTo = null,
    } = opts;
    if (!noiseBuffer) return;
    const start = c.currentTime + at;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(hz, start);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(Math.max(60, sweepTo), start + dur);
    filter.Q.value = q;
    const amp = c.createGain();
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), start + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filter).connect(amp).connect(panner(c, pan));
    src.start(start);
    src.stop(start + dur + 0.02);
  }

  /* Kalimba: a metal tine over a wooden box — fundamental plus two
     inharmonic partials that die away faster than the root note. */
  function kalimba(c, freq, { at = 0, gain = 0.22, pan = 0, dur = 0.9 } = {}) {
    tone(c, { freq, type: 'sine', at, dur, gain, pan, attack: 0.002 });
    tone(c, { freq: freq * 2.02, type: 'sine', at: at + 0.004, dur: dur * 0.42, gain: gain * 0.3, pan });
    tone(c, { freq: freq * 3.87, type: 'sine', at: at + 0.002, dur: dur * 0.2, gain: gain * 0.1, pan });
    noise(c, { at, dur: 0.03, gain: 0.04, pan, hz: freq * 6, q: 2 });
  }

  /* Djembe: a tuned goat-skin membrane. A sharp pitch drop reads as the
     slap; a low noise band reads as the body of the drum. */
  function djembe(c, { at = 0, gain = 0.33, pan = 0, pitch = 150 } = {}) {
    tone(c, { freq: pitch, to: pitch * 0.44, type: 'sine', at, dur: 0.22, gain, pan, glide: 0.14 });
    tone(c, { freq: pitch * 0.5, type: 'triangle', at, dur: 0.3, gain: gain * 0.35, pan });
    noise(c, { at, dur: 0.07, gain: gain * 0.5, pan, hz: 1300, q: 0.8, sweepTo: 420 });
  }

  const RECIPE = {
    /* a single cast-metal switch */
    tick(c, o) { tone(c, { freq: 1720, type: 'square', dur: 0.03, gain: 0.05, pan: o.pan }); noise(c, { dur: 0.025, gain: 0.09, pan: o.pan, hz: 3200, q: 1.4 }); },
    /* one key of the console */
    key(c, o) {
      const f = 760 + (o.pitch || 0) * 46;
      tone(c, { freq: f, type: 'triangle', dur: 0.035, gain: 0.05, pan: o.pan });
      noise(c, { dur: 0.02, gain: 0.05, pan: o.pan, hz: 2600, q: 2 });
    },
    /* pre-flight click on submit */
    click(c, o) { tone(c, { freq: 980, to: 620, type: 'square', dur: 0.07, gain: 0.09, pan: o.pan }); noise(c, { dur: 0.04, gain: 0.08, pan: o.pan, hz: 1800 }); },
    /* a ratchet: stepped pawl over a gear */
    ratchet(c, o) {
      const steps = o.steps || 4;
      for (let i = 0; i < steps; i += 1) {
        noise(c, { at: i * 0.055, dur: 0.028, gain: 0.1 - i * 0.012, pan: o.pan, hz: 3000 - i * 220, q: 2.2 });
        tone(c, { freq: 1200 - i * 90, type: 'square', at: i * 0.055, dur: 0.03, gain: 0.04, pan: o.pan });
      }
    },
    /* a servo steering a dial */
    servo(c, o) {
      const dir = o.dir || 1;
      const dur = o.dur || 0.34;
      tone(c, { freq: 86, to: 190 * dir + 90, type: 'sawtooth', dur, gain: 0.05 * (o.gain || 1), pan: o.pan, glide: dur * 0.8 });
      noise(c, { dur, gain: 0.035 * (o.gain || 1), pan: o.pan, hz: 900, sweepTo: 2200, q: 0.7 });
    },
    /* a heavy latch seating into its strike plate */
    latch(c, o) {
      noise(c, { dur: 0.16, gain: 0.22, pan: o.pan, hz: 1500, q: 0.7, sweepTo: 300 });
      tone(c, { freq: 92, to: 48, type: 'sine', dur: 0.22, gain: 0.3, pan: o.pan, glide: 0.16 });
      tone(c, { freq: 2400, type: 'sine', dur: 0.12, gain: 0.05, pan: o.pan });
      noise(c, { at: 0.09, dur: 0.03, gain: 0.09, pan: o.pan, hz: 2600, q: 3 });
    },
    /* the vault door swings open */
    open(c, o) {
      RECIPE.latch(c, o);
      RECIPE.servo(c, { ...o, dir: 1, dur: 0.5 });
      kalimba(c, 587.33, { at: 0.32, gain: 0.15, pan: o.pan });
    },
    /* NURU answering: kalimba consultation phrase (D pentatonic) */
    consult(c, o) {
      const pan = o.pan || 0;
      const notes = [293.66, 349.23, 392.0, 587.33];
      notes.forEach((freq, i) => kalimba(c, freq, { at: i * 0.11, gain: 0.15 - i * 0.015, pan, dur: 1.1 }));
      djembe(c, { at: 0.02, gain: 0.1, pan, pitch: 120 });
    },
    /* NURU listening */
    listen(c, o) { tone(c, { freq: 660, to: 990, type: 'sine', dur: 0.12, gain: 0.07, pan: o.pan, glide: 0.1 }); },
    /* a single kalimba note as an acknowledgement */
    chime(c, o) { kalimba(c, o.freq || 587.33, { gain: 0.18, pan: o.pan }); },
    /* two rising notes */
    confirm(c, o) {
      kalimba(c, 523.25, { gain: 0.15, pan: o.pan, dur: 0.6 });
      kalimba(c, 783.99, { at: 0.1, gain: 0.13, pan: o.pan, dur: 0.7 });
    },
    /* money moving: drum body, then coin plinks walking across the stereo field */
    money(c, o) {
      djembe(c, { gain: 0.16, pan: o.pan || 0, pitch: 130 });
      const spread = o.spread ?? 0.7;
      const base = o.pan || 0;
      for (let i = 0; i < 6; i += 1) {
        const pan = clamp(base + (i / 5 - 0.5) * spread * 2, -0.95, 0.95);
        tone(c, { freq: 2100 + Math.random() * 1500, type: 'sine', at: 0.06 + i * 0.045, dur: 0.16, gain: 0.05, pan });
      }
    },
    /* something did not seat */
    error(c, o) {
      tone(c, { freq: 168, to: 120, type: 'square', dur: 0.16, gain: 0.1, pan: o.pan });
      tone(c, { freq: 121, type: 'square', at: 0.13, dur: 0.2, gain: 0.08, pan: o.pan });
      noise(c, { at: 0.02, dur: 0.12, gain: 0.05, pan: o.pan, hz: 700, q: 0.9 });
    },
    /* seal closing on the pot */
    seal(c, o) {
      RECIPE.latch(c, o);
      djembe(c, { at: 0.14, gain: 0.2, pan: o.pan || 0, pitch: 100 });
    },
    /* soft run for a page transition */
    page(c, o) {
      noise(c, { dur: 0.22, gain: 0.05, pan: o.pan || 0, hz: 500, sweepTo: 2600, q: 0.6 });
      tone(c, { freq: 140, to: 110, type: 'sine', dur: 0.14, gain: 0.08, pan: o.pan || 0 });
    },
  };

  function play(name, opts = {}) {
    if (!enabled) return false;
    const c = live();
    if (!c) return false;
    const recipe = RECIPE[name];
    if (!recipe) return false;
    try {
      recipe(c, {
        pan: clamp(Number(opts.pan) || 0, -1, 1),
        ...opts,
      });
      return true;
    } catch { return false; }
  }

  /* Where a sound should come from: the horizontal position of the
     element on screen, mapped to the stereo field. */
  function panFor(element) {
    if (!element || typeof element.getBoundingClientRect !== 'function') return 0;
    const rect = element.getBoundingClientRect();
    const centre = rect.left + rect.width / 2;
    const width = globalThis.innerWidth || 1;
    return clamp(((centre / width) * 2 - 1) * 0.85, -0.9, 0.9);
  }

  function enabledNow() { return enabled; }

  function setEnabled(value) {
    enabled = Boolean(value);
    write(enabled);
    if (!enabled) { try { ctx?.suspend?.(); } catch { /* already closed */ } }
    else unlock();
    reflect();
    document.dispatchEvent(new CustomEvent('wheel:sound', { detail: { enabled } }));
    return enabled;
  }

  function toggle(force) {
    const next = typeof force === 'boolean' ? force : !enabled;
    if (next === enabled) return enabled;
    setEnabled(next);
    if (next) play('confirm', { pan: 0 });
    return enabled;
  }

  function reflect() {
    document.documentElement.dataset.sound = enabled ? 'on' : 'off';
    document.querySelectorAll('[data-sound-label]').forEach((node) => {
      node.textContent = enabled ? 'Sound on' : 'Sound off';
    });
    document.querySelectorAll('[data-sound-icon] use').forEach((node) => {
      node.setAttribute('href', enabled ? '#i-sound-on' : '#i-sound-off');
    });
    document.querySelectorAll('[data-action="toggle-sound"]').forEach((node) => {
      node.setAttribute('aria-pressed', String(enabled));
      node.setAttribute('aria-label', enabled ? 'Turn machine sound off' : 'Turn machine sound on');
    });
  }

  globalThis.WheelSound = {
    play,
    panFor,
    unlock,
    toggle,
    setEnabled,
    enabled: enabledNow,
    context: () => (ctx && ctx.state === 'running' ? ctx : null),
  };

  reflect();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindGesture, { once: true });
  else bindGesture();
})();
