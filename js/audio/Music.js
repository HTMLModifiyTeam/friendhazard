import AudioEngine from "./AudioEngine.js";
import { mtof, rand } from "../utils.js";

const THIN_LAYERS = [[1, -18, 1, 'sawtooth'], [1, 18, 1, 'sawtooth']];
const THICK_LAYERS = [[1, -22, 1, 'sawtooth'], [1, 0, 1, 'sawtooth'], [1, 22, 1, 'sawtooth'], [.5, 0, .55, 'square'], [2, 6, .3, 'sawtooth']];

class MusicRig {
  constructor(ctx, { dest, spb, makeIR, noiseBuffer, env }) {
    this.ctx = ctx;
    this.spb = spb;
    this.s16 = spb / 4;
    this.env = env;

    // ---- node factories (arrow fns so they can be destructured) ----
    this.gain = (v) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    this.osc = (type, f) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      return o;
    };
    this.filter = (type, f, q = 1) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };
    this.noise = (rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = noiseBuffer;
      s.loop = true;
      s.playbackRate.value = rate;
      return s;
    };
    this.shaper = (curve, oversample) => {
      const s = ctx.createWaveShaper();
      s.curve = curve;
      if (oversample) s.oversample = oversample;
      return s;
    };
    /** Exponential frequency/filter sweep: ramp(param, t, from, [[to, secondsAfterT], …]) */
    this.ramp = (param, t, from, steps) => {
      param.setValueAtTime(from, t);
      for (const [to, dt] of steps) param.exponentialRampToValueAtTime(to, t + dt);
    };
    /** Start/stop an oscillator. */
    this.go = (src, t, end) => {
      src.start(t);
      src.stop(end);
    };
    /** Start/stop a noise source at a random offset in the buffer. */
    this.goNoise = (src, t, end) => {
      src.start(t, rand(0, 2));
      src.stop(end);
    };
    /** Aux send: node → gain(amount) → target */
    this.send = (node, amount, target) => {
      const s = this.gain(amount);
      node.connect(s);
      s.connect(target);
      return s;
    };

    // ---- buses: duck → bus → dest, short reverb, big hall, dotted-8th delay ----
    this.bus = this.gain(1);
    this.bus.connect(dest);
    this.duck = this.gain(1);
    this.duck.connect(this.bus);

    this.verb = ctx.createConvolver();
    this.verb.buffer = makeIR(ctx, 0.8, 4.2);
    this.verb.connect(this.gain(0.16)).connect(this.bus);

    this.hall = ctx.createConvolver();
    this.hall.buffer = makeIR(ctx, 1.9, 2.8);
    this.hall.connect(this.gain(0.3)).connect(this.bus);

    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = this.s16 * 3;
    const fb = this.gain(0.25);
    const lp = this.filter('lowpass', 2800, 0.5);
    this.delay.connect(lp);
    lp.connect(fb);
    fb.connect(this.delay);
    lp.connect(this.gain(0.16)).connect(this.bus);
  }
}

/* ------------------------------------------------------------------ */
class Synth {
  constructor(rig, curves) {
    this.r = rig;
    this.curves = curves; // { hard, soft }
    this.s16 = rig.s16;
  }

  /** 909-style: fast pitch drop, distorted, plus a click. Also ducks the bus. */
  kick(t, v = 1) {
    const { osc, gain, filter, noise, shaper, ramp, go, goNoise, env, bus, duck } = this.r;
    const o = osc('sine', 210), g = gain(0);
    ramp(o.frequency, t, 210, [[56, 0.045], [42, 0.26]]);
    env(g.gain, t, 0.001, 1.1 * v, 0.33);
    o.connect(g).connect(shaper(this.curves.hard, '2x')).connect(gain(0.85)).connect(bus);
    go(o, t, t + 0.36);

    const n = noise(), gn = gain(0);
    env(gn.gain, t, 0.0005, 0.32 * v, 0.016);
    n.connect(filter('highpass', 2600, 0.8)).connect(gn).connect(bus);
    goNoise(n, t, t + 0.03);

    duck.gain.setValueAtTime(0.3, t);
    duck.gain.linearRampToValueAtTime(1, t + 0.13);
  }

