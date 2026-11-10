

const Priority = Object.freeze({ AMBIENT: 0, KILL: 1, WEAPON: 2, UI: 3 });

const SFX_MAX = 20;
const BURST_WINDOW = 0.06;
const MAX_TINKS_PER_FRAME = 4;

class SfxVoice {
  constructor(sfx, t0, { volume = 1, pan = 0, reverb = 0, shaper = null }) {
    this.audio = sfx.audio;
    this.engine = sfx.engine;
    this.rand = sfx.rand;
    this.t0 = t0;
    this.out = this.audio.outChain(volume, pan, reverb);
    this.shaper = null;
    if (shaper) {
      this.shaper = this.audio.ctx.createWaveShaper();
      this.shaper.curve = shaper;
      this.shaper.connect(this.out);
    }
    this._lastSrc = null;
    this._lastEnd = -Infinity;
  }

  /**
   * Filtered noise burst.
   * o: { at, len, rate, type, freq, q, sweep:[[freq,time],…],
   *      attack, peak, decay, env:(param,t)=>void, dry }
   * `dry` skips the waveshaper (if the voice has one).
   */
  noise(o) {
    const a = this.audio;
    const t = this.t0 + (o.at ?? 0);
    const src = o.rate === undefined ? a.noiseSource() : a.noiseSource(o.rate);
    const filter = a.filter(o.type, o.freq, o.q ?? 1);
    this._sweep(filter.frequency, t, o.freq, o.sweep);
    const g = a.gain(0);
    this._envelope(g.gain, t, o);
    src.connect(filter).connect(g).connect(this._dest(o));
    src.start(t, this.rand(0, 2));
    src.stop(t + o.len);
    this._track(src, t + o.len);
    return this;
  }

  /**
   * Oscillator.
   * o: { at, len, type, freq, sweep:[[freq,time],…], vibrato:[rate,depth],
   *      attack, peak, decay, env, dry }
   */
  tone(o) {
    const a = this.audio;
    const t = this.t0 + (o.at ?? 0);
    const osc = a.osc(o.type ?? 'sine', o.freq);
    this._sweep(osc.frequency, t, o.freq, o.sweep);
    const g = a.gain(0);
    this._envelope(g.gain, t, o);
    if (o.vibrato) {
      const vib = a.osc('sine', o.vibrato[0]);
      const depth = a.gain(o.vibrato[1]);
      vib.connect(depth).connect(osc.frequency);
      vib.start(t);
      vib.stop(t + o.len);
      this._track(vib, t + o.len);
    }
    osc.connect(g).connect(this._dest(o));
    osc.start(t);
    osc.stop(t + o.len);
    this._track(osc, t + o.len);
    return this;
  }

  /** Called once everything is scheduled. */
  seal() {
    if (!this._lastSrc) return this._free();
    this._lastSrc.onended = () => this._free();
  }

  _free() {
    this.out.disconnect();
    if (this.shaper) this.shaper.disconnect();
  }
  _dest(o) {
    return this.shaper && !o.dry ? this.shaper : this.out;
  }
  _envelope(param, t, o) {
    if (o.env) o.env(param, t);
    else this.engine.envAD(param, t, o.attack, o.peak, o.decay);
  }
  _sweep(param, t, from, steps) {
    if (!steps) return;
    param.setValueAtTime(from, t);
    for (const [to, time] of steps) param.exponentialRampToValueAtTime(to, t + time);
  }
  _track(src, end) {
    if (end > this._lastEnd) {
      this._lastEnd = end;
      this._lastSrc = src;
    }
  }
}

export default class Sfx {
  constructor({ audio, engine, rand, isMuted = () => false }) {
    this.audio = audio;
    this.engine = engine;
    this.rand = rand;
    this.isMuted = isMuted;

    this.tinkBudget = 0;
    this._ends = [];
    this._winStart = -1;
    this._winCount = 0;
    this._curves = new Map();
  }

