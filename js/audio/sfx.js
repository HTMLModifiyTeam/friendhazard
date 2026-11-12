import AudioEngine from "./AudioEngine.js";
import { rand } from "../utils.js";

const Priority = Object.freeze({ AMBIENT: 0, KILL: 1, WEAPON: 2, UI: 3 });

const SFX_MAX = 20;
const BURST_WINDOW = 0.06;
const MAX_TINKS_PER_FRAME = 4;

class SfxVoice {
  constructor(sfx, t0, { volume = 1, pan = 0, reverb = 0, lp = 0, shaper = null }) {
    this.audio = sfx.audio;
    this.engine = sfx.engine;
    this.t0 = t0;
    this.out = this.audio.outChain(volume, pan, reverb, lp);
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
    this._sweep(filter.frequency, t, o.freq, o.sweep, o.linear);
    const g = a.gain(0);
    this._envelope(g.gain, t, o);
    src.connect(filter).connect(g).connect(this._dest(o));
    src.start(t, rand(0, 2));
    src.stop(t + o.len);
    this._track(src, t + o.len);
    return this;
  }

  /**
   * Oscillator.
   * o: { at, len, type, freq, sweep:[[freq,time],…], vibrato:[rate,depth],
   *      linear (sweep linearly), filter:[type,freq,q] (osc -> filter -> gain),
   *      attack, peak, decay, env, dry }
   */
  tone(o) {
    const a = this.audio;
    const t = this.t0 + (o.at ?? 0);
    const osc = a.osc(o.type ?? 'sine', o.freq);
    this._sweep(osc.frequency, t, o.freq, o.sweep, o.linear);
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
    if (o.filter) {
      const f = a.filter(o.filter[0], o.filter[1], o.filter[2] ?? 1);
      osc.connect(f).connect(g);
    } else osc.connect(g);
    g.connect(this._dest(o));
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
    else AudioEngine.envAD(param, t, o.attack, o.peak, o.decay);
  }
  _sweep(param, t, from, steps, linear = false) {
    if (!steps) return;
    param.setValueAtTime(from, t);
    for (const [to, time] of steps) {
      if (linear) param.linearRampToValueAtTime(to, t + time);
      else param.exponentialRampToValueAtTime(to, t + time);
    }
  }
  _track(src, end) {
    if (end > this._lastEnd) {
      this._lastEnd = end;
      this._lastSrc = src;
    }
  }
}

export default class Sfx {
  constructor(audio) {
    this.audio = audio;

    this.tinkBudget = 0;
    this._ends = [];
    this._winStart = -1;
    this._winCount = 0;
    this._curves = new Map();
    this.drag = { v: [] };
    this.hum = { on: false, dead: false };
  }

  /* ---------------- internals ---------------- */

  /** Voice limiter: drops low-priority sounds when the engine is busy. */
  _gate(prio, dur) {
    if (!this.audio.running) return false;
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
    if (!c) this._curves.set(amount, (c = AudioEngine.makeCurve(amount)));
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
    const r = rand;
    this._play({ time, volume }, (s) => {
      s.noise({ rate: r(0.9, 1.2), type: 'bandpass', freq, q, len: dur + 0.03, attack: 0.0008, peak: 1, decay: dur });
      s.tone({ type: 'square', freq: freq * 0.5, len: dur + 0.02, attack: 0.0005, peak: 0.12, decay: dur * 0.6 });
    });
  }

  /* ---------------- weapons ---------------- */

  gun(pan = 0) {
    if (!this._gate(Priority.WEAPON, 0.3)) return;
    const r = rand(0.92, 1.08);
    this._play(
      { at: 0.002, volume: 0.95, pan: pan * 0.6, reverb: 0.55, shaper: this._curve(2.5) },
      (s) => {
        s.noise({ rate: rand(0.9, 1.15), type: 'highpass', freq: 2400, q: 0.7, len: 0.07, attack: 0.0008, peak: 1, decay: 0.045 });
        s.noise({ type: 'lowpass', freq: 7000 * r, q: 0.8, sweep: [[260, 0.22]], len: 0.3, attack: 0.0015, peak: 0.95, decay: 0.24 });
        s.tone({ freq: 165 * r, sweep: [[44, 0.1]], len: 0.22, attack: 0.002, peak: 1.15, decay: 0.17 });
      }
    );
  }