  /** Two body tones + clap-like triple noise burst + gated reverb. */
  snare(t, v = 1) {
    const { osc, gain, filter, noise, ramp, go, goNoise, env, bus, verb } = this.r;
    for (const [f0, f1, a, d] of [[185, 150, 0.5, 0.12], [330, 280, 0.25, 0.08]]) {
      const o = osc('triangle', f0), g = gain(0);
      ramp(o.frequency, t, f0, [[f1, 0.06]]);
      env(g.gain, t, 0.001, a * v, d);
      o.connect(g).connect(bus);
      go(o, t, t + d + 0.02);
    }
    const n = noise(), g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    for (const d of [0, 0.009, 0.019]) {
      g.gain.setValueAtTime(0.5 * v, t + d);
      g.gain.exponentialRampToValueAtTime(0.1 * v, t + d + 0.007);
    }
    g.gain.setValueAtTime(0.42 * v, t + 0.028);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    n.connect(filter('highpass', 1400, 0.7)).connect(filter('lowpass', 9000, 0.7)).connect(g).connect(bus);
    goNoise(n, t, t + 0.22);

    const n2 = noise(), g2 = gain(0);
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.linearRampToValueAtTime(0.16 * v, t + 0.03);
    g2.gain.setValueAtTime(0.16 * v, t + 0.13);
    g2.gain.linearRampToValueAtTime(0, t + 0.15);
    n2.connect(filter('bandpass', 2200, 0.6)).connect(g2).connect(bus);
    goNoise(n2, t, t + 0.17);

    this.r.send(g, 0.3, verb);
  }

  hat(t, v, open) {
    const { gain, filter, noise, goNoise, env, bus } = this.r;
    const n = noise(), pk = filter('peaking', 10000, 1.2), g = gain(0);
    pk.gain.value = 6;
    env(g.gain, t, 0.0006, (open ? 0.2 : 0.14) * v, open ? 0.2 : 0.03);
    n.connect(filter('highpass', open ? 6000 : 7500, 0.7)).connect(pk).connect(g).connect(bus);
    goNoise(n, t, t + (open ? 0.26 : 0.05));
  }

  /** Saw + square + sub through a resonant filter that opens on accents. */
  bass(t, m, dur, acc) {
    const { osc, gain, filter, shaper, ramp, go, env, duck } = this.r;
    const f = mtof(m);
    const o1 = osc('sawtooth', f), o2 = osc('square', f), sub = osc('sine', f);
    o1.detune.value = -6;
    o2.detune.value = 6;
    const lp = filter('lowpass', 800, 5);
    ramp(lp.frequency, t, 420 + 2200 * acc, [[170, dur]]);
    const g = gain(0), g2 = gain(0.35), gs = gain(0);
    env(g.gain, t, 0.002, 0.3 * (0.85 + acc * 0.3), dur);
    env(gs.gain, t, 0.002, 0.22, dur);
    o1.connect(lp);
    o2.connect(g2).connect(lp);
    lp.connect(shaper(this.curves.soft)).connect(g).connect(duck);
    sub.connect(gs).connect(duck);
    for (const o of [o1, o2, sub]) go(o, t, t + dur + 0.02);
  }

  /** Alpha-Juno "hoover": wide detuned saws + sub square + octave up, with a pitch-fall at the start. */
  hoover(t, m, steps, v = 1, thin = false) {
    const { osc, gain, filter, shaper, ramp, go, send, duck, verb, delay } = this.r;
    const dur = Math.max(0.06, steps * this.s16 - 0.015), f = mtof(m);
    const lp = filter('lowpass', 2600, 1.4);
    ramp(lp.frequency, t, 4500, [[2200, Math.max(0.08, dur)]]);
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.34 * v, t + 0.006);
    g.gain.setValueAtTime(0.34 * v, t + dur - 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.03);