  get canPlay() {
    const ctx = this.audio.ctx;
    return !!ctx && ctx.state === 'running' && !this.isMuted();
  }

  /* ---------------- internals ---------------- */

  /** Voice limiter: drops low-priority sounds when the engine is busy. */
  _gate(prio, dur) {
    if (!this.canPlay) return false;
    const now = this.audio.ctx.currentTime;
    const ends = this._ends;
    for (let i = ends.length - 1; i >= 0; i--) if (ends[i] <= now) ends.splice(i, 1);

    if (now - this._winStart > BURST_WINDOW) {
      this._winStart = now;
      this._winCount = 0;
    }
    const lim = Object.freeze({
      [Priority.AMBIENT]: { cap: SFX_MAX - 8, burst: 2 },
      [Priority.KILL]: { cap: SFX_MAX, burst: 4 },
      [Priority.WEAPON]: { cap: SFX_MAX + 4, burst: 6 },
    })[prio];
    if (lim && (ends.length >= lim.cap || this._winCount >= lim.burst)) return false;

    ends.push(now + dur);
    this._winCount++;
    return true;
  }

  _curve(amount) {
    let c = this._curves.get(amount);
    if (!c) this._curves.set(amount, (c = this.engine.makeCurve(amount)));
    return c;
  }

  /**
   * Build and schedule one voice.
   * opts: { at (s from now) | time (absolute), volume, pan, reverb, shaper }
   */
  _play(opts, build) {
    const ctx = this.audio.ctx;
    const t0 = opts.time ?? ctx.currentTime + (opts.at ?? 0);
    const voice = new SfxVoice(this, t0, opts);
    build(voice);
    voice.seal();
  }

  _click(time, freq, volume, dur = 0.02, q = 5) {
    const r = this.rand;
    this._play({ time, volume }, (s) => {
      s.noise({ rate: r(0.9, 1.2), type: 'bandpass', freq, q, len: dur + 0.03, attack: 0.0008, peak: 1, decay: dur });
      s.tone({ type: 'square', freq: freq * 0.5, len: dur + 0.02, attack: 0.0005, peak: 0.12, decay: dur * 0.6 });
    });
  }

  /* ---------------- weapons ---------------- */

  gun(pan = 0) {
    if (!this._gate(Priority.WEAPON, 0.3)) return;
    const r = this.rand(0.92, 1.08);
    this._play(
      { at: 0.002, volume: 0.95, pan: pan * 0.6, reverb: 0.55, shaper: this._curve(2.5) },
      (s) => {
        s.noise({ rate: this.rand(0.9, 1.15), type: 'highpass', freq: 2400, q: 0.7, len: 0.07, attack: 0.0008, peak: 1, decay: 0.045 });
        s.noise({ type: 'lowpass', freq: 7000 * r, q: 0.8, sweep: [[260, 0.22]], len: 0.3, attack: 0.0015, peak: 0.95, decay: 0.24 });
        s.tone({ freq: 165 * r, sweep: [[44, 0.1]], len: 0.22, attack: 0.002, peak: 1.15, decay: 0.17 });
      }
    );
  }

  /** Spent shell casing. */
  tink(vol = 1, pan = 0) {
    if (this.tinkBudget >= MAX_TINKS_PER_FRAME || !this._gate(Priority.AMBIENT, 0.17)) return;
    this.tinkBudget++;
    const r = this.rand(0.88, 1.12);
    this._play({ volume: 0.17 * vol, pan: pan * 0.5 }, (s) => {
      for (const [f, d, a] of [[3150, 0.16, 1], [6820, 0.07, 0.5]]) {
        s.tone({ freq: f * r, len: d + 0.05, attack: 0.0008, peak: a, decay: d * this.rand(0.8, 1.2) });
      }
    });
  }