  /** Spent shell casing. */
  tink(vol = 1, pan = 0) {
    if (this.tinkBudget >= MAX_TINKS_PER_FRAME || !this._gate(Priority.AMBIENT, 0.17)) return;
    this.tinkBudget++;
    const r = rand(0.88, 1.12);
    this._play({ volume: 0.17 * vol, pan: pan * 0.5 }, (s) => {
      for (const [f, d, a] of [[3150, 0.16, 1], [6820, 0.07, 0.5]]) {
        s.tone({ freq: f * r, len: d + 0.05, attack: 0.0008, peak: a, decay: d * rand(0.8, 1.2) });
      }
    });
  }

  swing(pan = 0, vol = 1) {
    if (!this._gate(Priority.AMBIENT, 0.25)) return;
    this._play({ volume: 0.42 * vol, pan: pan * 0.5 }, (s) => {
      s.noise({
        rate: rand(0.9, 1.1), type: 'bandpass', freq: 420, q: 1.6,
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
    const r = rand;
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
        s.noise({ rate: rand(0.85, 1), type: 'highpass', freq: 1600, q: 0.6, len: 0.12, attack: 0.0008, peak: 1, decay: 0.08 });
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

  flesh(vol = 1, pan = 0, lp = 0) {
    if (!this._gate(Priority.KILL, 0.14)) return;
    this._play({ at: 0.004, volume: 0.85 * vol, pan: pan * 0.5, reverb: 0.18, lp }, (s) => {
      s.noise({ rate: rand(0.7, 0.9), type: 'lowpass', freq: 1100, q: 1.4, len: 0.12, attack: 0.002, peak: 0.9, decay: 0.07 });
      s.tone({ freq: 95, sweep: [[52, 0.09]], len: 0.14, attack: 0.002, peak: 0.9, decay: 0.1 });
      // wet squelch
      s.noise({ at: 0.012, rate: rand(1, 1.3), type: 'bandpass', freq: 1500, q: 1.6, len: 0.088, attack: 0.002, peak: 0.55, decay: 0.06 });
    });
  }

  splat(vol = 1, pan = 0) {
    if (!this._gate(Priority.AMBIENT, 0.1)) return;
    this._play({ volume: 0.45 * vol, pan: pan * 0.5 }, (s) => {
      for (let i = 0; i < 2; i++) {
        s.noise({
          at: i * rand(0.012, 0.03), rate: rand(0.8, 1.4),
          type: 'bandpass', freq: rand(700, 1400), q: 2.2, len: 0.1,
          attack: 0.001, peak: rand(0.4, 0.8), decay: rand(0.03, 0.06),
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
      s.noise({ at: 0.004, rate: rand(1, 1.3), type: 'bandpass', freq: 1700, q: 1.2, sweep: [[650, 0.1]], len: 0.146, attack: 0.003, peak: 0.8, decay: 0.09 });
      s.tone({ at: 0.01, type: 'triangle', freq: 360, sweep: [[180, 0.09]], len: 0.15, attack: 0.006, peak: 0.38, decay: 0.1 });
    });
  }

  /* ---------------- UI / events ---------------- */

  /** Item pickup chirp. Bypasses the limiter so combat can't mask it. */
  itemPickup() {
    if (!this.audio.running) return;
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
        rate: rand(0.95, 1.05), type: 'bandpass', freq: 1750, q: 1.1, len: 0.15,
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
    this._play({ volume: 0.16, pan: rand(-0.2, 0.2) }, (s) => {
      s.noise({ rate: rand(0.9, 1.3), type: 'bandpass', freq: rand(2600, 4200), q: 2, len: 0.04, attack: 0.001, peak: 1, decay: 0.022 });
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
    if (!this.audio.running) return;
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
    if (!this.audio.running) return;
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
    if (!this.audio.running) return;
    const t = this.audio.ctx.currentTime + 0.01;
    this._play({ time: t, volume: 1.05, reverb: 0.7 }, (s) => {
      s.tone({ freq: 115, sweep: [[42, 0.25]], len: 0.36, attack: 0.003, peak: 1.1, decay: 0.3 });
      s.noise({ rate: 0.9, type: 'bandpass', freq: 700, q: 1.3, len: 0.22, attack: 0.002, peak: 1, decay: 0.16 });
    });
    this._click(t + 0.03, 2500, 0.6, 0.03, 6);
    this._click(t + 0.08, 3300, 0.35, 0.02, 7);
  }

  /* ---------------- weapon handling ---------------- */
  magOut(d = 0) {
    if (!this._gate(Priority.WEAPON, 0.2)) return;
    const t = this.audio.ctx.currentTime + d;
    this._click(t, 2200, 0.45, 0.025);
    this._click(t + 0.05, 1300, 0.3, 0.04, 3);
  }

  magIn(d = 0) {
    if (!this._gate(Priority.WEAPON, 0.2)) return;
    const t = this.audio.ctx.currentTime + d;
    this._click(t, 1500, 0.55, 0.03, 3);
    this._click(t + 0.045, 3200, 0.5, 0.02, 7);
  }

  slide(d = 0) {
    if (!this._gate(Priority.WEAPON, 0.25)) return;
    const t = this.audio.ctx.currentTime + d;
    this._click(t, 2600, 0.5, 0.03, 4);
    this._click(t + 0.09, 3800, 0.65, 0.025, 8);
  }

  shellIn(d = 0) {
    if (!this._gate(Priority.WEAPON, 0.15)) return;
    const t = this.audio.ctx.currentTime + d;
    this._click(t, 1800, 0.5, 0.03, 3);
    this._click(t + 0.035, 900, 0.35, 0.04, 2);
  }

  switchWeapon() {
    if (!this._gate(Priority.WEAPON, 0.3)) return;
    const t = this.audio.ctx.currentTime;
    this._click(t, 1700, 0.3, 0.04, 2);
    this._click(t + 0.16, 2600, 0.35, 0.03, 5);
  }

  /** Picking up a weapon: pump + short low rumble. */
  getGun() {
    if (!this.audio.running) return;
    const t = this.audio.ctx.currentTime;
    this.pumpOut(0.05);
    this._play({ time: t, volume: 0.8, reverb: 0.9 }, (s) => {
      s.tone({ type: 'sawtooth', freq: 55, filter: ['lowpass', 420, 2], len: 1.6, attack: 0.02, peak: 0.6, decay: 1.4 });
      s.tone({ freq: 82.4, len: 1.8, attack: 0.02, peak: 0.5, decay: 1.6 });
    });
  }

  /* ---------------- impacts ---------------- */

  /** Bullet into drywall: dull "pff" + debris. */
  wallHit(v = 1, pan = 0) {
    if (!this._gate(Priority.AMBIENT, 0.12)) return;
    this._play({ at: 0.01, volume: 0.4 * v, pan: pan * 0.5, reverb: 0.25 }, (s) => {
      s.noise({ rate: rand(0.8, 1.1), type: 'bandpass', freq: rand(900, 1400), q: 1.2, len: 0.08, attack: 0.001, peak: 0.9, decay: 0.05 });
      s.noise({ at: 0.02, rate: 1.4, type: 'highpass', freq: 3500, q: 0.7, len: 0.12, attack: 0.004, peak: 0.25, decay: 0.09 });
    });
  }

  /** Headshot: cracking shell + wet burst. */
  head(pan = 0) {
    if (!this._gate(Priority.WEAPON, 0.2)) return;
    this._play({ at: 0.006, volume: 0.9, pan: pan * 0.5, reverb: 0.3 }, (s) => {
      s.noise({ rate: rand(1.1, 1.3), type: 'bandpass', freq: 2400, q: 2, len: 0.05, attack: 0.0006, peak: 1, decay: 0.03 });
      s.noise({ at: 0.008, rate: 0.7, type: 'lowpass', freq: 2400, q: 4, sweep: [[300, 0.132]], len: 0.192, attack: 0.002, peak: 1, decay: 0.13 });
      s.tone({ freq: 150, sweep: [[48, 0.12]], len: 0.18, attack: 0.002, peak: 1, decay: 0.13 });
    });
  }

  hitTick(kill) {
    if (!this.audio.running) return;
    this._play({ at: 0.01, volume: kill ? 0.3 : 0.2 }, (s) => {
      s.tone({ type: 'triangle', freq: kill ? 1650 : 2300, len: 0.1, attack: 0.0008, peak: 1, decay: kill ? 0.07 : 0.035 });
    });
  }

  /* ---------------- footsteps ---------------- */

  /** Player steps. surface: 'vinyl' | 'carpet' | 'wood' | 'tile'. */
  step(surface, v = 1) {
    if (!this._gate(Priority.AMBIENT, 0.12)) return;
    const r = rand;
    this._play({ volume: v, pan: r(-0.12, 0.12), reverb: surface === 'carpet' ? 0.04 : 0.12 }, (s) => {
      if (surface === 'vinyl') {
        s.noise({ rate: r(0.55, 0.7), type: 'lowpass', freq: r(280, 360), q: 0.8, len: 0.12, attack: 0.005, peak: 1.05, decay: 0.08 });
        s.noise({ at: 0.004, rate: r(0.9, 1.15), type: 'bandpass', freq: r(1250, 1600), q: 1.6, len: 0.066, attack: 0.002, peak: 0.5, decay: 0.035 });
        if (Math.random() < 0.35) {
          const at = r(0.05, 0.08);
          s.noise({ at, rate: 1.2, type: 'bandpass', freq: r(2600, 3400), q: 2.2, len: 0.13 - at, attack: 0.003, peak: 0.14, decay: 0.022 });
        }
      } else if (surface === 'carpet') {
        // damp carpet: dull thud + mid "chk" band for phone speakers + cloth drag
        s.noise({ rate: r(0.5, 0.7), type: 'lowpass', freq: r(380, 520), q: 0.8, len: 0.16, attack: 0.008, peak: 0.8, decay: 0.1 });
        s.noise({ at: 0.012, rate: r(0.85, 1.1), type: 'bandpass', freq: r(820, 1050), q: 1.3, len: 0.078, attack: 0.004, peak: 0.2, decay: 0.05 });
        s.noise({ at: 0.025, rate: 1.1, type: 'bandpass', freq: 1900, q: 1.5, len: 0.095, attack: 0.01, peak: 0.09, decay: 0.07 });
      } else {
        const hard = surface === 'tile';
        s.noise({
          rate: r(0.9, 1.2), type: 'bandpass', freq: hard ? r(2400, 3000) : r(1100, 1500), q: hard ? 3 : 2,
          len: 0.06, attack: 0.001, peak: hard ? 0.5 : 0.4, decay: hard ? 0.03 : 0.04,
        });
        s.tone({ freq: hard ? 180 : 120, sweep: [[70, 0.06]], len: 0.09, attack: 0.002, peak: 0.35, decay: 0.06 });
      }
    });
  }

  /** Approaching crowd: dragging through damp carpet (runners are shorter and harder). */
  crowdStep(v, pan, runner) {
    if (!this._gate(Priority.AMBIENT, 0.12)) return;
    const r = rand;
    this._play({ volume: v, pan, reverb: 0.1 }, (s) => {
      s.noise({ rate: r(0.5, 0.7), type: 'lowpass', freq: r(420, 560), q: 0.8, len: 0.18, attack: runner ? 0.004 : 0.012, peak: 0.85, decay: runner ? 0.07 : 0.12 });
      s.noise({ at: 0.01, rate: r(0.85, 1.05), type: 'bandpass', freq: r(850, 1150), q: 1.2, len: 0.09, attack: 0.004, peak: runner ? 0.3 : 0.22, decay: 0.05 });
      if (!runner) s.noise({ at: 0.05, rate: 1, type: 'bandpass', freq: 2200, q: 1.4, len: 0.15, attack: 0.03, peak: 0.06, decay: 0.09 });
    });
  }

  /* ---------------- dragged bodies (continuous, pooled voices) ---------------- */
  // A body scraping over vinyl flooring: an unbroken "shhhhk", with the occasional
  // skin-sticks-then-peels squeak layered on top.

  _dragVoice() {
    const a = this.audio, ctx = a.ctx, t = ctx.currentTime, r = rand;
    const n = a.noiseSource(r(0.85, 1.1));
    const body = a.filter('bandpass', 560, 0.75);
    const low = a.filter('lowpass', 240, 0.7);
    const lowG = a.gain(0.9);
    const lp = a.filter('lowpass', 2400, 0.7);
    const g = a.gain(0);
    n.connect(body).connect(lp);
    n.connect(low).connect(lowG).connect(lp);
    // squeak: sawtooth through a narrow band (silent until triggered)
    const sq = a.osc('sawtooth', 900);
    const sqB = a.filter('bandpass', 1500, 7);
    const sqG = a.gain(0);
    sq.connect(sqB).connect(sqG).connect(lp);
    lp.connect(g);
    const out = a.outChain(1, 0, 0.3);
    const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pn) {
      g.connect(pn);
      pn.connect(out);
    } else g.connect(out);
    n.start(t, r(0, 2));
    sq.start(t);
    return { n, sq, sqB, sqG, lp, g, pn, out, p: null, lv: 0, target: 0, pan: 0, occl: false, ph: r(0, 10), sqT: r(0.4, 1.5) };
  }

  /** items: [{ p (owner key), lv (0..1), pan (-1..1), occl (bool) }]. Call every frame. */
  dragAssign(items, dt = 1 / 60) {
    if (!this.audio.running) return;
    const r = rand, voices = this.drag.v, t = this.audio.ctx.currentTime;
    for (const v of voices) if (v.p && !items.some((it) => it.p === v.p)) v.p = null;
    for (const it of items) {
      let v = voices.find((q) => q.p === it.p);
      if (!v) {
        v = voices.find((q) => !q.p && q.lv < 0.03);
        if (!v && voices.length < 3) {
          v = this._dragVoice();
          voices.push(v);
        }
        if (!v) continue;
        v.p = it.p;
      }
      v.target = it.lv;
      v.pan = it.pan;
      v.occl = it.occl;
    }
    for (const v of voices) {
      const tgt = v.p ? v.target : 0;
      v.lv += (tgt - v.lv) * (1 - Math.exp(-dt * (tgt > v.lv ? 9 : 5)));
      // uneven slide: slow swell with the occasional catch
      v.ph += dt * (1.2 + v.lv * 2.6);
      const wob = 0.66 + 0.34 * Math.sin(v.ph * 2.3) * Math.sin(v.ph * 0.71 + 1.3);
      v.g.gain.setTargetAtTime(v.lv * 0.62 * wob, t, 0.045);
      v.lp.frequency.setTargetAtTime(v.occl ? 650 : 2600, t, 0.12);
      if (v.pn) v.pn.pan.setTargetAtTime(Math.max(-1, Math.min(1, v.pan)), t, 0.05);
      v.sqT -= dt;
      if (v.sqT <= 0) {
        v.sqT = r(0.5, 1.8);
        if (v.lv > 0.08) {
          const f = r(700, 1150), d = r(0.07, 0.17), k = Math.min(1, v.lv * 1.6);
          v.sq.frequency.cancelScheduledValues(t);
          v.sq.frequency.setValueAtTime(f, t);
          v.sq.frequency.exponentialRampToValueAtTime(f * r(0.62, 0.8), t + d);
          v.sqB.frequency.setValueAtTime(f * 1.6, t);
          v.sqG.gain.cancelScheduledValues(t);
          v.sqG.gain.setValueAtTime(0.0001, t);
          v.sqG.gain.exponentialRampToValueAtTime(0.42 * k, t + 0.012);
          v.sqG.gain.setValueAtTime(0.3 * k, t + d * 0.6);
          v.sqG.gain.exponentialRampToValueAtTime(0.0001, t + d);
        }
      }
    }
  }

  dragStop(p) {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    for (const v of this.drag.v) {
      if (v.p !== p) continue;
      v.p = null;
      v.lv = 0;
      try { v.g.gain.setTargetAtTime(0, ctx.currentTime, 0.03); } catch { }
    }
  }

  dragAllStop() {
    const ctx = this.audio.ctx;
    if (!ctx) return;
    for (const v of this.drag.v) {
      v.p = null;
      v.lv = 0;
      try { v.g.gain.setTargetAtTime(0, ctx.currentTime, 0.03); } catch { }
    }
  }

  /* ---------------- doors & room ---------------- */

  /** Door flung open into the wall: wood boom + low thump + knob rattle. */
  doorBang(pan = 0, v = 1, lp = 0) {
    if (!this._gate(Priority.WEAPON, 0.5)) return;
    const t = this.audio.ctx.currentTime + 0.005;
    this._play({ time: t, volume: 1.1 * v, pan: pan * 0.7, reverb: 0.55, lp }, (s) => {
      s.tone({ freq: 110, sweep: [[48, 0.22]], len: 0.32, attack: 0.003, peak: 1, decay: 0.26 });
      s.noise({ rate: rand(0.8, 1), type: 'bandpass', freq: rand(620, 760), q: 1.4, len: 0.22, attack: 0.002, peak: 1, decay: 0.16 });
      s.noise({ rate: 0.5, type: 'lowpass', freq: 400, q: 0.8, len: 0.36, attack: 0.004, peak: 0.8, decay: 0.3 });
    });
    for (const [d, f, a] of [[0.05, 2600, 0.5], [0.09, 3400, 0.35], [0.14, 2200, 0.25]]) {
      this._click(t + d, f, a * v, 0.02, 6);
    }
  }

  /** Standing up from a wheeled chair: squeak + rolling. */
  chair(pan = 0, v = 1) {
    if (!this._gate(Priority.KILL, 0.6)) return;
    this._play({ volume: 0.5 * v, pan: pan * 0.7, reverb: 0.3 }, (s) => {
      s.tone({
        type: 'sawtooth', freq: 480, sweep: [[690, 0.12], [560, 0.26]], linear: true,
        filter: ['bandpass', 1300, 5], len: 0.32,
        env: (p, t) => {
          p.setValueAtTime(0.0001, t);
          p.exponentialRampToValueAtTime(0.5, t + 0.03);
          p.setValueAtTime(0.35, t + 0.18);
          p.exponentialRampToValueAtTime(0.0001, t + 0.3);
        },
      });
      s.noise({
        rate: 0.7, type: 'bandpass', freq: 380, q: 1.1, len: 0.66,
        env: (p, t) => {
          p.setValueAtTime(0.0001, t + 0.08);
          p.exponentialRampToValueAtTime(0.45, t + 0.16);
          p.exponentialRampToValueAtTime(0.0001, t + 0.62);
        },
      });
    });
  }

  /** Digital door lock: beep-beep-beep-beep -> motor -> bolt. `t` is absolute. */
  lock(t) {
    if (!this.audio.running) return;
    this._play({ time: t, volume: 0.32, reverb: 0.12 }, (s) => {
      [1318.5, 1568, 1975.5, 2637].forEach((f, i) => {
        s.tone({ at: i * 0.07, type: 'square', freq: f, filter: ['lowpass', 5000, 0.7], len: 0.09, attack: 0.002, peak: 0.5, decay: 0.06 });
      });
      s.tone({
        at: 0.34, type: 'sawtooth', freq: 140, sweep: [[210, 0.26]], linear: true,
        filter: ['bandpass', 900, 2], len: 0.3,
        env: (p, tm) => {
          p.setValueAtTime(0.0001, tm);
          p.exponentialRampToValueAtTime(0.25, tm + 0.04);
          p.setValueAtTime(0.25, tm + 0.22);
          p.exponentialRampToValueAtTime(0.0001, tm + 0.28);
        },
      });
    });
    this._click(t + 0.64, 1200, 0.8, 0.04, 2);
    this._click(t + 0.67, 2600, 0.5, 0.025, 6);
  }

  /** Bolt/latch. `t` is absolute. */
  latch(t, v = 1) {
    if (!this.audio.running) return;
    this._click(t, 900, 0.7 * v, 0.05, 2);
    this._click(t + 0.03, 2400, 0.45 * v, 0.03, 6);
  }

  /** Rattling a locked front door handle. */
  rattle() {
    if (!this.audio.running) return;
    const t = this.audio.ctx.currentTime + 0.01;
    for (const [d, v] of [[0, 1], [0.12, 0.85], [0.23, 0.6]]) {
      this._play({ time: t + d, volume: 0.6 * v, reverb: 0.3 }, (s) => {
        s.noise({ rate: 0.75, type: 'lowpass', freq: 950, q: 1.4, len: 0.11, attack: 0.002, peak: 1, decay: 0.075 });
        s.tone({ freq: 150, sweep: [[70, 0.06]], len: 0.1, attack: 0.002, peak: 0.7, decay: 0.07 });
      });
      this._click(t + d + 0.004, 1700, 0.55 * v, 0.03, 4);
      this._click(t + d + 0.02, 3100, 0.32 * v, 0.02, 7);
    }
  }

  /** Hinge creak: stick-slip friction. `t` is absolute. */
  creak(t, dur, v = 1, f0 = 150) {
    if (!this.audio.running) return;
    const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
    this._play({ time: t, volume: 0.55 * v, reverb: 0.45 }, (s) => {
      const a = s.audio, r = rand, N = 256;
      const fc = new Float32Array(N), gc = new Float32Array(N);
      let fr = f0, stick = 0;
      for (let i = 0; i < N; i++) {
        const k = i / (N - 1);
        fr = clamp(fr + r(-14, 14), f0 * 0.7, f0 * 1.6);
        stick = Math.random() < 0.18 ? r(0.2, 1) : stick * 0.8;
        fc[i] = fr * (1 + 0.35 * Math.sin(k * 9.0));
        gc[i] = Math.max(0.0001, (0.25 + 0.75 * stick) * Math.sin(Math.PI * Math.min(1, k * 1.08)) * (k < 0.04 ? k / 0.04 : 1));
      }
      const o = a.osc('sawtooth', f0);
      o.frequency.setValueCurveAtTime(fc, t, dur);
      const b1 = a.filter('bandpass', 950, 7);
      const b2 = a.filter('bandpass', 2300, 9);
      const g = a.gain(0);
      g.gain.setValueCurveAtTime(gc, t, dur);
      const mix = a.gain(1);
      o.connect(b1).connect(mix);
      o.connect(b2).connect(mix);
      mix.connect(g).connect(s.out);
      o.start(t);
      o.stop(t + dur + 0.05);
      s._track(o, t + dur + 0.05);
      s.noise({ rate: 0.4, type: 'lowpass', freq: 260, q: 0.7, len: dur + 0.4, attack: 0.3, peak: 0.12, decay: dur });
    });
  }

  /** Motion-sensor light "click". `t` is absolute. */
  sensor(t) {
    if (!this.audio.running) return;
    this._click(t, 3200, 0.45, 0.012, 9);
    this._click(t + 0.018, 1400, 0.25, 0.02, 4);
  }

  /** Fluorescent tube flicker: crackle. */
  flick(v = 1, pan = 0) {
    if (!this._gate(Priority.AMBIENT, 0.18)) return;
    const r = rand;
    const segs = [];
    let tt = 0;
    for (let i = 0; i < 5; i++) {
      const on = tt;
      tt += r(0.008, 0.025);
      segs.push([r(0.3, 1), on, tt]);
      tt += r(0.004, 0.02);
    }
    this._play({ volume: 0.22 * v, pan: pan * 0.6, reverb: 0.15 }, (s) => {
      s.noise({
        rate: r(0.9, 1.4), type: 'bandpass', freq: r(2600, 4200), q: 2.5, len: tt + 0.02,
        env: (p, t) => {
          p.setValueAtTime(0.0001, t);
          for (const [lvl, on, off] of segs) {
            p.setValueAtTime(lvl, t + on);
            p.setValueAtTime(0.0001, t + off);
          }
        },
      });
      s.tone({ type: 'sawtooth', freq: 120, filter: ['bandpass', 480, 3], len: 0.14, attack: 0.004, peak: 0.35, decay: 0.1 });
    });
  }

  /** Breaker trips: "thunk" + electrical zap. */
  breaker() {
    if (!this.audio.running) return;
    const r = rand;
    const t = this.audio.ctx.currentTime + 0.01;
    const segs = [];
    let tt = 0;
    for (let i = 0; i < 9; i++) {
      const on = tt;
      tt += r(0.01, 0.04);
      segs.push([r(0.2, 0.7), on, tt]);
      tt += r(0.004, 0.02);
    }
    this._play({ time: t, volume: 1.15, reverb: 1.2 }, (s) => {
      s.tone({ freq: 70, sweep: [[28, 0.7]], len: 1.1, attack: 0.004, peak: 1.4, decay: 0.9 });
      s.noise({ rate: 0.6, type: 'lowpass', freq: 1600, q: 0.8, sweep: [[90, 0.6]], len: 0.8, attack: 0.002, peak: 1, decay: 0.55 });
      s.noise({
        rate: 1.6, type: 'bandpass', freq: 5200, q: 1.5, sweep: [[700, 0.35]], len: tt + 0.05,
        env: (p, t0) => {
          p.setValueAtTime(0.0001, t0);
          for (const [lvl, on, off] of segs) {
            p.setValueAtTime(lvl, t0 + on);
            p.setValueAtTime(0.0001, t0 + off);
          }
        },
      });
    });
  }

  /** Stepping out the door into the white space. */
  exitToWhite() {
    if (!this.audio.running) return;
    const t = this.audio.ctx.currentTime;
    this.latch(t, 1.2);
    this._play({ time: t, volume: 0.6, reverb: 0.7 }, (s) => {
      s.noise({
        type: 'bandpass', freq: 300, q: 0.8, sweep: [[5000, 1.1]], len: 1.6,
        env: (p, tt) => {
          p.setValueAtTime(0.0001, tt);
          p.exponentialRampToValueAtTime(0.7, tt + 0.9);
          p.exponentialRampToValueAtTime(0.0001, tt + 1.5);
        },
      });
    });
  }

  /* ---------------- fluorescent hum (continuous) ---------------- */

  humStart() {
    const a = this.audio, hum = this.hum;
    if (hum.on || !a.ctx) return;
    const t = a.ctx.currentTime;
    hum.g = a.gain(0);
    hum.lp = a.filter('lowpass', 380, 0.5);
    const o1 = a.osc('sawtooth', 120);
    const b1 = a.filter('bandpass', 360, 0.9);
    const g1 = a.gain(0.22);
    o1.connect(b1).connect(g1).connect(hum.lp);
    const o2 = a.osc('square', 240);
    const b2 = a.filter('bandpass', 960, 3.5);
    const g2 = a.gain(0.05);
    o2.connect(b2).connect(g2).connect(hum.lp);
    const o3 = a.osc('sine', 120);
    const g3 = a.gain(0.2);
    o3.connect(g3).connect(hum.lp);
    const n = a.noiseSource();
    const hp = a.filter('highpass', 5200, 0.7);
    const g4 = a.gain(0.014);
    n.connect(hp).connect(g4).connect(hum.lp);
    hum.lp.connect(hum.g);
    hum.out = a.outChain(1, 0, 0);
    hum.g.connect(hum.out);
    const lfo = a.osc('sine', 0.23);
    const lg = a.gain(0.012);
    lfo.connect(lg).connect(hum.g.gain);
    for (const s of [o1, o2, o3, n, lfo]) s.start(t);
    hum.src = [o1, o2, o3, n, lfo];
    hum.tone = [o1, o2, o3];
    hum.on = true;
    hum.dead = false;
  }

  humSet(level, open) {
    const hum = this.hum;
    if (!hum.on) return;
    const t = this.audio.ctx.currentTime;
    hum.g.gain.setTargetAtTime(hum.dead ? 0 : level * 0.17, t, 0.07);
    hum.lp.frequency.setTargetAtTime(open ? 3600 : 330, t, 0.25);
  }

  /** Lights die: pitch sags and the hum fades out. */
  humKill() {
    const hum = this.hum;
    if (!hum.on || hum.dead) return;
    hum.dead = true;
    const t = this.audio.ctx.currentTime;
    for (const o of hum.tone) {
      o.frequency.cancelScheduledValues(t);
      o.frequency.setValueAtTime(o.frequency.value, t);
      o.frequency.exponentialRampToValueAtTime(o.frequency.value * 0.45, t + 0.8);
    }
    hum.g.gain.cancelScheduledValues(t);
    hum.g.gain.setValueAtTime(hum.g.gain.value, t);
    hum.g.gain.linearRampToValueAtTime(0, t + 0.85);
  }

  humStop() {
    const hum = this.hum;
    if (!hum.on) return;
    const t = this.audio.ctx.currentTime;
    try { for (const s of hum.src) s.stop(t + 0.05); } catch { }
    const { g, out } = hum;
    hum.src[0].onended = () => {
      g.disconnect();
      out.disconnect();
    };
    hum.on = false;
  }
}