    let lfoTarget = null;
    for (const [mul, det, a, type] of (thin ? THIN_LAYERS : THICK_LAYERS)) {
      const o = osc(type, f * mul);
      o.detune.value = det;
      ramp(o.frequency, t, f * mul * 1.6, [[f * mul, steps >= 3 ? 0.11 : 0.065]]);
      o.connect(gain(a * 0.3)).connect(lp);
      go(o, t, t + dur + 0.06);
      if (det === 0 && mul === 1) lfoTarget = o;
    }
    if (lfoTarget) {
      const lfo = osc('sine', 5.5);
      lfo.connect(gain(14)).connect(lfoTarget.detune);
      go(lfo, t, t + dur + 0.06);
    }
    lp.connect(shaper(this.curves.soft)).connect(g).connect(duck);
    send(g, 0.28, verb);
    send(g, 0.14, delay);
  }

  /** Hoover power chord (root + fifth). */
  stab(t, m, steps, v = 1) {
    this.hoover(t, m, steps, v);
    this.hoover(t, m + 7, steps, v * 0.55, true);
  }

  /** Orchestra hit: stacked minor-triad brass + timpani thump + snap, big hall. */
  orch(t, root, v = 1) {
    const { osc, gain, filter, noise, shaper, ramp, go, goNoise, env, send, bus, hall } = this.r;
    const lp = filter('lowpass', 5000, 0.9);
    ramp(lp.frequency, t, 6000, [[1300, 0.35]]);
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.045 * v, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    for (const iv of [0, 12, 19, 24, 27, 31, 36]) {
      const f = mtof(root + iv);
      for (const [type, a] of [['sawtooth', 1], ['square', 0.35]]) {
        const o = osc(type, f);
        o.detune.value = rand(-8, 8);
        ramp(o.frequency, t, f * 1.02, [[f, 0.05]]);
        o.connect(gain(a)).connect(lp);
        go(o, t, t + 0.55);
      }
    }
    lp.connect(shaper(this.curves.soft)).connect(g).connect(bus);

    const o = osc('sine', 110), og = gain(0);
    ramp(o.frequency, t, 120, [[52, 0.2]]);
    env(og.gain, t, 0.002, 0.6 * v, 0.3);
    o.connect(og).connect(bus);
    go(o, t, t + 0.35);

    const n = noise(), ng = gain(0);
    env(ng.gain, t, 0.001, 0.4 * v, 0.04);
    n.connect(filter('bandpass', 1800, 1)).connect(ng).connect(bus);
    goNoise(n, t, t + 0.06);

    send(g, 0.9, hall);
    send(og, 0.5, hall);
  }

  /** Crowd shout: five saws (five guys) through vowel formants. kind 0 = "hey!", 1 = "huh!" */
  shout(t, v = 1, kind = 0) {
    const { osc, gain, filter, noise, shaper, ramp, go, goNoise, env, send, bus, hall } = this.r;
    const F = kind ? [[640, 8, 1], [1150, 9, 0.5], [2500, 10, 0.25]]  : [[600, 7, 1], [1900, 9, 0.55], [2600, 10, 0.3]];
    const mix = gain(0.22), pre = gain(1);
    for (const b of [118, 136, 152, 171, 196]) {
      const f0 = b * rand(0.97, 1.03), o = osc('sawtooth', f0);
      ramp(o.frequency, t, f0 * 1.28, [[f0, 0.07], [f0 * 0.8, 0.28]]);
      o.connect(pre);
      go(o, t, t + 0.34);
    }
    // breathy texture
    const nv = noise(), nvg = gain(0);
    nvg.gain.setValueAtTime(0.0001, t);
    nvg.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
    nvg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    nv.connect(nvg).connect(pre);
    goNoise(nv, t, t + 0.32);
    for (const [f, q, a] of F) pre.connect(filter('bandpass', f, q)).connect(gain(a)).connect(mix);

    // consonant burst
    const t1 = Math.max(0, t - 0.01);
    const n = noise(), ng = gain(0);
    env(ng.gain, t1, 0.005, 0.25, 0.05);
    n.connect(filter('bandpass', 1600, 0.8)).connect(ng).connect(mix);
    goNoise(n, t1, t + 0.08);

    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.5 * v, t + 0.025);
    g.gain.setValueAtTime(1.5 * v, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    mix.connect(shaper(this.curves.soft)).connect(g).connect(bus);
    send(g, 0.5, hall);
  }

  arp(t, m, cut, v = 1) {
    const { osc, gain, filter, ramp, go, env, send, duck, delay } = this.r;
    const f = mtof(m);
    const o = osc('square', f), o2 = osc('sawtooth', f);
    const lp = filter('lowpass', cut, 2), g = gain(0);
    o2.detune.value = 8;
    ramp(lp.frequency, t, cut * 1.6, [[cut * 0.5, 0.09]]);
    env(g.gain, t, 0.001, 0.2 * v, 0.085);
    o.connect(lp);
    o2.connect(gain(0.6)).connect(lp);
    lp.connect(g).connect(duck);
    go(o, t, t + 0.1);
    go(o2, t, t + 0.1);
    send(g, 0.3, delay);
  }

  /** Tension pad for the break: clustered chord that slowly opens. */
  pad(t, notes, dur, v = 1) {
    const { osc, gain, filter, ramp, go, send, bus, hall } = this.r;
    const lp = filter('lowpass', 600, 1.2);
    ramp(lp.frequency, t, 500, [[2600, dur]]);
    const g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07 * v, t + dur * 0.5);
    g.gain.setValueAtTime(0.07 * v, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur);
    for (const m of notes) {
      for (const d of [-12, 0, 12]) {
        const o = osc('sawtooth', mtof(m));
        o.detune.value = d;
        o.connect(lp);
        go(o, t, t + dur + 0.05);
      }
    }
    lp.connect(g).connect(bus);
    send(g, 0.5, hall);
  }

  drone(t, m, dur, v = 1) {
    const { osc, gain, filter, go, bus } = this.r;
    const f = mtof(m), o = osc('sine', f), o2 = osc('sawtooth', f), g = gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1 * v, t + 0.05);
    g.gain.setValueAtTime(0.1 * v, t + dur - 0.1);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g);
    o2.connect(gain(0.35)).connect(filter('lowpass', 220, 1)).connect(g);
    g.connect(bus);
    go(o, t, t + dur + 0.02);
    go(o2, t, t + dur + 0.02);
  }

  timp(t, v = 1, f = 73) {
    const { osc, gain, filter, noise, shaper, ramp, go, goNoise, env, send, bus, hall } = this.r;
    const o = osc('sine', f), g = gain(0);
    ramp(o.frequency, t, f * 1.3, [[f, 0.03], [f * 0.85, 0.4]]);
    env(g.gain, t, 0.002, 0.55 * v, 0.42);
    o.connect(g).connect(shaper(this.curves.soft)).connect(bus);
    go(o, t, t + 0.5);

    const n = noise(), ng = gain(0);
    env(ng.gain, t, 0.001, 0.3 * v, 0.03);
    n.connect(filter('lowpass', 900, 0.8)).connect(ng).connect(bus);
    goNoise(n, t, t + 0.05);
    send(g, 0.35, hall);
  }

  crash(t, v = 1) {
    const { osc, gain, filter, noise, go, goNoise, env, send, bus, hall } = this.r;
    const n = noise(), g = gain(0);
    env(g.gain, t, 0.001, 0.26 * v, 1.1);
    n.connect(filter('highpass', 3200, 0.5)).connect(g).connect(bus);
    goNoise(n, t, t + 1.2);
    for (const f of [3100, 4730, 6210]) {
      const o = osc('square', f), og = gain(0);
      env(og.gain, t, 0.001, 0.02 * v, 0.6);
      o.connect(og).connect(bus);
      go(o, t, t + 0.7);
    }
    send(g, 0.3, hall);
  }

  tom(t, f, v = 1) {
    const { osc, gain, shaper, ramp, go, env, send, bus, verb } = this.r;
    const o = osc('triangle', f), g = gain(0);
    ramp(o.frequency, t, f * 1.15, [[f * 0.6, 0.16]]);
    env(g.gain, t, 0.001, 0.45 * v, 0.18);
    o.connect(g).connect(shaper(this.curves.soft)).connect(bus);
    go(o, t, t + 0.22);
    send(g, 0.25, verb);
  }

  /** Noise sweep (riser). */
  sweep(t, dur, v = 1) {
    const { gain, filter, noise, ramp, goNoise, bus } = this.r;
    const n = noise(), bp = filter('bandpass', 400, 1.2), g = gain(0);
    ramp(bp.frequency, t, 400, [[8000, dur]]);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28 * v, t + dur * 0.95);
    g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(bp).connect(g).connect(bus);
    goNoise(n, t, t + dur + 0.02);
  }

  /** Hoover siren: rises an octave while the filter opens (right before the drop). */
  rise(t, m, dur, v = 1) {
    const { osc, gain, filter, shaper, ramp, go, send, bus, hall } = this.r;
    const f = mtof(m), lp = filter('lowpass', 800, 2), g = gain(0);
    ramp(lp.frequency, t, 700, [[5000, dur]]);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1 * v, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.16 * v, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.01);
    for (const det of [-20, 0, 20]) {
      const o = osc('sawtooth', f);
      o.detune.value = det;
      ramp(o.frequency, t, f, [[f * 2, dur]]);
      o.connect(lp);
      go(o, t, t + dur + 0.02);
    }
    lp.connect(shaper(this.curves.soft)).connect(g).connect(bus);
    send(g, 0.3, hall);
  }
}