  swing(pan = 0, vol = 1) {
    if (!this._gate(Priority.AMBIENT, 0.25)) return;
    this._play({ volume: 0.42 * vol, pan: pan * 0.5 }, (s) => {
      s.noise({
        rate: this.rand(0.9, 1.1), type: 'bandpass', freq: 420, q: 1.6,
        sweep: [[2300, 0.13], [900, 0.22]], len: 0.26,
        env: (p, t) => {
          p.setValueAtTime(0.0001, t);
          p.exponentialRampToValueAtTime(0.9, t + 0.1);
          p.exponentialRampToValueAtTime(0.0001, t + 0.24);
        },
      });
    });
  }

  /** Bat hit: wooden "tock" + body thump. */
  bat(pan = 0, vol = 1) {
    if (!this._gate(Priority.KILL, 0.18)) return;
    const r = this.rand;
    this._play({ at: 0.002, volume: 0.95 * vol, pan: pan * 0.5, reverb: 0.3 }, (s) => {
      s.tone({ type: 'triangle', freq: 980 * r(0.93, 1.07), len: 0.09, attack: 0.0008, peak: 0.55, decay: 0.06 });
      s.tone({ freq: 1620 * r(0.95, 1.05), len: 0.06, attack: 0.0008, peak: 0.3, decay: 0.035 });
      s.noise({ rate: 1.2, type: 'bandpass', freq: 2600, q: 2.5, len: 0.04, attack: 0.0006, peak: 0.8, decay: 0.025 });
      s.tone({ freq: 140, sweep: [[48, 0.14]], len: 0.2, attack: 0.002, peak: 1, decay: 0.16 });
      s.noise({ at: 0.004, rate: 0.6, type: 'lowpass', freq: 900, len: 0.116, attack: 0.002, peak: 0.7, decay: 0.08 });
    });
  }

  stab(pan = 0, vol = 1) {
    if (!this._gate(vol >= 1 ? Priority.WEAPON : Priority.KILL, 0.2)) return;
    this._play({ volume: 0.9 * vol, pan: pan * 0.4, reverb: 0.2 }, (s) => {
      // whoosh
      s.noise({ type: 'bandpass', freq: 900, q: 2.4, sweep: [[4200, 0.07]], len: 0.1, attack: 0.01, peak: 0.5, decay: 0.06 });
      // wet thrust
      s.noise({ at: 0.055, rate: 0.8, type: 'lowpass', freq: 2200, q: 9, sweep: [[320, 0.13]], len: 0.2, attack: 0.002, peak: 1, decay: 0.14 });
      s.tone({ at: 0.055, freq: 130, sweep: [[55, 0.1]], len: 0.16, attack: 0.002, peak: 0.95, decay: 0.12 });
      // blade ring
      s.tone({ at: 0.045, type: 'triangle', freq: 5200, len: 0.07, attack: 0.001, peak: 0.05, decay: 0.05 });
    });
  }

  shotgunOut(pan = 0) {
    if (!this._gate(Priority.UI, 0.9)) return;
    this._play(
      { at: 0.002, volume: 1.1, pan: pan * 0.5, reverb: 0.9, shaper: this._curve(4.5) },
      (s) => {
        s.noise({ rate: this.rand(0.85, 1), type: 'highpass', freq: 1600, q: 0.6, len: 0.12, attack: 0.0008, peak: 1, decay: 0.08 });
        s.noise({ rate: 0.8, type: 'lowpass', freq: 5200, q: 0.7, sweep: [[160, 0.45]], len: 0.55, attack: 0.002, peak: 1.2, decay: 0.48 });
        s.tone({ freq: 110, sweep: [[30, 0.3]], len: 0.4, attack: 0.003, peak: 1.5, decay: 0.34 });
        s.tone({ at: 0.01, type: 'triangle', freq: 55, len: 0.59, attack: 0.01, peak: 0.7, decay: 0.5, dry: true });
      }
    );
  }

  /** Pump action "chk-chk". */
  pumpOut(delay = 0) {
    if (!this._gate(Priority.WEAPON, 0.4)) return;
    const t = this.audio.ctx.currentTime + delay;
    this._click(t, 1100, 0.75, 0.05, 2.5);
    this._click(t + 0.02, 2600, 0.4, 0.03, 6);
    this._click(t + 0.2, 1400, 0.85, 0.05, 2.5);
    this._click(t + 0.215, 3400, 0.55, 0.03, 8);
  }

  gunDrop(pan = 0, delay = 0.12) {
    if (!this._gate(Priority.KILL, 0.4 + delay)) return;
    const t = this.audio.ctx.currentTime + delay;
    this._play({ time: t, volume: 0.55, pan: pan * 0.5, reverb: 0.2 }, (s) => {
      s.noise({ rate: 0.7, type: 'lowpass', freq: 900, len: 0.16, attack: 0.003, peak: 0.9, decay: 0.12 });
    });
    this._click(t + 0.01, 2400, 0.35, 0.03, 6);
    this._click(t + 0.11, 1800, 0.25, 0.03, 5);
  }

  /* ---------------- bodies ---------------- */

  flesh(vol = 1, pan = 0) {
    if (!this._gate(Priority.KILL, 0.14)) return;
    this._play({ at: 0.004, volume: 0.85 * vol, pan: pan * 0.5, reverb: 0.18 }, (s) => {
      s.noise({ rate: this.rand(0.7, 0.9), type: 'lowpass', freq: 1100, q: 1.4, len: 0.12, attack: 0.002, peak: 0.9, decay: 0.07 });
      s.tone({ freq: 95, sweep: [[52, 0.09]], len: 0.14, attack: 0.002, peak: 0.9, decay: 0.1 });
      // wet squelch
      s.noise({ at: 0.012, rate: this.rand(1, 1.3), type: 'bandpass', freq: 1500, q: 1.6, len: 0.088, attack: 0.002, peak: 0.55, decay: 0.06 });
    });
  }

  splat(vol = 1, pan = 0) {
    if (!this._gate(Priority.AMBIENT, 0.1)) return;
    this._play({ volume: 0.45 * vol, pan: pan * 0.5 }, (s) => {
      for (let i = 0; i < 2; i++) {
        s.noise({
          at: i * this.rand(0.012, 0.03), rate: this.rand(0.8, 1.4),
          type: 'bandpass', freq: this.rand(700, 1400), q: 2.2, len: 0.1,
          attack: 0.001, peak: this.rand(0.4, 0.8), decay: this.rand(0.03, 0.06),
        });
      }
    });
  }

  fall(vol = 1, pan = 0) {
    if (!this._gate(Priority.AMBIENT, 0.22)) return;
    this._play({ volume: 0.75 * vol, pan: pan * 0.5 }, (s) => {
      s.tone({ freq: 80, sweep: [[36, 0.16]], len: 0.25, attack: 0.003, peak: 1, decay: 0.18 });
      s.noise({ rate: 0.6, type: 'lowpass', freq: 420, q: 0.8, len: 0.16, attack: 0.002, peak: 0.7, decay: 0.11 });
    });
  }

  /** Getting grabbed: body thud + cloth rustle + short grunt (mids so phone speakers carry it). */
  grab(pan = 0, vol = 1) {
    if (!this._gate(vol >= 1 ? Priority.WEAPON : Priority.AMBIENT, 0.18)) return;
    this._play({ volume: vol, pan: pan * 0.5, reverb: 0.12 }, (s) => {
      s.noise({ rate: 0.5, type: 'lowpass', freq: 700, len: 0.16, attack: 0.008, peak: 0.8, decay: 0.11 });
      s.tone({ freq: 140, sweep: [[85, 0.08]], len: 0.12, attack: 0.004, peak: 0.7, decay: 0.09 });
      s.noise({ at: 0.004, rate: this.rand(1, 1.3), type: 'bandpass', freq: 1700, q: 1.2, sweep: [[650, 0.1]], len: 0.146, attack: 0.003, peak: 0.8, decay: 0.09 });
      s.tone({ at: 0.01, type: 'triangle', freq: 360, sweep: [[180, 0.09]], len: 0.15, attack: 0.006, peak: 0.38, decay: 0.1 });
    });
  }