/* ------------------------------------------------------------------ */
/**
 * The song. 40 bars per loop:
 *   H (0–3) hit intro → A (4–11) hoover riff → B (12–19) arpeggio →
 *   X (20–23) break/build-up → A2 (24–31) → B2 (32–39)
 */
class Arrangement {
  static SECTIONS = [
    { id: 'H', start: 0, bars: 4 },
    { id: 'A', start: 4, bars: 8 },
    { id: 'B', start: 12, bars: 8 },
    { id: 'X', start: 20, bars: 4 },
    { id: 'A', start: 24, bars: 8 },
    { id: 'B', start: 32, bars: 8 },
  ];

  constructor(score, loopBars = 40) {
    this.score = score;
    this.loopBars = loopBars;
  }

  /** Play everything that happens on 16th-note step `n` at audio time `t`. */
  play(syn, n, t) {
    const { roots, bassPat, riff, arp } = this.score;
    const S16 = syn.s16;
    const bar = n >> 4, s = n & 15;
    const k = bar < 2 ? bar : (bar - 2) % this.loopBars;
    const si = Arrangement.SECTIONS.findLastIndex((x) => k >= x.start);
    const { id: sec, start, bars } = Arrangement.SECTIONS[si];
    const kk = k - start;
    const lastBar = kk === bars - 1;
    const second = si >= 4;
    const X = sec === 'X';
    const ci = k % 4, root = roots[ci], pcm = root + 24;
    const hit = (v) => syn.orch(t, root, v);
    const shout = (v, kind) => syn.shout(t, v, kind);

    this._drums(syn, t, s, sec, kk, lastBar, X);
    if (s === 0 && (kk === 0 || (sec === 'H' && kk === 2))) syn.crash(t, sec === 'H' ? 1 : 0.8); // H bar 2 = loop-seam landing

    // bass
    if (!X) {
      const p = bassPat[s];
      syn.bass(t, root + p, S16 * 0.85, p ? 1 : 0.3);
    } else if (kk === 2 && s % 2 === 0) syn.bass(t, root, S16 * 1.2, 0.15);
    else if (kk === 3 && s < 12) syn.bass(t, root + (s % 4 === 2 ? 12 : 0), S16 * 0.85, 0.3 + s / 14);

    // hoover
    if (sec === 'H') {
      if (s === 0 || s === 6) syn.stab(t, pcm, 2, 1);
      else if (s === 12) syn.stab(t, pcm, kk % 2 ? 1 : 2, 1);
      if (kk % 2 && s === 14) syn.stab(t, pcm + 1, 1, 0.9);
    } else if (sec === 'A') {
      for (const [ss, m, d] of riff[ci]) if (ss === s) syn.stab(t, m, d, second ? 1 : 0.92);
    } else if (sec === 'B') {
      for (const [ss, m, d] of riff[ci]) if (ss === s && (ss <= 6 || ci === 3)) syn.stab(t, m, d, 0.85);
    }

    // arpeggio
    if (sec === 'B') syn.arp(t, arp[ci][s], second ? 3200 : 2600, 1);
    else if (sec === 'A' && second && s % 2 === 1) syn.arp(t, arp[0][s], 1700, 0.55);
    else if (X && kk >= 2 && !(kk === 3 && s >= 12)) syn.arp(t, arp[0][s], 500 + ((kk - 2) * 16 + s) * 90, 0.9);

    // orchestra hits
    if (sec === 'H') {
      if (s === 0) hit(1);
      else if (s === 6) hit(0.8);
      else if (s === 12 && kk % 2 === 0) hit(0.8);
      else if (kk === 3 && (s === 12 || s === 14)) hit(0.75);
    } else if (X) {
      if (kk === 0 && s === 0) hit(1.1);
      else if (kk === 1 && s === 0) hit(0.6);
      else if (kk === 3 && s === 12) hit(1);
    } else if (!second) {
      if (s === 0 && kk % 4 === 0) hit(1);
      else if (lastBar && (s === 12 || s === 14)) hit(0.75);
    } else if (s === 0 && kk % 2 === 0) hit(1);
    else if (lastBar && (s === 6 || s === 12 || s === 14)) hit(0.8);

    // crowd
    if (sec === 'H') {
      if (s === 0 && kk % 2 === 0) shout(1, 0);
      else if (kk === 3 && s === 12) shout(1, 0);
      else if (kk === 3 && s === 14) shout(0.8, 0);
    } else if (X) {
      if (s === 0 || (kk >= 1 && s === 8) || (kk === 3 && s === 4)) shout(kk === 3 ? 1 : 0.8, 1);
      if (kk === 3 && s === 12) shout(1.2, 0);
    } else {
      if (kk % 4 === 3 && s === 14) shout(0.9, 0);
      if (lastBar && s === 12 && sec === 'B') shout(0.9, 0);
      if (lastBar && s === 0 && sec === 'B' && second) shout(1, 0);
    }

    // break decorations
    if (X && kk === 0 && s === 0) {
      syn.pad(t, [50, 51, 57, 62], syn.r.spb * 16, 1);
      syn.sweep(t, S16 * 60, 1);
      syn.drone(t, 38, syn.r.spb * 8, 1);
      syn.timp(t, 1, 73);
    }
    if (X && kk === 1 && s >= 8) syn.timp(t, 0.25 + (s - 8) * 0.07, 73);
    if (X && kk === 3 && s < 12 && s % 2 === 0) syn.timp(t, 0.3 + s * 0.05, 73);
    if (X && kk === 2 && s === 0) syn.rise(t, 62, S16 * 28, 1); // the beat before the drop is left empty
  }

  _drums(syn, t, s, sec, kk, lastBar, X) {
    const S16 = syn.s16;
    if (!X) {
      if (s % 4 === 0) syn.kick(t);
      if (s === 4 || s === 12) syn.snare(t, 1);
      if (lastBar && s > 12 && sec !== 'H') syn.snare(t, 0.5 + (s - 13) * 0.15);
      if (lastBar && s > 12 && sec === 'B') syn.tom(t, 220 - (s - 13) * 30, 0.8);
      if (s % 4 === 2) syn.hat(t, 1, true);
      else syn.hat(t, s % 2 === 0 ? 0.75 : 0.4, false);
      return;
    }
    if (kk === 2 && (s === 0 || s === 8)) syn.kick(t);
    if (kk === 3 && s < 12 && s % 4 === 0) syn.kick(t);
    if (kk === 2) syn.snare(t, 0.3 + s * 0.025);
    if (kk === 3 && s < 12) {
      syn.snare(t, 0.45 + s * 0.045);
      syn.snare(t + S16 / 2, 0.4 + s * 0.045);
    }
    if (kk < 2) {
      if (s % 2 === 0) syn.hat(t, 0.3, false);
    } else if (kk === 2 || s < 12) {
      if (s % 4 === 2) syn.hat(t, kk === 2 ? 0.7 : 0.9, true);
      else syn.hat(t, kk === 2 ? 0.45 : 0.6, false);
    }
  }
}