  /* ---------------- UI / events ---------------- */

  /** Item pickup chirp. Bypasses the limiter so combat can't mask it. */
  itemPickup() {
    if (!this.canPlay) return;
    const notes = [[1318.51, 0, 0.07], [1760, 0.075, 0.07], [2637.02, 0.15, 0.16]];
    this._play({ at: 0.002, volume: 0.48 }, (s) => {
      for (const [f, at, decay] of notes) {
        s.tone({ at, type: 'triangle', freq: f, len: decay + 0.025, attack: 0.002, peak: 0.68, decay });
        s.tone({ at, freq: f * 2, len: decay + 0.025, attack: 0.001, peak: 0.14, decay: decay * 0.65 });
      }
    });
  }

  /** High-five "clap!" */
  clap() {
    if (!this._gate(Priority.UI, 0.15)) return;
    this._play({ at: 0.002, volume: 1.05, reverb: 0.42 }, (s) => {
      s.noise({
        rate: this.rand(0.95, 1.05), type: 'bandpass', freq: 1750, q: 1.1, len: 0.15,
        env: (p, t) => {
          p.setValueAtTime(0.0001, t);
          [0, 0.006, 0.013].forEach((d, i) => {
            p.setValueAtTime(i ? 0.75 : 1.1, t + d);
            p.exponentialRampToValueAtTime(0.12, t + d + 0.005);
          });
          p.setValueAtTime(0.95, t + 0.019);
          p.exponentialRampToValueAtTime(0.0001, t + 0.13);
        },
      });
      s.noise({ rate: 1.3, type: 'highpass', freq: 4200, q: 0.7, len: 0.07, attack: 0.0006, peak: 0.5, decay: 0.05 });
      s.tone({ freq: 330, sweep: [[140, 0.06]], len: 0.09, attack: 0.001, peak: 0.55, decay: 0.06 });
    });
  }

  /** Social-media notification. */
  chime() {
    if (!this._gate(Priority.UI, 0.5)) return;
    this._play({ at: 0.01, volume: 0.36, reverb: 0.22 }, (s) => {
      for (const [f, at] of [[1567.98, 0], [2093, 0.085]]) {
        s.tone({ at, freq: f, len: 0.5, attack: 0.003, peak: 0.8, decay: 0.42 });
        s.tone({ at, type: 'triangle', freq: f * 2, len: 0.16, attack: 0.002, peak: 0.12, decay: 0.12 });
      }
    });
  }

  stamp() {
    if (!this._gate(Priority.UI, 0.35)) return;
    this._play({ volume: 1, reverb: 0.45 }, (s) => {
      s.tone({ freq: 110, sweep: [[34, 0.28]], len: 0.35, attack: 0.002, peak: 1.2, decay: 0.3 });
      s.noise({ rate: 0.7, type: 'lowpass', freq: 1400, q: 0.8, len: 0.14, attack: 0.001, peak: 0.9, decay: 0.09 });
      s.noise({ rate: 1.2, type: 'highpass', freq: 2500, q: 0.7, len: 0.06, attack: 0.0008, peak: 0.5, decay: 0.035 });
    });
  }

  sparkle(vol = 1) {
    if (!this._gate(Priority.UI, 0.7)) return;
    this._play({ volume: 0.32 * vol, reverb: 0.6 }, (s) => {
      [1567.98, 2093, 2637, 3136, 4186].forEach((f, i) => {
        s.tone({
          at: i * 0.045, type: i % 2 ? 'sine' : 'triangle', freq: f, vibrato: [7, f * 0.004],
          len: 0.7, attack: 0.002, peak: i === 4 ? 0.7 : 0.5, decay: 0.55,
        });
      });
      s.noise({ at: 0.1, rate: 1.4, type: 'highpass', freq: 7000, q: 0.7, len: 0.5, attack: 0.05, peak: 0.12, decay: 0.35 });
    });
  }