export default class Music {
  constructor({ audio, score, bpm = 140, loopBars = 40 }) {
    this.audio = audio;
    this.spb = 60 / bpm;
    this.s16 = this.spb / 4;
    this.curves = { hard: AudioEngine.makeCurve(3.2), soft: AudioEngine.makeCurve(1.6) };
    this.arr = new Arrangement(score, loopBars);

    // Pre-render layout: bars 2…(2+loopBars+2). Looping bars 4…44 keeps the reverb tail seamless.
    this.musicBars = loopBars + 2;
    this.loop0 = 2 * 16 * this.s16;
    this.loop1 = this.musicBars * 16 * this.s16;

    this.on = false;
    this.out = null; // node faded in/out on start/stop
    this.rig = null;
    this.synth = null;
    this.src = null; // buffer source when playing the pre-rendered loop
    this.buffer = null;
    this.rendering = false;
    this.timer = 0;
    this.next = 0;
    this.step = 0;
    this.t0 = 0;
    this.from = 32;
    this._noise = null;
  }

  get canPlay() {
    const c = this.audio.ctx;
    return !!c && c.state === 'running';
  }

  /* ---------------- helpers ---------------- */

  static makeImpulse(ctx, dur, decay) {
    const sr = ctx.sampleRate, len = Math.floor(sr * dur);
    const buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  _noiseBuffer() {
    if (!this._noise) {
      const ctx = this.audio.ctx, sr = ctx.sampleRate;
      const buf = ctx.createBuffer(1, sr * 4, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this._noise = buf; // AudioBuffers can be shared with offline contexts
    }
    return this._noise;
  }

  _makeRig(ctx, dest) {
    return new MusicRig(ctx, {
      dest,
      spb: this.spb,
      makeIR: Music.makeImpulse,
      noiseBuffer: this._noiseBuffer(),
      env: (p, t, a, pk, d) => AudioEngine.envAD(p, t, a, pk, d),
    });
  }

  /* ---------------- pre-render ---------------- */

  /** Render the loop offline once. Safe to call repeatedly. */
  prerender() {
    if (this.buffer || this.rendering || !this.audio.ctx) return;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return;
    const sr = 32000;
    const dur = this.musicBars * 16 * this.s16;
    let off, synth;
    try {
      off = new OAC(2, Math.ceil(sr * dur), sr);
      if (!off.suspend) return;
      synth = new Synth(this._makeRig(off, off.destination), this.curves);
    } catch { return; }
    this.rendering = true;

    // Schedule ~1 s ahead at a time (scheduling everything up-front is very slow).
    const total = this.musicBars * 16;
    let step = 0;
    const schedUntil = (tEnd) => {
      while (step < total && step * this.s16 < tEnd) {
        this.arr.play(synth, 32 + step, step * this.s16);
        step++;
      }
    };
    schedUntil(1.2);
    for (let t = 1; t < dur - 0.05; t += 1) {
      off.suspend(t).then(() => {
        schedUntil(t + 1.2);
        off.resume();
      });
    }

    const done = (buf) => {
      if (buf && buf.duration > 0) {
        this.buffer = buf;
        this._handoff();
      }
      this.rendering = false;
    };
    const p = off.startRendering();
    if (p && p.then) p.then(done, () => (this.rendering = false));
    else off.oncomplete = (e) => done(e.renderedBuffer);
  }

  _startBuffer(fromStep, t0) {
    const ctx = this.audio.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.loopStart = this.loop0;
    src.loopEnd = this.loop1;
    let off = (fromStep - 32) * this.s16;
    if (off >= this.loop1) off = this.loop0 + ((off - this.loop0) % (this.loop1 - this.loop0));
    src.connect(this.out);
    src.start(t0, off);
    this.src = src;
    this.on = true;
    this.t0 = t0;
    this.from = fromStep;
  }

  _newOut() {
    const g = this.audio.ctx.createGain();
    g.connect(this.audio.nodes.music);
    return g;
  }

  /* ---------------- transport ---------------- */

  start(t0, fromStep = 0) {
    if (!this.canPlay) return;
    this.stop(true);
    if (this.buffer && fromStep >= 32) {
      this.out = this._newOut();
      this._startBuffer(fromStep, t0);
      return;
    }
    // Not rendered yet → play live; _handoff() switches to the buffer when it's ready.
    this.rig = this._makeRig(this.audio.ctx, this.audio.nodes.music);
    this.synth = new Synth(this.rig, this.curves);
    this.out = this.rig.bus;
    this.on = true;
    this.step = fromStep;
    this.next = t0;
    this.src = null;
    clearInterval(this.timer);
    this.timer = setInterval(() => this._tick(), 25);
    this._tick();
  }

  stop(hard = false) {
    if (!this.out) return;
    this.on = false;
    clearInterval(this.timer);
    const ctx = this.audio.ctx;
    if (!ctx) return;
    const t = ctx.currentTime, b = this.out, src = this.src;
    b.gain.cancelScheduledValues(t);
    b.gain.setValueAtTime(b.gain.value, t);
    b.gain.linearRampToValueAtTime(0, t + (hard ? 0.025 : 0.7));
    if (src) {
      try { src.stop(t + (hard ? 0.05 : 0.75)); } catch { /* already stopped */ }
    }
    this.out = this.src = this.rig = this.synth = null;
    setTimeout(() => { try { b.disconnect(); } catch { /* ignore */ } }, 2000);
  }

  /** Current 16th-note step (so a restart can resume in place). */
  nowStep() {
    return this.src ? this.from + Math.max(0, Math.floor((this.audio.ctx.currentTime - this.t0) / this.s16)) : this.step;
  }

  /* ---------------- internals ---------------- */

  _tick() {
    const ctx = this.audio.ctx;
    if (!this.on || !ctx || this.src) return;
    if (this.next < ctx.currentTime - 0.03) { // fell behind (tab was throttled): skip ahead
      const skip = Math.ceil((ctx.currentTime - this.next) / this.s16);
      this.step += skip;
      this.next += skip * this.s16;
    }
    while (this.next < ctx.currentTime + 0.14) {
      this.arr.play(this.synth, this.step, this.next);
      this.step++;
      this.next += this.s16;
    }
  }

  /** Render finished while playing live: the buffer takes over at the next unscheduled step. */
  _handoff() {
    const ctx = this.audio.ctx;
    if (!this.on || this.src || !this.out || !ctx || !this.buffer) return;
    let st = this.step, t = this.next;
    if (st < 32) return;
    if (t < ctx.currentTime + 0.01) {
      const skip = Math.ceil((ctx.currentTime + 0.01 - t) / this.s16);
      st += skip;
      t += skip * this.s16;
    }
    clearInterval(this.timer);
    const old = this.out;
    old.gain.setValueAtTime(1, t);
    old.gain.linearRampToValueAtTime(0, t + 0.02);
    setTimeout(() => { try { old.disconnect(); } catch { /* ignore */ } }, 3000);
    this.rig = this.synth = null;
    this.out = this._newOut();
    this._startBuffer(st, t);
  }
}