  type() {
    if (!this._gate(Priority.UI, 0.04)) return;
    this._play({ volume: 0.16, pan: this.rand(-0.2, 0.2) }, (s) => {
      s.noise({ rate: this.rand(0.9, 1.3), type: 'bandpass', freq: this.rand(2600, 4200), q: 2, len: 0.04, attack: 0.001, peak: 1, decay: 0.022 });
    });
  }

  heart(vol = 1) {
    if (!this._gate(Priority.UI, 0.4)) return;
    this._play({ at: 0.005, volume: 0.9 * vol }, (s) => {
      for (const [at, peak] of [[0, 1], [0.16, 0.7]]) {
        s.tone({ at, freq: 70, sweep: [[42, 0.12]], len: 0.18, attack: 0.006, peak, decay: 0.14 });
      }
    });
  }

  /* ---------------- cinematic (not limited) ---------------- */

  /** Big boom + gong. `t` is an absolute AudioContext time. */
  impact(t) {
    if (!this.canPlay) return;
    const base = 98;
    const partials = [[1, 3.6, 0.5], [1.483, 3.0, 0.42], [1.932, 2.6, 0.35], [2.546, 2.2, 0.3],
    [2.63, 2.0, 0.26], [3.358, 1.6, 0.2], [4.1, 1.2, 0.16], [5.4, 0.9, 0.1]];
    this._play({ time: t ?? this.audio.ctx.currentTime, volume: 1, reverb: 0.8 }, (s) => {
      s.tone({ freq: 78, sweep: [[34, 1.2]], len: 1.8, attack: 0.004, peak: 1.3, decay: 1.6 });
      s.noise({ rate: 0.5, type: 'lowpass', freq: 1600, q: 0.7, sweep: [[120, 1.0]], len: 1.2, attack: 0.003, peak: 1, decay: 1.0 });
      for (const [m, d, a] of partials) {
        s.tone({
          freq: base * m * 1.012, sweep: [[base * m, 0.6]], len: d + 0.05,
          env: (p, tt) => {
            p.setValueAtTime(0.0001, tt);
            p.exponentialRampToValueAtTime(a * 0.55, tt + 0.012);
            p.exponentialRampToValueAtTime(0.0001, tt + d);
          },
        });
      }
    });
  }

  /** Rising whoosh. `t` is an absolute AudioContext time. */
  riser(t, dur) {
    if (!this.canPlay) return;
    this._play({ time: t, volume: 0.6, reverb: 0.4 }, (s) => {
      s.noise({
        type: 'bandpass', freq: 300, q: 3, sweep: [[7000, dur]], len: dur + 0.02,
        env: (p, tt) => {
          p.setValueAtTime(0.0001, tt);
          p.exponentialRampToValueAtTime(0.5, tt + dur * 0.95);
          p.linearRampToValueAtTime(0, tt + dur);
        },
      });
    });
  }

  doorSlamOut() {
    if (!this.canPlay) return;
    const t = this.audio.ctx.currentTime + 0.01;
    this._play({ time: t, volume: 1.05, reverb: 0.7 }, (s) => {
      s.tone({ freq: 115, sweep: [[42, 0.25]], len: 0.36, attack: 0.003, peak: 1.1, decay: 0.3 });
      s.noise({ rate: 0.9, type: 'bandpass', freq: 700, q: 1.3, len: 0.22, attack: 0.002, peak: 1, decay: 0.16 });
    });
    this._click(t + 0.03, 2500, 0.6, 0.03, 6);
    this._click(t + 0.08, 3300, 0.35, 0.02, 7);
  }
}