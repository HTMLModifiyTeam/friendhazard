// Game runtime extracted from the original page.
import * as THREE from 'three';
import VOICE_DATA from './data/voices.js';
import { CROWD_COLORS, introText } from './data/data.js';
import Linker from './utils/Linker.js';
import Store from './utils/Store.js';
import { $, rand, pick, TAU, approach, wrapAngle, angleApproach, seeded } from './utils.js';
import { easeOutCubic, easeInOutCubic, easeInQuad, easeInOutSine } from './eases.js'

// ───────────────────────── 기본 도구 ─────────────────────────
const store = new Store("friendhazard");
let IS_TOUCH = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;

const Link = new Linker();
// 집에서 막 나온 참이면 그 상태로 이어서
const RETURN = (() => {
  const l = Link.read();
  if (l && l.dir === 'in') Link.clear();
  return l && l.dir === 'out' ? l : null;
})();
if (RETURN) Link.clear();

// 에스팀랩의 온이 원본을 작은 기관 마크로만 사용한다.
const ONI_MARK_SRC = "./imgs/oniMark.png";
const oniMarkImage = new Image();
oniMarkImage.src = ONI_MARK_SRC;
for (const holder of document.querySelectorAll('.agency-mark')) {
  const img = new Image();
  img.src = ONI_MARK_SRC;
  holder.append(img);
}

function drawAgencyMark(g, x, y, size, ink = '#69788c') {
  g.save();
  g.strokeStyle = ink;
  g.lineWidth = size * 0.025;
  g.beginPath();
  g.arc(x, y, size * 0.46, 0, TAU);
  g.stroke();
  if (oniMarkImage.naturalWidth) g.drawImage(oniMarkImage, x - size * 0.44, y - size * 0.44, size * 0.88, size * 0.88);
  g.restore();
}

// ───────────────────────── 렌더러 / 장면 ─────────────────────────
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas });
let PR = Math.min(window.devicePixelRatio || 1, 2);
renderer.setPixelRatio(PR);
renderer.shadowMap.enabled = true;
renderer.setClearColor(0xffffff, 1);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);
scene.fog = new THREE.Fog(0xffffff, 22, 52);

const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 160);
camera.position.set(0, 12, 12);

scene.add(new THREE.HemisphereLight(0xffffff, 0xe7e1ef, 1.95));
const sun = new THREE.DirectionalLight(0xfff8ee, 2.25);
sun.castShadow = true;
sun.shadow.mapSize.set(IS_TOUCH ? 1536 : 2048, IS_TOUCH ? 1536 : 2048);
{
  const c = sun.shadow.camera;
  c.left = -15;
  c.right = 15;
  c.top = 15;
  c.bottom = -15;
  c.near = 0.5;
  c.far = 60;
}
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);
const SUN_OFF = new THREE.Vector3(-6, 15, 10);

// 윤곽선: 화면 픽셀 단위로 일정한 두께
const OUTLINE = {
  px: { value: 2.6 },
  res: { value: new THREE.Vector2(1, 1) }
};

let VW = 1, VH = 1;
const _bufSize = new THREE.Vector2();

function onResize() {
  VW = window.innerWidth;
  VH = window.innerHeight;
  renderer.setPixelRatio(PR);
  renderer.setSize(VW, VH, false);
  camera.aspect = VW / VH;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(_bufSize);
  OUTLINE.res.value.copy(_bufSize);
  OUTLINE.px.value = 1.55 * PR;
}
window.addEventListener('resize', onResize);
onResize();

// ───────────────────────── 소리 ─────────────────────────
let ac = null;
const A = {};
let MUTED = !!store.get('muted', false);
const VO = {}; // 이름 → AudioBuffer
const activeVoices = new Set();

function audioInit() {
  if (ac) {
    if (ac.state === 'suspended') ac.resume();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ac = new AC({
    latencyHint: 'interactive'
  });
  A.master = ac.createGain();
  A.master.gain.value = MUTED ? 0 : 0.92;
  A.comp = ac.createDynamicsCompressor();
  A.comp.threshold.value = -13;
  A.comp.knee.value = 8;
  A.comp.ratio.value = 4.5;
  A.comp.attack.value = 0.002;
  A.comp.release.value = 0.16;
  A.comp.connect(A.master);
  A.master.connect(ac.destination);
  A.sfx = ac.createGain();
  A.sfx.gain.value = 0.95;
  A.sfx.connect(A.comp);
  A.voice = ac.createGain();
  A.voice.gain.value = 1.05;
  A.voice.connect(A.comp);
  A.music = ac.createGain();
  A.music.gain.value = 0.4;
  A.music.connect(A.comp);
  A.ir = makeIR(2.3, 2.6);
  A.verb = ac.createConvolver();
  A.verb.buffer = A.ir;
  A.verbOut = ac.createGain();
  A.verbOut.gain.value = 0.42;
  A.verb.connect(A.verbOut);
  A.verbOut.connect(A.comp);
  A.tap = ac.createAnalyser();
  A.tap.fftSize = 256;
  A.master.connect(A.tap);
  A.tapBuf = new Float32Array(256);
  A.noise = makeNoise(2.5);
  A.shaper = makeCurve(2.4);
  decodeVoices();
  if (ac.state === 'suspended') ac.resume();
  setTimeout(renderMusicBuffer, 400);
}
// 소리가 끊겼을 때 되살리기: 멈춘 컨텍스트 재개, 출력이 망가졌으면(NaN) 버스를 새로 짬
function audioRebuild() {
  for (const n of [A.comp, A.master, A.verb, A.verbOut, A.tap, A.sfx, A.voice, A.music]) {
    try {
      n.disconnect();
    } catch { }
  }
  A.master = ac.createGain();
  A.master.gain.value = MUTED ? 0 : 0.92;
  A.comp = ac.createDynamicsCompressor();
  A.comp.threshold.value = -13;
  A.comp.knee.value = 8;
  A.comp.ratio.value = 4.5;
  A.comp.attack.value = 0.002;
  A.comp.release.value = 0.16;
  A.comp.connect(A.master);
  A.master.connect(ac.destination);
  A.tap = ac.createAnalyser();
  A.tap.fftSize = 256;
  A.master.connect(A.tap);
  A.sfx.connect(A.comp);
  A.voice.connect(A.comp);
  A.music.connect(A.comp);
  A.verb = ac.createConvolver();
  A.verb.buffer = A.ir;
  A.verbOut = gainN(0.42);
  A.verb.connect(A.verbOut);
  A.verbOut.connect(A.comp);
  if (MU.on) musicStart(ac.currentTime + 0.05, musicNowStep());
}
let audioWatchT = 0,
  audioBad = 0;

function audioWatch(dt) {
  if (!ac) return;
  audioWatchT -= dt;
  if (audioWatchT > 0) return;
  audioWatchT = 1.2;
  if (document.hidden) return;
  if (ac.state !== 'running' && ac.state !== 'closed') {
    try {
      const p = ac.resume();
      if (p && p.catch) p.catch(() => { });
    } catch { }
    return;
  }
  if (!A.tap) return;
  A.tap.getFloatTimeDomainData(A.tapBuf);
  let bad = false;
  for (let i = 0; i < A.tapBuf.length; i++) {
    if (!Number.isFinite(A.tapBuf[i])) {
      bad = true;
      break;
    }
  }
  if (bad) {
    audioBad++;
    audioRebuild();
  }
}

function audioPoke() {
  if (!ac || ac.state === 'running' || ac.state === 'closed') return;
  try {
    const p = ac.resume();
    if (p && p.catch) p.catch(() => { });
  } catch { }
}

function setMuted(m) {
  MUTED = m;
  store.set('muted', m);
  $('mute').classList.toggle('muted', m);
  $('mute').setAttribute('aria-label', m ? '소리 켜기' : '소리 끄기');
  if (ac) {
    const t = ac.currentTime;
    A.master.gain.cancelScheduledValues(t);
    A.master.gain.setTargetAtTime(m ? 0 : 0.92, t, 0.03);
  }
}

function makeNoise(sec) {
  const n = Math.floor(ac.sampleRate * sec),
    b = ac.createBuffer(1, n, ac.sampleRate),
    d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function makeIR(sec, decay) {
  const n = Math.floor(ac.sampleRate * sec),
    b = ac.createBuffer(2, n, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 90 ? i / 90 : 1);
    }
  }
  return b;
}

function makeCurve(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    c[i] = Math.tanh(x * k) / Math.tanh(k);
  }
  return c;
}

async function decodeVoices() {
  let data = VOICE_DATA || {};
  await Promise.all(Object.keys(data).map(async (k) => {
    try {
      const res = await fetch("voices/" + data[k].b);
      if (!res.ok) throw new Error(res.status);
      const ab = await res.arrayBuffer();
      VO[k] = await ac.decodeAudioData(ab);
    } catch (e) { console.warn('Failed to load voice:', k, data[k].b, e); }
  }));
}

// ── 작은 헬퍼 ──
function gainN(v) {
  const g = ac.createGain();
  g.gain.value = v;
  return g;
}

function filt(type, f, q) {
  const b = ac.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  if (q !== undefined) b.Q.value = q;
  return b;
}

function oscN(type, f) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = f;
  return o;
}

function noiseN(rate) {
  const s = ac.createBufferSource();
  s.buffer = A.noise;
  s.loop = true;
  if (rate) s.playbackRate.value = rate;
  return s;
}

function envAD(param, t, a, peak, d) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  param.exponentialRampToValueAtTime(0.0001, t + a + d);
}

function outChain(vol, pan, verb) {
  const g = gainN(vol);
  let tail = g;
  if (pan && Math.abs(pan) > 0.06 && ac.createStereoPanner) {
    const p = ac.createStereoPanner();
    p.pan.value = THREE.MathUtils.clamp(pan, -1, 1);
    g.connect(p);
    tail = p;
  }
  tail.connect(A.sfx);
  if (verb && verb > 0.2) {
    const s = gainN(verb);
    g.connect(s);
    s.connect(A.verb);
  }
  return g;
}
const ok = () => ac && (ac.state === 'running');
// ── 효과음 수 제한 ──
// 후반에 한꺼번에 수백 개씩 만들면 휴대폰 소리 엔진이 버티지 못한다.
// 중요도: 3 연출(도장, 하이파이브, 알림…) / 2 내 총·칼 / 1 쓰러뜨리는 소리 / 0 잔소리(탄피, 털썩, 철퍽, 휘두름)
const SFX_MAX = 20;
const sfxEnds = [];
let sfxWinT = -1,
  sfxWinN = 0;

function sfxGate(prio, dur) {
  if (!ok()) return false;
  const now = ac.currentTime;
  for (let i = sfxEnds.length - 1; i >= 0; i--)
    if (sfxEnds[i] <= now) sfxEnds.splice(i, 1);
  if (now - sfxWinT > 0.06) {
    sfxWinT = now;
    sfxWinN = 0;
  }
  if (prio < 3) {
    const cap = prio === 2 ? SFX_MAX + 4 : prio === 1 ? SFX_MAX : SFX_MAX - 8;
    const win = prio === 2 ? 6 : prio === 1 ? 4 : 2;
    if (sfxEnds.length >= cap || sfxWinN >= win) return false;
  }
  sfxEnds.push(now + dur);
  sfxWinN++;
  return true;
}

// ── 효과음 ──
function sfxGun(pan = 0) {
  if (!sfxGate(2, 0.3)) return;
  const t = ac.currentTime + 0.002,
    r = rand(0.92, 1.08);
  const out = outChain(0.95, pan * 0.6, 0.55);
  const sh = ac.createWaveShaper();
  sh.curve = A.shaper;
  sh.connect(out);
  // 1. 찢어지는 크랙
  const n1 = noiseN(rand(0.9, 1.15));
  const hp = filt('highpass', 2400, 0.7);
  const g1 = gainN(0);
  envAD(g1.gain, t, 0.0008, 1.0, 0.045);
  n1.connect(hp).connect(g1).connect(sh);
  n1.start(t, rand(0, 2));
  n1.stop(t + 0.07);
  // 2. 몸통 (저역 스윕)
  const n2 = noiseN();
  const lp = filt('lowpass', 6500, 0.8);
  lp.frequency.setValueAtTime(7000 * r, t);
  lp.frequency.exponentialRampToValueAtTime(260, t + 0.22);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.0015, 0.95, 0.24);
  n2.connect(lp).connect(g2).connect(sh);
  n2.start(t, rand(0, 2));
  n2.stop(t + 0.3);
  // 3. 쿵 (펀치)
  const o = oscN('sine', 160 * r);
  o.frequency.setValueAtTime(165 * r, t);
  o.frequency.exponentialRampToValueAtTime(44, t + 0.1);
  const g3 = gainN(0);
  envAD(g3.gain, t, 0.002, 1.15, 0.17);
  o.connect(g3).connect(sh);
  o.start(t);
  o.stop(t + 0.22);
}
let tinkBudget = 0;

function sfxTink(v = 1, pan = 0) {
  if (tinkBudget > 3 || !sfxGate(0, 0.17)) return;
  tinkBudget++;
  const t = ac.currentTime, r = rand(0.88, 1.12);
  const out = outChain(0.17 * v, pan * 0.5, 0);
  for (const [f, d, a] of [
    [3150, 0.16, 1],
    [6820, 0.07, 0.5]
  ]) {
    const o = oscN('sine', f * r);
    const g = gainN(0);
    envAD(g.gain, t, 0.0008, a, d * rand(0.8, 1.2));
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + d + 0.05);
  }
}
// 아이템 획득 '띠리링': 탄피 예산과 전투 효과음 제한에 묻히지 않는 짧은 상승음.
function sfxItemPickup() {
  if (!ok() || MUTED) return;
  const t = ac.currentTime + 0.002, out = outChain(0.48, 0, 0), nodes = [];
  [[1318.51, 0, 0.07], [1760, 0.075, 0.07], [2637.02, 0.15, 0.16]].forEach(([f, d, decay], i) => {
    const tt = t + d;
    const o = oscN('triangle', f),
      g = gainN(0);
    const overtone = oscN('sine', f * 2),
      overtoneGain = gainN(0);
    envAD(g.gain, tt, 0.002, 0.68, decay);
    envAD(overtoneGain.gain, tt, 0.001, 0.14, decay * 0.65);
    o.connect(g).connect(out);
    overtone.connect(overtoneGain).connect(out);
    nodes.push(o, g, overtone, overtoneGain);
    o.start(tt);
    overtone.start(tt);
    o.stop(tt + decay + 0.025);
    overtone.stop(tt + decay + 0.025);
    if (i === 2) o.onended = () => {
      for (const n of nodes) n.disconnect();
      out.disconnect();
    };
  });
}

function sfxFlesh(v = 1, pan = 0) {
  if (!sfxGate(1, 0.14)) return;
  const t = ac.currentTime + 0.004;
  const out = outChain(0.85 * v, pan * 0.5, 0.18);
  const n = noiseN(rand(0.7, 0.9));
  const lp = filt('lowpass', 1100, 1.4);
  const g = gainN(0);
  envAD(g.gain, t, 0.002, 0.9, 0.07);
  n.connect(lp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.12);
  const o = oscN('sine', 95);
  o.frequency.exponentialRampToValueAtTime(52, t + 0.09);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.002, 0.9, 0.1);
  o.connect(g2).connect(out);
  o.start(t);
  o.stop(t + 0.14);
  // 물기 있는 철퍽
  const n2 = noiseN(rand(1, 1.3));
  const bp = filt('bandpass', 1500, 1.6);
  const g3 = gainN(0);
  envAD(g3.gain, t + 0.012, 0.002, 0.55, 0.06);
  n2.connect(bp).connect(g3).connect(out);
  n2.start(t + 0.01, rand(0, 2));
  n2.stop(t + 0.1);
}

function sfxSplat(v = 1, pan = 0) {
  if (!sfxGate(0, 0.1)) return;
  const t = ac.currentTime;
  const out = outChain(0.45 * v, pan * 0.5, 0);
  for (let i = 0; i < 2; i++) {
    const tt = t + i * rand(0.012, 0.03);
    const n = noiseN(rand(0.8, 1.4));
    const bp = filt('bandpass', rand(700, 1400), 2.2);
    const g = gainN(0);
    envAD(g.gain, tt, 0.001, rand(0.4, 0.8), rand(0.03, 0.06));
    n.connect(bp).connect(g).connect(out);
    n.start(tt, rand(0, 2));
    n.stop(tt + 0.1);
  }
}

function sfxFall(v = 1, pan = 0) {
  if (!sfxGate(0, 0.22)) return;
  const t = ac.currentTime;
  const out = outChain(0.75 * v, pan * 0.5, 0);
  for (const [dt, a] of [[0, 1]]) {
    const o = oscN('sine', 78);
    o.frequency.setValueAtTime(80, t + dt);
    o.frequency.exponentialRampToValueAtTime(36, t + dt + 0.16);
    const g = gainN(0);
    envAD(g.gain, t + dt, 0.003, a, 0.18);
    o.connect(g).connect(out);
    o.start(t + dt);
    o.stop(t + dt + 0.25);
    const n = noiseN(0.6);
    const lp = filt('lowpass', 420, 0.8);
    const g2 = gainN(0);
    envAD(g2.gain, t + dt, 0.002, a * 0.7, 0.11);
    n.connect(lp).connect(g2).connect(out);
    n.start(t + dt, rand(0, 2));
    n.stop(t + dt + 0.16);
  }
}

function sfxStab(pan = 0, v = 1) {
  if (!sfxGate(v >= 1 ? 2 : 1, 0.2)) return;
  const t = ac.currentTime;
  const out = outChain(0.9 * v, pan * 0.4, 0.2);
  // 휙
  const n = noiseN();
  const bp = filt('bandpass', 900, 2.4);
  bp.frequency.setValueAtTime(900, t);
  bp.frequency.exponentialRampToValueAtTime(4200, t + 0.07);
  const g = gainN(0);
  envAD(g.gain, t, 0.01, 0.5, 0.06);
  n.connect(bp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.1);
  // 푹 (젖은 공명)
  const t2 = t + 0.055;
  const n2 = noiseN(0.8);
  const lp = filt('lowpass', 2000, 9);
  lp.frequency.setValueAtTime(2200, t2);
  lp.frequency.exponentialRampToValueAtTime(320, t2 + 0.13);
  const g2 = gainN(0);
  envAD(g2.gain, t2, 0.002, 1.0, 0.14);
  n2.connect(lp).connect(g2).connect(out);
  n2.start(t2, rand(0, 2));
  n2.stop(t2 + 0.2);
  const o = oscN('sine', 120);
  o.frequency.setValueAtTime(130, t2);
  o.frequency.exponentialRampToValueAtTime(55, t2 + 0.1);
  const g3 = gainN(0);
  envAD(g3.gain, t2, 0.002, 0.95, 0.12);
  o.connect(g3).connect(out);
  o.start(t2);
  o.stop(t2 + 0.16);
  // 칼끝 쇳소리
  const o2 = oscN('triangle', 5200);
  const g4 = gainN(0);
  envAD(g4.gain, t2 - 0.01, 0.001, 0.05, 0.05);
  o2.connect(g4).connect(out);
  o2.start(t2 - 0.01);
  o2.stop(t2 + 0.06);
}
// 붙잡히는 소리: 몸이 부딪히는 '쿵' + 옷을 움켜쥐는 '부스럭' + 짧은 '헉'. 저음만으로는 휴대폰 스피커에서 안 들려서 중역을 같이 넣는다.
function sfxGrab(pan = 0, v = 1) {
  if (!sfxGate(v >= 1 ? 2 : 0, 0.18)) return;
  const t = ac.currentTime;
  const out = outChain(1.0 * v, pan * 0.5, 0.12);
  const n = noiseN(0.5);
  const lp = filt('lowpass', 700, 1);
  const g = gainN(0);
  envAD(g.gain, t, 0.008, 0.8, 0.11);
  n.connect(lp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.16);
  const o = oscN('sine', 140);
  o.frequency.exponentialRampToValueAtTime(85, t + 0.08);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.004, 0.7, 0.09);
  o.connect(g2).connect(out);
  o.start(t);
  o.stop(t + 0.12);
  const n2 = noiseN(rand(1.0, 1.3));
  const bp = filt('bandpass', 1300, 1.2);
  bp.frequency.setValueAtTime(1700, t);
  bp.frequency.exponentialRampToValueAtTime(650, t + 0.1);
  const g3 = gainN(0);
  envAD(g3.gain, t + 0.004, 0.003, 0.8, 0.09);
  n2.connect(bp).connect(g3).connect(out);
  n2.start(t, rand(0, 2));
  n2.stop(t + 0.15);
  const o2 = oscN('triangle', 330);
  o2.frequency.setValueAtTime(360, t + 0.01);
  o2.frequency.exponentialRampToValueAtTime(180, t + 0.1);
  const g4 = gainN(0);
  envAD(g4.gain, t + 0.01, 0.006, 0.38, 0.1);
  o2.connect(g4).connect(out);
  o2.start(t + 0.01);
  o2.stop(t + 0.16);
}
// 방망이 휘두르는 바람 소리
function sfxSwing(pan = 0, v = 1) {
  if (!sfxGate(0, 0.25)) return;
  const t = ac.currentTime;
  const out = outChain(0.42 * v, pan * 0.5, 0);
  const n = noiseN(rand(0.9, 1.1));
  const bp = filt('bandpass', 450, 1.6);
  bp.frequency.setValueAtTime(420, t);
  bp.frequency.exponentialRampToValueAtTime(2300, t + 0.13);
  bp.frequency.exponentialRampToValueAtTime(900, t + 0.22);
  const g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.9, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  n.connect(bp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.26);
}
// 방망이에 맞는 소리: 나무 '딱' + 몸 '퍽'
function sfxBat(pan = 0, v = 1) {
  if (!sfxGate(1, 0.18)) return;
  const t = ac.currentTime + 0.002;
  const out = outChain(0.95 * v, pan * 0.5, 0.3);
  const o = oscN('triangle', 980 * rand(0.93, 1.07));
  const g = gainN(0);
  envAD(g.gain, t, 0.0008, 0.55, 0.06);
  const o2 = oscN('sine', 1620 * rand(0.95, 1.05));
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.0008, 0.3, 0.035);
  o.connect(g).connect(out);
  o2.connect(g2).connect(out);
  o.start(t);
  o.stop(t + 0.09);
  o2.start(t);
  o2.stop(t + 0.06);
  const n = noiseN(1.2);
  const bp = filt('bandpass', 2600, 2.5);
  const g3 = gainN(0);
  envAD(g3.gain, t, 0.0006, 0.8, 0.025);
  n.connect(bp).connect(g3).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.04);
  const b = oscN('sine', 130);
  b.frequency.setValueAtTime(140, t);
  b.frequency.exponentialRampToValueAtTime(48, t + 0.14);
  const g4 = gainN(0);
  envAD(g4.gain, t, 0.002, 1.0, 0.16);
  b.connect(g4).connect(out);
  b.start(t);
  b.stop(t + 0.2);
  const n2 = noiseN(0.6);
  const lp = filt('lowpass', 900, 1);
  const g5 = gainN(0);
  envAD(g5.gain, t + 0.004, 0.002, 0.7, 0.08);
  n2.connect(lp).connect(g5).connect(out);
  n2.start(t, rand(0, 2));
  n2.stop(t + 0.12);
}
// 하이파이브 '짝!'
function sfxClap() {
  if (!sfxGate(3, 0.15)) return;
  const t = ac.currentTime + 0.002;
  const out = outChain(1.05, 0, 0.42);
  const n = noiseN(rand(0.95, 1.05));
  const bp = filt('bandpass', 1750, 1.1);
  const g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  [0, 0.006, 0.013].forEach((d, i) => {
    g.gain.setValueAtTime(i ? 0.75 : 1.1, t + d);
    g.gain.exponentialRampToValueAtTime(0.12, t + d + 0.005);
  });
  g.gain.setValueAtTime(0.95, t + 0.019);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  n.connect(bp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.15);
  const n2 = noiseN(1.3);
  const hp = filt('highpass', 4200, 0.7);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.0006, 0.5, 0.05);
  n2.connect(hp).connect(g2).connect(out);
  n2.start(t, rand(0, 2));
  n2.stop(t + 0.07);
  const o = oscN('sine', 320);
  o.frequency.setValueAtTime(330, t);
  o.frequency.exponentialRampToValueAtTime(140, t + 0.06);
  const g3 = gainN(0);
  envAD(g3.gain, t, 0.001, 0.55, 0.06);
  o.connect(g3).connect(out);
  o.start(t);
  o.stop(t + 0.09);
}
// SNS 알림음
function sfxChime() {
  if (!sfxGate(3, 0.5)) return;
  const t = ac.currentTime + 0.01;
  const out = outChain(0.36, 0, 0.22);
  [
    [1567.98, 0],
    [2093.0, 0.085]
  ].forEach(([f, d]) => {
    const o = oscN('sine', f),
      o2 = oscN('triangle', f * 2);
    const g = gainN(0);
    envAD(g.gain, t + d, 0.003, 0.8, 0.42);
    const g2 = gainN(0);
    envAD(g2.gain, t + d, 0.002, 0.12, 0.12);
    o.connect(g).connect(out);
    o2.connect(g2).connect(out);
    o.start(t + d);
    o.stop(t + d + 0.5);
    o2.start(t + d);
    o2.stop(t + d + 0.16);
  });
}

function sfxStamp() {
  if (!sfxGate(3, 0.35)) return;
  const t = ac.currentTime;
  const out = outChain(1.0, 0, 0.45);
  const o = oscN('sine', 95);
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(34, t + 0.28);
  const g = gainN(0);
  envAD(g.gain, t, 0.002, 1.2, 0.3);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.35);
  const n = noiseN(0.7);
  const lp = filt('lowpass', 1400, 0.8);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.001, 0.9, 0.09);
  n.connect(lp).connect(g2).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.14);
  const n2 = noiseN(1.2);
  const hp = filt('highpass', 2500, 0.7);
  const g3 = gainN(0);
  envAD(g3.gain, t, 0.0008, 0.5, 0.035);
  n2.connect(hp).connect(g3).connect(out);
  n2.start(t, rand(0, 2));
  n2.stop(t + 0.06);
}

function sfxSparkle(v = 1) {
  if (!sfxGate(3, 0.7)) return;
  const t = ac.currentTime;
  const out = outChain(0.32 * v, 0, 0.6);
  [1567.98, 2093, 2637, 3136, 4186].forEach((f, i) => {
    const tt = t + i * 0.045;
    const o = oscN(i % 2 ? 'sine' : 'triangle', f);
    const g = gainN(0);
    envAD(g.gain, tt, 0.002, i === 4 ? 0.7 : 0.5, 0.55);
    const vib = oscN('sine', 7);
    const vg = gainN(f * 0.004);
    vib.connect(vg).connect(o.frequency);
    vib.start(tt);
    vib.stop(tt + 0.7);
    o.connect(g).connect(out);
    o.start(tt);
    o.stop(tt + 0.7);
  });
  const n = noiseN(1.4);
  const bp = filt('highpass', 7000, 0.7);
  const g = gainN(0);
  envAD(g.gain, t + 0.1, 0.05, 0.12, 0.35);
  n.connect(bp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.6);
}

function sfxType() {
  if (!sfxGate(3, 0.04)) return;
  const t = ac.currentTime;
  const out = outChain(0.16, rand(-0.2, 0.2), 0);
  const n = noiseN(rand(0.9, 1.3));
  const bp = filt('bandpass', rand(2600, 4200), 2);
  const g = gainN(0);
  envAD(g.gain, t, 0.001, 1, 0.022);
  n.connect(bp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.04);
}

function sfxHeart(v = 1) {
  if (!sfxGate(3, 0.4)) return;
  const t = ac.currentTime + 0.005;
  const out = outChain(0.9 * v, 0, 0);
  for (const [d, a] of [
    [0, 1],
    [0.16, 0.7]
  ]) {
    const o = oscN('sine', 62);
    o.frequency.setValueAtTime(70, t + d);
    o.frequency.exponentialRampToValueAtTime(42, t + d + 0.12);
    const g = gainN(0);
    envAD(g.gain, t + d, 0.006, a, 0.14);
    o.connect(g).connect(out);
    o.start(t + d);
    o.stop(t + d + 0.18);
  }
}

function sfxImpact(t) {
  if (!ok()) return;
  t = t || ac.currentTime;
  const out = outChain(1.0, 0, 0.8);
  const o = oscN('sine', 60);
  o.frequency.setValueAtTime(78, t);
  o.frequency.exponentialRampToValueAtTime(34, t + 1.2);
  const g = gainN(0);
  envAD(g.gain, t, 0.004, 1.3, 1.6);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 1.8);
  const n = noiseN(0.5);
  const lp = filt('lowpass', 500, 0.7);
  lp.frequency.setValueAtTime(1600, t);
  lp.frequency.exponentialRampToValueAtTime(120, t + 1.0);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.003, 1.0, 1.0);
  n.connect(lp).connect(g2).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 1.2);
  // 징 (비조화 배음)
  const base = 98;
  [
    [1, 3.6, 0.5],
    [1.483, 3.0, 0.42],
    [1.932, 2.6, 0.35],
    [2.546, 2.2, 0.3],
    [2.63, 2.0, 0.26],
    [3.358, 1.6, 0.2],
    [4.1, 1.2, 0.16],
    [5.4, 0.9, 0.1]
  ].forEach(([m, d, a]) => {
    const oo = oscN('sine', base * m);
    oo.frequency.setValueAtTime(base * m * 1.012, t);
    oo.frequency.exponentialRampToValueAtTime(base * m, t + 0.6);
    const gg = gainN(0);
    gg.gain.setValueAtTime(0.0001, t);
    gg.gain.exponentialRampToValueAtTime(a * 0.55, t + 0.012);
    gg.gain.exponentialRampToValueAtTime(0.0001, t + d);
    oo.connect(gg).connect(out);
    oo.start(t);
    oo.stop(t + d + 0.05);
  });
}

function sfxRiser(t, dur) {
  if (!ok()) return;
  const out = outChain(0.6, 0, 0.4);
  const n = noiseN();
  const bp = filt('bandpass', 300, 3);
  bp.frequency.setValueAtTime(300, t);
  bp.frequency.exponentialRampToValueAtTime(7000, t + dur);
  const g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.95);
  g.gain.linearRampToValueAtTime(0, t + dur);
  n.connect(bp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + dur + 0.02);
}

// ── 집에서 들고 나온 산탄총, 현관문 ──
function sfxClickAt(t, f, v, dur = 0.02, q = 5) {
  const out = outChain(v, 0, 0);
  const n = noiseN(rand(0.9, 1.2));
  const bp = filt('bandpass', f, q);
  const g = gainN(0);
  envAD(g.gain, t, 0.0008, 1, dur);
  n.connect(bp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + dur + 0.03);
  const o = oscN('square', f * 0.5);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.0005, 0.12, dur * 0.6);
  o.connect(g2).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}
let SG_CURVE = null;

function sfxShotgunOut(pan = 0) {
  if (!sfxGate(3, 0.9)) return;
  const t = ac.currentTime + 0.002;
  const out = outChain(1.1, pan * 0.5, 0.9);
  const sh = ac.createWaveShaper();
  sh.curve = SG_CURVE || (SG_CURVE = makeCurve(4.5));
  sh.connect(out);
  // 찢어지는 앞소리 + 길게 꺼지는 몸통 + 가슴을 치는 저음
  const n1 = noiseN(rand(0.85, 1.0));
  const hp = filt('highpass', 1600, 0.6);
  const g1 = gainN(0);
  envAD(g1.gain, t, 0.0008, 1.0, 0.08);
  n1.connect(hp).connect(g1).connect(sh);
  n1.start(t, rand(0, 2));
  n1.stop(t + 0.12);
  const n2 = noiseN(0.8);
  const lp = filt('lowpass', 5000, 0.7);
  lp.frequency.setValueAtTime(5200, t);
  lp.frequency.exponentialRampToValueAtTime(160, t + 0.45);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.002, 1.2, 0.48);
  n2.connect(lp).connect(g2).connect(sh);
  n2.start(t, rand(0, 2));
  n2.stop(t + 0.55);
  const o = oscN('sine', 90);
  o.frequency.setValueAtTime(110, t);
  o.frequency.exponentialRampToValueAtTime(30, t + 0.3);
  const g3 = gainN(0);
  envAD(g3.gain, t, 0.003, 1.5, 0.34);
  o.connect(g3).connect(sh);
  o.start(t);
  o.stop(t + 0.4);
  const o2 = oscN('triangle', 55);
  const g5 = gainN(0);
  envAD(g5.gain, t + 0.01, 0.01, 0.7, 0.5);
  o2.connect(g5).connect(out);
  o2.start(t);
  o2.stop(t + 0.6);
}
// 철컥-척 (펌프)
function sfxPumpOut(d = 0) {
  if (!sfxGate(2, 0.4)) return;
  const t = ac.currentTime + d;
  sfxClickAt(t, 1100, 0.75, 0.05, 2.5);
  sfxClickAt(t + 0.02, 2600, 0.4, 0.03, 6);
  sfxClickAt(t + 0.2, 1400, 0.85, 0.05, 2.5);
  sfxClickAt(t + 0.215, 3400, 0.55, 0.03, 8);
}
// 빈 산탄총을 바닥에 던짐
function sfxGunDrop(pan = 0, d = 0.12) {
  if (!sfxGate(1, 0.4 + d)) return;
  const t = ac.currentTime + d;
  const out = outChain(0.55, pan * 0.5, 0.2);
  const n = noiseN(0.7);
  const lp = filt('lowpass', 900, 1);
  const g = gainN(0);
  envAD(g.gain, t, 0.003, 0.9, 0.12);
  n.connect(lp).connect(g).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.16);
  sfxClickAt(t + 0.01, 2400, 0.35, 0.03, 6);
  sfxClickAt(t + 0.11, 1800, 0.25, 0.03, 5);
}
// 현관문이 쾅 닫힘
function sfxDoorSlamOut() {
  if (!ok()) return;
  const t = ac.currentTime + 0.01;
  const out = outChain(1.05, 0, 0.7);
  const o = oscN('sine', 92);
  o.frequency.setValueAtTime(115, t);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.25);
  const g = gainN(0);
  envAD(g.gain, t, 0.003, 1.1, 0.3);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.36);
  const n = noiseN(0.9);
  const bp = filt('bandpass', 700, 1.3);
  const g2 = gainN(0);
  envAD(g2.gain, t, 0.002, 1.0, 0.16);
  n.connect(bp).connect(g2).connect(out);
  n.start(t, rand(0, 2));
  n.stop(t + 0.22);
  sfxClickAt(t + 0.03, 2500, 0.6, 0.03, 6);
  sfxClickAt(t + 0.08, 3300, 0.35, 0.02, 7);
}

// ── 목소리 ──
function voicesPlaying() {
  let n = 0;
  for (const h of activeVoices)
    if (!h.stopped) n++;
  return n;
}

function playVoice(key, o = {}) {
  if (!ok() || !VO[key]) return null;
  const buf = VO[key];
  const rate = o.rate || 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = rate;
  const g = gainN(o.gain === undefined ? 1 : o.gain);
  let node = src;
  let lfo = null, lfo2 = null;
  if (o.sob) {
    // 울먹임: 음높이 떨림 + 숨 떨림
    lfo = oscN('sine', rand(5.6, 7.4));
    const lg = gainN(o.sob * rate);
    lfo.connect(lg);
    lg.connect(src.playbackRate);
    const trem = gainN(0.78);
    lfo2 = oscN('sine', rand(4.5, 6));
    const tg = gainN(0.22);
    lfo2.connect(tg);
    tg.connect(trem.gain);
    node.connect(trem);
    node = trem;
    lfo.start();
    lfo2.start();
  }
  if (o.lp) {
    const f = filt('lowpass', o.lp, 0.7);
    node.connect(f);
    node = f;
  }
  node.connect(g);
  let tail = g;
  if (ac.createStereoPanner) {
    const p = ac.createStereoPanner();
    p.pan.value = THREE.MathUtils.clamp(o.pan || 0, -1, 1);
    g.connect(p);
    tail = p;
  }
  tail.connect(A.voice);
  const vs = gainN(o.verb === undefined ? 0.22 : o.verb);
  g.connect(vs);
  vs.connect(A.verb);
  const t0 = ac.currentTime;
  src.start(t0);
  const h = {
    key,
    src,
    g,
    t0,
    rate,
    dur: buf.duration / rate,
    stopped: false,
    progress() {
      return THREE.MathUtils.clamp((ac.currentTime - h.t0) / h.dur, 0, 1);
    },
    stop(fast = 0.012) {
      if (h.stopped) return;
      h.stopped = true;
      const t = ac.currentTime;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + fast);
        src.stop(t + fast + 0.01);
      } catch { }
      try {
        if (lfo) lfo.stop(t + fast + 0.02);
        if (lfo2) lfo2.stop(t + fast + 0.02);
      } catch { }
    },
  };
  src.onended = () => {
    h.stopped = true;
    activeVoices.delete(h);
    try {
      if (lfo) lfo.stop();
      if (lfo2) lfo2.stop();
    } catch { }
  };
  activeVoices.add(h);
  return h;
}

function stopAllVoices() {
  for (const h of activeVoices) h.stop(0.05);
  activeVoices.clear();
}

// ───────────────────────── 음악 (90년대 격투게임 레이브, 140BPM) ─────────────────────────
// 후버 스탭(뿡빵) + 오케스트라 히트 + 군중 함성 + 구르는 베이스 + 기관총 아르페지오. D 프리지안.
const BPM = 140,
  SPB = 60 / BPM,
  S16 = SPB / 4;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const ROOTS = [38, 38, 41, 39]; // D D F Eb — 4마디 진행
const BASS_PAT = [0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12, 0, 0, 12, 0]; // 3-3-2 옥타브 악센트
// 후버 리프 [스텝, 음, 길이(16분)] — 마디마다 (4마디 한 바퀴). 마지막 마디는 반음 이웃(Eb, C#)으로 D를 조인다.
const RIFF = [
  [
    [0, 62, 2],
    [3, 62, 1],
    [6, 74, 2],
    [8, 62, 1],
    [10, 62, 1],
    [12, 65, 2],
    [14, 63, 2]
  ],
  [
    [0, 62, 2],
    [3, 62, 1],
    [6, 74, 2],
    [8, 62, 1],
    [10, 60, 1],
    [12, 62, 3]
  ],
  [
    [0, 65, 2],
    [3, 65, 1],
    [6, 77, 2],
    [8, 65, 1],
    [10, 65, 1],
    [12, 67, 2],
    [14, 65, 2]
  ],
  [
    [0, 63, 2],
    [3, 63, 1],
    [6, 75, 2],
    [8, 63, 1],
    [10, 62, 1],
    [12, 63, 2],
    [14, 61, 2]
  ],
];
// 기관총 아르페지오 (16분음표 16개)
const ARP = [
  [74, 74, 86, 74, 74, 86, 74, 74, 86, 74, 74, 86, 74, 74, 86, 74],
  [74, 77, 81, 86, 84, 81, 77, 74, 75, 77, 81, 87, 86, 84, 81, 77],
  [77, 77, 89, 77, 77, 89, 77, 77, 89, 77, 77, 89, 77, 77, 89, 77],
  [75, 75, 87, 75, 75, 87, 75, 75, 87, 75, 86, 75, 84, 75, 82, 75],
];
const CURVE_HARD = makeCurve(3.2),
  CURVE_SOFT = makeCurve(1.6);
const MU = {
  on: false,
  bus: null,
  duck: null,
  delay: null,
  verb: null,
  hall: null,
  next: 0,
  step: 0,
  timer: 0,
  src: null,
  t0: 0,
  from: 32
};

// 음악 버스: 덕킹(킥마다 눌림) → 버스, 짧은 잔향 + 큰 홀 + 점8분 딜레이
function musicBusBuild(dest) {
  const bus = gainN(1);
  bus.connect(dest);
  const duck = gainN(1);
  duck.connect(bus);
  const verb = ac.createConvolver();
  verb.buffer = makeIR(0.8, 4.2);
  const mv = gainN(0.16);
  verb.connect(mv);
  mv.connect(bus);
  const hall = ac.createConvolver();
  hall.buffer = makeIR(1.9, 2.8);
  const hv = gainN(0.3);
  hall.connect(hv);
  hv.connect(bus);
  const delay = ac.createDelay(1);
  delay.delayTime.value = S16 * 3;
  const fb = gainN(0.25),
    wet = gainN(0.16),
    lp = filt('lowpass', 2800, 0.5);
  delay.connect(lp);
  lp.connect(fb);
  fb.connect(delay);
  lp.connect(wet);
  wet.connect(bus);
  return {
    bus,
    duck,
    verb,
    hall,
    delay
  };
}

// 음악은 시작할 때 한 번 미리 녹음해 두고 그걸 돌려 튼다 (실시간으로 음표마다 소리 부품을 만들면 휴대폰이 버거움).
// 녹음이 끝나기 전에 게임이 시작되면 그때만 실시간으로 연주하다가, 녹음이 끝나면 다음 16분음표에서 녹음본으로 갈아탄다.
// 녹음 범위: 2마디부터 42마디 분량(40마디 한 바퀴 + 2마디). 4마디~44마디를 반복하면 반복 이음매의 잔향까지 그대로 이어진다.
const LOOP_BARS = 40,
  MUSIC_BARS = LOOP_BARS + 2,
  MUSIC_LOOP0 = 2 * 16 * S16,
  MUSIC_LOOP1 = MUSIC_BARS * 16 * S16;
let MUSIC_BUF = null,
  musicRendering = false;

function renderMusicBuffer() {
  if (MUSIC_BUF || musicRendering || !ac) return;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return;
  const sr = 32000,
    dur = MUSIC_BARS * 16 * S16,
    len = Math.ceil(sr * dur);
  let off;
  try {
    off = new OAC(2, len, sr);
  } catch { return; }
  if (!off.suspend) return;
  musicRendering = true;
  // 녹음용 부품을 따로 만들어 두고, 음표를 짤 때만 잠깐 바꿔 끼운다
  const R = {
    A: {},
    MU: {}
  };
  let save = null;
  const swapIn = () => {
    save = {
      ac,
      A: Object.assign({}, A),
      MU: Object.assign({}, MU)
    };
    ac = off;
    Object.assign(A, R.A);
    Object.assign(MU, R.MU);
  };
  const swapOut = () => {
    ac = save.ac;
    Object.assign(A, save.A);
    Object.assign(MU, save.MU);
    save = null;
  };
  try {
    swapIn();
    R.A.music = gainN(1);
    R.A.music.connect(off.destination); // 음악 버스(0.4)는 나중에 실시간에서 곱한다
    Object.assign(R.MU, musicBusBuild(R.A.music));
    swapOut();
  } catch {
    if (save) swapOut();
    musicRendering = false;
    return;
  }
  // 실시간처럼 1초씩 앞만 짜 넣으며 녹음 (한꺼번에 다 만들면 녹음이 아주 느려짐)
  const total = MUSIC_BARS * 16;
  let step = 0;
  const schedUntil = (tEnd) => {
    swapIn();
    try {
      while (step < total && step * S16 < tEnd) {
        musicStep(32 + step, step * S16);
        step++;
      }
    } finally {
      swapOut();
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
      MUSIC_BUF = buf;
      musicHandoff();
    }
    musicRendering = false;
  };
  const p = off.startRendering();
  if (p && p.then) p.then(done, () => {
    musicRendering = false;
  });
  else off.oncomplete = (e) => done(e.renderedBuffer);
}

function musicBufSource(fromStep, t0) {
  const src = ac.createBufferSource();
  src.buffer = MUSIC_BUF;
  src.loop = true;
  src.loopStart = MUSIC_LOOP0;
  src.loopEnd = MUSIC_LOOP1;
  let off = (fromStep - 32) * S16;
  if (off >= MUSIC_LOOP1) off = MUSIC_LOOP0 + (off - MUSIC_LOOP0) % (MUSIC_LOOP1 - MUSIC_LOOP0);
  src.connect(MU.bus);
  src.start(t0, off);
  MU.src = src;
  MU.on = true;
  MU.t0 = t0;
  MU.from = fromStep;
}

function musicStart(t0, fromStep = 0) {
  if (!ok()) return;
  musicStop(true);
  if (MUSIC_BUF && fromStep >= 32) {
    MU.bus = gainN(1);
    MU.bus.connect(A.music);
    musicBufSource(fromStep, t0);
    return;
  }
  Object.assign(MU, musicBusBuild(A.music));
  MU.on = true;
  MU.step = fromStep;
  MU.next = t0;
  MU.src = null;
  clearInterval(MU.timer);
  MU.timer = setInterval(musicTick, 25);
  musicTick();
}
// 실시간 연주 중에 녹음이 끝나면: 아직 안 짠 다음 16분음표부터 녹음본이 이어받는다
function musicHandoff() {
  if (!MU.on || MU.src || !MU.bus || !ac || !MUSIC_BUF) return;
  let st = MU.step,
    t = MU.next;
  if (st < 32) return;
  if (t < ac.currentTime + 0.01) {
    const skip = Math.ceil((ac.currentTime + 0.01 - t) / S16);
    st += skip;
    t += skip * S16;
  }
  clearInterval(MU.timer);
  const old = MU.bus;
  old.gain.setValueAtTime(1, t);
  old.gain.linearRampToValueAtTime(0, t + 0.02);
  setTimeout(() => {
    try {
      old.disconnect();
    } catch { }
  }, 3000);
  MU.bus = gainN(1);
  MU.bus.connect(A.music);
  musicBufSource(st, t);
}

function musicStop(hard) {
  if (!MU.bus) return;
  MU.on = false;
  clearInterval(MU.timer);
  if (!ac) return;
  const t = ac.currentTime,
    b = MU.bus,
    src = MU.src;
  b.gain.cancelScheduledValues(t);
  b.gain.setValueAtTime(b.gain.value, t);
  b.gain.linearRampToValueAtTime(0, t + (hard ? 0.025 : 0.7));
  if (src) {
    try {
      src.stop(t + (hard ? 0.05 : 0.75));
    } catch { }
  }
  MU.bus = null;
  MU.src = null;
  setTimeout(() => {
    try {
      b.disconnect();
    } catch { }
  }, 2000);
}
// 지금 몇 번째 16분음표인지 (다시 짤 때 이어서 틀기용)
function musicNowStep() {
  return MU.src ? MU.from + Math.max(0, Math.floor((ac.currentTime - MU.t0) / S16)) : MU.step;
}

function musicTick() {
  if (!MU.on || !ac || MU.src) return;
  if (MU.next < ac.currentTime - 0.03) {
    const skip = Math.ceil((ac.currentTime - MU.next) / S16);
    MU.step += skip;
    MU.next += skip * S16;
  }
  while (MU.next < ac.currentTime + 0.14) {
    musicStep(MU.step, MU.next);
    MU.step++;
    MU.next += S16;
  }
}

// ── 악기 ──
function mKick(t, v = 1) {
  // 909풍: 높은 데서 훅 떨어지는 몸통을 찌그러뜨려 '퍽' + 짧은 클릭
  const o = oscN('sine', 200),
    g = gainN(0);
  o.frequency.setValueAtTime(210, t);
  o.frequency.exponentialRampToValueAtTime(56, t + 0.045);
  o.frequency.exponentialRampToValueAtTime(42, t + 0.26);
  envAD(g.gain, t, 0.001, 1.1 * v, 0.33);
  const sh = ac.createWaveShaper();
  sh.curve = CURVE_HARD;
  sh.oversample = '2x';
  const post = gainN(0.85);
  o.connect(g).connect(sh).connect(post).connect(MU.bus);
  o.start(t);
  o.stop(t + 0.36);
  const n = noiseN(),
    hp = filt('highpass', 2600, 0.8),
    gn = gainN(0);
  envAD(gn.gain, t, 0.0005, 0.32 * v, 0.016);
  n.connect(hp).connect(gn).connect(MU.bus);
  n.start(t, rand(0, 2));
  n.stop(t + 0.03);
  MU.duck.gain.setValueAtTime(0.3, t);
  MU.duck.gain.linearRampToValueAtTime(1, t + 0.13);
}

function mSnare(t, v = 1) {
  // 909풍 스네어: 몸통 음 두 개 + 쏴 하는 노이즈(클랩처럼 세 번 튐) + 80년대식 게이트 잔향
  for (const [f0, f1, a, d] of [
    [185, 150, 0.5, 0.12],
    [330, 280, 0.25, 0.08]
  ]) {
    const o = oscN('triangle', f0),
      g = gainN(0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + 0.06);
    envAD(g.gain, t, 0.001, a * v, d);
    o.connect(g).connect(MU.bus);
    o.start(t);
    o.stop(t + d + 0.02);
  }
  const n = noiseN(),
    hp = filt('highpass', 1400, 0.7),
    lp = filt('lowpass', 9000, 0.7),
    g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  [0, 0.009, 0.019].forEach((d) => {
    g.gain.setValueAtTime(0.5 * v, t + d);
    g.gain.exponentialRampToValueAtTime(0.1 * v, t + d + 0.007);
  });
  g.gain.setValueAtTime(0.42 * v, t + 0.028);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  n.connect(hp).connect(lp).connect(g).connect(MU.bus);
  n.start(t, rand(0, 2));
  n.stop(t + 0.22);
  const n2 = noiseN(),
    bp = filt('bandpass', 2200, 0.6),
    g2 = gainN(0);
  g2.gain.setValueAtTime(0.0001, t);
  g2.gain.linearRampToValueAtTime(0.16 * v, t + 0.03);
  g2.gain.setValueAtTime(0.16 * v, t + 0.13);
  g2.gain.linearRampToValueAtTime(0, t + 0.15);
  n2.connect(bp).connect(g2).connect(MU.bus);
  n2.start(t, rand(0, 2));
  n2.stop(t + 0.17);
  const rv = gainN(0.3);
  g.connect(rv);
  rv.connect(MU.verb);
}

function mHat(t, v, open) {
  const n = noiseN(),
    hp = filt('highpass', open ? 6000 : 7500, 0.7),
    pk = filt('peaking', 10000, 1.2),
    g = gainN(0);
  pk.gain.value = 6;
  envAD(g.gain, t, 0.0006, (open ? 0.2 : 0.14) * v, open ? 0.2 : 0.03);
  n.connect(hp).connect(pk).connect(g).connect(MU.bus);
  n.start(t, rand(0, 2));
  n.stop(t + (open ? 0.26 : 0.05));
}

function mBass(t, m, dur, acc) {
  // 톱니+사각+사인 서브, 공진 큰 필터를 악센트마다 열고 찌그러뜨린다
  const f = mtof(m),
    o1 = oscN('sawtooth', f),
    o2 = oscN('square', f),
    sub = oscN('sine', f);
  o1.detune.value = -6;
  o2.detune.value = 6;
  const lp = filt('lowpass', 800, 5);
  lp.frequency.setValueAtTime(420 + 2200 * acc, t);
  lp.frequency.exponentialRampToValueAtTime(170, t + dur);
  const sh = ac.createWaveShaper();
  sh.curve = A.shaper;
  const g = gainN(0);
  envAD(g.gain, t, 0.002, 0.3 * (0.85 + acc * 0.3), dur);
  const g2 = gainN(0.35),
    gs = gainN(0);
  envAD(gs.gain, t, 0.002, 0.22, dur);
  o1.connect(lp);
  o2.connect(g2).connect(lp);
  lp.connect(sh).connect(g).connect(MU.duck);
  sub.connect(gs).connect(MU.duck);
  for (const o of [o1, o2, sub]) {
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}
// 후버(알파주노 '뿡'): 넓게 디튠한 톱니 여러 겹 + 아래 옥타브 사각 + 위 옥타브 톱니, 처음에 위에서 아래로 훅 떨어지는 음정
function mHoover(t, m, steps, v = 1, thin = false) {
  const dur = Math.max(0.06, steps * S16 - 0.015),
    f = mtof(m);
  const lp = filt('lowpass', 2600, 1.4);
  lp.frequency.setValueAtTime(4500, t);
  lp.frequency.exponentialRampToValueAtTime(2200, t + Math.max(0.08, dur));
  const sh = ac.createWaveShaper();
  sh.curve = CURVE_SOFT;
  const g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.34 * v, t + 0.006);
  g.gain.setValueAtTime(0.34 * v, t + dur - 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.03);
  const layers = thin ? [
    [1, -18, 1, 'sawtooth'],
    [1, 18, 1, 'sawtooth']
  ] : [
    [1, -22, 1, 'sawtooth'],
    [1, 0, 1, 'sawtooth'],
    [1, 22, 1, 'sawtooth'],
    [0.5, 0, 0.55, 'square'],
    [2, 6, 0.3, 'sawtooth']
  ];
  let lfoTarget = null;
  for (const [mul, det, a, type] of layers) {
    const osc = oscN(type, f * mul),
      ga = gainN(a * 0.3);
    osc.detune.value = det;
    osc.frequency.setValueAtTime(f * mul * 1.6, t);
    osc.frequency.exponentialRampToValueAtTime(f * mul, t + (steps >= 3 ? 0.11 : 0.065));
    osc.connect(ga).connect(lp);
    osc.start(t);
    osc.stop(t + dur + 0.06);
    if (det === 0 && mul === 1) lfoTarget = osc;
  }
  if (lfoTarget) {
    const lfo = oscN('sine', 5.5),
      lg = gainN(14);
    lfo.connect(lg);
    lg.connect(lfoTarget.detune);
    lfo.start(t);
    lfo.stop(t + dur + 0.06);
  }
  lp.connect(sh).connect(g).connect(MU.duck);
  const rv = gainN(0.28);
  g.connect(rv);
  rv.connect(MU.verb);
  const ds = gainN(0.14);
  g.connect(ds);
  ds.connect(MU.delay);
}
// 후버 파워코드 (근음 + 5도)
function mStab(t, m, steps, v = 1) {
  mHoover(t, m, steps, v);
  mHoover(t, m + 7, steps, v * 0.55, true);
}
// 오케스트라 히트: 단3화음을 옥타브로 쌓은 금관 + 팀파니 쿵 + 스냅, 큰 홀 잔향
function mOrch(t, root, v = 1) {
  const lp = filt('lowpass', 5000, 0.9);
  lp.frequency.setValueAtTime(6000, t);
  lp.frequency.exponentialRampToValueAtTime(1300, t + 0.35);
  const g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09 * v, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.045 * v, t + 0.12);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  for (const iv of [0, 12, 19, 24, 27, 31, 36]) {
    const f = mtof(root + iv);
    for (const [type, a] of [
      ['sawtooth', 1],
      ['square', 0.35]
    ]) {
      const o = oscN(type, f),
        ga = gainN(a);
      o.detune.value = rand(-8, 8);
      o.frequency.setValueAtTime(f * 1.02, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
      o.connect(ga).connect(lp);
      o.start(t);
      o.stop(t + 0.55);
    }
  }
  const sh = ac.createWaveShaper();
  sh.curve = CURVE_SOFT;
  lp.connect(sh).connect(g).connect(MU.bus);
  const o = oscN('sine', 110),
    og = gainN(0);
  o.frequency.setValueAtTime(120, t);
  o.frequency.exponentialRampToValueAtTime(52, t + 0.2);
  envAD(og.gain, t, 0.002, 0.6 * v, 0.3);
  o.connect(og).connect(MU.bus);
  o.start(t);
  o.stop(t + 0.35);
  const n = noiseN(),
    bp = filt('bandpass', 1800, 1),
    ng = gainN(0);
  envAD(ng.gain, t, 0.001, 0.4 * v, 0.04);
  n.connect(bp).connect(ng).connect(MU.bus);
  n.start(t, rand(0, 2));
  n.stop(t + 0.06);
  const rv = gainN(0.9);
  g.connect(rv);
  rv.connect(MU.hall);
  const rv2 = gainN(0.5);
  og.connect(rv2);
  rv2.connect(MU.hall);
}
// 군중 함성: 톱니 다섯 겹(남자 다섯 명 음높이)을 모음 공명 필터로 — kind 0: "헤이!", 1: "허!"
function mShout(t, v = 1, kind = 0) {
  const F = kind ? [
    [640, 8, 1],
    [1150, 9, 0.5],
    [2500, 10, 0.25]
  ] : [
    [600, 7, 1],
    [1900, 9, 0.55],
    [2600, 10, 0.3]
  ];
  const mix = gainN(0.22),
    pre = gainN(1);
  [118, 136, 152, 171, 196].forEach((b) => {
    const f0 = b * rand(0.97, 1.03),
      o = oscN('sawtooth', f0);
    o.frequency.setValueAtTime(f0 * 1.28, t);
    o.frequency.exponentialRampToValueAtTime(f0, t + 0.07);
    o.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + 0.28);
    o.connect(pre);
    o.start(t);
    o.stop(t + 0.34);
  });
  // 여러 명이 외치는 거친 질감: 모음 필터에 숨소리 노이즈도 같이 넣는다
  const nv = noiseN(),
    nvg = gainN(0);
  nvg.gain.setValueAtTime(0.0001, t);
  nvg.gain.exponentialRampToValueAtTime(0.5, t + 0.03);
  nvg.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  nv.connect(nvg).connect(pre);
  nv.start(t, rand(0, 2));
  nv.stop(t + 0.32);
  for (const [f, q, a] of F) {
    const bp = filt('bandpass', f, q),
      g = gainN(a);
    pre.connect(bp).connect(g).connect(mix);
  }
  const t1 = Math.max(0, t - 0.01);
  const n = noiseN(),
    bp = filt('bandpass', 1600, 0.8),
    ng = gainN(0);
  envAD(ng.gain, t1, 0.005, 0.25, 0.05);
  n.connect(bp).connect(ng).connect(mix);
  n.start(t1, rand(0, 2));
  n.stop(t + 0.08);
  const sh = ac.createWaveShaper();
  sh.curve = CURVE_SOFT;
  const g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(1.5 * v, t + 0.025);
  g.gain.setValueAtTime(1.5 * v, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  mix.connect(sh).connect(g).connect(MU.bus);
  const rv = gainN(0.5);
  g.connect(rv);
  rv.connect(MU.hall);
}

function mArp(t, m, cut, v = 1) {
  const o = oscN('square', mtof(m)),
    o2 = oscN('sawtooth', mtof(m)),
    lp = filt('lowpass', cut, 2),
    g = gainN(0),
    g2 = gainN(0.6);
  o2.detune.value = 8;
  lp.frequency.setValueAtTime(cut * 1.6, t);
  lp.frequency.exponentialRampToValueAtTime(cut * 0.5, t + 0.09);
  envAD(g.gain, t, 0.001, 0.2 * v, 0.085);
  o.connect(lp);
  o2.connect(g2).connect(lp);
  lp.connect(g).connect(MU.duck);
  o.start(t);
  o2.start(t);
  o.stop(t + 0.1);
  o2.stop(t + 0.1);
  const ds = gainN(0.3);
  g.connect(ds);
  ds.connect(MU.delay);
}
// 브레이크용 긴장 패드 (반음 뭉친 화음이 서서히 열린다)
function mPad(t, notes, dur, v = 1) {
  const lp = filt('lowpass', 600, 1.2);
  lp.frequency.setValueAtTime(500, t);
  lp.frequency.exponentialRampToValueAtTime(2600, t + dur);
  const g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.07 * v, t + dur * 0.5);
  g.gain.setValueAtTime(0.07 * v, t + dur - 0.05);
  g.gain.linearRampToValueAtTime(0, t + dur);
  for (const m of notes)
    for (const d of [-12, 0, 12]) {
      const o = oscN('sawtooth', mtof(m));
      o.detune.value = d;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  lp.connect(g).connect(MU.bus);
  const rv = gainN(0.5);
  g.connect(rv);
  rv.connect(MU.hall);
}

function mDrone(t, m, dur, v = 1) {
  const f = mtof(m),
    o = oscN('sine', f),
    o2 = oscN('sawtooth', f),
    lp = filt('lowpass', 220, 1),
    g = gainN(0),
    g2 = gainN(0.35);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.1 * v, t + 0.05);
  g.gain.setValueAtTime(0.1 * v, t + dur - 0.1);
  g.gain.linearRampToValueAtTime(0, t + dur);
  o.connect(g);
  o2.connect(g2).connect(lp).connect(g);
  g.connect(MU.bus);
  o.start(t);
  o2.start(t);
  o.stop(t + dur + 0.02);
  o2.stop(t + dur + 0.02);
}

function mTimp(t, v = 1, f = 73) {
  const o = oscN('sine', f),
    g = gainN(0);
  o.frequency.setValueAtTime(f * 1.3, t);
  o.frequency.exponentialRampToValueAtTime(f, t + 0.03);
  o.frequency.exponentialRampToValueAtTime(f * 0.85, t + 0.4);
  envAD(g.gain, t, 0.002, 0.55 * v, 0.42);
  const sh = ac.createWaveShaper();
  sh.curve = A.shaper;
  o.connect(g).connect(sh).connect(MU.bus);
  o.start(t);
  o.stop(t + 0.5);
  const n = noiseN(),
    lp = filt('lowpass', 900, 0.8),
    ng = gainN(0);
  envAD(ng.gain, t, 0.001, 0.3 * v, 0.03);
  n.connect(lp).connect(ng).connect(MU.bus);
  n.start(t, rand(0, 2));
  n.stop(t + 0.05);
  const rv = gainN(0.35);
  g.connect(rv);
  rv.connect(MU.hall);
}

function mCrash(t, v = 1) {
  const n = noiseN(),
    hp = filt('highpass', 3200, 0.5),
    g = gainN(0);
  envAD(g.gain, t, 0.001, 0.26 * v, 1.1);
  n.connect(hp).connect(g).connect(MU.bus);
  n.start(t, rand(0, 2));
  n.stop(t + 1.2);
  for (const f of [3100, 4730, 6210]) {
    const o = oscN('square', f),
      og = gainN(0);
    envAD(og.gain, t, 0.001, 0.02 * v, 0.6);
    o.connect(og).connect(MU.bus);
    o.start(t);
    o.stop(t + 0.7);
  }
  const rv = gainN(0.3);
  g.connect(rv);
  rv.connect(MU.hall);
}

function mTom(t, f, v = 1) {
  const o = oscN('triangle', f),
    g = gainN(0);
  o.frequency.setValueAtTime(f * 1.15, t);
  o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.16);
  envAD(g.gain, t, 0.001, 0.45 * v, 0.18);
  const sh = ac.createWaveShaper();
  sh.curve = A.shaper;
  o.connect(g).connect(sh).connect(MU.bus);
  o.start(t);
  o.stop(t + 0.22);
  const rv = gainN(0.25);
  g.connect(rv);
  rv.connect(MU.verb);
}

function mSweep(t, dur, v = 1) {
  const n = noiseN(),
    bp = filt('bandpass', 400, 1.2),
    g = gainN(0);
  bp.frequency.setValueAtTime(400, t);
  bp.frequency.exponentialRampToValueAtTime(8000, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.28 * v, t + dur * 0.95);
  g.gain.linearRampToValueAtTime(0, t + dur);
  n.connect(bp).connect(g).connect(MU.bus);
  n.start(t, rand(0, 2));
  n.stop(t + dur + 0.02);
}
// 후버 사이렌: 한 옥타브 올라가며 필터가 열린다 (드롭 직전)
function mRise(t, m, dur, v = 1) {
  const f = mtof(m),
    lp = filt('lowpass', 800, 2),
    g = gainN(0);
  lp.frequency.setValueAtTime(700, t);
  lp.frequency.exponentialRampToValueAtTime(5000, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.1 * v, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.16 * v, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.01);
  for (const det of [-20, 0, 20]) {
    const o = oscN('sawtooth', f);
    o.detune.value = det;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 2, t + dur);
    o.connect(lp);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sh = ac.createWaveShaper();
  sh.curve = CURVE_SOFT;
  lp.connect(sh).connect(g).connect(MU.bus);
  const rv = gainN(0.3);
  g.connect(rv);
  rv.connect(MU.hall);
}

// ── 시퀀스 ──
// 40마디 한 바퀴: H(0~3) 히트 인트로 → A(4~11) 후버 리프 → B(12~19) 아르페지오 → X(20~23) 브레이크·빌드업 → A2(24~31) → B2(32~39)
function musicStep(n, t) {
  const bar = n >> 4,
    s = n & 15;
  const k = bar < 2 ? bar : (bar - 2) % LOOP_BARS;
  const si = k < 4 ? 0 : k < 12 ? 1 : k < 20 ? 2 : k < 24 ? 3 : k < 32 ? 4 : 5;
  const sec = 'HABXAB'[si],
    kk = k - [0, 4, 12, 20, 24, 32][si],
    lastBar = kk === [4, 8, 8, 4, 8, 8][si] - 1,
    second = si >= 4;
  const ci = k % 4,
    root = ROOTS[ci],
    X = sec === 'X',
    pcm = root + 24;
  const h = (v) => mOrch(t, root, v),
    sh = (v, kind) => mShout(t, v, kind);
  // ── 드럼 ──
  if (!X) {
    if (s % 4 === 0) mKick(t);
    if (s === 4 || s === 12) mSnare(t, 1);
    if (lastBar && s > 12 && sec !== 'H' && sec !== 'B2') mSnare(t, 0.5 + (s - 13) * 0.15);
    if (lastBar && s >= 8 && sec === 'B2') mTom(t, 260 - (s - 8) * 24, 0.9);
    if (lastBar && s > 12 && sec === 'B') mTom(t, 220 - (s - 13) * 30, 0.8);
    if (s % 4 === 2) mHat(t, 1, true);
    else mHat(t, s % 2 === 0 ? 0.75 : 0.4, false);
  } else {
    if (kk === 2 && (s === 0 || s === 8)) mKick(t);
    if (kk === 3 && s < 12 && s % 4 === 0) mKick(t);
    if (kk === 2) mSnare(t, 0.3 + s * 0.025);
    if (kk === 3 && s < 12) {
      mSnare(t, 0.45 + s * 0.045);
      mSnare(t + S16 / 2, 0.4 + s * 0.045);
    }
    if (kk < 2) {
      if (s % 2 === 0) mHat(t, 0.3, false);
    } else if (kk === 2 || s < 12) {
      if (s % 4 === 2) mHat(t, kk === 2 ? 0.7 : 0.9, true);
      else mHat(t, kk === 2 ? 0.45 : 0.6, false);
    }
  }
  if (s === 0 && (kk === 0 || (sec === 'H' && kk === 2))) mCrash(t, sec === 'H' ? 1 : 0.8); // H 2마디째는 반복 이음매 착지점
  // ── 베이스 ──
  if (!X) {
    const p = BASS_PAT[s];
    mBass(t, root + p, S16 * 0.85, p ? 1 : 0.3);
  } else if (kk === 2 && s % 2 === 0) mBass(t, root, S16 * 1.2, 0.15);
  else if (kk === 3 && s < 12) mBass(t, root + (s % 4 === 2 ? 12 : 0), S16 * 0.85, 0.3 + s / 14);
  // ── 후버 ──
  if (sec === 'H') {
    if (s === 0 || s === 6) mStab(t, pcm, 2, 1);
    else if (s === 12) mStab(t, pcm, kk % 2 ? 1 : 2, 1);
    if (kk % 2 && s === 14) mStab(t, pcm + 1, 1, 0.9);
  } else if (sec === 'A') {
    for (const [ss, m, d] of RIFF[ci])
      if (ss === s) mStab(t, m, d, second ? 1 : 0.92);
  } else if (sec === 'B') {
    for (const [ss, m, d] of RIFF[ci])
      if (ss === s && (ss <= 6 || ci === 3)) mStab(t, m, d, 0.85);
  }
  // ── 아르페지오 ──
  if (sec === 'B') mArp(t, ARP[ci][s], second ? 3200 : 2600, 1);
  else if (sec === 'A' && second && s % 2 === 1) mArp(t, ARP[0][s], 1700, 0.55);
  else if (X && kk >= 2 && !(kk === 3 && s >= 12)) mArp(t, ARP[0][s], 500 + ((kk - 2) * 16 + s) * 90, 0.9);
  // ── 오케스트라 히트 ──
  if (sec === 'H') {
    if (s === 0) h(1);
    else if (s === 6) h(0.8);
    else if (s === 12 && kk % 2 === 0) h(0.8);
    else if (kk === 3 && (s === 12 || s === 14)) h(0.75);
  } else if (X) {
    if (kk === 0 && s === 0) h(1.1);
    else if (kk === 1 && s === 0) h(0.6);
    else if (kk === 3 && s === 12) h(1);
  } else if (!second) {
    if (s === 0 && kk % 4 === 0) h(1);
    else if (lastBar && (s === 12 || s === 14)) h(0.75);
  } else if (s === 0 && kk % 2 === 0) h(1);
  else if (lastBar && (s === 6 || s === 12 || s === 14)) h(0.8);
  // ── 함성 ──
  if (sec === 'H') {
    if (s === 0 && kk % 2 === 0) sh(1, 0);
    else if (kk === 3 && s === 12) sh(1, 0);
    else if (kk === 3 && s === 14) sh(0.8, 0);
  } else if (X) {
    if (s === 0 || (kk >= 1 && s === 8) || (kk === 3 && s === 4)) sh(kk === 3 ? 1 : 0.8, 1);
    if (kk === 3 && s === 12) sh(1.2, 0);
  } else {
    if (kk % 4 === 3 && s === 14) sh(0.9, 0);
    if (lastBar && s === 12 && sec === 'B') sh(0.9, 0);
    if (lastBar && s === 0 && sec === 'B' && second) sh(1, 0);
  }
  // ── 브레이크 장식 ──
  if (X && kk === 0 && s === 0) {
    mPad(t, [50, 51, 57, 62], SPB * 16, 1);
    mSweep(t, S16 * 60, 1);
    mDrone(t, 38, SPB * 8, 1);
    mTimp(t, 1, 73);
  }
  if (X && kk === 1 && s >= 8) mTimp(t, 0.25 + (s - 8) * 0.07, 73);
  if (X && kk === 3 && s < 12 && s % 2 === 0) mTimp(t, 0.3 + s * 0.05, 73);
  if (X && kk === 2 && s === 0) mRise(t, 62, S16 * 28, 1); // 드롭 직전 한 박은 비운다 (함성과 잔향만)
}

// ───────────────────────── 캔버스 텍스처 ─────────────────────────
function cnv(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function texOf(c, o = {}) {
  const t = new THREE.CanvasTexture(c);
  if (o.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (o.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  return t;
}

// 바닥: 아주 옅은 줄눈
function makeFloorTex() {
  const c = cnv(256, 256),
    g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(110, 100, 140, 0.085)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, 253, 253);
  return texOf(c, {
    repeat: true
  });
}

// ── 군중 얼굴 (3×2: 기존 네 표정 + 4 서로를 훑을 때의 무표정) ──
const FACE_OFF = [
  [0, 0.5],
  [1 / 3, 0.5],
  [0, 0],
  [1 / 3, 0],
  [2 / 3, 0.5]
];

function drawTears(g, cx, ey, ex, alpha) {
  for (const sx of [-1, 1]) {
    const x0 = cx + sx * (ex + 11),
      y0 = ey + 15;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.strokeStyle = `rgba(95, 190, 255, ${0.85 * alpha})`;
    g.lineWidth = 11;
    g.beginPath();
    g.moveTo(x0, y0);
    g.bezierCurveTo(x0 + sx * 8, y0 + 30, x0 - sx * 6, y0 + 58, x0 + sx * 6, y0 + 112);
    g.stroke();
    g.strokeStyle = `rgba(235, 250, 255, ${0.9 * alpha})`;
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(x0 - sx * 2, y0 + 6);
    g.bezierCurveTo(x0 + sx * 5, y0 + 30, x0 - sx * 8, y0 + 56, x0 + sx * 3, y0 + 100);
    g.stroke();
    // 눈물 방울
    g.fillStyle = `rgba(95, 190, 255, ${0.9 * alpha})`;
    g.beginPath();
    g.ellipse(x0 + sx * 7, y0 + 118, 6, 8, 0, 0, TAU);
    g.fill();
  }
}
// 무광의 반쯤 감긴 군중 눈: 바깥 눈꼬리와 윗눈꺼풀이 아래로 처진다.
function drawCrowdDeadEyes(g, cx, ey, ex) {
  const ink = '#2a1d26';
  for (const sx of [-1, 1]) {
    const x = cx + sx * ex,
      inner = x - sx * 20,
      outer = x + sx * 20;
    g.save();
    g.beginPath();
    g.moveTo(inner, ey - 3);
    g.quadraticCurveTo(x, ey + 1, outer, ey + 8);
    g.quadraticCurveTo(x, ey + 24, inner, ey + 13);
    g.closePath();
    g.fillStyle = '#ddd6da';
    g.fill();
    g.clip();
    g.fillStyle = ink;
    g.beginPath();
    g.ellipse(x, ey + 12, 8, 11, 0, 0, TAU);
    g.fill();
    g.restore();
    g.strokeStyle = ink;
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(inner, ey - 3);
    g.quadraticCurveTo(x, ey + 1, outer, ey + 8);
    g.stroke();
    g.strokeStyle = 'rgba(70, 45, 58, 0.3)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(inner + sx * 3, ey + 20);
    g.quadraticCurveTo(x, ey + 28, outer - sx * 2, ey + 22);
    g.stroke();
  }
}

function drawCrowdFace(g, ox, oy, st) {
  g.save();
  g.translate(ox, oy);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  const cx = 128,
    ey = 120,
    ex = 40,
    ink = '#2a1d26';
  // Crying blush and red nose remain, but the brows and eyes are now angry.
  for (const sx of [-1, 1]) {
    const x = cx + sx * 64;
    const blush = g.createRadialGradient(x, 160, 2, x, 160, 30);
    blush.addColorStop(0, st === 2 ? 'rgba(255, 110, 140, .55)' : 'rgba(240, 80, 90, .42)');
    blush.addColorStop(1, 'rgba(240, 80, 90, 0)');
    g.fillStyle = blush;
    g.beginPath();
    g.arc(x, 160, 30, 0, TAU);
    g.fill();
  }
  g.fillStyle = 'rgba(230, 85, 92, .6)';
  g.beginPath();
  g.ellipse(cx, 156, 9, 6.5, 0, 0, TAU);
  g.fill();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // Inner brow tips drop into a determined scowl.
  g.strokeStyle = ink;
  g.lineWidth = 8;
  for (const sx of [-1, 1]) {
    const inner = cx + sx * 14,
      outer = cx + sx * 64;
    g.beginPath();
    g.moveTo(outer, 76);
    g.quadraticCurveTo(cx + sx * 40, 81, inner, 100);
    g.stroke();
  }
  if (st === 3) {
    g.strokeStyle = ink;
    g.lineWidth = 8;
    for (const sx of [-1, 1]) {
      const x = cx + sx * ex;
      g.beginPath();
      g.moveTo(x - 13, ey - 13);
      g.lineTo(x + 13, ey + 13);
      g.moveTo(x + 13, ey - 13);
      g.lineTo(x - 13, ey + 13);
      g.stroke();
    }
  } else {
    g.fillStyle = ink;
    for (const sx of [-1, 1]) {
      const x = cx + sx * ex;
      g.beginPath();
      g.moveTo(x - 19, ey - 7);
      g.quadraticCurveTo(x, ey + 3, x + 19, ey - 7);
      g.lineTo(x + 13, ey + 7);
      g.quadraticCurveTo(x, ey + 13, x - 13, ey + 7);
      g.closePath();
      g.fill();
    }
    drawTears(g, cx, ey, ex, st === 2 ? .65 : 1);
  }
  g.strokeStyle = ink;
  g.lineWidth = 5;
  if (st === 2) {
    // Tight, downward-curved mouth: an angry pout under the tears.
    g.beginPath();
    g.moveTo(108, 202);
    g.lineTo(120, 207);
    g.lineTo(128, 203);
    g.lineTo(136, 207);
    g.lineTo(148, 202);
    g.stroke();
  } else if (st === 1) {
    g.fillStyle = '#4a1724';
    g.beginPath();
    g.ellipse(128, 208, 16, 21, 0, 0, TAU);
    g.fill();
    g.fillStyle = '#fff';
    g.fillRect(117, 192, 22, 5);
  } else if (st === 0) {
    g.beginPath();
    g.moveTo(111, 203);
    g.lineTo(145, 203);
    g.stroke();
  } else {
    g.fillStyle = '#3a1520';
    g.beginPath();
    g.ellipse(128, 206, 11, 14, 0, 0, TAU);
    g.fill();
  }
  g.restore();
}

function drawCrowdNeutralFace(g, ox, oy) {
  g.save();
  g.translate(ox, oy);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  const ink = '#2a1d26';
  g.strokeStyle = ink;
  g.lineCap = 'round';
  g.lineWidth = 6;
  // 눈물·홍조 없이 처진 죽은 눈과 일자로 다문 입.
  drawCrowdDeadEyes(g, 128, 120, 40);
  g.strokeStyle = ink;
  g.lineWidth = 6;
  for (const x of [88, 168]) {
    g.beginPath();
    g.moveTo(x - 18, 88);
    g.lineTo(x + 18, 88);
    g.stroke();
  }
  g.strokeStyle = 'rgba(120, 75, 70, 0.45)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(124, 155);
  g.quadraticCurveTo(128, 159, 132, 155);
  g.stroke();
  g.strokeStyle = ink;
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(109, 202);
  g.lineTo(147, 202);
  g.stroke();
  g.restore();
}

function makeCrowdFaceAtlas() {
  const c = cnv(768, 512),
    g = c.getContext('2d');
  drawCrowdFace(g, 0, 0, 0);
  drawCrowdFace(g, 256, 0, 1);
  drawCrowdFace(g, 0, 256, 2);
  drawCrowdFace(g, 256, 256, 3);
  drawCrowdNeutralFace(g, 512, 0);
  return texOf(c);
}

// ── 주인공 얼굴 (1024): 땡글땡글 반짝이는 눈, 단정한 웃상 ──
const ME_SKIN = '#ffdcc6';
const meFaceCanvas = cnv(1024, 1024);
const meFaceCtx = meFaceCanvas.getContext('2d');
let meFaceTex = null;

function star4(g, x, y, r, w, color) {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x + w, y - w, x + r, y);
  g.quadraticCurveTo(x + w, y + w, x, y + r);
  g.quadraticCurveTo(x - w, y + w, x - r, y);
  g.quadraticCurveTo(x - w, y - w, x, y - r);
  g.fill();
}

function drawMeFace() {
  faceBloodN = 0;
  const g = meFaceCtx;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = ME_SKIN;
  g.fillRect(0, 0, 1024, 1024);
  const cx = 512,
    ey = 520,
    ex = 168;
  // 볼터치
  for (const sx of [-1, 1]) {
    const x = cx + sx * 268,
      y = 660;
    const gr = g.createRadialGradient(x, y, 4, x, y, 96);
    gr.addColorStop(0, 'rgba(255, 120, 150, 0.62)');
    gr.addColorStop(1, 'rgba(255, 120, 150, 0)');
    g.fillStyle = gr;
    g.beginPath();
    g.ellipse(x, y, 100, 64, 0, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(240, 90, 120, 0.55)';
    g.lineWidth = 7;
    g.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(x + i * 30 - 10, y + 14);
      g.lineTo(x + i * 30 + 10, y - 14);
      g.stroke();
    }
  }
  const ink = '#2a1712';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // 눈썹: 단정한 아치
  g.strokeStyle = '#3b241b';
  g.lineWidth = 20;
  for (const sx of [-1, 1]) {
    g.beginPath();
    g.moveTo(cx + sx * 88, 352);
    g.quadraticCurveTo(cx + sx * 168, 318, cx + sx * 246, 350);
    g.stroke();
  }
  // 눈
  for (const sx of [-1, 1]) {
    const x = cx + sx * ex;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(x, ey, 96, 110, 0, 0, TAU);
    g.fill();
    // 홍채 그라데이션
    const ig = g.createLinearGradient(x, ey - 100, x, ey + 100);
    ig.addColorStop(0, '#1d0f0a');
    ig.addColorStop(0.55, '#4a2716');
    ig.addColorStop(1, '#a86536');
    g.fillStyle = ig;
    g.beginPath();
    g.ellipse(x, ey + 6, 78, 96, 0, 0, TAU);
    g.fill();
    g.strokeStyle = '#1a0c08';
    g.lineWidth = 6;
    g.stroke();
    // 동공
    g.fillStyle = '#100705';
    g.beginPath();
    g.ellipse(x, ey + 2, 40, 50, 0, 0, TAU);
    g.fill();
    // 아래쪽 반사광 링
    g.strokeStyle = 'rgba(255, 200, 140, 0.55)';
    g.lineWidth = 8;
    g.beginPath();
    g.ellipse(x, ey + 10, 58, 70, 0, 0.25 * Math.PI, 0.75 * Math.PI);
    g.stroke();
    // 하이라이트
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(x - 30, ey - 38, 30, 36, -0.35, 0, TAU);
    g.fill();
    g.beginPath();
    g.arc(x + 34, ey + 36, 14, 0, TAU);
    g.fill();
    star4(g, x + 30, ey - 48, 26, 5, '#ffffff');
    g.beginPath();
    g.arc(x - 44, ey + 30, 6, 0, TAU);
    g.fill();
    // 윗눈꺼풀 라인 + 속눈썹
    g.strokeStyle = ink;
    g.lineWidth = 17;
    g.beginPath();
    g.moveTo(x - sx * 98, ey + 6);
    g.bezierCurveTo(x - sx * 90, ey - 102, x + sx * 70, ey - 128, x + sx * 108, ey - 40);
    g.stroke();
    g.lineWidth = 11;
    g.beginPath();
    g.moveTo(x + sx * 100, ey - 50);
    g.lineTo(x + sx * 136, ey - 74);
    g.stroke();
    g.beginPath();
    g.moveTo(x + sx * 106, ey - 28);
    g.lineTo(x + sx * 140, ey - 38);
    g.stroke();
    // 아랫속눈썹
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(42, 23, 18, 0.7)';
    g.beginPath();
    g.moveTo(x - sx * 70, ey + 98);
    g.quadraticCurveTo(x, ey + 124, x + sx * 76, ey + 92);
    g.stroke();
  }
  // 코
  g.strokeStyle = 'rgba(205, 120, 100, 0.65)';
  g.lineWidth = 8;
  g.beginPath();
  g.moveTo(cx - 10, 664);
  g.quadraticCurveTo(cx, 674, cx + 10, 664);
  g.stroke();
  // 입: 단정하게 다문 살짝 웃는 입
  g.strokeStyle = '#8c3a3a';
  g.lineWidth = 12;
  g.beginPath();
  g.moveTo(cx - 74, 746);
  g.bezierCurveTo(cx - 40, 786, cx + 40, 786, cx + 74, 746);
  g.stroke();
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(cx - 74, 746);
  g.lineTo(cx - 84, 736);
  g.stroke();
  g.beginPath();
  g.moveTo(cx + 74, 746);
  g.lineTo(cx + 84, 736);
  g.stroke();
  g.fillStyle = 'rgba(255, 150, 160, 0.5)';
  g.beginPath();
  g.ellipse(cx, 790, 30, 9, 0, 0, TAU);
  g.fill();
  if (meFaceTex) meFaceTex.needsUpdate = true;
}

function bloodSpot(g, x, y, r) {
  g.fillStyle = Math.random() < 0.5 ? '#b40018' : '#d0102a';
  g.beginPath();
  const n = 9;
  for (let i = 0; i <= n; i++) {
    const a = i / n * TAU,
      rr = r * rand(0.7, 1.25);
    const px = x + Math.cos(a) * rr,
      py = y + Math.sin(a) * rr;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.fill();
  const k = Math.random() < 0.7 ? Math.floor(rand(1, 4)) : 0;
  for (let i = 0; i < k; i++) {
    const a = rand(0, TAU),
      d = r * rand(1.4, 2.6);
    g.beginPath();
    g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * rand(0.15, 0.35), 0, TAU);
    g.fill();
  }
}
let faceBloodN = 0, shirtBloodN = 0;

function addMeFaceBlood(n) {
  if (faceBloodN > 34) return;
  faceBloodN += n;
  const g = meFaceCtx;
  for (let i = 0; i < n; i++) {
    let x, y, tries = 0;
    do {
      x = rand(260, 780);
      y = rand(300, 860);
      tries++;
    } while (tries < 20 && (Math.hypot(x - 344, y - 520) < 120 || Math.hypot(x - 680, y - 520) < 120));
    bloodSpot(g, x, y, rand(6, 16));
  }
  FXDirty.face = true;
}

// ── 주인공 셔츠 (원통 UV, 앞면 = u 0.5) ──
const ME_SHIRT = '#4fb0ee';
const shirtCanvas = cnv(512, 256);
const shirtCtx = shirtCanvas.getContext('2d');
let shirtTex = null;

function drawShirt() {
  shirtBloodN = 0;
  const g = shirtCtx;
  g.fillStyle = ME_SHIRT;
  g.fillRect(0, 0, 512, 256);
  // 단추 여밈선
  g.fillStyle = 'rgba(20, 70, 120, 0.28)';
  g.fillRect(253, 0, 6, 256);
  g.fillStyle = '#ffffff';
  for (const y of [70, 120, 170, 220]) {
    g.beginPath();
    g.arc(256, y, 5.5, 0, TAU);
    g.fill();
  }
  // 주머니 (오른쪽 가슴 = 화면 왼쪽 시점에서 반대) — 명찰과 겹치지 않게 반대쪽
  g.strokeStyle = 'rgba(20, 70, 120, 0.3)';
  g.lineWidth = 3;
  g.strokeRect(196, 64, 34, 30);
  if (shirtTex) shirtTex.needsUpdate = true;
}

function addShirtBlood(n) {
  if (shirtBloodN > 60) return;
  shirtBloodN += n;
  const g = shirtCtx;
  for (let i = 0; i < n; i++) bloodSpot(g, rand(150, 362), rand(40, 240), rand(5, 15));
  FXDirty.shirt = true;
}
const FXDirty = {
  face: false,
  shirt: false,
  t: 0
};

// ── 명찰 ──
function makeBadgeTex() {
  const c = cnv(256, 128),
    g = c.getContext('2d');
  const draw = () => {
    g.clearRect(0, 0, 256, 128);
    g.fillStyle = '#ffffff';
    g.strokeStyle = '#1e2a4a';
    g.lineWidth = 8;
    g.beginPath();
    g.roundRect ? g.roundRect(6, 6, 244, 116, 16) : g.rect(6, 6, 244, 116);
    g.fill();
    g.stroke();
    drawAgencyMark(g, 40, 64, 48, '#1e2a4a');
    g.fillStyle = '#1e2a4a';
    g.font = '700 32px "Noto Sans KR", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('정신건강', 151, 44);
    g.fillStyle = '#d3122c';
    g.font = '400 52px "Black Han Sans", "Noto Sans KR", sans-serif';
    g.fillText('0급', 151, 92);
    t.needsUpdate = true;
  };
  const t = texOf(c);
  draw();
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('400 52px "Black Han Sans"'), document.fonts.load('700 36px "Noto Sans KR"')]).then(draw, () => { });
  }
  return t;
}

// ── 2급·3급 얼굴 (4×2 아틀라스, 칸 512: 윗줄 평소 / 아랫줄 붙잡혀서 버둥) ──
const ALLY_SKIN = '#fbd5bd';
const ALLY_LOOK = [{
  grade: 2,
  eyeW: 42,
  eyeH: 48,
  hl: 2,
  brow: '#3a2a20',
  fem: false,
  glasses: false,
  smile: 15,
  bags: false
},
{
  grade: 3,
  eyeW: 37,
  eyeH: 42,
  hl: 1,
  brow: '#2a2024',
  fem: true,
  glasses: false,
  smile: 9,
  bags: true
},
{
  grade: 2,
  eyeW: 41,
  eyeH: 47,
  hl: 2,
  brow: '#5a3a28',
  fem: true,
  glasses: false,
  smile: 14,
  bags: false
},
{
  grade: 3,
  eyeW: 36,
  eyeH: 41,
  hl: 1,
  brow: '#1d1a1c',
  fem: false,
  glasses: true,
  smile: 8,
  bags: true
},
];

function drawAllyFace(g, ox, oy, L, struggle) {
  g.save();
  g.translate(ox, oy);
  g.fillStyle = ALLY_SKIN;
  g.fillRect(0, 0, 512, 512);
  const cx = 256,
    ey = 262,
    ex = 84;
  const ink = '#2a1712';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // 볼터치
  for (const sx of [-1, 1]) {
    const x = cx + sx * 134,
      y = 334;
    const gr = g.createRadialGradient(x, y, 2, x, y, 46);
    gr.addColorStop(0, `rgba(255, 120, 150, ${struggle ? 0.62 : 0.4})`);
    gr.addColorStop(1, 'rgba(255, 120, 150, 0)');
    g.fillStyle = gr;
    g.beginPath();
    g.ellipse(x, y, 48, 31, 0, 0, TAU);
    g.fill();
  }
  // 눈썹
  g.strokeStyle = L.brow;
  g.lineWidth = L.fem ? 8 : 10.5;
  for (const sx of [-1, 1]) {
    g.beginPath();
    if (struggle) {
      g.moveTo(cx + sx * 42, 196);
      g.quadraticCurveTo(cx + sx * 80, 178, cx + sx * 124, 168);
    } else {
      g.moveTo(cx + sx * 44, 180);
      g.quadraticCurveTo(cx + sx * 84, 160, cx + sx * 124, 176);
    }
    g.stroke();
  }
  // 눈
  for (const sx of [-1, 1]) {
    const x = cx + sx * ex;
    if (struggle) {
      // 질끈 감은 눈 > <
      g.strokeStyle = ink;
      g.lineWidth = 9;
      g.beginPath();
      g.moveTo(x - sx * 22, ey - 18);
      g.lineTo(x + sx * 16, ey);
      g.lineTo(x - sx * 22, ey + 18);
      g.stroke();
      continue;
    }
    const w = L.eyeW,
      h = L.eyeH;
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(x, ey, w, h, 0, 0, TAU);
    g.fill();
    const ig = g.createLinearGradient(x, ey - h, x, ey + h);
    ig.addColorStop(0, '#1d0f0a');
    ig.addColorStop(0.6, '#3e2516');
    ig.addColorStop(1, '#8a5530');
    g.fillStyle = ig;
    g.beginPath();
    g.ellipse(x, ey + 3, w - 8, h - 7, 0, 0, TAU);
    g.fill();
    g.fillStyle = '#100705';
    g.beginPath();
    g.ellipse(x, ey + 1, (w - 8) * 0.5, (h - 7) * 0.52, 0, 0, TAU);
    g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.ellipse(x - w * 0.3, ey - h * 0.34, w * 0.27, h * 0.29, -0.35, 0, TAU);
    g.fill();
    if (L.hl > 1) {
      g.beginPath();
      g.arc(x + w * 0.34, ey + h * 0.32, w * 0.12, 0, TAU);
      g.fill();
    }
    // 윗눈꺼풀
    g.strokeStyle = ink;
    g.lineWidth = 8;
    g.beginPath();
    g.moveTo(x - sx * (w + 2), ey + 4);
    g.bezierCurveTo(x - sx * w * 0.95, ey - h * 0.95, x + sx * w * 0.7, ey - h * 1.18, x + sx * (w + 4), ey - h * 0.38);
    g.stroke();
    if (L.fem) {
      g.lineWidth = 5.5;
      g.beginPath();
      g.moveTo(x + sx * (w + 2), ey - h * 0.45);
      g.lineTo(x + sx * (w + 17), ey - h * 0.7);
      g.stroke();
      g.beginPath();
      g.moveTo(x + sx * (w + 4), ey - h * 0.2);
      g.lineTo(x + sx * (w + 19), ey - h * 0.3);
      g.stroke();
    }
    if (L.bags) {
      // 3급: 살짝 피곤한 눈 밑
      g.strokeStyle = 'rgba(150, 105, 160, 0.38)';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(x - w * 0.75, ey + h + 8);
      g.quadraticCurveTo(x, ey + h + 22, x + w * 0.75, ey + h + 8);
      g.stroke();
    }
  }
  // 안경
  if (L.glasses) {
    g.strokeStyle = '#2b2430';
    g.lineWidth = 6.5;
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.ellipse(cx + sx * ex, ey + 2, 60, 54, 0, 0, TAU);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(cx - ex + 58, ey - 8);
    g.quadraticCurveTo(cx, ey - 22, cx + ex - 58, ey - 8);
    g.stroke();
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + sx * (ex + 60), ey - 6);
      g.lineTo(cx + sx * 236, ey - 14);
      g.stroke();
    }
  }
  // 코
  g.strokeStyle = 'rgba(205, 120, 100, 0.6)';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(cx - 6, 332);
  g.quadraticCurveTo(cx, 338, cx + 6, 332);
  g.stroke();
  // 입
  if (struggle) {
    // 이를 악문 입
    g.fillStyle = '#ffffff';
    g.strokeStyle = ink;
    g.lineWidth = 5.5;
    g.beginPath();
    g.roundRect ? g.roundRect(cx - 38, 362, 76, 30, 12) : g.rect(cx - 38, 362, 76, 30);
    g.fill();
    g.stroke();
    g.lineWidth = 3.5;
    g.beginPath();
    g.moveTo(cx - 36, 377);
    g.lineTo(cx + 36, 377);
    for (const x of [-18, 0, 18]) {
      g.moveTo(cx + x, 364);
      g.lineTo(cx + x, 390);
    }
    g.stroke();
    // 땀
    g.fillStyle = 'rgba(120, 200, 255, 0.9)';
    g.strokeStyle = 'rgba(40, 120, 190, 0.9)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx + 176, 150);
    g.quadraticCurveTo(cx + 196, 186, cx + 186, 198);
    g.quadraticCurveTo(cx + 170, 206, cx + 164, 190);
    g.quadraticCurveTo(cx + 162, 176, cx + 176, 150);
    g.fill();
    g.stroke();
  } else {
    g.strokeStyle = '#8c3a3a';
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(cx - 32, 372);
    g.bezierCurveTo(cx - 16, 372 + L.smile, cx + 16, 372 + L.smile, cx + 32, 372);
    g.stroke();
    g.lineWidth = 4.5;
    g.beginPath();
    g.moveTo(cx - 32, 372);
    g.lineTo(cx - 37, 367);
    g.stroke();
    g.beginPath();
    g.moveTo(cx + 32, 372);
    g.lineTo(cx + 37, 367);
    g.stroke();
  }
  g.restore();
}

function makeAllyFaceAtlas() {
  const c = cnv(2048, 1024),
    g = c.getContext('2d');
  ALLY_LOOK.forEach((L, k) => {
    drawAllyFace(g, k * 512, 0, L, false);
    drawAllyFace(g, k * 512, 512, L, true);
  });
  return texOf(c);
}
// 명찰 2급·3급 (위 칸 2급, 아래 칸 3급)
function makeAllyBadgeAtlas() {
  const c = cnv(256, 256),
    g = c.getContext('2d');
  const t = texOf(c);
  const draw = () => {
    g.clearRect(0, 0, 256, 256);
    ['2급', '3급'].forEach((txt, k) => {
      const y = k * 128;
      g.fillStyle = '#ffffff';
      g.strokeStyle = '#1e2a4a';
      g.lineWidth = 8;
      g.beginPath();
      g.roundRect ? g.roundRect(6, y + 6, 244, 116, 16) : g.rect(6, y + 6, 244, 116);
      g.fill();
      g.stroke();
      drawAgencyMark(g, 40, y + 64, 48, '#1e2a4a');
      g.fillStyle = '#1e2a4a';
      g.font = '700 32px "Noto Sans KR", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('정신건강', 151, y + 44);
      g.fillStyle = '#d3122c';
      g.font = '400 52px "Black Han Sans", "Noto Sans KR", sans-serif';
      g.fillText(txt, 151, y + 92);
    });
    t.needsUpdate = true;
  };
  draw();
  if (document.fonts && document.fonts.load) {
    Promise.all([document.fonts.load('400 52px "Black Han Sans"'), document.fonts.load('700 36px "Noto Sans KR"')]).then(draw, () => { });
  }
  return t;
}
// 하이파이브 순간의 '짝' 그림 (만화식 충격 표시)
function makeBurstTex() {
  const c = cnv(256, 256),
    g = c.getContext('2d');
  g.translate(128, 128);
  const spikes = 12;
  const path = (ro, ri, rot) => {
    g.beginPath();
    for (let i = 0; i <= spikes * 2; i++) {
      const a = i / (spikes * 2) * TAU + rot,
        r = i % 2 ? ri : ro * (i % 4 === 0 ? 1 : 0.84);
      const x = Math.cos(a) * r,
        y = Math.sin(a) * r;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
  };
  g.lineJoin = 'round';
  path(118, 66, -0.1);
  g.fillStyle = '#ffffff';
  g.fill();
  g.lineWidth = 9;
  g.strokeStyle = '#1f1a24';
  g.stroke();
  path(78, 44, 0.16);
  g.fillStyle = '#ffe14d';
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(0, 0, 26, 0, TAU);
  g.fill();
  return texOf(c);
}

// ── 핏자국 아틀라스 (0,1 튄 자국 / 2 길게 튄 자국 / 3 웅덩이) ──
const BLOOD_OFF = [
  [0, 0.5],
  [0.5, 0.5],
  [0, 0],
  [0.5, 0]
];

function makeBloodAtlas() {
  const c = cnv(512, 512),
    g = c.getContext('2d');
  const blob = (x, y, r, col) => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  };
  const cell = (ox, oy, kind) => {
    g.save();
    g.translate(ox + 128, oy + 128);
    const dark = '#8e0014',
      mid = '#bb0019',
      hi = '#e0152f';
    if (kind === 3) {
      g.fillStyle = dark;
      g.beginPath();
      for (let i = 0; i <= 28; i++) {
        const a = i / 28 * TAU,
          r = 92 + Math.sin(a * 3 + 1) * 10 + Math.sin(a * 7) * 6;
        const px = Math.cos(a) * r,
          py = Math.sin(a) * r;
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.fill();
      g.fillStyle = mid;
      g.beginPath();
      g.ellipse(-6, -6, 76, 70, 0, 0, TAU);
      g.fill();
      g.fillStyle = 'rgba(255, 120, 130, 0.45)';
      g.beginPath();
      g.ellipse(-30, -34, 26, 11, -0.6, 0, TAU);
      g.fill();
    } else if (kind === 2) {
      g.rotate(0.15);
      g.fillStyle = mid;
      g.beginPath();
      g.ellipse(-30, 0, 44, 30, 0, 0, TAU);
      g.fill();
      for (let i = 0; i < 14; i++) {
        const d = 30 + i * 6.5,
          r = Math.max(2.5, 16 - i * 1.0);
        blob(d, rand(-10, 10), r, i % 3 ? mid : dark);
      }
      for (let i = 0; i < 10; i++) blob(rand(-70, 110), rand(-50, 50), rand(2, 5), dark);
    } else {
      g.fillStyle = mid;
      g.beginPath();
      for (let i = 0; i <= 40; i++) {
        const a = i / 40 * TAU,
          r = 48 + (i % 2 ? rand(10, 34) : rand(-6, 6));
        const px = Math.cos(a) * r,
          py = Math.sin(a) * r;
        if (i) g.lineTo(px, py);
        else g.moveTo(px, py);
      }
      g.fill();
      blob(0, 0, 44, mid);
      g.fillStyle = hi;
      g.beginPath();
      g.ellipse(-12, -14, 20, 12, -0.5, 0, TAU);
      g.fill();
      for (let i = 0; i < 16; i++) {
        const a = rand(0, TAU),
          d = rand(66, 112);
        blob(Math.cos(a) * d, Math.sin(a) * d, rand(2.5, 8), i % 2 ? dark : mid);
      }
    }
    g.restore();
  };
  cell(0, 0, 0);
  cell(256, 0, 1);
  cell(0, 256, 2);
  cell(256, 256, 3);
  return texOf(c);
}

// ── 반짝이, 총구 화염 ──
function makeStarTex() {
  const c = cnv(128, 128),
    g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 40);
  gr.addColorStop(0, 'rgba(255, 252, 220, 0.95)');
  gr.addColorStop(1, 'rgba(255, 240, 170, 0)');
  g.fillStyle = gr;
  g.beginPath();
  g.arc(64, 64, 40, 0, TAU);
  g.fill();
  star4(g, 64, 64, 62, 7, '#fffbe6');
  star4(g, 64, 64, 40, 4, '#ffffff');
  g.globalCompositeOperation = 'source-over';
  return texOf(c);
}

function makeFlashTex() {
  const c = cnv(128, 128),
    g = c.getContext('2d');
  g.translate(64, 64);
  g.fillStyle = '#ff9a1a';
  g.beginPath();
  for (let i = 0; i <= 16; i++) {
    const a = i / 16 * TAU,
      r = i % 2 ? 22 : 62;
    const px = Math.cos(a) * r,
      py = Math.sin(a) * r;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.fill();
  g.fillStyle = '#ffe14d';
  g.beginPath();
  for (let i = 0; i <= 16; i++) {
    const a = i / 16 * TAU + 0.2,
      r = i % 2 ? 14 : 40;
    const px = Math.cos(a) * r,
      py = Math.sin(a) * r;
    if (i) g.lineTo(px, py);
    else g.moveTo(px, py);
  }
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(0, 0, 13, 0, TAU);
  g.fill();
  return texOf(c);
}

// ───────────────────────── 재질 / 지오메트리 ─────────────────────────
function makeGradient(stops) {
  const d = new Uint8Array(stops.length * 4);
  stops.forEach((v, i) => {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  });
  const t = new THREE.DataTexture(d, stops.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
const GRAD = makeGradient([118, 196, 255]);

function toon(color, extra = {}) {
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: GRAD,
    ...extra
  });
}

function outlineMat(color = 0x221a2b) {
  const m = new THREE.MeshBasicMaterial({
    color,
    side: THREE.BackSide
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPx = OUTLINE.px;
    sh.uniforms.uRes = OUTLINE.res;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uPx;\nuniform vec2 uRes;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec3 oN = normal;
        #ifdef USE_INSTANCING
          oN = mat3(instanceMatrix) * oN;
        #endif
        vec3 oV = normalize(normalMatrix * oN);
        vec2 oD = oV.xy; float oL = length(oD);
        oD = oL > 0.0001 ? oD / oL : vec2(0.0);
        gl_Position.xy += oD * uPx * 2.0 / uRes * gl_Position.w;`);
  };
  m.customProgramCacheKey = () => 'outline-v1';
  return m;
}
const OUT_MAT = outlineMat();

function mergeGeos(geos) {
  let vc = 0,
    ic = 0;
  const hasCol = geos.some((g) => g.attributes.color);
  for (const g of geos) {
    vc += g.attributes.position.count;
    ic += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vc * 3),
    nor = new Float32Array(vc * 3),
    uv = new Float32Array(vc * 2),
    idx = new Uint32Array(ic);
  const col = hasCol ? new Float32Array(vc * 3).fill(1) : null;
  let vo = 0,
    io = 0;
  for (const g of geos) {
    const p = g.attributes.position,
      n = g.attributes.normal,
      u = g.attributes.uv,
      c = g.attributes.color;
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i);
      pos[(vo + i) * 3 + 1] = p.getY(i);
      pos[(vo + i) * 3 + 2] = p.getZ(i);
      nor[(vo + i) * 3] = n.getX(i);
      nor[(vo + i) * 3 + 1] = n.getY(i);
      nor[(vo + i) * 3 + 2] = n.getZ(i);
      if (u) {
        uv[(vo + i) * 2] = u.getX(i);
        uv[(vo + i) * 2 + 1] = u.getY(i);
      }
      if (col && c) {
        col[(vo + i) * 3] = c.getX(i);
        col[(vo + i) * 3 + 1] = c.getY(i);
        col[(vo + i) * 3 + 2] = c.getZ(i);
      }
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
      io += p.count;
    }
    vo += p.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.setIndex(new THREE.BufferAttribute(idx, 1));
  m.computeBoundingSphere();
  return m;
}
// 꼭짓점 색 칠하기 (여러 색이 한 부위에 섞일 때)
function paint(g, hex) {
  const n = g.attributes.position.count,
    a = new Float32Array(n * 3);
  const c = new THREE.Color(hex);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function legacyCapsule(radius, length, capSegments = 4, radialSegments = 8) {
  const path = new THREE.Path();
  path.absarc(0, -length / 2, radius, Math.PI * 1.5, 0);
  path.absarc(0, length / 2, radius, 0, Math.PI * 0.5);
  return new THREE.LatheGeometry(path.getPoints(capSegments), radialSegments);
}

const G3 = {
  sphere: (r, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h),
  ell: (sx, sy, sz, w = 16, h = 12) => {
    const g = new THREE.SphereGeometry(1, w, h);
    g.scale(sx, sy, sz);
    return g;
  },
  cap: (r, len, rs = 12) => legacyCapsule(r, len, 5, rs),
};
// 얼굴용 구: 앞 반구는 평면 투영 UV, 뒤 반구는 무늬 없는 한 점
function headGeo(r, ws = 28, hs = 20) {
  const front = new THREE.SphereGeometry(r, ws, hs, 0, Math.PI);
  const back = new THREE.SphereGeometry(r, ws, hs, Math.PI, Math.PI);
  const fp = front.attributes.position,
    fu = front.attributes.uv;
  for (let i = 0; i < fp.count; i++) fu.setXY(i, 0.5 + fp.getX(i) / (2 * r) * 0.98, 0.5 + fp.getY(i) / (2 * r) * 0.98);
  const bu = back.attributes.uv;
  for (let i = 0; i < bu.count; i++) bu.setXY(i, 0.03, 0.97);
  return mergeGeos([front, back]);
}

function noisify(g, amt, f1, f2) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i),
      y = p.getY(i),
      z = p.getZ(i);
    const n = 1 + amt * Math.sin(x * f1 + y * 13.1) * Math.cos(z * f2 - y * 7.7);
    p.setXYZ(i, x * n, y * n, z * n);
  }
  g.computeVertexNormals();
  return g;
}

// ───────────────────────── 군중 (인스턴싱: 움직이는 사람 / 바닥의 시체 두 묶음) ─────────────────────────
const C = {
  HIP_Y: 0.52,
  TORSO_H: 0.39,
  HEAD_R: 0.3,
  HEAD_UP: 0.262,
  SH_X: 0.2,
  SH_Y: 0.33,
  UARM: 0.19,
  FARM: 0.17,
  HIP_X: 0.095,
  THIGH: 0.22,
  SHIN: 0.22
};
const MAXA = 170; // 동시에 움직이는 사람 (쓰러지는 중 포함)
const MAXD = 300; // 바닥에 남는 시체 (넘치면 오래된 것부터 지워짐, 핏자국은 남음)
const _zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
const _m4c = new THREE.Matrix4();
const cap8 = (r, len) => new THREE.CapsuleGeometry(r, len, 3, 8);

function crowdHairGeo(r) {
  const parts = [];
  const back = new THREE.SphereGeometry(r * 1.06, 16, 9, Math.PI / 2 + 1.0, TAU - 2.0, 0, Math.PI * 0.6);
  const front = new THREE.SphereGeometry(r * 1.07, 8, 5, Math.PI / 2 - 1.02, 2.04, 0, Math.PI * 0.27);
  noisify(back, 0.04, 31, 27);
  noisify(front, 0.035, 29, 23);
  parts.push(back, front);
  // 헝클어진 앞머리 가닥
  const strands = [
    [-0.5, 0.55, 0.22],
    [-0.18, 0.62, 0.0],
    [0.15, 0.6, -0.15],
    [0.48, 0.52, 0.3]
  ];
  for (const [a, h, tilt] of strands) {
    const st = G3.ell(0.055, 0.12, 0.045, 6, 4);
    st.rotateZ(tilt);
    st.rotateX(-0.35);
    st.translate(Math.sin(a) * r * 0.82, r * h, Math.cos(a) * r * 0.86);
    parts.push(st);
  }
  // 정수리 뻗친 머리
  for (const [x, z, rz] of [
    [0.04, -0.05, -0.5],
    [-0.07, 0.02, 0.6],
    [0.09, 0.05, -0.2]
  ]) {
    const c = new THREE.ConeGeometry(0.045, 0.14, 5);
    c.rotateZ(rz);
    c.translate(x, r * 1.05, z);
    parts.push(c);
  }
  // 옆머리 (귀 위)
  for (const sx of [-1, 1]) {
    const e = G3.ell(0.06, 0.1, 0.09, 6, 4);
    e.translate(sx * r * 0.93, r * 0.05, -0.02);
    parts.push(e);
  }
  const m = mergeGeos(parts);
  m.translate(0, C.HEAD_UP, 0);
  return m;
}

const CROWD_GEO = (() => {
  const torso = new THREE.CapsuleGeometry(0.17, 0.11, 4, 10);
  torso.scale(1.18, 1, 0.8);
  torso.translate(0, 0.195, 0);
  const pelvis = G3.ell(0.182, 0.12, 0.135, 10, 6);
  const head = headGeo(C.HEAD_R, 18, 12);
  head.translate(0, C.HEAD_UP, 0);
  const hair = crowdHairGeo(C.HEAD_R);
  const uarm = cap8(0.062, 0.12);
  uarm.translate(0, -0.1, 0);
  const farm = cap8(0.056, 0.1);
  farm.translate(0, -0.088, 0);
  const hand = G3.sphere(0.066, 8, 6);
  hand.translate(0, -0.035, 0);
  const thigh = cap8(0.083, 0.08);
  thigh.translate(0, -0.1, 0);
  const shin = cap8(0.073, 0.1);
  shin.translate(0, -0.1, 0);
  const shoe = G3.ell(0.078, 0.052, 0.125, 8, 6);
  shoe.translate(0, -0.03, 0.04);
  return {
    torso,
    pelvis,
    head,
    hair,
    uarm,
    farm,
    hand,
    thigh,
    shin,
    shoe
  };
})();

// 바닥에 누운 시체용: 같은 모양을 훨씬 적은 면으로 (시체가 수백 구라서)
function crowdHairGeoLite(r) {
  const parts = [];
  const back = new THREE.SphereGeometry(r * 1.06, 10, 6, Math.PI / 2 + 1.0, TAU - 2.0, 0, Math.PI * 0.6);
  const front = new THREE.SphereGeometry(r * 1.07, 6, 3, Math.PI / 2 - 1.02, 2.04, 0, Math.PI * 0.27);
  noisify(back, 0.04, 31, 27);
  noisify(front, 0.035, 29, 23);
  parts.push(back, front);
  for (const [a, h, tilt] of [
    [-0.5, 0.55, 0.22],
    [0.48, 0.52, 0.3]
  ]) {
    const st = G3.ell(0.055, 0.12, 0.045, 5, 3);
    st.rotateZ(tilt);
    st.rotateX(-0.35);
    st.translate(Math.sin(a) * r * 0.82, r * h, Math.cos(a) * r * 0.86);
    parts.push(st);
  }
  for (const sx of [-1, 1]) {
    const e = G3.ell(0.06, 0.1, 0.09, 5, 3);
    e.translate(sx * r * 0.93, r * 0.05, -0.02);
    parts.push(e);
  }
  const m = mergeGeos(parts);
  m.translate(0, C.HEAD_UP, 0);
  return m;
}
const CROWD_GEO_LITE = (() => {
  const cap6 = (r, len) => new THREE.CapsuleGeometry(r, len, 2, 6);
  const torso = new THREE.CapsuleGeometry(0.17, 0.11, 2, 8);
  torso.scale(1.18, 1, 0.8);
  torso.translate(0, 0.195, 0);
  const pelvis = G3.ell(0.182, 0.12, 0.135, 8, 5);
  const head = headGeo(C.HEAD_R, 12, 9);
  head.translate(0, C.HEAD_UP, 0);
  const hair = crowdHairGeoLite(C.HEAD_R);
  const uarm = cap6(0.062, 0.12);
  uarm.translate(0, -0.1, 0);
  const farm = cap6(0.056, 0.1);
  farm.translate(0, -0.088, 0);
  const hand = G3.sphere(0.066, 6, 4);
  hand.translate(0, -0.035, 0);
  const thigh = cap6(0.083, 0.08);
  thigh.translate(0, -0.1, 0);
  const shin = cap6(0.073, 0.1);
  shin.translate(0, -0.1, 0);
  const shoe = G3.ell(0.078, 0.052, 0.125, 6, 4);
  shoe.translate(0, -0.03, 0.04);
  return {
    torso,
    pelvis,
    head,
    hair,
    uarm,
    farm,
    hand,
    thigh,
    shin,
    shoe
  };
})();

// 부위 정의: [이름, 지오메트리, 색 종류, 리그 노드]
const PART_DEFS = [
  ['torso', 'torso', 'shirt', 'torso'],
  ['pelvis', 'pelvis', 'pants', 'hips'],
  ['head', 'head', 'skin', 'neck'],
  ['hair', 'hair', 'hair', 'neck'],
  ['uarmL', 'uarm', 'shirt', 'shL'],
  ['uarmR', 'uarm', 'shirt', 'shR'],
  ['farmL', 'farm', 'shirt', 'elL'],
  ['farmR', 'farm', 'shirt', 'elR'],
  ['handL', 'hand', 'skin', 'wrL'],
  ['handR', 'hand', 'skin', 'wrR'],
  ['thighL', 'thigh', 'pants', 'hipL'],
  ['thighR', 'thigh', 'pants', 'hipR'],
  ['shinL', 'shin', 'pants', 'knL'],
  ['shinR', 'shin', 'pants', 'knR'],
  ['shoeL', 'shoe', 'shoe', 'anL'],
  ['shoeR', 'shoe', 'shoe', 'anR'],
];

const crowdFaceTex = makeCrowdFaceAtlas();
const crowdMat = toon(0xffffff);
const crowdHeadMat = toon(0xffffff, {
  map: crowdFaceTex
});
crowdHeadMat.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aFace;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * vec2(1.0 / 3.0, 0.5) + aFace;\n#endif');
};
crowdHeadMat.customProgramCacheKey = () => 'crowd-head-v2';

const _white = new THREE.Color(1, 1, 1);

function makeCrowdSet(max, shadows, face, geos = CROWD_GEO) {
  const set = {
    parts: [],
    max,
    count: 0
  };
  const hg = geos.head.clone();
  const af = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
  af.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < max; i++) af.setXY(i, FACE_OFF[face][0], FACE_OFF[face][1]);
  hg.setAttribute('aFace', af);
  set.aFace = af;
  for (const [name, geoKey, kind, node] of PART_DEFS) {
    const geo = name === 'head' ? hg : geos[geoKey];
    const m = new THREE.InstancedMesh(geo, name === 'head' ? crowdHeadMat : crowdMat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < max; i++) m.setMatrixAt(i, _zeroM);
    m.setColorAt(0, _white);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = shadows;
    m.receiveShadow = false;
    const o = new THREE.InstancedMesh(geo, OUT_MAT, max);
    o.instanceMatrix = m.instanceMatrix;
    o.count = 0;
    o.frustumCulled = false;
    scene.add(m, o);
    set.parts.push({
      name,
      m,
      o,
      node,
      kind
    });
  }
  return set;
}
const CA = makeCrowdSet(MAXA, true, 0); // 움직이는 사람: 그림자 있음
const CD = makeCrowdSet(MAXD, false, 3, CROWD_GEO_LITE); // 시체: 그림자 없음, 가벼운 모양
// 정신건강 서적: 한 장의 표지/책등/종이 단면 아틀라스와 두 인스턴스 묶음만 사용한다.
function makeCareBookAtlas(existing) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const g = c.getContext('2d');
  const colors = ['#376da8', '#637d58'];
  for (let k = 0; k < 2; k++) {
    const x = k * 512,
      color = colors[k];
    g.fillStyle = color;
    g.fillRect(x, 0, 512, 512);
    // 왼쪽 절반: 앞표지. 오른쪽 위: 뒤표지. 오른쪽 아래: 책장 단면.
    g.fillStyle = '#f9f5e8';
    g.fillRect(x + 12, 12, 232, 488);
    g.fillStyle = color;
    g.fillRect(x + 12, 12, 17, 488);
    g.textAlign = 'center';
    g.fillStyle = '#1e2a35';
    g.font = '900 51px "Noto Sans KR", "Malgun Gothic", sans-serif';
    const lines = k === 0 ? ['마음', '건강'] : ['건강한', '관계'];
    lines.forEach((line, j) => g.fillText(line, x + 136, 171 + j * 69));
    g.strokeStyle = color;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(x + 135, 351, 36, 0, TAU);
    g.stroke();
    g.beginPath();
    g.moveTo(x + 117, 352);
    g.quadraticCurveTo(x + 135, 375, x + 153, 352);
    g.stroke();
    g.fillStyle = color;
    g.fillRect(x + 57, 442, 155, 6);
    g.fillStyle = '#f1eadc';
    g.fillRect(x + 256, 256, 256, 256);
    g.strokeStyle = '#c9bcab';
    g.lineWidth = 2;
    for (let y = 263; y < 512; y += 12) {
      g.beginPath();
      g.moveTo(x + 256, y);
      g.lineTo(x + 512, y);
      g.stroke();
    }
    g.fillStyle = '#ede4d2';
    g.fillRect(x + 270, 37, 210, 5);
    g.fillRect(x + 270, 53, 180, 4);
  }
  if (existing) {
    existing.image = c;
    existing.needsUpdate = true;
    return existing;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  return t;
}
const careBookTex = makeCareBookAtlas();
const careBookGeo = new THREE.BoxGeometry(0.265, 0.355, 0.065);
{
  // BoxGeometry 순서: 옆, 옆, 위, 아래, 앞, 뒤. 표지·단면을 같은 텍스처에서 선택.
  const uv = careBookGeo.attributes.uv;
  for (let face = 0; face < 6; face++) {
    for (let j = 0; j < 4; j++) {
      const i = face * 4 + j,
        u = uv.getX(i),
        v = uv.getY(i);
      if (face === 4) uv.setXY(i, (0.02 + u * 0.22), 0.02 + v * 0.96);
      else if (face === 5) uv.setXY(i, 0.26 + u * 0.22, 0.52 + v * 0.46);
      else uv.setXY(i, 0.26 + u * 0.23, 0.02 + v * 0.46);
    }
  }
}
const careBookMat = toon(0xffffff, {
  map: careBookTex
});
careBookMat.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aBook;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv.x += aBook * 0.5;\n#endif');
};
careBookMat.customProgramCacheKey = () => 'care-book-v1';

function makeCareBooks(max, shadows) {
  const geo = careBookGeo.clone();
  const cover = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  cover.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aBook', cover);
  const m = new THREE.InstancedMesh(geo, careBookMat, max);
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.count = 0;
  m.frustumCulled = false;
  m.castShadow = shadows;
  for (let i = 0; i < max; i++) m.setMatrixAt(i, _zeroM);
  const o = new THREE.InstancedMesh(geo, OUT_MAT, max);
  o.instanceMatrix = m.instanceMatrix;
  o.count = 0;
  o.frustumCulled = false;
  scene.add(m, o);
  return {
    m,
    o,
    cover
  };
}
const careBooksAlive = makeCareBooks(MAXA, true),
  careBooksDead = makeCareBooks(MAXD, false);
const _bookM = new THREE.Matrix4(),
  _bookLocal = new THREE.Matrix4();
const _bookRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.22);
const _bookPos = new THREE.Vector3(),
  _bookScale = new THREE.Vector3(1, 1, 1);

function writeCareBook(p) {
  // seed 이미 존재: 새 난수 소비 없이 25%만 책을 든다. 기존 전투/음성 난수 순서도 유지.
  const has = p.seed % 4 < 1;
  if (!has || p.state === 'poster') {
    careBooksAlive.m.setMatrixAt(p.i, _zeroM);
    return;
  }
  const left = Math.floor(p.seed * 7) % 2 === 0;
  _bookPos.set(left ? 0.12 : -0.12, -0.115, 0.036);
  _bookLocal.compose(_bookPos, _bookRot, _bookScale);
  _bookM.multiplyMatrices((left ? CR.wrL : CR.wrR).matrixWorld, _bookLocal);
  careBooksAlive.m.setMatrixAt(p.i, _bookM);
  const cover = Math.floor(p.seed * 13) % 2;
  if (careBooksAlive.cover.getX(p.i) !== cover) {
    careBooksAlive.cover.setX(p.i, cover);
    careBooksAlive.cover.needsUpdate = true;
  }
}

function setSetCount(set, n) {
  set.count = n;
  for (const part of set.parts) {
    part.m.count = n;
    part.o.count = n;
  }
}
const freeA = [];
let highA = 0,
  deadNext = 0,
  deadUsed = 0;

function allocAlive() {
  let i;
  if (freeA.length) i = freeA.pop();
  else if (highA < MAXA) {
    i = highA++;
    setSetCount(CA, highA);
  } else return -1;
  return i;
}

function freeAlive(i) {
  for (const part of CA.parts) part.m.setMatrixAt(i, _zeroM);
  careBooksAlive.m.setMatrixAt(i, _zeroM);
  freeA.push(i);
}
const _hsl = {};

function addCorpse(i) {
  const d = deadNext;
  deadNext = (deadNext + 1) % MAXD;
  deadUsed = Math.min(MAXD, deadUsed + 1);
  for (let k = 0; k < CA.parts.length; k++) {
    const a = CA.parts[k].m,
      b = CD.parts[k].m;
    a.getMatrixAt(i, _m4c);
    b.setMatrixAt(d, _m4c);
    a.getColorAt(i, _col);
    _col.getHSL(_hsl);
    _col.setHSL(_hsl.h, _hsl.s * 0.55, _hsl.l * 0.8);
    b.setColorAt(d, _col);
    b.instanceMatrix.addUpdateRange(d * 16, 16);
    b.instanceMatrix.needsUpdate = true;
    b.instanceColor.addUpdateRange(d * 3, 3);
    b.instanceColor.needsUpdate = true;
  }
  setSetCount(CD, deadUsed);
  careBooksAlive.m.getMatrixAt(i, _m4c);
  careBooksDead.m.setMatrixAt(d, _m4c);
  careBooksDead.cover.setX(d, careBooksAlive.cover.getX(i));
  careBooksDead.cover.needsUpdate = true;
  careBooksDead.m.count = careBooksDead.o.count = deadUsed;
  careBooksDead.m.instanceMatrix.needsUpdate = true;
}

function clearCrowd() {
  for (const set of [CA, CD]) {
    for (const part of set.parts) {
      for (let i = 0; i < set.max; i++) part.m.setMatrixAt(i, _zeroM);
      part.m.instanceMatrix.clearUpdateRanges();
      part.m.instanceMatrix.needsUpdate = true;
      if (part.m.instanceColor) {
        part.m.instanceColor.clearUpdateRanges();
        part.m.instanceColor.needsUpdate = true;
      }
    }
    setSetCount(set, 0);
  }
  for (const books of [careBooksAlive, careBooksDead]) {
    for (let i = 0; i < books.m.instanceMatrix.count; i++) books.m.setMatrixAt(i, _zeroM);
    books.m.count = books.o.count = 0;
    books.m.instanceMatrix.needsUpdate = true;
  }
  freeA.length = 0;
  highA = 0;
  deadNext = 0;
  deadUsed = 0;
}

// 군중용 템플릿 리그 (계산 전용, 장면에 넣지 않음)
function mkNode(parent, x, y, z, order) {
  const n = new THREE.Object3D();
  n.position.set(x, y, z);
  if (order) n.rotation.order = order;
  if (parent) parent.add(n);
  return n;
}

function buildRig(D) {
  const R = {};
  R.root = mkNode(null, 0, 0, 0, 'YXZ');
  R.hips = mkNode(R.root, 0, D.HIP_Y, 0);
  R.torso = mkNode(R.hips, 0, 0.03, 0, 'YXZ');
  R.neck = mkNode(R.torso, 0, D.TORSO_H, 0, 'YXZ');
  R.shL = mkNode(R.torso, D.SH_X, D.SH_Y, 0, 'YXZ');
  R.shR = mkNode(R.torso, -D.SH_X, D.SH_Y, 0, 'YXZ');
  R.elL = mkNode(R.shL, 0, -D.UARM, 0, 'XYZ');
  R.elR = mkNode(R.shR, 0, -D.UARM, 0, 'XYZ');
  R.wrL = mkNode(R.elL, 0, -D.FARM, 0);
  R.wrR = mkNode(R.elR, 0, -D.FARM, 0);
  R.hipL = mkNode(R.hips, D.HIP_X, 0, 0, 'YXZ');
  R.hipR = mkNode(R.hips, -D.HIP_X, 0, 0, 'YXZ');
  R.knL = mkNode(R.hipL, 0, -D.THIGH, 0);
  R.knR = mkNode(R.hipR, 0, -D.THIGH, 0);
  R.anL = mkNode(R.knL, 0, -D.SHIN, 0);
  R.anR = mkNode(R.knR, 0, -D.SHIN, 0);
  return R;
}
const CR = buildRig(C);

// 포즈 배열 인덱스
const P = {
  RP: 0,
  RR: 1,
  HY: 2,
  SX: 3,
  SY: 4,
  SZ: 5,
  HX: 6,
  HW: 7,
  HZ: 8,
  LSX: 9,
  LSY: 10,
  LSZ: 11,
  LEX: 12,
  LEZ: 13,
  RSX: 14,
  RSY: 15,
  RSZ: 16,
  REX: 17,
  REZ: 18,
  LHX: 19,
  LHZ: 20,
  LKX: 21,
  RHX: 22,
  RHZ: 23,
  RKX: 24,
  LIFT: 25
};
const NPOSE = 26;

function applyRig(R, pose, x, z, yaw) {
  R.root.position.set(x, pose[P.LIFT], z);
  R.root.rotation.set(pose[P.RP], yaw, pose[P.RR]);
  R.hips.position.y = pose[P.HY];
  R.torso.rotation.set(pose[P.SX], pose[P.SY], pose[P.SZ]);
  R.neck.rotation.set(pose[P.HX], pose[P.HW], pose[P.HZ]);
  R.shL.rotation.set(pose[P.LSX], pose[P.LSY], pose[P.LSZ]);
  R.shR.rotation.set(pose[P.RSX], pose[P.RSY], pose[P.RSZ]);
  R.elL.rotation.set(pose[P.LEX], 0, pose[P.LEZ]);
  R.elR.rotation.set(pose[P.REX], 0, pose[P.REZ]);
  R.hipL.rotation.set(pose[P.LHX], 0, pose[P.LHZ]);
  R.hipR.rotation.set(pose[P.RHX], 0, pose[P.RHZ]);
  R.knL.rotation.set(pose[P.LKX], 0, 0);
  R.knR.rotation.set(pose[P.RKX], 0, 0);
  R.root.updateMatrixWorld(true);
}
const _hv = new THREE.Vector3();

function writeCrowdInstance(p) {
  applyRig(CR, p.pose, p.x, p.z, p.yaw);
  for (const part of CA.parts) part.m.setMatrixAt(p.i, CR[part.node].matrixWorld);
  writeCareBook(p);
  // 머리 위치 (말풍선, 눈물용)
  _hv.set(0, C.HEAD_UP + 0.1, 0).applyMatrix4(CR.neck.matrixWorld);
  p.hx = _hv.x;
  p.hy = _hv.y;
  p.hz = _hv.z;
  _hv.set(0, 0.15, 0).applyMatrix4(CR.torso.matrixWorld);
  p.tx = _hv.x;
  p.ty = _hv.y;
  p.tz = _hv.z;
  // 눈 바깥쪽 위치
  _hv.set(-0.15, C.HEAD_UP - 0.05, C.HEAD_R * 0.72).applyMatrix4(CR.neck.matrixWorld);
  p.e1x = _hv.x;
  p.e1y = _hv.y;
  p.e1z = _hv.z;
  _hv.set(0.15, C.HEAD_UP - 0.05, C.HEAD_R * 0.72).applyMatrix4(CR.neck.matrixWorld);
  p.e2x = _hv.x;
  p.e2y = _hv.y;
  p.e2z = _hv.z;
}
const _col = new THREE.Color();

function setCrowdColors(i, cols) {
  for (const part of CA.parts) {
    _col.set(cols[part.kind]);
    part.m.setColorAt(i, _col);
    part.m.instanceColor.addUpdateRange(i * 3, 3);
    part.m.instanceColor.needsUpdate = true;
  }
}
// 움직이는 사람: 쓰는 칸까지만 올림
function flushCrowd() {
  careBooksAlive.m.count = careBooksAlive.o.count = highA;
  const bm = careBooksAlive.m.instanceMatrix;
  bm.clearUpdateRanges();
  bm.addUpdateRange(0, Math.max(1, highA) * 16);
  bm.needsUpdate = true;
  for (const part of CA.parts) {
    const a = part.m.instanceMatrix;
    a.clearUpdateRanges();
    a.addUpdateRange(0, Math.max(1, highA) * 16);
    a.needsUpdate = true;
  }
}

// ───────────────────────── 주인공 ─────────────────────────
const M = {
  HIP_Y: 0.6,
  TORSO_H: 0.44,
  HEAD_R: 0.31,
  HEAD_UP: 0.275,
  SH_X: 0.215,
  SH_Y: 0.37,
  UARM: 0.2,
  FARM: 0.18,
  HIP_X: 0.1,
  THIGH: 0.25,
  SHIN: 0.25
};
const MR = buildRig(M);
MR.root.rotation.order = 'YXZ';
scene.add(MR.root);
MR.root.traverse((n) => {
  n.matrixAutoUpdate = true;
});

const meMat = {
  skin: toon(ME_SKIN),
  hair: toon('#1c1519'),
  pants: toon('#2b3b67'),
  shoe: toon('#f5f5f5'),
  sole: toon('#9aa0ab'),
  belt: toon('#5d3b22'),
  white: toon('#ffffff'),
  gun: toon('#26252c'),
  gunHi: toon('#9a9aa6'),
  blade: toon('#e6eaef'),
  handle: toon('#1b1a1f'),
};

function mePart(geo, mat, parent, outline = true) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  parent.add(m);
  if (outline) {
    const o = new THREE.Mesh(geo, OUT_MAT);
    o.castShadow = false;
    m.add(o);
  }
  return m;
}
const ME_PARTS = { hands: [] };
(() => {
  // 셔츠 몸통 (텍스처: 단추, 피)
  shirtTex = texOf(shirtCanvas);
  drawShirt();
  const torsoG = G3.cap(0.175, 0.12, 20);
  torsoG.rotateY(Math.PI);
  torsoG.scale(1.2, 1, 0.82);
  torsoG.translate(0, 0.215, 0);
  ME_PARTS.torso = mePart(torsoG, toon(0xffffff, {
    map: shirtTex
  }), MR.torso);
  // 칼라
  for (const sx of [-1, 1]) {
    const cg = new THREE.ConeGeometry(0.07, 0.12, 3);
    cg.rotateX(Math.PI);
    cg.rotateZ(sx * 0.5);
    cg.scale(1, 1, 0.45);
    const c = mePart(cg, meMat.white, MR.torso);
    c.position.set(sx * 0.07, 0.4, 0.105);
    c.rotation.x = -0.35;
  }
  const collarRing = new THREE.TorusGeometry(0.115, 0.03, 8, 20);
  collarRing.rotateX(Math.PI / 2);
  collarRing.scale(1.1, 1, 0.85);
  const cr = mePart(collarRing, meMat.white, MR.torso);
  cr.position.set(0, 0.415, 0.005);
  // 명찰
  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.075, 0.012), [meMat.white, meMat.white, meMat.white, meMat.white, new THREE.MeshToonMaterial({
    map: makeBadgeTex(),
    gradientMap: GRAD
  }), meMat.white]);
  badge.position.set(0.095, 0.29, 0.143);
  badge.rotation.y = 0.32;
  badge.rotation.x = -0.12;
  badge.castShadow = true;
  MR.torso.add(badge);
  // 허리띠
  const beltG = new THREE.CylinderGeometry(0.205, 0.205, 0.05, 20, 1, true);
  beltG.scale(1, 1, 0.78);
  const belt = mePart(beltG, meMat.belt, MR.hips, false);
  belt.position.y = 0.05;
  const buckle = mePart(new THREE.BoxGeometry(0.06, 0.04, 0.02), meMat.gunHi, MR.hips, false);
  buckle.position.set(0, 0.05, 0.165);
  // 골반
  ME_PARTS.pelvis = mePart(G3.ell(0.19, 0.12, 0.145, 16, 10), meMat.pants, MR.hips);
  // 머리
  meFaceTex = texOf(meFaceCanvas);
  drawMeFace();
  const hg = headGeo(M.HEAD_R, 40, 30);
  hg.translate(0, M.HEAD_UP, 0);
  ME_PARTS.head = mePart(hg, toon(0xffffff, {
    map: meFaceTex
  }), MR.neck);
  // 귀
  for (const sx of [-1, 1]) {
    const e = mePart(G3.ell(0.048, 0.075, 0.036, 10, 8), meMat.skin, MR.neck);
    e.position.set(sx * (M.HEAD_R - 0.005), M.HEAD_UP - 0.015, -0.01);
  }
  // 단정한 가르마 머리
  const r = M.HEAD_R;
  const front = Math.PI / 2;
  const hf = new THREE.SphereGeometry(r * 1.065, 16, 8, front - 0.95, 1.9, 0, Math.PI * 0.25);
  const hsL = new THREE.SphereGeometry(r * 1.06, 10, 12, front + 0.95, 0.9, 0, Math.PI * 0.43);
  const hsR = new THREE.SphereGeometry(r * 1.06, 10, 12, front - 1.85, 0.9, 0, Math.PI * 0.43);
  const hb = new THREE.SphereGeometry(r * 1.055, 24, 16, front + 1.85, TAU - 3.7, 0, Math.PI * 0.6);
  const fr = G3.ell(0.21, 0.085, 0.12, 18, 10);
  fr.rotateZ(-0.3);
  fr.rotateX(-0.55);
  fr.translate(0.06, r * 0.73, r * 0.71);
  const fr2 = G3.ell(0.1, 0.065, 0.085, 12, 8);
  fr2.rotateZ(0.25);
  fr2.rotateX(-0.5);
  fr2.translate(-0.16, r * 0.69, r * 0.65);
  const hairG = mergeGeos([hf, hsL, hsR, hb, fr, fr2]);
  hairG.translate(0, M.HEAD_UP, 0);
  ME_PARTS.hair = mePart(hairG, meMat.hair, MR.neck);
  // 머리 광택 띠
  const ring = new THREE.TorusGeometry(r * 0.86, 0.013, 6, 28, 1.7);
  ring.rotateX(-Math.PI / 2 + 0.55);
  ring.rotateZ(Math.PI / 2 - 0.85);
  const ringM = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
    color: '#7d6f8a'
  }));
  ringM.position.set(0, M.HEAD_UP + 0.05, 0.02);
  MR.neck.add(ringM);
  // 팔 (긴 소매)
  const shirtPlain = toon(ME_SHIRT);
  ME_PARTS.shirtPlain = shirtPlain;
  for (const [s, e, w] of [
    [MR.shL, MR.elL, MR.wrL],
    [MR.shR, MR.elR, MR.wrR]
  ]) {
    const ua = G3.cap(0.066, 0.13, 12);
    ua.translate(0, -0.1, 0);
    mePart(ua, shirtPlain, s);
    const fa = G3.cap(0.06, 0.11, 12);
    fa.translate(0, -0.09, 0);
    mePart(fa, shirtPlain, e);
    const cuff = new THREE.CylinderGeometry(0.066, 0.066, 0.035, 12);
    cuff.translate(0, -0.17, 0);
    mePart(cuff, meMat.white, e, false);
    const hd = G3.sphere(0.068, 12, 10);
    hd.translate(0, -0.035, 0);
    ME_PARTS.hands.push(mePart(hd, meMat.skin, w));
  }
  // 다리
  for (const [h, k, a] of [
    [MR.hipL, MR.knL, MR.anL],
    [MR.hipR, MR.knR, MR.anR]
  ]) {
    const th = G3.cap(0.088, 0.1, 12);
    th.translate(0, -0.11, 0);
    mePart(th, meMat.pants, h);
    const sh = G3.cap(0.078, 0.12, 12);
    sh.translate(0, -0.11, 0);
    mePart(sh, meMat.pants, k);
    const shoe = G3.ell(0.082, 0.055, 0.13, 14, 10);
    shoe.translate(0, -0.03, 0.045);
    mePart(shoe, meMat.shoe, a);
    const sole = new THREE.BoxGeometry(0.15, 0.03, 0.25);
    sole.translate(0, -0.075, 0.045);
    mePart(sole, meMat.sole, a, false);
  }
})();

// 총 / 칼
// 만화 비율: 손이 크니 총도 크게(1.6배). 위(슬라이드)는 밝은 쇠, 아래(손잡이·틀)는 검정으로 나눠 멀리서도 총으로 읽히게.
const GUN_SCALE = 1.6,
  GUN_BACK = 0.03;

function pistolGeo() {
  const slide = new THREE.BoxGeometry(0.046, 0.054, 0.2);
  slide.translate(0, 0.03, 0.06);
  const muzzle = new THREE.CylinderGeometry(0.013, 0.013, 0.014, 8);
  muzzle.rotateX(Math.PI / 2);
  muzzle.translate(0, 0.035, 0.162);
  const sight = new THREE.BoxGeometry(0.012, 0.014, 0.012);
  sight.translate(0, 0.062, 0.14);
  const grip = new THREE.BoxGeometry(0.04, 0.12, 0.058);
  grip.rotateX(-0.28);
  grip.translate(0, -0.04, -0.02);
  const guard = new THREE.TorusGeometry(0.026, 0.008, 6, 12, Math.PI);
  guard.rotateY(Math.PI / 2);
  guard.rotateX(Math.PI);
  guard.translate(0, -0.002, 0.03);
  const frame = new THREE.BoxGeometry(0.042, 0.03, 0.15);
  frame.translate(0, -0.006, 0.05);
  const top = mergeGeos([slide, muzzle, sight]),
    low = mergeGeos([grip, guard, frame]);
  for (const g of [top, low]) {
    g.scale(GUN_SCALE, GUN_SCALE, GUN_SCALE);
    g.translate(0, 0, -GUN_BACK);
  }
  return {
    top,
    low
  };
}

function knifeGeo() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(0.034, 0);
  shape.quadraticCurveTo(0.03, 0.17, 0.0, 0.24);
  shape.lineTo(-0.004, 0.06);
  shape.lineTo(0, 0);
  const blade = new THREE.ExtrudeGeometry(shape, {
    depth: 0.008,
    bevelEnabled: false
  });
  blade.translate(-0.015, 0.0, -0.004);
  return blade;
}
const GUN_G = pistolGeo();
const KNIFE_G = knifeGeo();
const HANDLE_G = (() => {
  const g = new THREE.BoxGeometry(0.03, 0.1, 0.034);
  g.translate(0, -0.05, 0);
  return g;
})();
const GUNS = [];
const TITLE_HANDS = [];
const titleGripSide = new THREE.Vector3(),
  titleGripView = new THREE.Vector3();
const KNIVES = [];
const MUZZLE_LOCAL = new THREE.Vector3(0, 0.035 * GUN_SCALE, 0.17 * GUN_SCALE - GUN_BACK);
for (const [h, w] of [MR.wrL, MR.wrR].entries()) {
  const holder = new THREE.Object3D();
  holder.position.set(0, -0.04, 0.0);
  holder.rotation.x = Math.PI / 2;
  w.add(holder);
  const gun = new THREE.Group();
  holder.add(gun);
  const gTop = new THREE.Mesh(GUN_G.top, meMat.gunHi);
  gTop.castShadow = true;
  gun.add(gTop);
  gTop.add(new THREE.Mesh(GUN_G.top, OUT_MAT));
  const gLow = new THREE.Mesh(GUN_G.low, meMat.gun);
  gLow.castShadow = true;
  gun.add(gLow);
  gLow.add(new THREE.Mesh(GUN_G.low, OUT_MAT));
  GUNS.push(gun);
  // 카메라에 보이는 손잡이 옆면을 이어진 손바닥과 손가락으로 감싼다.
  const palm = G3.ell(0.050, 0.050, 0.047, 16, 12);
  palm.translate(0.026, -0.065, -0.070);
  const gripParts = [palm];
  for (let f = 0; f < 4; f++) {
    const finger = G3.ell(0.051, 0.018, 0.045, 14, 10);
    finger.translate(0.025, -0.027 - f * 0.022, -0.038);
    gripParts.push(finger);
  }
  const thumb = G3.ell(0.027, 0.018, 0.042, 14, 10);
  thumb.rotateX(-0.25);
  thumb.translate(0.066, -0.028, -0.055);
  gripParts.push(thumb);
  const gripHand = mePart(mergeGeos(gripParts), meMat.skin, gun);
  gripHand.visible = false;
  TITLE_HANDS.push(gripHand);
  const kh = new THREE.Object3D();
  kh.position.set(0, -0.04, 0);
  kh.rotation.x = Math.PI / 2;
  w.add(kh);
  const blade = new THREE.Mesh(KNIFE_G, meMat.blade);
  blade.rotation.x = Math.PI / 2;
  blade.position.z = 0.03;
  kh.add(blade);
  const bo = new THREE.Mesh(KNIFE_G, OUT_MAT);
  blade.add(bo);
  const handle = new THREE.Mesh(HANDLE_G, meMat.handle);
  handle.rotation.x = Math.PI / 2;
  handle.position.z = 0.03;
  kh.add(handle);
  kh.visible = false;
  KNIVES.push(kh);
}

// 집에서 들고 나온 산탄총: 오른손 권총 대신 한 손으로 든다 (만화처럼 큰 손). 다 쓰면 바닥에 버리고 다시 쌍권총.
const SG = {
  on: false,
  shells: 0,
  cd: 0,
  pumpT: 9,
  model: null,
  pump: null,
  pumpZ: 0,
  flash: null,
  flashT: 0,
  dropped: [],
  muzzleW: new THREE.Vector3(),
  dropT: -1,
  ejectT: -1
};
const SG_S = 1.25;
const SG_MUZZLE = new THREE.Vector3(0, 0.045 * SG_S, 0.7 * SG_S);

function makeOutShotgun() {
  const g = new THREE.Group();
  const metal = toon('#34333b'),
    metalHi = toon('#8b8e9a'),
    wood = toon('#9c5a2e'),
    woodDk = toon('#6d3c1f');
  const part = (geo, mat, x, y, z, outline = true) => {
    geo.scale(SG_S, SG_S, SG_S);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x * SG_S, y * SG_S, z * SG_S);
    m.castShadow = true;
    g.add(m);
    if (outline) m.add(new THREE.Mesh(geo, OUT_MAT));
    return m;
  };
  const barrel = new THREE.CylinderGeometry(0.022, 0.022, 0.5, 12);
  barrel.rotateX(Math.PI / 2);
  part(barrel, metalHi, 0, 0.045, 0.44);
  const tube = new THREE.CylinderGeometry(0.018, 0.018, 0.4, 10);
  tube.rotateX(Math.PI / 2);
  part(tube, metal, 0, 0.004, 0.39);
  part(new THREE.BoxGeometry(0.052, 0.085, 0.24), metal, 0, 0.026, 0.09);
  const pumpG = new THREE.CylinderGeometry(0.035, 0.035, 0.17, 12);
  pumpG.rotateX(Math.PI / 2);
  const pump = part(pumpG, wood, 0, 0.006, 0.39);
  const grip = new THREE.BoxGeometry(0.042, 0.11, 0.062);
  grip.rotateX(-0.42);
  part(grip, woodDk, 0, -0.04, -0.02);
  const stock = new THREE.BoxGeometry(0.05, 0.09, 0.3);
  stock.rotateX(0.14);
  part(stock, wood, 0, -0.016, -0.18);
  part(new THREE.BoxGeometry(0.012, 0.016, 0.012), metalHi, 0, 0.074, 0.68, false);
  return {
    g,
    pump
  };
} {
  const holder = new THREE.Object3D();
  holder.position.set(0, -0.04, 0.0);
  holder.rotation.x = Math.PI / 2;
  MR.wrR.add(holder);
  const {
    g,
    pump
  } = makeOutShotgun();
  holder.add(g);
  g.visible = false;
  SG.model = g;
  SG.pump = pump;
  SG.pumpZ = pump.position.z;
}

function sgDropAt(x, z, y0) {
  // 다 쓴 총은 손에서 떨어져 바닥에 그대로 남는다
  const {
    g
  } = makeOutShotgun();
  g.position.set(x, y0, z);
  g.rotation.set(0, rand(0, TAU), 0.25, 'YXZ');
  g.userData.fall = {
    t: 0,
    y0,
    r0: 0.25
  };
  scene.add(g);
  SG.dropped.push(g);
  return g;
}

// 눈 반짝이
const starTex = makeStarTex();
const SPARKS = [];
for (const sx of [-1, 1]) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: starTex,
    transparent: true,
    depthWrite: false,
    fog: false
  }));
  sp.position.set(sx * 0.11 + 0.025, M.HEAD_UP + 0.04, M.HEAD_R + 0.03);
  sp.renderOrder = 5;
  MR.neck.add(sp);
  SPARKS.push(sp);
}
const BIG_SPARK = new THREE.Sprite(new THREE.SpriteMaterial({
  map: starTex,
  transparent: true,
  depthWrite: false,
  fog: false
}));
BIG_SPARK.renderOrder = 6;
BIG_SPARK.visible = false;
MR.neck.add(BIG_SPARK);

// ───────────────────────── 정신건강 2급·3급 (인스턴싱, 최대 4명) ─────────────────────────
// 쌍권총은 못 받았다. 오른손 방망이, 왼손 칼.
const MAXH = 4;
const HR = buildRig(M); // 계산 전용 리그
const allyFaceTex = makeAllyFaceAtlas();
const allyBadgeTex = makeAllyBadgeAtlas();

function atlasMat(tex, attr, sx, sy, key) {
  const m = toon(0xffffff, {
    map: tex
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 ${attr};`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * vec2(${sx.toFixed(3)}, ${sy.toFixed(3)}) + ${attr};\n#endif`);
  };
  m.customProgramCacheKey = () => key;
  return m;
}
const H_MAT = {
  tint: toon(0xffffff), // 인스턴스 색(셔츠, 머리)
  vc: toon(0xffffff, {
    vertexColors: true
  }), // 꼭짓점 색
  white: toon('#ffffff'),
  navy: toon('#2b3b67'),
  head: atlasMat(allyFaceTex, 'aFace', 0.25, 0.5, 'ally-head-v1'),
  badge: atlasMat(allyBadgeTex, 'aBadge', 1, 0.5, 'ally-badge-v1'),
};
const H_GEO = (() => {
  const r = M.HEAD_R,
    front = Math.PI / 2;
  const torso = G3.cap(0.175, 0.12, 14);
  torso.rotateY(Math.PI);
  torso.scale(1.2, 1, 0.82);
  torso.translate(0, 0.215, 0);
  // 칼라 + 단추
  const collarParts = [];
  for (const sx of [-1, 1]) {
    const cg = new THREE.ConeGeometry(0.07, 0.12, 3);
    cg.rotateX(Math.PI);
    cg.rotateZ(sx * 0.5);
    cg.scale(1, 1, 0.45);
    cg.rotateX(-0.35);
    cg.translate(sx * 0.07, 0.4, 0.105);
    collarParts.push(cg);
  }
  const ring = new THREE.TorusGeometry(0.115, 0.03, 6, 16);
  ring.rotateX(Math.PI / 2);
  ring.scale(1.1, 1, 0.85);
  ring.translate(0, 0.415, 0.005);
  collarParts.push(ring);
  for (const [y, z] of [
    [0.33, 0.139],
    [0.26, 0.147],
    [0.19, 0.147]
  ]) {
    const b = G3.sphere(0.013, 6, 5);
    b.scale(1, 1, 0.5);
    b.translate(0, y, z);
    collarParts.push(b);
  }
  const collar = mergeGeos(collarParts);
  // 명찰
  const badge = new THREE.PlaneGeometry(0.15, 0.075);
  badge.rotateY(0.32);
  badge.rotateX(-0.12);
  badge.translate(0.097, 0.29, 0.152);
  // 골반 + 허리띠
  const beltG = new THREE.CylinderGeometry(0.205, 0.205, 0.05, 16, 1, true);
  beltG.scale(1, 1, 0.78);
  beltG.translate(0, 0.05, 0);
  const buckle = new THREE.BoxGeometry(0.06, 0.04, 0.02);
  buckle.translate(0, 0.05, 0.165);
  const hips = mergeGeos([paint(G3.ell(0.19, 0.12, 0.145, 14, 8), '#2b3b67'), paint(beltG, '#5d3b22'), paint(buckle, '#4a4952')]);
  // 머리 (귀는 얼굴 아틀라스의 살색 구석을 씀)
  const hg = headGeo(r, 28, 20);
  const ears = [];
  for (const sx of [-1, 1]) {
    const e = G3.ell(0.048, 0.075, 0.036, 8, 6);
    e.translate(sx * (r - 0.005), -0.015, -0.01);
    const u = e.attributes.uv;
    for (let i = 0; i < u.count; i++) u.setXY(i, 0.03, 0.97);
    ears.push(e);
  }
  const head = mergeGeos([hg, ...ears]);
  head.translate(0, M.HEAD_UP, 0);
  // 머리 A: 단정한 가르마
  const hf = new THREE.SphereGeometry(r * 1.065, 12, 6, front - 0.95, 1.9, 0, Math.PI * 0.25);
  const hsL = new THREE.SphereGeometry(r * 1.06, 8, 10, front + 0.95, 0.9, 0, Math.PI * 0.43);
  const hsR = new THREE.SphereGeometry(r * 1.06, 8, 10, front - 1.85, 0.9, 0, Math.PI * 0.43);
  const hb = new THREE.SphereGeometry(r * 1.055, 18, 12, front + 1.85, TAU - 3.7, 0, Math.PI * 0.6);
  const fr = G3.ell(0.21, 0.085, 0.12, 14, 8);
  fr.rotateZ(-0.3);
  fr.rotateX(-0.55);
  fr.translate(0.06, r * 0.73, r * 0.71);
  const fr2 = G3.ell(0.1, 0.065, 0.085, 10, 6);
  fr2.rotateZ(0.25);
  fr2.rotateX(-0.5);
  fr2.translate(-0.16, r * 0.69, r * 0.65);
  const hairA = mergeGeos([hf, hsL, hsR, hb, fr, fr2]);
  hairA.translate(0, M.HEAD_UP, 0);
  // 머리 B: 단발
  const bob = new THREE.SphereGeometry(r * 1.08, 22, 14, front + 1.12, TAU - 2.24, 0, Math.PI * 0.7);
  const cap = new THREE.SphereGeometry(r * 1.085, 22, 8, 0, TAU, 0, Math.PI * 0.3);
  const bang = new THREE.SphereGeometry(r * 1.09, 14, 6, front - 1.2, 2.4, 0, Math.PI * 0.355);
  const hairB = mergeGeos([bob, cap, bang]);
  hairB.translate(0, M.HEAD_UP, 0);
  // 팔 (긴 소매)
  const uarm = G3.cap(0.066, 0.13, 10);
  uarm.translate(0, -0.1, 0);
  const farm = G3.cap(0.06, 0.11, 10);
  farm.translate(0, -0.09, 0);
  const cuff = new THREE.CylinderGeometry(0.066, 0.066, 0.035, 10);
  cuff.translate(0, 0.01, 0);
  const handS = G3.sphere(0.068, 10, 8);
  handS.translate(0, -0.035, 0);
  const hand = mergeGeos([paint(handS, ALLY_SKIN), paint(cuff, '#ffffff')]);
  // 다리
  const thigh = G3.cap(0.088, 0.1, 10);
  thigh.translate(0, -0.11, 0);
  const shin = G3.cap(0.078, 0.12, 10);
  shin.translate(0, -0.11, 0);
  const shoeS = G3.ell(0.082, 0.055, 0.13, 12, 8);
  shoeS.translate(0, -0.03, 0.045);
  const sole = new THREE.BoxGeometry(0.15, 0.03, 0.25);
  sole.translate(0, -0.075, 0.045);
  const shoe = mergeGeos([paint(shoeS, '#f5f5f5'), paint(sole, '#9aa0ab')]);
  // 방망이: 손목 기준. 팔 방향(-y)에서 앞(+z)으로 35도 들림
  const grip = new THREE.CylinderGeometry(0.018, 0.019, 0.2, 8);
  grip.translate(0, 0.1, 0);
  const knob = new THREE.CylinderGeometry(0.028, 0.026, 0.022, 8);
  knob.translate(0, -0.008, 0);
  const barrel = new THREE.CylinderGeometry(0.043, 0.02, 0.44, 10);
  barrel.translate(0, 0.42, 0);
  const tip = G3.sphere(0.043, 10, 6);
  tip.scale(1, 0.55, 1);
  tip.translate(0, 0.64, 0);
  const bat = mergeGeos([paint(grip, '#2b2b33'), paint(knob, '#2b2b33'), paint(barrel, '#d8a057'), paint(tip, '#d8a057')]);
  bat.translate(0, -0.09, 0);
  bat.rotateX(Math.PI - 0.61);
  bat.translate(0, -0.035, 0.01);
  // 칼: 주인공 칼과 같은 모양, 왼손
  const blade = paint(knifeGeo(), '#e6eaef');
  blade.rotateX(Math.PI / 2);
  blade.translate(0, 0, 0.03);
  blade.rotateX(Math.PI / 2);
  blade.translate(0, -0.04, 0);
  const handle = paint(new THREE.BoxGeometry(0.03, 0.1, 0.034), '#1b1a1f');
  handle.translate(0, -0.05, 0);
  handle.rotateX(Math.PI / 2);
  handle.translate(0, 0, 0.03);
  handle.rotateX(Math.PI / 2);
  handle.translate(0, -0.04, 0);
  const knife = mergeGeos([blade, handle]);
  return {
    torso,
    collar,
    badge,
    hips,
    head,
    hairA,
    hairB,
    uarm,
    farm,
    hand,
    thigh,
    shin,
    shoe,
    bat,
    knife
  };
})();
// [이름, 지오메트리, 재질, 노드, 윤곽선, 색 종류, 켜고 끄기]
const H_DEFS = [
  ['torso', 'torso', 'tint', 'torso', true, 'shirt', null],
  ['collar', 'collar', 'white', 'torso', true, null, null],
  ['badge', 'badge', 'badge', 'torso', false, null, null],
  ['hips', 'hips', 'vc', 'hips', true, null, null],
  ['head', 'head', 'head', 'neck', true, null, null],
  ['hairA', 'hairA', 'tint', 'neck', true, 'hair', 'hairA'],
  ['hairB', 'hairB', 'tint', 'neck', true, 'hair', 'hairB'],
  ['uarmL', 'uarm', 'tint', 'shL', true, 'shirt', null],
  ['uarmR', 'uarm', 'tint', 'shR', true, 'shirt', null],
  ['farmL', 'farm', 'tint', 'elL', true, 'shirt', null],
  ['farmR', 'farm', 'tint', 'elR', true, 'shirt', null],
  ['handL', 'hand', 'vc', 'wrL', true, null, null],
  ['handR', 'hand', 'vc', 'wrR', true, null, null],
  ['thighL', 'thigh', 'navy', 'hipL', true, null, null],
  ['thighR', 'thigh', 'navy', 'hipR', true, null, null],
  ['shinL', 'shin', 'navy', 'knL', true, null, null],
  ['shinR', 'shin', 'navy', 'knR', true, null, null],
  ['shoeL', 'shoe', 'vc', 'anL', true, null, null],
  ['shoeR', 'shoe', 'vc', 'anR', true, null, null],
  ['bat', 'bat', 'vc', 'wrR', true, null, 'bat'],
  ['knife', 'knife', 'vc', 'wrL', true, null, 'knife'],
];
const HS = (() => {
  const set = {
    parts: []
  };
  const af = new THREE.InstancedBufferAttribute(new Float32Array(MAXH * 2), 2);
  const ab = new THREE.InstancedBufferAttribute(new Float32Array(MAXH * 2), 2);
  for (let i = 0; i < MAXH; i++) {
    af.setXY(i, i * 0.25, 0.5);
    ab.setXY(i, 0, ALLY_LOOK[i].grade === 2 ? 0.5 : 0);
  }
  af.setUsage(THREE.DynamicDrawUsage);
  set.aFace = af;
  for (const [name, geoKey, matKey, node, outline, kind, toggle] of H_DEFS) {
    let geo = H_GEO[geoKey];
    if (name === 'head') {
      geo = geo.clone();
      geo.setAttribute('aFace', af);
    }
    if (name === 'badge') {
      geo = geo.clone();
      geo.setAttribute('aBadge', ab);
    }
    const m = new THREE.InstancedMesh(geo, H_MAT[matKey], MAXH);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAXH; i++) m.setMatrixAt(i, _zeroM);
    if (kind) m.setColorAt(0, _white);
    m.frustumCulled = false;
    m.castShadow = name !== 'badge';
    m.receiveShadow = false;
    scene.add(m);
    let o = null;
    if (outline) {
      o = new THREE.InstancedMesh(geo, OUT_MAT, MAXH);
      o.instanceMatrix = m.instanceMatrix;
      o.frustumCulled = false;
      scene.add(o);
    }
    set.parts.push({
      name,
      m,
      o,
      node,
      kind,
      toggle
    });
  }
  return set;
})();

function setAllyColors(k, cols) {
  for (const part of HS.parts) {
    if (!part.kind) continue;
    _col.set(cols[part.kind]);
    part.m.setColorAt(k, _col);
    part.m.instanceColor.needsUpdate = true;
  }
}

function setAllyFace(k, struggle) {
  HS.aFace.setXY(k, k * 0.25, struggle ? 0 : 0.5);
  HS.aFace.needsUpdate = true;
}

function hideAllyInstance(k) {
  for (const part of HS.parts) part.m.setMatrixAt(k, _zeroM);
}

function flushAllies() {
  for (const part of HS.parts) part.m.instanceMatrix.needsUpdate = true;
}

// ───────────────────────── 이펙트 ─────────────────────────
const _m4 = new THREE.Matrix4(),
  _q = new THREE.Quaternion(),
  _v = new THREE.Vector3(),
  _v2 = new THREE.Vector3(),
  _s = new THREE.Vector3(),
  _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);

// 바닥 핏자국 (아틀라스 + 인스턴스별 칸 선택)
const DECAL_MAX = 900;
const bloodAtlas = makeBloodAtlas();
const decalGeo = new THREE.PlaneGeometry(1, 1);
decalGeo.rotateX(-Math.PI / 2);
const aCell = new THREE.InstancedBufferAttribute(new Float32Array(DECAL_MAX * 2), 2);
decalGeo.setAttribute('aCell', aCell);
const decalMat = new THREE.MeshBasicMaterial({
  map: bloodAtlas,
  transparent: true,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -3,
  polygonOffsetUnits: -3
});
decalMat.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * 0.5 + aCell;\n#endif');
};
decalMat.customProgramCacheKey = () => 'decal-v1';
const decals = new THREE.InstancedMesh(decalGeo, decalMat, DECAL_MAX);
decals.frustumCulled = false;
decals.renderOrder = 1;
decals.count = 0;
scene.add(decals);
let decalNext = 0,
  decalUsed = 0;
const growing = [];

function addDecal(x, z, size, cell, rot, grow = 0) {
  const i = decalNext;
  decalNext = (decalNext + 1) % DECAL_MAX;
  decalUsed = Math.min(DECAL_MAX, decalUsed + 1);
  decals.count = decalUsed;
  aCell.setXY(i, BLOOD_OFF[cell][0], BLOOD_OFF[cell][1]);
  aCell.needsUpdate = true;
  const y = 0.004 + (i % 50) * 0.00012;
  const d = {
    i,
    x,
    z,
    y,
    rot,
    size,
    s: grow ? size * 0.15 : size,
    t: 0,
    dur: grow
  };
  setDecal(d);
  if (grow) growing.push(d);
  return d;
}

function setDecal(d) {
  _q.setFromAxisAngle(_up, d.rot);
  _s.set(d.s, 1, d.s);
  _m4.compose(_v.set(d.x, d.y, d.z), _q, _s);
  decals.setMatrixAt(d.i, _m4);
  decals.instanceMatrix.needsUpdate = true;
}

function clearDecals() {
  decalNext = 0;
  decalUsed = 0;
  decals.count = 0;
  growing.length = 0;
}

// 피 방울
const DROP_MAX = 700;
const drops = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 5), new THREE.MeshBasicMaterial({
  color: 0xc8001d
}), DROP_MAX);
drops.frustumCulled = false;
drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(drops);
const dropS = [];
for (let i = 0; i < DROP_MAX; i++) {
  dropS.push({
    on: false,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    r: 0.03
  });
  drops.setMatrixAt(i, _zeroM);
}
let dropNext = 0;

function bloodBurst(x, y, z, dx, dz, n, power = 1) {
  for (let k = 0; k < n; k++) {
    const d = dropS[dropNext];
    dropNext = (dropNext + 1) % DROP_MAX;
    d.on = true;
    d.x = x + rand(-0.05, 0.05);
    d.y = y + rand(-0.08, 0.08);
    d.z = z + rand(-0.05, 0.05);
    const sp = rand(1.2, 4.6) * power;
    d.vx = dx * sp + rand(-1.3, 1.3);
    d.vz = dz * sp + rand(-1.3, 1.3);
    d.vy = rand(0.6, 3.6) * power;
    d.r = rand(0.018, 0.05);
  }
}

function bloodSpurt(x, y, z, dx, dy, dz, n) {
  for (let k = 0; k < n; k++) {
    const d = dropS[dropNext];
    dropNext = (dropNext + 1) % DROP_MAX;
    d.on = true;
    d.x = x;
    d.y = y;
    d.z = z;
    const sp = rand(1.5, 3.5);
    d.vx = dx * sp + rand(-0.6, 0.6);
    d.vy = dy * sp + rand(0.2, 1.6);
    d.vz = dz * sp + rand(-0.6, 0.6);
    d.r = rand(0.016, 0.04);
  }
}
let splatBudget = 0;

function updateDrops(dt) {
  for (let i = 0; i < DROP_MAX; i++) {
    const d = dropS[i];
    if (!d.on) continue;
    d.vy -= 15 * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.z += d.vz * dt;
    if (d.y < 0.01) {
      d.on = false;
      drops.setMatrixAt(i, _zeroM);
      if (Math.random() < 0.55) addDecal(d.x, d.z, d.r * rand(4, 8), Math.random() < 0.5 ? 0 : 1, rand(0, TAU));
      continue;
    }
    _m4.makeScale(d.r, d.r * 1.25, d.r);
    _m4.setPosition(d.x, d.y, d.z);
    drops.setMatrixAt(i, _m4);
  }
  drops.instanceMatrix.needsUpdate = true;
}

function clearDrops() {
  for (let i = 0; i < DROP_MAX; i++) {
    dropS[i].on = false;
    drops.setMatrixAt(i, _zeroM);
  }
  drops.instanceMatrix.needsUpdate = true;
}

// 눈물 방울
const TEAR_MAX = 360;
const tears = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 5), new THREE.MeshBasicMaterial({
  color: 0x2fa8ff
}), TEAR_MAX);
tears.frustumCulled = false;
tears.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(tears);
const tearS = [];
for (let i = 0; i < TEAR_MAX; i++) {
  tearS.push({
    on: false,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    r: 0.02
  });
  tears.setMatrixAt(i, _zeroM);
}
let tearNext = 0;

function addTear(x, y, z, vx, vz, owner = null) {
  const d = tearS[tearNext];
  tearNext = (tearNext + 1) % TEAR_MAX;
  d.on = true;
  d.owner = owner;
  d.x = x;
  d.y = y;
  d.z = z;
  d.vx = vx + rand(-0.25, 0.25);
  d.vz = vz + rand(-0.25, 0.25);
  d.vy = rand(0.2, 0.9);
  d.r = rand(0.02, 0.03);
}

function updateTears(dt) {
  for (let i = 0; i < TEAR_MAX; i++) {
    const d = tearS[i];
    if (!d.on) continue;
    d.vy -= 9 * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.z += d.vz * dt;
    if (d.y < 0.01) {
      d.on = false;
      tears.setMatrixAt(i, _zeroM);
      continue;
    }
    _m4.makeScale(d.r, d.r * 1.35, d.r);
    _m4.setPosition(d.x, d.y, d.z);
    tears.setMatrixAt(i, _m4);
  }
  tears.instanceMatrix.needsUpdate = true;
}

function clearTears() {
  for (let i = 0; i < TEAR_MAX; i++) {
    tearS[i].on = false;
    tears.setMatrixAt(i, _zeroM);
  }
  tears.instanceMatrix.needsUpdate = true;
}

// 탄피
const SHELL_MAX = 420;
const shellGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.034, 7);
const shells = new THREE.InstancedMesh(shellGeo, toon('#c99a2e'), SHELL_MAX);
shells.frustumCulled = false;
shells.castShadow = false;
shells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(shells);
const shellS = [];
for (let i = 0; i < SHELL_MAX; i++) {
  shellS.push({
    on: false,
    rest: false,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    ax: 0,
    ay: 0,
    az: 0,
    wx: 0,
    wy: 0,
    wz: 0
  });
  shells.setMatrixAt(i, _zeroM);
}
let shellNext = 0,
  shellUsed = 0;

function ejectShell(x, y, z, dirx, dirz) {
  const s = shellS[shellNext];
  shellNext = (shellNext + 1) % SHELL_MAX;
  shellUsed = Math.min(SHELL_MAX, shellUsed + 1);
  // 탄피는 사격 방향의 오른쪽 위로 튄다
  const rx = -dirz,
    rz = dirx;
  s.on = true;
  s.rest = false;
  s.x = x;
  s.y = y;
  s.z = z;
  s.vx = rx * rand(1.4, 2.4) + dirx * rand(-0.4, 0.3);
  s.vz = rz * rand(1.4, 2.4) + dirz * rand(-0.4, 0.3);
  s.vy = rand(2.2, 3.4);
  s.ax = rand(0, TAU);
  s.ay = rand(0, TAU);
  s.az = rand(0, TAU);
  s.wx = rand(-20, 20);
  s.wy = rand(-12, 12);
  s.wz = rand(-20, 20);
  s.bounces = 0;
}

function updateShells(dt) {
  let dirty = false;
  for (let i = 0; i < SHELL_MAX; i++) {
    const s = shellS[i];
    if (!s.on || s.rest) continue;
    dirty = true;
    s.vy -= 16 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.z += s.vz * dt;
    s.ax += s.wx * dt;
    s.ay += s.wy * dt;
    s.az += s.wz * dt;
    if (s.y < 0.014 && s.vy < 0) {
      s.y = 0.014;
      const sp = -s.vy;
      if (s.bounces < 3) sfxTink(THREE.MathUtils.clamp(sp / 3, 0.25, 1), THREE.MathUtils.clamp((s.x - CAMX) / 6, -1, 1));
      s.bounces++;
      s.vy = sp * 0.38;
      s.vx *= 0.55;
      s.vz *= 0.55;
      s.wx *= 0.5;
      s.wz *= 0.5;
      if (sp < 0.7) {
        s.rest = true;
        s.ax = Math.PI / 2;
        s.az = 0;
      }
    }
    _e.set(s.ax, s.ay, s.az);
    _q.setFromEuler(_e);
    _m4.compose(_v.set(s.x, s.y, s.z), _q, _s.set(1, 1, 1));
    shells.setMatrixAt(i, _m4);
  }
  if (dirty) shells.instanceMatrix.needsUpdate = true;
}

function clearShells() {
  for (let i = 0; i < SHELL_MAX; i++) {
    shellS[i].on = false;
    shells.setMatrixAt(i, _zeroM);
  }
  shells.instanceMatrix.needsUpdate = true;
  shellNext = 0;
}

// 총구 화염
const flashTex = makeFlashTex();
const FLASHES = GUNS.map((gun) => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: flashTex,
    transparent: true,
    depthWrite: false,
    fog: false
  }));
  sp.position.copy(MUZZLE_LOCAL).add(new THREE.Vector3(0, 0, 0.06));
  sp.scale.set(0.42, 0.42, 1);
  sp.visible = false;
  sp.renderOrder = 7;
  gun.add(sp);
  return { sp, t: 0 };
});
SG.flash = new THREE.Sprite(new THREE.SpriteMaterial({
  map: flashTex,
  transparent: true,
  depthWrite: false,
  fog: false
}));
SG.flash.position.copy(SG_MUZZLE).add(new THREE.Vector3(0, 0, 0.1));
SG.flash.scale.set(0.8, 0.8, 1);
SG.flash.visible = false;
SG.flash.renderOrder = 7;
SG.model.add(SG.flash);
// 총알 궤적
const TRACER_MAX = 24;
const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
tracerGeo.translate(0, 0, 0.5);
const tracers = new THREE.InstancedMesh(tracerGeo, new THREE.MeshBasicMaterial({
  color: 0xffae1f,
  fog: false
}), TRACER_MAX);
tracers.frustumCulled = false;
tracers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
scene.add(tracers);
const tracerS = [];
for (let i = 0; i < TRACER_MAX; i++) {
  tracerS.push({
    t: 0,
    on: false,
    ax: 0,
    ay: 0,
    az: 0,
    bx: 0,
    by: 0,
    bz: 0
  });
  tracers.setMatrixAt(i, _zeroM);
}
let tracerNext = 0;

function addTracer(ax, ay, az, bx, by, bz) {
  const t = tracerS[tracerNext];
  tracerNext = (tracerNext + 1) % TRACER_MAX;
  t.on = true;
  t.t = 0;
  t.ax = ax;
  t.ay = ay;
  t.az = az;
  t.bx = bx;
  t.by = by;
  t.bz = bz;
}
const _dir = new THREE.Vector3(), _zAxis = new THREE.Vector3(0, 0, 1);

function updateTracers(dt) {
  for (let i = 0; i < TRACER_MAX; i++) {
    const t = tracerS[i];
    if (!t.on) continue;
    t.t += dt;
    if (t.t > 0.07) {
      t.on = false;
      tracers.setMatrixAt(i, _zeroM);
      continue;
    }
    const k = t.t / 0.07;
    // 앞쪽부터 사라지는 궤적
    const sx = THREE.MathUtils.lerp(t.ax, t.bx, k * 0.7),
      sy = THREE.MathUtils.lerp(t.ay, t.by, k * 0.7),
      sz = THREE.MathUtils.lerp(t.az, t.bz, k * 0.7);
    _dir.set(t.bx - sx, t.by - sy, t.bz - sz);
    const len = _dir.length();
    _dir.divideScalar(len || 1);
    _q.setFromUnitVectors(_zAxis, _dir);
    const w = 0.028 * (1 - k * 0.6);
    _m4.compose(_v.set(sx, sy, sz), _q, _s.set(w, w, len));
    tracers.setMatrixAt(i, _m4);
  }
  tracers.instanceMatrix.needsUpdate = true;
}

// 하이파이브 '짝'
const burstTex = makeBurstTex();
const BURSTS = [];
for (let i = 0; i < 3; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: burstTex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    fog: false
  }));
  sp.visible = false;
  sp.renderOrder = 8;
  scene.add(sp);
  BURSTS.push({
    sp,
    t: 0,
    dur: 0.34,
    size: 0.8
  });
}
let burstNext = 0;

function popBurst(x, y, z, size = 0.8) {
  const b = BURSTS[burstNext];
  burstNext = (burstNext + 1) % BURSTS.length;
  b.sp.position.set(x, y, z);
  b.t = 0;
  b.size = size;
  b.sp.visible = true;
  b.sp.material.rotation = rand(-0.3, 0.3);
  b.sp.material.opacity = 1;
  b.sp.scale.setScalar(0.01);
}

function updateBursts(dt) {
  for (const b of BURSTS) {
    if (!b.sp.visible) continue;
    b.t += dt;
    const k = b.t / b.dur;
    if (k >= 1) {
      b.sp.visible = false;
      continue;
    }
    const s = b.size * (k < 0.22 ? easeOutCubic(k / 0.22) * 1.15 : THREE.MathUtils.lerp(1.15, 1.0, (k - 0.22) / 0.78));
    b.sp.scale.setScalar(s);
    b.sp.material.opacity = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
  }
}

// 붙잡혀 위험할 때 발밑에 차오르는 고리 (위쪽부터 시계 방향)
const dangerRing = (() => {
  const g = new THREE.RingGeometry(1.12, 1.3, 72, 1);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uProg: {
        value: 0
      },
      uAlpha: {
        value: 0
      }
    },
    vertexShader: 'varying vec2 vP; void main() { vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform float uProg; uniform float uAlpha; varying vec2 vP;
      void main() {
        float a = atan(vP.x, -vP.y); if (a < 0.0) a += 6.2831853; a /= 6.2831853;
        float on = step(a, uProg);
        vec3 c = mix(vec3(1.0, 0.78, 0.82), vec3(0.83, 0.07, 0.17), on);
        gl_FragColor = vec4(c, uAlpha * mix(0.45, 0.95, on));
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 9;
  mesh.visible = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
})();

function fxUpdate(dt) {
  updateDrops(dt);
  updateTears(dt);
  updateShells(dt);
  updateTracers(dt);
  updateBursts(dt);
  for (let i = growing.length - 1; i >= 0; i--) {
    const d = growing[i];
    d.t += dt;
    const k = easeOutCubic(d.t / d.dur);
    d.s = THREE.MathUtils.lerp(d.size * 0.15, d.size, k);
    setDecal(d);
    if (d.t >= d.dur) growing.splice(i, 1);
  }
  for (const f of FLASHES) {
    if (f.t > 0) {
      f.t -= dt;
      if (f.t <= 0) f.sp.visible = false;
    }
  }
  tinkBudget = Math.max(0, tinkBudget - dt * 5);
  // 주인공 텍스처 갱신은 몰아서
  FXDirty.t -= dt;
  if (FXDirty.t <= 0 && (FXDirty.face || FXDirty.shirt)) {
    if (FXDirty.face) {
      meFaceTex.needsUpdate = true;
      FXDirty.face = false;
    }
    if (FXDirty.shirt) {
      shirtTex.needsUpdate = true;
      FXDirty.shirt = false;
    }
    FXDirty.t = 0.2;
  }
}

function fxClearAll() {
  for (const b of BURSTS) b.sp.visible = false;
  clearDecals();
  clearDrops();
  clearTears();
  clearShells();
  for (let i = 0; i < TRACER_MAX; i++) {
    tracerS[i].on = false;
    tracers.setMatrixAt(i, _zeroM);
  }
  tracers.instanceMatrix.needsUpdate = true;
}

// 바닥
const floorTex = makeFloorTex();
floorTex.repeat.set(80, 80);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshLambertMaterial({
  color: 0xffffff,
  map: floorTex
}));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
floor.renderOrder = 0;
scene.add(floor);

// 바닥의 캠페인 포스터: 드문 간격의 종이. 이동할 때 격자 경계를 넘는 경우에만 재배치.
const CARE_POSTER_VARIANTS = 4;

function makeCarePosterAtlas(existing) {
  const c = document.createElement('canvas');
  c.width = 512 * CARE_POSTER_VARIANTS;
  c.height = 768;
  const g = c.getContext('2d');
  const lines = [
    ['건강한 인간관계가', '당신을 건강하게', '합니다.'],
    ['마음이 건강한', '사람을', '곁에 두세요'],
    ['나를 아프게 하는', '관계는', '정리하세요'],
    ['이놈이', '누가', '어디서', '핵을', '써래!']
  ];
  const colors = ['#37658b', '#5c7869', '#9b5b60', '#69788c'];
  for (let k = 0; k < CARE_POSTER_VARIANTS; k++) {
    const x = k * 512;
    g.save();
    g.translate(x, 0);
    g.shadowColor = '#26253638';
    g.shadowBlur = 13;
    g.shadowOffsetX = 4;
    g.shadowOffsetY = 8;
    g.fillStyle = '#fffdf7';
    g.beginPath();
    g.moveTo(24, 23);
    g.lineTo(474, 30);
    g.lineTo(488, 729);
    g.lineTo(28, 737);
    g.closePath();
    g.fill();
    g.shadowColor = 'transparent';
    const paper = g.createLinearGradient(24, 23, 488, 729);
    paper.addColorStop(0, '#fffdf7');
    paper.addColorStop(0.58, '#fdfaf0');
    paper.addColorStop(1, '#ece9df');
    g.fillStyle = paper;
    g.fill();
    g.strokeStyle = '#d4d0c7';
    g.lineWidth = 2;
    g.stroke();
    if (k === 3) {
      // 캠페인 종이 사이에 드물게 섞이는 평범한 연구소 광고.
      g.fillStyle = '#e8edf2';
      g.fillRect(54, 70, 399, 64);
      g.fillStyle = colors[k];
      g.textAlign = 'center';
      g.font = '700 24px Arial, sans-serif';
      g.fillText('ESTEEM LAB', 256, 111);
      g.fillStyle = '#252d35';
      g.font = '900 62px "Noto Sans KR", "Malgun Gothic", sans-serif';
      g.fillText('에스팀랩', 256, 248);
      g.fillStyle = colors[k];
      g.font = '700 31px "Noto Sans KR", "Malgun Gothic", sans-serif';
      g.fillText('자존감 연구소', 256, 305);
      g.fillStyle = '#e8edf2';
      g.beginPath();
      g.arc(256, 479, 113, 0, TAU);
      g.fill();
      drawAgencyMark(g, 256, 479, 216, colors[k]);
      g.strokeStyle = '#c7cfd7';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(96, 644);
      g.lineTo(416, 644);
      g.stroke();
      g.fillStyle = colors[k];
      g.font = '700 19px Arial, sans-serif';
      g.fillText('ESTEEM LAB', 256, 687);
    } else {
      g.fillStyle = colors[k];
      g.fillRect(54, 70, 10, 35);
      g.font = '700 24px "Noto Sans KR", "Malgun Gothic", sans-serif';
      g.textAlign = 'left';
      g.fillText('정신건강 캠페인', 80, 97);
      g.strokeStyle = colors[k];
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(54, 132);
      g.lineTo(453, 132);
      g.stroke();
      g.textAlign = 'center';
      g.fillStyle = '#252d35';
      g.font = '900 43px "Noto Sans KR", "Malgun Gothic", sans-serif';
      const arr = pick(lines);
      const arrIdx = lines.indexOf(arr);
      for (let j = 0; j < arr.length; j++) g.fillText(arr[j], 256, 266 + j * 75);
      // 두 사람 그림. 마지막 포스터에는 둘 사이를 가르는 단선이 인쇄되어 있다.
      if (arrIdx != 3) {
        g.strokeStyle = colors[k];
        g.lineWidth = 9;
        g.lineCap = 'round';
        for (const px of [192, 320]) {
          g.beginPath();
          g.arc(px, 519, 23, 0, TAU);
          g.stroke();
          g.beginPath();
          g.moveTo(px, 546);
          g.lineTo(px, 593);
          g.moveTo(px - 32, 567);
          g.lineTo(px + 32, 567);
          g.moveTo(px, 593);
          g.lineTo(px - 25, 628);
          g.moveTo(px, 593);
          g.lineTo(px + 25, 628);
          g.stroke();
        }
        g.beginPath();
        if (k === 2) {
          g.moveTo(263, 530);
          g.lineTo(248, 610);
        } else {
          g.moveTo(224, 567);
          g.lineTo(288, 567);
        }
        g.stroke();
      }
      // 하단의 작은 발행기관 표식. 포스터 크기와 본문은 그대로 둔다.
      drawAgencyMark(g, 427, 680, 46, colors[k]);
      g.fillStyle = colors[k];
      g.font = '700 16px "Noto Sans KR", "Malgun Gothic", sans-serif';
      g.textAlign = 'left';
      g.fillText('국가정신건강등급심사원', 58, 687);
    }
    // 종이의 접힌 귀와 얕은 접힘선.
    g.fillStyle = '#e5e0d4';
    g.beginPath();
    g.moveTo(447, 30);
    g.lineTo(474, 30);
    g.lineTo(475, 60);
    g.closePath();
    g.fill();
    g.strokeStyle = '#a8a29324';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(36, 457);
    g.lineTo(479, 452);
    g.stroke();
    g.restore();
  }
  if (existing) {
    existing.image = c;
    existing.needsUpdate = true;
    return existing;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}
const carePosterTex = makeCarePosterAtlas();
const carePosterGeo = new THREE.PlaneGeometry(0.9, 1.22);
carePosterGeo.rotateX(-Math.PI / 2);
const CARE_POSTER_RING = 3,
  CARE_POSTER_SPACING = 10.5,
  CARE_POSTER_COUNT = (CARE_POSTER_RING * 2 + 1) ** 2;
const carePosterAttr = new THREE.InstancedBufferAttribute(new Float32Array(CARE_POSTER_COUNT), 1);
carePosterAttr.setUsage(THREE.DynamicDrawUsage);
carePosterGeo.setAttribute('aPoster', carePosterAttr);
const carePosterMat = new THREE.MeshBasicMaterial({
  map: carePosterTex,
  transparent: true,
  depthWrite: false,
  alphaTest: 0.02,
  side: THREE.DoubleSide
});
carePosterMat.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aPoster;')
    .replace('#include <uv_vertex>', `#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv.x = (vMapUv.x + aPoster) / ${CARE_POSTER_VARIANTS}.0;\n#endif`);
};
carePosterMat.customProgramCacheKey = () => 'care-poster-v2';
const carePosters = new THREE.InstancedMesh(carePosterGeo, carePosterMat, CARE_POSTER_COUNT);
carePosters.frustumCulled = false;
carePosters.renderOrder = 0.5;
scene.add(carePosters);
let carePosterCellX = Infinity,
  carePosterCellZ = Infinity;
const _posterM = new THREE.Matrix4(),
  _posterQ = new THREE.Quaternion(),
  _posterPos = new THREE.Vector3(),
  _posterScale = new THREE.Vector3(1, 1, 1),
  _posterUp = new THREE.Vector3(0, 1, 0);

function carePosterHash(x, z, salt) {
  let n = Math.imul(x ^ salt, 374761393) + Math.imul(z, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function updateCarePosters(force = false) {
  carePosters.visible = G.state !== 'title';
  if (!carePosters.visible) return;
  const cx = Math.floor((ME.x + CARE_POSTER_SPACING * 0.5) / CARE_POSTER_SPACING),
    cz = Math.floor((ME.z + CARE_POSTER_SPACING * 0.5) / CARE_POSTER_SPACING);
  if (!force && cx === carePosterCellX && cz === carePosterCellZ) return;
  carePosterCellX = cx;
  carePosterCellZ = cz;
  let i = 0;
  for (let dz = -CARE_POSTER_RING; dz <= CARE_POSTER_RING; dz++)
    for (let dx = -CARE_POSTER_RING; dx <= CARE_POSTER_RING; dx++) {
      const gx = cx + dx,
        gz = cz + dz;
      let x = gx * CARE_POSTER_SPACING + (carePosterHash(gx, gz, 61) - 0.5) * 5,
        z = gz * CARE_POSTER_SPACING + (carePosterHash(gx, gz, 97) - 0.5) * 5;
      let kind = Math.floor(carePosterHash(gx, gz, 157) * 3),
        angle = (carePosterHash(gx, gz, 193) - 0.5) * 0.5;
      if (carePosterHash(gx, gz, 251) < 1 / 6) kind = 3;
      // 시작 구역에는 세 문구가 각각 한 장씩. 주변 세계에는 큰 빈 공간을 남긴다.
      if (gx === 0 && gz === 0) {
        x = -1.75;
        z = 1.9;
        kind = 2;
        angle = -0.10;
      }
      if (gx === 1 && gz === 0) {
        x = 2.35;
        z = -2.7;
        kind = 1;
        angle = 0.12;
      }
      if (gx === 0 && gz === -1) {
        x = -0.5;
        z = -6.2;
        kind = 0;
        angle = -0.07;
      }
      _posterPos.set(x, 0.013, z);
      _posterQ.setFromAxisAngle(_posterUp, angle);
      _posterM.compose(_posterPos, _posterQ, _posterScale);
      carePosters.setMatrixAt(i, _posterM);
      carePosterAttr.setX(i, kind);
      i++;
    }
  carePosters.instanceMatrix.needsUpdate = true;
  carePosterAttr.needsUpdate = true;
}

// ───────────────────────── 집 (안에 들어가면 1인칭 고시원) ─────────────────────────
// 하얀 공간 한가운데 평범한 단층집. 창문은 다 깜깜하고, 현관문 밑으로 고시원 형광등 빛이 샌다.
const HW = 6.4,
  HD = 5.2,
  HH = 2.95,
  ROOF_UP = 1.55,
  EAVE = 0.45,
  DOOR_OFF = -1.15,
  DOOR_W = 1.0,
  DOOR_H = 2.1;

function makeStuccoTex() {
  const c = cnv(512, 512),
    g = c.getContext('2d');
  g.fillStyle = '#efe6d6';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 5200; i++) {
    const v = Math.random();
    g.fillStyle = v < 0.5 ? `rgba(120,100,80,${0.05 + Math.random() * 0.08})` : `rgba(255,255,255,${0.2 + Math.random() * 0.3})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 2.2, 1 + Math.random() * 2.2);
  }
  // 빗물 자국
  for (let i = 0; i < 9; i++) {
    const x = Math.random() * 512,
      w = 6 + Math.random() * 18;
    const gr = g.createLinearGradient(0, 0, 0, 512);
    gr.addColorStop(0, 'rgba(110,96,80,0.09)');
    gr.addColorStop(0.5, 'rgba(110,96,80,0.03)');
    gr.addColorStop(1, 'rgba(110,96,80,0)');
    g.fillStyle = gr;
    g.fillRect(x, 0, w, 220 + Math.random() * 200);
  }
  const t = texOf(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeBaseTex() {
  const c = cnv(512, 128),
    g = c.getContext('2d');
  g.fillStyle = '#b9b2a5';
  g.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(60,55,50,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * 512, Math.random() * 128, 2, 2);
  }
  g.strokeStyle = 'rgba(70,64,58,0.5)';
  g.lineWidth = 3;
  for (let y = 0; y <= 128; y += 64) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(512, y);
    g.stroke();
  }
  for (let r = 0; r < 2; r++)
    for (let x = (r ? 64 : 0); x < 512; x += 128) {
      g.beginPath();
      g.moveTo(x, r * 64);
      g.lineTo(x, r * 64 + 64);
      g.stroke();
    }
  const t = texOf(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeRoofTex() {
  const c = cnv(512, 512),
    g = c.getContext('2d');
  g.fillStyle = '#4a5060';
  g.fillRect(0, 0, 512, 512);
  for (let row = 0; row < 8; row++) {
    const y = row * 64;
    for (let col = -1; col < 6; col++) {
      const x = col * 96 + (row % 2) * 48;
      const v = 0.9 + Math.random() * 0.2;
      g.fillStyle = `rgb(${74 * v | 0},${80 * v | 0},${96 * v | 0})`;
      g.fillRect(x + 2, y + 2, 92, 60);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(x + 2, y + 2, 92, 6);
    }
    g.fillStyle = 'rgba(20,22,30,0.55)';
    g.fillRect(0, y + 58, 512, 6);
  }
  const t = texOf(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function makeDoorTex() {
  const c = cnv(256, 512),
    g = c.getContext('2d');
  g.fillStyle = '#2c2e35';
  g.fillRect(0, 0, 256, 512);
  for (const [x, y, w, h] of [
    [34, 40, 188, 190],
    [34, 262, 188, 190]
  ]) {
    g.fillStyle = '#353841';
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#1b1c21';
    g.lineWidth = 5;
    g.strokeRect(x, y, w, h);
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 2;
    g.strokeRect(x + 6, y + 6, w - 12, h - 12);
  }
  g.fillStyle = '#8d9099';
  g.fillRect(0, 478, 256, 26);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(0, 478, 256, 4);
  return texOf(c);
}

function makeInsideTex() {
  // 열린 문 안: 깜깜한데 저 안쪽 바닥에 형광등 빛이 희미하게
  const c = cnv(128, 256),
    g = c.getContext('2d');
  g.fillStyle = '#0c0d10';
  g.fillRect(0, 0, 128, 256);
  const gr = g.createRadialGradient(64, 250, 4, 64, 250, 120);
  gr.addColorStop(0, 'rgba(190,255,180,0.55)');
  gr.addColorStop(0.35, 'rgba(120,190,120,0.18)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 256);
  return texOf(c);
}

function makeGlowTex() {
  const c = cnv(128, 128),
    g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 2, 64, 64, 62);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return texOf(c);
}
const HOUSE = {
  roofMats: [],
  cineHide: false,
  on: false,
  used: false,
  x: 0,
  z: 0,
  dx: 0,
  dz: 0,
  fade: 1,
  fk: 1,
  at: 0,
  door: 0,
  doorTo: 0,
  enter: null,
  mats: [],
  glowT: 0,
  flk: 0,
  group: new THREE.Group(),
  leaf: null,
  leak: null,
  pool: null,
  inside: null,
  lockLed: null,
  arrow: {
    x: 0,
    z: 0,
    hy: 2.1,
    state: 'house'
  },
};
HOUSE.group.visible = false;
scene.add(HOUSE.group);
const HOUSE_OUT = outlineMat();
(() => {
  const H = HOUSE,
    grp = H.group;
  const stucco = makeStuccoTex();
  stucco.repeat.set(2.2, 1);
  const wallM = toon(0xffffff, {
    map: stucco
  }),
    baseM = toon(0xffffff, {
      map: makeBaseTex()
    }),
    roofT = makeRoofTex();
  roofT.repeat.set(3, 1.6);
  const roofM = toon(0xffffff, {
    map: roofT
  }),
    trimM = toon('#f7f5ef'),
    darkM = toon('#2b2d33'),
    frameM = toon('#3a3c43');
  const glassM = toon('#1b2030'),
    curtainM = toon('#e7dcc6'),
    metalM = toon('#a7aab3'),
    stepM = toon('#c7c2b8'),
    matM = toon('#5d4a3a'),
    pipeM = toon('#9b9ea6');
  const doorM = toon(0xffffff, {
    map: makeDoorTex()
  });
  H.mats.push(wallM, baseM, roofM, trimM, darkM, frameM, glassM, curtainM, metalM, stepM, matM, pipeM, doorM, HOUSE_OUT);
  H.roofMats = [roofM, darkM, HOUSE_OUT]; // 가릴 때 지붕(과 윤곽선)은 벽보다 훨씬 옅게
  const add = (geo, mat, x, y, z, outline = true, parent = grp) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    if (outline) m.add(new THREE.Mesh(geo, HOUSE_OUT));
    return m;
  };
  const fz = HD / 2;
  // 벽, 기단
  add(new THREE.BoxGeometry(HW, HH, HD), wallM, 0, HH / 2, 0);
  const baseG = new THREE.BoxGeometry(HW + 0.08, 0.42, HD + 0.08);
  {
    const uv = baseG.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 6);
  }
  add(baseG, baseM, 0, 0.21, 0, false);
  // 박공 (옆면 세모 벽)
  const tri = new THREE.Shape();
  tri.moveTo(-fz, 0);
  tri.lineTo(fz, 0);
  tri.lineTo(0, ROOF_UP);
  tri.closePath();
  for (const sx of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(tri, {
      depth: 0.02,
      bevelEnabled: false
    });
    g.rotateY(Math.PI / 2);
    g.translate(sx * (HW / 2) - 0.01, HH, 0);
    add(g, wallM, 0, 0, 0, false);
  }
  // 지붕 두 장 + 용마루 + 처마 끝
  const run = fz + EAVE,
    slope = Math.atan2(ROOF_UP + EAVE * ROOF_UP / fz, run),
    len = Math.hypot(run, ROOF_UP + EAVE * ROOF_UP / fz);
  for (const sz of [-1, 1]) {
    const g = new THREE.BoxGeometry(HW + 0.8, 0.13, len + 0.06);
    const m = add(g, roofM, 0, HH + ROOF_UP / 2 - EAVE * ROOF_UP / fz / 2 + 0.06, sz * run / 2);
    m.rotation.x = sz * slope;
    const fascia = add(new THREE.BoxGeometry(HW + 0.84, 0.16, 0.06), trimM, 0, HH - EAVE * ROOF_UP / fz + 0.01, sz * (run + 0.01), false);
    fascia.rotation.x = sz * slope * 0.15;
  }
  add(new THREE.BoxGeometry(HW + 0.8, 0.16, 0.24), darkM, 0, HH + ROOF_UP + 0.1, 0);
  // 홈통
  add(new THREE.CylinderGeometry(0.045, 0.045, HH - 0.1, 10), pipeM, HW / 2 - 0.12, (HH - 0.1) / 2, fz + 0.08, false);
  // 현관: 문틀, 안쪽(깜깜), 문짝(오른쪽 경첩, 밖으로 열림), 도어락, 손잡이
  const dx = DOOR_OFF;
  for (const [x, w, y, h] of [
    [dx - DOOR_W / 2 - 0.06, 0.12, DOOR_H / 2 + 0.03, DOOR_H + 0.06],
    [dx + DOOR_W / 2 + 0.06, 0.12, DOOR_H / 2 + 0.03, DOOR_H + 0.06],
    [dx, DOOR_W + 0.24, DOOR_H + 0.09, 0.12]
  ]) add(new THREE.BoxGeometry(w, h, 0.1), frameM, x, y, fz + 0.03);
  H.inside = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W, DOOR_H), new THREE.MeshBasicMaterial({
    map: makeInsideTex()
  }));
  H.inside.position.set(dx, DOOR_H / 2, fz + 0.006);
  grp.add(H.inside);
  H.mats.push(H.inside.material);
  const pivot = new THREE.Group();
  pivot.position.set(dx + DOOR_W / 2, 0, fz + 0.045);
  grp.add(pivot);
  const leaf = add(new THREE.BoxGeometry(DOOR_W - 0.02, DOOR_H - 0.02, 0.05), doorM, -DOOR_W / 2, DOOR_H / 2, 0, true, pivot);
  const lock = add(new THREE.BoxGeometry(0.075, 0.24, 0.04), toon('#121318'), -(DOOR_W - 0.16), 1.18, 0.045, false, pivot);
  H.lockLed = new THREE.Mesh(new THREE.PlaneGeometry(0.035, 0.012), new THREE.MeshBasicMaterial({
    color: 0x4fc8ff
  }));
  H.lockLed.position.set(0, 0.07, 0.021);
  lock.add(H.lockLed);
  const lever = add(new THREE.BoxGeometry(0.15, 0.025, 0.03), metalM, -(DOOR_W - 0.2), 1.0, 0.055, false, pivot);
  H.mats.push(lock.material, H.lockLed.material);
  H.leaf = pivot;
  // 문 밑으로 새는 빛 + 계단 위에 번진 빛
  H.leak = new THREE.Mesh(new THREE.PlaneGeometry(DOOR_W - 0.06, 0.03), new THREE.MeshBasicMaterial({
    color: 0xe3ffd6
  }));
  H.leak.position.set(dx, 0.117, fz + 0.074);
  grp.add(H.leak);
  H.mats.push(H.leak.material);
  // 현관 계단, 매트, 등
  add(new THREE.BoxGeometry(1.6, 0.1, 0.95), stepM, dx, 0.05, fz + 0.5);
  const mat = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.012, 0.5), matM);
  mat.position.set(dx, 0.106, fz + 0.45);
  grp.add(mat);
  H.pool = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 0.8), new THREE.MeshBasicMaterial({
    map: makeGlowTex(),
    color: 0x6fe266,
    transparent: true,
    opacity: 0.7,
    depthWrite: false
  }));
  H.pool.rotation.x = -Math.PI / 2;
  H.pool.position.set(dx, 0.122, fz + 0.27);
  H.pool.renderOrder = 2;
  grp.add(H.pool);
  H.mats.push(H.pool.material);
  const lamp = add(new THREE.BoxGeometry(0.2, 0.26, 0.14), darkM, dx + DOOR_W / 2 + 0.38, 2.15, fz + 0.08);
  const lampGlass = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.18, 0.02), toon('#5b6170'));
  lampGlass.position.set(0, 0, 0.075);
  lamp.add(lampGlass);
  H.mats.push(lampGlass.material);
  // 창문: 앞에 큰 창 하나, 문 왼쪽 작은 창, 옆면에 하나씩 (다 깜깜)
  const win = (x, y, z, w, h, ry, curtain) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = ry;
    grp.add(g);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glassM);
    glass.position.z = 0.012;
    g.add(glass);
    const streak = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.16, h * 1.05), new THREE.MeshBasicMaterial({
      color: 0x8090ad,
      transparent: true,
      opacity: 0.18,
      depthWrite: false
    }));
    streak.position.set(-w * 0.18, 0, 0.016);
    streak.rotation.z = -0.5;
    g.add(streak);
    H.mats.push(streak.material);
    if (curtain) {
      const cu = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.42, h * 0.96), curtainM);
      cu.position.set(w * 0.27, 0, 0.018);
      g.add(cu);
    }
    const t = 0.07;
    for (const [px, py, pw, ph] of [
      [0, h / 2 + t / 2, w + 2 * t, t],
      [0, -h / 2 - t / 2, w + 2 * t, t],
      [-w / 2 - t / 2, 0, t, h],
      [w / 2 + t / 2, 0, t, h],
      [0, 0, 0.04, h],
      [0, 0, w, 0.04]
    ]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, 0.06), trimM);
      m.position.set(px, py, 0.03);
      g.add(m);
    }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.06, 0.16), trimM);
    sill.position.set(0, -h / 2 - 0.1, 0.07);
    g.add(sill);
  };
  win(1.35, 1.6, fz + 0.002, 1.7, 1.15, 0, true);
  win(-2.55, 1.65, fz + 0.002, 0.7, 0.9, 0, false);
  win(HW / 2 + 0.002, 1.6, -0.4, 1.2, 1.0, Math.PI / 2, false);
  win(-HW / 2 - 0.002, 1.6, 0.3, 1.2, 1.0, -Math.PI / 2, true);
  // 움직이지 않는 부분은 재질별로 한 덩어리로 합친다 (그리는 횟수 줄이기). 문짝·빛은 따로 둔다.
  grp.updateMatrixWorld(true);
  const keep = new Set([H.inside, H.leak, H.pool]);
  const byMat = new Map(),
    outl = [],
    drop = [];
  grp.traverse((o) => {
    if (!o.isMesh || keep.has(o)) return;
    for (let q = o.parent; q && q !== grp; q = q.parent)
      if (q === pivot) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (o.material === HOUSE_OUT) outl.push(g);
    else {
      if (!byMat.has(o.material)) byMat.set(o.material, []);
      byMat.get(o.material).push(g);
    }
    drop.push(o);
  });
  for (const o of drop)
    if (o.parent) o.parent.remove(o);
  for (const [mat, gs] of byMat) {
    const m = new THREE.Mesh(mergeGeos(gs), mat);
    m.castShadow = !mat.transparent;
    grp.add(m);
  }
  if (outl.length) grp.add(new THREE.Mesh(mergeGeos(outl), HOUSE_OUT));
})();
// 앞(남쪽, 화면 아래쪽)으로 문이 난 집을 (x, z) 중심에 세운다
function housePlace(x, z) {
  const H = HOUSE;
  H.x = x;
  H.z = z;
  H.dx = x + DOOR_OFF;
  H.dz = z + HD / 2 + 0.62;
  H.arrow.x = H.dx;
  H.arrow.z = z + HD / 2 + 0.2;
  H.group.position.set(x, 0, z);
  H.group.visible = true;
  H.on = true;
  H.door = H.doorTo = 0;
  H.leaf.rotation.y = 0;
  H.enter = null;
  houseFade(1);
  for (const p of live) houseCollide(p, 0.4);
}

function houseHide() {
  const H = HOUSE;
  H.on = false;
  H.used = false;
  H.enter = null;
  H.at = 0;
  H.fk = 1;
  H.group.visible = false;
  H.door = H.doorTo = 0;
  H.leaf.rotation.y = 0;
  houseFade(1);
}
// 집 뒤로 가면 집을 반쯤 투명하게 (주인공이 가려지지 않게)
function houseFade(k) {
  const H = HOUSE;
  if (Math.abs(H.fade - k) < 0.005 && (k === 1) === (H.fade === 1)) return;
  const was = H.fade < 1;
  H.fade = k;
  const now = k < 1;
  for (const m of H.mats) {
    if (m === H.pool.material) {
      m.opacity = 0.7 * k;
      continue;
    }
    if (was !== now) {
      m.transparent = now || !!m.userData.alwaysTr;
      m.depthWrite = !now && !m.userData.alwaysTr;
      m.needsUpdate = true;
    }
    m.opacity = (H.roofMats.includes(m) ? k * k * k : k) * (m.userData.baseOp || 1);
  }
}
for (const m of HOUSE.mats) {
  if (m.transparent) {
    m.userData.alwaysTr = true;
    m.userData.baseOp = m.opacity;
  }
}
// 동그라미(사람)를 집 벽 밖으로 밀어냄. 밀렸으면 벽의 바깥 방향을 돌려준다
const _hn = {
  x: 0,
  z: 0
};

function houseCollide(o, r) {
  const H = HOUSE;
  if (!H.on) return null;
  const x0 = H.x - HW / 2 - 0.05,
    x1 = H.x + HW / 2 + 0.05,
    z0 = H.z - HD / 2 - 0.05,
    z1 = H.z + HD / 2 + 0.05;
  const cx = THREE.MathUtils.clamp(o.x, x0, x1), cz = THREE.MathUtils.clamp(o.z, z0, z1);
  let dx = o.x - cx,
    dz = o.z - cz,
    d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  if (d2 < 1e-8) {
    const l = o.x - x0,
      rr = x1 - o.x,
      t = o.z - z0,
      b = z1 - o.z,
      m = Math.min(l, rr, t, b);
    if (m === l) {
      o.x = x0 - r;
      _hn.x = -1;
      _hn.z = 0;
    } else if (m === rr) {
      o.x = x1 + r;
      _hn.x = 1;
      _hn.z = 0;
    } else if (m === t) {
      o.z = z0 - r;
      _hn.x = 0;
      _hn.z = -1;
    } else {
      o.z = z1 + r;
      _hn.x = 0;
      _hn.z = 1;
    }
    return _hn;
  }
  const d = Math.sqrt(d2),
    push = r - d;
  o.x += dx / d * push;
  o.z += dz / d * push;
  _hn.x = dx / d;
  _hn.z = dz / d;
  return _hn;
}

// 총알은 집 벽을 뚫지 못한다: 벽까지의 거리 (안 맞으면 Infinity)
function houseRayT(ox, oz, dx, dz) {
  const H = HOUSE;
  if (!H.on) return Infinity;
  let t0 = -Infinity, t1 = Infinity;
  for (const [o, d, a, b] of [
    [ox, dx, H.x - HW / 2, H.x + HW / 2],
    [oz, dz, H.z - HD / 2, H.z + HD / 2]
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (o < a || o > b) return Infinity;
      continue;
    }
    let u = (a - o) / d,
      v = (b - o) / d;
    if (u > v) {
      const w = u;
      u = v;
      v = w;
    }
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
  }
  return t1 >= t0 && t0 > 0 ? t0 : Infinity;
}
// 카메라에서 이 점까지 사이에 집이 끼어 있는지 (pad: 집 상자를 얼마나 넓혀 볼지, top: 지붕 높이로 칠 높이)
function houseBlocks(x, y, z, pad, top) {
  const H = HOUSE;
  const ox = camera.position.x,
    oy = camera.position.y,
    oz = camera.position.z;
  let t0 = 0,
    t1 = 1;
  for (const [o, d, a, b] of [
    [ox, x - ox, H.x - HW / 2 - pad, H.x + HW / 2 + pad],
    [oy, y - oy, 0, top],
    [oz, z - oz, H.z - HD / 2 - pad, H.z + HD / 2 + pad]
  ]) {
    if (Math.abs(d) < 1e-9) {
      if (o < a || o > b) return false;
      continue;
    }
    let u = (a - o) / d,
      v = (b - o) / d;
    if (u > v) {
      const w = u;
      u = v;
      v = w;
    }
    if (u > t0) t0 = u;
    if (v < t1) t1 = v;
    if (t0 > t1) return false;
  }
  return true;
}
// 집 뒤 사람의 말풍선이 지붕 위에 뜨지 않게 (집이 반투명해졌을 때는 그대로 보여 줌)
function houseHides(x, y, z) {
  const H = HOUSE;
  return H.on && H.group.visible && H.fade >= 0.6 && houseBlocks(x, y, z, -0.1, HH + ROOF_UP * 0.6);
}

function houseNear(x, z, m) {
  const H = HOUSE;
  return H.on && Math.abs(x - H.x) < HW / 2 + m && Math.abs(z - H.z) < HD / 2 + m;
}
// 벽에 막힌 사람은 막힌 면을 따라 쫓는 사람이 있는 쪽 모서리로 돌아간다 (모서리에 닿으면 다시 곧장)
function houseSlide(p, hx, hz) {
  const n = houseCollide(p, 0.3);
  if (!n) return;
  const vn = p.vx * n.x + p.vz * n.z;
  if (vn < 0) {
    p.vx -= vn * n.x;
    p.vz -= vn * n.z;
  }
  if (!p.wallC || G.t - p.wallT > 1.0) {
    const H = HOUSE,
      m = 0.75,
      x0 = H.x - HW / 2 - m,
      x1 = H.x + HW / 2 + m,
      z0 = H.z - HD / 2 - m,
      z1 = H.z + HD / 2 + m;
    if (Math.abs(n.z) >= Math.abs(n.x)) { // 앞뒤 면: 좌우 모서리 중 쫓는 사람 쪽
      const side = Math.abs(hx - H.x) > 0.5 ? hx - H.x : p.x - H.x;
      p.wallC = [side < 0 ? x0 : x1, n.z < 0 ? z0 : z1];
    } else { // 옆면: 앞뒤 모서리 중 쫓는 사람 쪽
      const side = Math.abs(hz - H.z) > 0.5 ? hz - H.z : p.z - H.z;
      p.wallC = [n.x < 0 ? x0 : x1, side < 0 ? z0 : z1];
    }
  }
  p.wallT = G.t;
}

let CAMX = 0;

// ───────────────────────── 게임 상태 ─────────────────────────
const G = {
  state: 'title',
  t: 0,
  playT: 0,
  ctrl: false,
  paused: false,
  kills: 0,
  spawnAcc: 0,
  groupAcc: 0,
  spawnDone: false,
  ringT: 134,
  danger: 0,
  freeze: false,
  burst: null,
  firing: false,
  fireCD: 0,
  lastShotT: -9,
  modRepelT: 0,
  stick: {
    x: 0,
    z: 0
  },
  keys: {
    x: 0,
    z: 0
  },
  input: {
    x: 0,
    z: 0
  },
  movedOnce: false,
  firedOnce: false,
  stabbedOnce: false,
  allyNext: 0,
  allyT: 14,
  allyKills: 0,
  trapped: null,
  helped: 0,
};
const GAME_MOD = {
  infiniteAmmo: false,
  noRecoil: false,
  aimbot: false,
  auto: false,
  noclip: false,
  allPowers: false,
  silencer: false
};
const ME = {
  x: 0,
  z: 0,
  vx: 0,
  vz: 0,
  speed: 4.2,
  phase: 0,
  walk: 0,
  pose: new Float32Array(NPOSE),
  tgt: new Float32Array(NPOSE),
  aim: [0, 0],
  aimPt: [new THREE.Vector3(), new THREE.Vector3()],
  lastShot: [-9, -9],
  recoil: [0, 0],
  spineYaw: 0,
  stab: null,
  clingers: [],
  muzzle: [new THREE.Vector3(), new THREE.Vector3()],
  slotOcc: null,
  five: null,
  turn: 0,
  turnTo: 0,
};
const SLOTS = [{
  x: 0.0,
  z: -0.37,
  kind: 'stand'
},
{
  x: 0.31,
  z: 0.13,
  kind: 'kneel'
},
{
  x: -0.31,
  z: 0.13,
  kind: 'kneel'
},
{
  x: 0.56,
  z: -0.08,
  kind: 'side'
},
{
  x: -0.56,
  z: -0.08,
  kind: 'side'
},
{
  x: 0.34,
  z: -0.34,
  kind: 'stand'
},
{
  x: -0.34,
  z: -0.34,
  kind: 'stand'
},
{
  x: 0.0,
  z: 0.5,
  kind: 'low'
},
];
ME.slotOcc = new Array(SLOTS.length).fill(null);
const SPEED_MUL = [1, 0.62, 0.43, 0.29, 0.19, 0.12, 0.08, 0.05, 0.04];
const MAX_ALIVE = 58; // 동료가 늘면 maxAlive()가 늘린다
const RANGE = 7.6;
const WAVES = [{
  t0: 0,
  t1: 14,
  every: 1.3,
  run: 0.12,
  north: 0.68
},
{
  t0: 14,
  t1: 40,
  every: 0.95,
  run: 0.48,
  north: 0.58
},
{
  t0: 40,
  t1: 85,
  every: 0.78,
  run: 0.65,
  north: 0.48
},
{
  t0: 85,
  t1: 130,
  every: 0.66,
  run: 0.76,
  north: 0.40
},
];
// 사방에서 한꺼번에 둘러싸는 물결 (시각, 인원). 그 뒤로는 12초마다 점점 크게
const RINGS = [
  [14, 18],
  [26, 20],
  [38, 22],
  [50, 24],
  [62, 26],
  [74, 28],
  [86, 30],
  [98, 32],
  [110, 34],
  [122, 36]
];
// 끝이 없다: 130초 뒤로는 조금씩 더 빠르고, 더 자주, 화면 밖(아래·옆)에서도 더 많이 온다. 결국은 붙잡힌다
const OVER_T = 130;

function overT() {
  return Math.max(0, G.playT - OVER_T);
}
const F_KEYS = ['f_F1', 'f_F2', 'f_F3', 'f_F4', 'f_F5', 'f_M2', 'f_M3', 'f_M4', 'f_M5'];
const G_KEYS = ['g_F1', 'g_F3', 'g_F5', 'g_M2', 'g_M4'];
const N_KEYS = ['n_F2', 'n_M3', 'n_F4', 'n_M4'];
const MAXV = 6;

const persons = []; // 움직이는 묶음의 인스턴스 번호 = 배열 번호
const live = []; // 아직 정지하지 않은 사람 (죽는 중 포함)
let aliveCount = 0;
const CROWD_SOCIAL = {
  pairs: [],
  scanT: 0.5
};

// ───────────────────────── 사람 만들기 ─────────────────────────
function newPerson(x, z, opt = {}) {
  const i = allocAlive();
  if (i < 0) return null;
  const kind = opt.kind || 0;
  const female = Math.random() < 0.5;
  const p = {
    i,
    x,
    z,
    vx: 0,
    vz: 0,
    yaw: opt.yaw === undefined ? rand(0, TAU) : opt.yaw,
    state: opt.state || 'chase',
    kind,
    idle: opt.idle || 0,
    playerFocus: kind === 1 && Math.random() < 0.72,
    speed: (kind === 1 ? rand(3.9, 4.5) : rand(1.45, 2.0)) * (1 + Math.min(0.35, overT() * 0.006)),
    spd: 0,
    phase: rand(0, TAU),
    seed: rand(0, 100),
    pose: new Float32Array(NPOSE),
    tgt: new Float32Array(NPOSE),
    tmp: new Float32Array(NPOSE),
    reach: 0,
    rise: 0,
    look: 0,
    noticeT: -1,
    faceSet: -1,
    speakCD: rand(0.4, 2.6),
    pleaCD: 0,
    vo: null,
    bubble: null,
    voiceKey: kind === 1 ? pick(G_KEYS) : pick(F_KEYS),
    vrate: rand(0.93, 1.07),
    slot: -1,
    clingT: 0,
    cx0: 0,
    cz0: 0,
    host: opt.host || ME,
    hostT: rand(0, 0.5),
    fly: 0,
    dieT: 0,
    fallT: 0.5,
    back: true,
    fallRoll: 0,
    kbx: 0,
    kbz: 0,
    spin: 0,
    corpse: null,
    landed: false,
    how: '',
    tearT: rand(0, 0.5),
    eyeFlip: 0,
    social: null,
    socialCD: rand(1.2, 3.8),
    socialFriend: null,
    socialReturn: 0,
    socialPlea: false,
    hx: x,
    hy: 1.4,
    hz: z,
    tx: x,
    ty: 0.8,
    tz: z,
    e1x: x,
    e1y: 1.2,
    e1z: z,
    e2x: x,
    e2y: 1.2,
    e2z: z,
  };
  if (HOUSE.on && p.state !== 'cling') houseCollide(p, 0.4);
  if (kind === 0) p.voiceKey = pick(female ? ['f_F1', 'f_F2', 'f_F3', 'f_F4', 'f_F5'] : ['f_M2', 'f_M3', 'f_M4', 'f_M5']);
  if (opt.slot !== undefined) {
    p.slot = opt.slot;
    p.clingT = 1;
    p.cx0 = SLOTS[opt.slot].x;
    p.cz0 = SLOTS[opt.slot].z;
  }
  persons[i] = p;
  setCrowdColors(i, {
    shirt: pick(CROWD_COLORS.shirt),
    pants: pick(CROWD_COLORS.pants),
    shoe: pick(CROWD_COLORS.shoe),
    hair: pick(CROWD_COLORS.hair),
    skin: pick(CROWD_COLORS.skin)
  });
  setFace(p, p.state === 'cling' ? 2 : 0);
  computePose(p, 0, p.pose);
  live.push(p);
  aliveCount++;
  return p;
}

function setFace(p, f) {
  if (p.faceSet === f) return;
  p.faceSet = f;
  CA.aFace.setXY(p.i, FACE_OFF[f][0], FACE_OFF[f][1]);
  CA.aFace.needsUpdate = true;
}

function shootable(p) {
  return p.state === 'chase' || p.state === 'press' || p.state === 'rise' || p.state === 'idle' || (p.state === 'cling' && p.host !== ME);
}
// 몰려드는 대상: 가장 가까운 정신건강한 사람 (0급을 조금 더 좋아함)
function hostActive(h) {
  return h === ME || (!!h && (h.state === 'trapped' || h.state === 'freed' || h.state === 'five' || h.state === 'fight'));
}

function pickHost(p) {
  // 일부 러너는 친구들에게 시선을 빼앗기지 않고 0급인 나를 끝까지 좇는다.
  if (p.playerFocus) return ME;
  let best = ME,
    bd = Math.hypot(ME.x - p.x, ME.z - p.z) * 0.75;
  for (const a of ALLIES) {
    if (!hostActive(a)) continue;
    const d = Math.hypot(a.x - p.x, a.z - p.z);
    if (d < bd) {
      bd = d;
      best = a;
    }
  }
  const cur = p.host;
  if (cur && cur !== best && hostActive(cur)) {
    const dc = Math.hypot(cur.x - p.x, cur.z - p.z) * (cur === ME ? 0.75 : 1);
    if (dc < bd * 1.2) return cur;
  }
  return best;
}

// ───────────────────────── 포즈 ─────────────────────────
function lookAtMe(p, o, w) {
  const H = p.state === 'idle' || p.state === 'rise' ? ME : (p.host || ME);
  const dx = H.x - p.x,
    dz = H.z - p.z,
    dist = Math.hypot(dx, dz) || 0.001;
  const headY = p.state === 'idle' ? 0.9 : 1.2;
  const rel = wrapAngle(Math.atan2(dx, dz) - p.yaw - o[P.SY]);
  const hw = THREE.MathUtils.clamp(rel, -1.15, 1.15);
  const pitch = -Math.atan2(1.38 - headY, dist) - 0.12 - o[P.SX];
  o[P.HW] = THREE.MathUtils.lerp(o[P.HW], hw, w);
  o[P.HX] = THREE.MathUtils.lerp(o[P.HX], THREE.MathUtils.clamp(pitch, -1.0, 0.8), w);
}

function poseIdle(p, t, o) {
  o.fill(0);
  o[P.HY] = C.HIP_Y;
  const hic = Math.pow(Math.max(0, Math.sin(t * 5.1 + p.seed * 3)), 3);
  const side = (p.seed % 2) < 1 ? 1 : -1;
  if (p.idle === 0) {
    o[P.HY] = C.HIP_Y - 0.012;
    o[P.SX] = 0.4 + hic * 0.07;
    o[P.HX] = 0.6 + hic * 0.1;
    o[P.HZ] = side * 0.14;
    o[P.LSX] = -0.3;
    o[P.RSX] = -0.3;
    o[P.LSZ] = 0.04;
    o[P.RSZ] = -0.04;
    o[P.LEX] = -0.15;
    o[P.REX] = -0.15;
    o[P.LHX] = -0.05;
    o[P.RHX] = -0.05;
    o[P.LKX] = 0.1;
    o[P.RKX] = 0.1;
  } else if (p.idle === 1) {
    o[P.HY] = 0.15;
    o[P.RP] = -0.1;
    o[P.LHX] = -1.95;
    o[P.RHX] = -1.95;
    o[P.LHZ] = 0.1;
    o[P.RHZ] = -0.1;
    o[P.LKX] = 2.5;
    o[P.RKX] = 2.5;
    o[P.SX] = 0.66 + hic * 0.06;
    o[P.HX] = 0.7;
    o[P.HZ] = side * 0.18;
    o[P.LSX] = -0.95;
    o[P.RSX] = -0.95;
    o[P.LSY] = -0.35;
    o[P.RSY] = 0.35;
    o[P.LEX] = -0.5;
    o[P.REX] = -0.5;
    o[P.LEZ] = -0.75;
    o[P.REZ] = 0.75;
  } else {
    o[P.HY] = 0.24;
    o[P.LHX] = -1.7;
    o[P.RHX] = -1.7;
    o[P.LHZ] = 0.28;
    o[P.RHZ] = -0.28;
    o[P.LKX] = 2.45;
    o[P.RKX] = 2.45;
    o[P.SX] = 0.72 + hic * 0.06;
    o[P.HX] = 0.5;
    o[P.LSX] = -1.3;
    o[P.RSX] = -1.3;
    o[P.LSY] = -0.3;
    o[P.RSY] = 0.3;
    o[P.LEX] = -1.95;
    o[P.REX] = -1.95;
  }
  if (p.look > 0) lookAtMe(p, o, p.look);
}

function poseChase(p, t, o) {
  o.fill(0);
  const run = p.kind === 1 && p.state === 'chase';
  const s = Math.sin(p.phase), c = Math.cos(p.phase);
  const g = THREE.MathUtils.clamp(p.spd / (run ? 2.8 : 1.3), 0, 1.15);
  const amp = (run ? 0.85 : 0.44) * g;
  const hic = Math.pow(Math.max(0, Math.sin(t * 5 + p.seed * 3)), 4);
  o[P.HY] = C.HIP_Y - Math.abs(c) * (run ? 0.045 : 0.02) * g - (run ? 0.035 : 0.012);
  o[P.RR] = s * (run ? 0.05 : 0.035) * g;
  o[P.SX] = (run ? 0.48 : 0.3) + hic * 0.06;
  o[P.SY] = -s * (run ? 0.16 : 0.07) * g;
  o[P.LHX] = -s * amp;
  o[P.RHX] = s * amp;
  o[P.LKX] = Math.max(0, c) * amp * 1.25 + 0.06;
  o[P.RKX] = Math.max(0, -c) * amp * 1.25 + 0.06;
  o[P.LHZ] = 0.03;
  o[P.RHZ] = -0.03;
  const tr = Math.sin(t * 13 + p.seed) * 0.05;
  if (run) {
    o[P.LSX] = -1.75 + Math.sin(p.phase) * 0.35;
    o[P.RSX] = -1.75 - Math.sin(p.phase) * 0.35;
    o[P.LSZ] = 0.22;
    o[P.RSZ] = -0.22;
    o[P.LEX] = -0.35;
    o[P.REX] = -0.35;
  } else {
    const r = p.reach,
      hang = -o[P.SX] + 0.1,
      sw = s * 0.2 * g;
    o[P.LSX] = THREE.MathUtils.lerp(hang + sw, -1.72 + tr, r);
    o[P.RSX] = THREE.MathUtils.lerp(hang - sw, -1.66 - tr, r);
    o[P.LSZ] = THREE.MathUtils.lerp(0.05, 0.13, r);
    o[P.RSZ] = -o[P.LSZ];
    o[P.LSY] = THREE.MathUtils.lerp(0, -0.12, r);
    o[P.RSY] = -o[P.LSY];
    o[P.LEX] = THREE.MathUtils.lerp(-0.12, -0.28, r);
    o[P.REX] = o[P.LEX];
  }
  lookAtMe(p, o, 1);
}

function poseCling(p, t, o) {
  o.fill(0);
  const s = SLOTS[p.slot];
  const br = Math.sin(t * 2.8 + p.seed) * 0.025;
  const side = (p.seed % 2) < 1 ? 1 : -1;
  if (s.kind === 'low') {
    // 발치에 엎드려 다리를 끌어안음
    o[P.HY] = 0.27;
    o[P.LHX] = -0.55;
    o[P.RHX] = -0.55;
    o[P.LKX] = 2.1;
    o[P.RKX] = 2.1;
    o[P.LHZ] = 0.14;
    o[P.RHZ] = -0.14;
    o[P.SX] = 0.95 + br;
    o[P.LSX] = -1.0;
    o[P.RSX] = -1.0;
    o[P.LSY] = -0.55;
    o[P.RSY] = 0.55;
    o[P.LEZ] = -1.0;
    o[P.REZ] = 1.0;
    o[P.LEX] = -0.3;
    o[P.REX] = -0.3;
    o[P.HX] = -0.45;
    o[P.HZ] = side * 0.5;
    o[P.HW] = side * 0.35;
  } else if (s.kind === 'kneel') {
    o[P.HY] = 0.31;
    o[P.LHX] = -0.12;
    o[P.RHX] = -0.12;
    o[P.LKX] = 1.62;
    o[P.RKX] = 1.62;
    o[P.LHZ] = 0.1;
    o[P.RHZ] = -0.1;
    o[P.SX] = 0.3 + br;
    o[P.LSX] = -1.3;
    o[P.RSX] = -1.3;
    o[P.LSY] = -0.6;
    o[P.RSY] = 0.6;
    o[P.LEZ] = -1.0;
    o[P.REZ] = 1.0;
    o[P.LEX] = -0.2;
    o[P.REX] = -0.2;
    o[P.HX] = -0.15;
    o[P.HZ] = side * 0.4;
    o[P.HW] = side * 0.25;
  } else if (s.kind === 'side') {
    // 옆에서 허리를 끌어안고 팔에 얼굴을 묻음 (머리가 주인공 얼굴을 가리지 않게 낮춤)
    o[P.HY] = C.HIP_Y - 0.19;
    o[P.LHX] = -0.85;
    o[P.RHX] = -0.85;
    o[P.LKX] = 1.35;
    o[P.RKX] = 1.35;
    o[P.SX] = 0.62 + br;
    o[P.LSX] = -1.2;
    o[P.RSX] = -1.2;
    o[P.LSY] = -0.5;
    o[P.RSY] = 0.5;
    o[P.LEZ] = -1.1;
    o[P.REZ] = 1.1;
    o[P.LEX] = -0.2;
    o[P.REX] = -0.2;
    o[P.HX] = -0.25;
    o[P.HZ] = side * 0.35;
    o[P.HW] = side * 0.2;
  } else {
    o[P.HY] = C.HIP_Y - 0.03;
    o[P.SX] = 0.14 + br;
    o[P.LKX] = 0.12;
    o[P.RKX] = 0.12;
    o[P.LHX] = -0.06;
    o[P.RHX] = -0.06;
    o[P.LSX] = -1.45;
    o[P.RSX] = -1.45;
    o[P.LSY] = -0.55;
    o[P.RSY] = 0.55;
    o[P.LEZ] = -1.15;
    o[P.REZ] = 1.15;
    o[P.LEX] = -0.15;
    o[P.REX] = -0.15;
    o[P.HX] = 0.05;
    o[P.HZ] = side * 0.45;
    o[P.HW] = side * 0.3;
  }
}

function makeCorpse(back) {
  const o = new Float32Array(NPOSE);
  o[P.HY] = C.HIP_Y;
  o[P.LSZ] = rand(0.7, 1.6);
  o[P.RSZ] = -rand(0.7, 1.6);
  o[P.LSX] = rand(-0.5, 0.3);
  o[P.RSX] = rand(-0.5, 0.3);
  o[P.LEX] = rand(-0.9, 0);
  o[P.REX] = rand(-0.9, 0);
  o[P.LHX] = rand(-0.7, 0.05);
  o[P.RHX] = rand(-0.5, 0.1);
  o[P.LKX] = rand(0, 1.1);
  o[P.RKX] = rand(0, 0.7);
  o[P.LHZ] = rand(0, 0.35);
  o[P.RHZ] = -rand(0, 0.35);
  o[P.HW] = rand(-0.9, 0.9);
  o[P.HX] = back ? 0.5 : -0.5;
  o[P.HZ] = rand(-0.3, 0.3);
  o[P.SZ] = rand(-0.2, 0.2);
  return o;
}

function poseDying(p, o) {
  o.set(p.corpse);
  const k = THREE.MathUtils.clamp(p.dieT / p.fallT, 0, 1);
  let a = easeInQuad(k) * Math.PI / 2;
  if (p.dieT > p.fallT) {
    const x = p.dieT - p.fallT;
    a = Math.PI / 2 - 0.09 * Math.exp(-x * 9) * Math.abs(Math.sin(x * 24));
  }
  const sgn = p.back ? -1 : 1;
  o[P.RP] = sgn * a;
  o[P.RR] = p.fallRoll * easeOutCubic(k);
  o[P.LIFT] = 0.12 * easeInQuad(k) + (p.fly ? p.fly * Math.sin(k * Math.PI) : 0);
  const fl = Math.sin(k * Math.PI);
  o[P.LSX] += -1.3 * fl;
  o[P.RSX] += -1.1 * fl;
  o[P.HX] += (p.back ? -0.6 : 0.5) * fl;
  if (p.how === 'stab') o[P.HY] = THREE.MathUtils.lerp(C.HIP_Y, C.HIP_Y - 0.15, fl);
}

function computePose(p, t, o) {
  switch (p.state) {
    case 'idle':
      poseIdle(p, t, o);
      break;
    case 'rise': {
      poseIdle(p, t, p.tmp);
      poseChase(p, t, o);
      const k = easeInOutSine(p.rise);
      for (let i = 0; i < NPOSE; i++) o[i] = THREE.MathUtils.lerp(p.tmp[i], o[i], k);
      break;
    }
    case 'chase':
    case 'press':
      poseChase(p, t, o);
      break;
    case 'cling': {
      poseCling(p, t, o);
      if (p.clingT < 0.25) {
        poseChase(p, t, p.tmp);
        const k = easeOutCubic(p.clingT / 0.25);
        for (let i = 0; i < NPOSE; i++) o[i] = THREE.MathUtils.lerp(p.tmp[i], o[i], k);
      }
      break;
    }
    case 'dying':
    case 'dead':
      poseDying(p, o);
      break;
    case 'poster':
      posePoster(p, t, o);
      break;
    default:
      poseChase(p, t, o);
  }
  if (p.state !== 'dying' && p.state !== 'dead' && p.state !== 'poster') {
    const shake = p.state === 'cling' ? 0.24 : 0.045;
    o[P.HW] += Math.sin(t * (p.state === 'cling' ? 19 : 13) + p.seed * 2.7) * shake;
  }
  crowdSocialPose(p, o);
}
const DIRECT = [P.RP, P.RR, P.LIFT];

function animatePerson(p, dt) {
  computePose(p, G.t, p.tgt);
  const rate = p.state === 'dying' ? 16 : 20;
  for (let i = 0; i < NPOSE; i++) p.pose[i] = approach(p.pose[i], p.tgt[i], rate, dt);
  for (const i of DIRECT) p.pose[i] = p.tgt[i];
  writeCrowdInstance(p);
}

// ───────────────────────── 군중 움직임 ─────────────────────────
function crowdSim(dt) {
  G.modRepelT = Math.max(0, G.modRepelT - dt);
  crowdSocialTick(dt);
  const n = live.length;
  for (let a = 0; a < n; a++) {
    const p = live[a];
    if (p.state === 'poster') {
      tearTick(p, dt, Math.hypot(p.x - ME.x, p.z - ME.z));
      continue;
    }
    // 친구 알림을 구경하는 1초: 걷던 사람만 멈추며, 붙잡은 몸은 계속 숙주를 따른다.
    if (p.socialFriend && socialCrowdActive(p) && p.state !== 'cling') {
      p.vx = p.vz = p.spd = 0;
      continue;
    }
    if (p.state === 'idle') {
      if (p.noticeT >= 0 && G.playT >= p.noticeT && G.state === 'play') {
        p.state = 'rise';
        p.rise = 0;
      }
      if (p.look > 0) {
        const want = Math.atan2(ME.x - p.x, ME.z - p.z);
        if (Math.abs(wrapAngle(want - p.yaw)) > 1.2) p.yaw = angleApproach(p.yaw, want, 1.2 * p.look, dt);
      }
      continue;
    }
    if (p.state === 'rise') {
      p.rise += dt / 0.65;
      p.look = 1;
      p.yaw = angleApproach(p.yaw, Math.atan2(ME.x - p.x, ME.z - p.z), 5, dt);
      if (p.rise >= 1) {
        p.rise = 1;
        p.state = 'chase';
      }
      continue;
    }
    if (p.state === 'chase' || p.state === 'press') {
      p.hostT -= dt;
      if (p.hostT <= 0 || !hostActive(p.host)) {
        p.hostT = rand(0.35, 0.7);
        p.host = pickHost(p);
      }
      const H = p.host;
      const dx = H.x - p.x,
        dz = H.z - p.z,
        d = Math.hypot(dx, dz) || 0.001;
      let ux = dx / d,
        uz = dz / d;
      if (G.modRepelT > 0) {
        const ax = p.x - ME.x,
          az = p.z - ME.z,
          al = Math.hypot(ax, az) || 1;
        ux = ax / al;
        uz = az / al;
      }
      // 집 벽에 막혔으면 정해 둔 모서리 쪽으로 돌아간다
      if (p.wallC) {
        const cx = p.wallC[0] - p.x,
          cz = p.wallC[1] - p.z,
          cl = Math.hypot(cx, cz);
        if (G.t - p.wallT > 0.6 || cl < 0.25) p.wallC = null;
        else {
          ux = cx / cl;
          uz = cz / cl;
        }
      }
      let sx = 0,
        sz = 0;
      for (let b = 0; b < n; b++) {
        if (b === a) continue;
        const q = live[b];
        if (q.state === 'dying' || q.state === 'idle') continue;
        const ex = p.x - q.x,
          ez = p.z - q.z,
          e2 = ex * ex + ez * ez;
        if (e2 < 0.52 && e2 > 1e-6) {
          const e = Math.sqrt(e2),
            f = (0.72 - e) / 0.72;
          sx += ex / e * f;
          sz += ez / e * f;
        }
      }
      // 나를 지키는 친구들은 몸으로 길을 막음
      for (const g of ALLIES) {
        if (g === H || (g.state !== 'fight' && g.state !== 'five' && g.state !== 'freed')) continue;
        const ex = p.x - g.x,
          ez = p.z - g.z,
          e2 = ex * ex + ez * ez;
        if (e2 < 0.6 && e2 > 1e-6) {
          const e = Math.sqrt(e2),
            f = (0.78 - e) / 0.78;
          sx += ex / e * f * 1.6;
          sz += ez / e * f * 1.6;
        }
      }
      const sp = G.freeze ? 0 : p.speed * (p.state === 'press' ? 0.35 : 1);
      let wx = ux * sp + sx * 2.4,
        wz = uz * sp + sz * 2.4;
      const keep = 0.92;
      if (d < keep) {
        wx -= ux * (keep - d) * 8;
        wz -= uz * (keep - d) * 8;
      }
      p.vx = approach(p.vx, wx, 6, dt);
      p.vz = approach(p.vz, wz, 6, dt);
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      if (HOUSE.on) houseSlide(p, H.x, H.z);
      p.spd = Math.hypot(p.vx, p.vz);
      p.phase += p.spd * dt / (p.kind === 1 ? 0.9 : 0.5) * Math.PI;
      if (p.state === 'press') p.phase += dt * 3;
      p.yaw = angleApproach(p.yaw, Math.atan2(dx, dz), 7, dt);
      p.reach = approach(p.reach, d < 3.3 ? 1 : 0, 4, dt);
      if (d < 1.2 && G.state === 'play') tryCling(p, H);
      const dm = H === ME ? d : Math.hypot(ME.x - p.x, ME.z - p.z);
      speechTick(p, dt, dm);
      tearTick(p, dt, dm);
      continue;
    }
    if (p.state === 'cling') {
      p.clingT += dt;
      const H = p.host,
        s = SLOTS[p.slot],
        k = easeOutCubic(p.clingT / 0.22);
      p.x = H.x + THREE.MathUtils.lerp(p.cx0, s.x, k);
      p.z = H.z + THREE.MathUtils.lerp(p.cz0, s.z, k);
      if (HOUSE.on) houseCollide(p, 0.22);
      p.yaw = angleApproach(p.yaw, Math.atan2(-s.x, -s.z), 14, dt);
      speechTick(p, dt, H === ME ? 0.5 : Math.hypot(ME.x - p.x, ME.z - p.z));
      continue;
    }
    if (p.state === 'dying') {
      p.dieT += dt;
      p.x += p.kbx * dt;
      p.z += p.kbz * dt;
      if (HOUSE.on) {
        const n = houseCollide(p, 0.3);
        if (n) {
          const vn = p.kbx * n.x + p.kbz * n.z;
          if (vn < 0) {
            p.kbx -= vn * n.x * 1.5;
            p.kbz -= vn * n.z * 1.5;
          }
        }
      }
      const damp = Math.exp(-5.5 * dt);
      p.kbx *= damp;
      p.kbz *= damp;
      p.yaw += p.spin * dt * Math.max(0, 1 - p.dieT / p.fallT);
      if (!p.landed && p.dieT >= p.fallT) {
        p.landed = true;
        // 멀리서 쓰러지는 소리는 생략 (소리 엔진 부담)
        if (!p.quiet && Math.hypot(p.x - ME.x, p.z - ME.z) < 12) {
          const pan = screenPan(p.x, p.z);
          sfxFall(0.8, pan);
          if (Math.random() < 0.4) sfxSplat(0.6, pan);
        }
        p.poolPending = p.quiet ? -1 : 0.05;
      }
      if (p.poolPending !== undefined && p.poolPending >= 0) {
        p.poolPending -= dt;
        if (p.poolPending < 0) {
          p.poolPending = -1;
          addDecal(p.tx, p.tz, rand(0.95, 1.5), 3, rand(0, TAU), rand(1.6, 2.6));
        }
      }
      if (p.dieT > p.fallT + 0.9) {
        p.state = 'dead';
      }
    }
  }
  // 정지한 시체는 목록에서 빼기
  for (let a = live.length - 1; a >= 0; a--) {
    const p = live[a];
    if (p.state === 'dead') {
      // 마지막 자세를 시체 묶음으로 옮기고 자리를 비움
      animatePerson(p, 1);
      addCorpse(p.i);
      freeAlive(p.i);
      persons[p.i] = null;
      live.splice(a, 1);
    }
  }
}

function tryCling(p, H) {
  H = H || ME;
  // 하이파이브 중인 동료에게는 매달리지 않음 (손이 가려짐)
  if (H.state === 'five') {
    p.state = 'press';
    return;
  }
  let best = -1,
    bd = 1e9;
  for (let s = 0; s < SLOTS.length; s++) {
    if (H.slotOcc[s]) continue;
    const sx = H.x + SLOTS[s].x,
      sz = H.z + SLOTS[s].z,
      d = (sx - p.x) ** 2 + (sz - p.z) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  if (best < 0) {
    p.state = 'press';
    return;
  }
  H.slotOcc[best] = p;
  p.slot = best;
  p.host = H;
  p.state = 'cling';
  p.clingT = 0;
  p.cx0 = p.x - H.x;
  p.cz0 = p.z - H.z;
  H.clingers.push(p);
  setFace(p, 2);
  if (p.vo && !p.vo.stopped) p.vo.stop(0.1);
  if (p.bubble) fadeBubble(p.bubble);
  p.speakCD = rand(0.6, 1.6);
  if (H === ME) {
    sfxGrab(screenPan(p.x, p.z));
    CAM.shake = Math.max(CAM.shake, 0.05);
    if (!G.stabbedOnce) $('weapon').classList.add('pulse');
  } else {
    const dm = Math.hypot(ME.x - p.x, ME.z - p.z);
    if (dm < 12) sfxGrab(screenPan(p.x, p.z), THREE.MathUtils.clamp(1.1 - dm * 0.08, 0.2, 0.7));
  }
}

function speechTick(p, dt, d) {
  if (socialQuiet(p)) {
    setFace(p, 4);
    return;
  }
  if (p.state === 'cling' && p.faceSet === 4) setFace(p, 2);
  // 말하는 동안 입 모양
  if (p.state !== 'cling') {
    const talking = p.vo && !p.vo.stopped;
    setFace(p, talking && Math.sin(G.t * 19 + p.seed) > -0.2 ? 1 : 0);
  }
  if (G.freeze) return;
  pleaBubbleTick(p, dt, d);
  p.speakCD -= dt;
  if (p.speakCD > 0) return;
  const cling = p.state === 'cling',
    mine = p.host === ME;
  p.speakCD = cling ? rand(2.4, 4.8) : rand(1.5, 4.0) * (d > 7 ? 1.5 : 1);
  if (p.vo && !p.vo.stopped) return;
  if (d > 14 || voicesPlaying() >= MAXV) return;
  const vol = cling && mine ? 0.5 : THREE.MathUtils.clamp(1.2 - d * 0.075, 0.28, 1) * (cling ? 0.7 : 1);
  const pan = screenPan(p.x, p.z);
  const key = cling ? p.voiceKey.replace(/^g_/, 'f_') : p.voiceKey;
  const h = playVoice(VO[key] ? key : p.voiceKey, {
    rate: p.vrate * (cling ? 0.96 : 1),
    gain: vol,
    pan,
    sob: cling ? 0.012 : 0.028,
    lp: cling && mine ? 2600 : (d > 8 ? 2200 : 0)
  });
  if (!h) return;
  p.vo = h;
  if (p.bubble && p.bubble.plea && !p.bubble.ending && p.bubble.t < 0.05) {
    p.bubble.voice = h;
    p.bubble.dur = h.dur;
  }
  p.socialPlea = false;
}

function tearTick(p, dt, d) {
  if (d > 16 || socialQuiet(p)) return;
  p.tearT -= dt;
  if (p.tearT > 0) return;
  p.tearT = rand(0.25, 0.55);
  p.eyeFlip ^= 1;
  // 눈 바깥쪽 볼을 타고 옆으로 떨어짐
  const cx = Math.cos(p.yaw) * 0.6,
    cz = -Math.sin(p.yaw) * 0.6,
    s = p.eyeFlip ? -1 : 1;
  if (p.eyeFlip) addTear(p.e1x, p.e1y, p.e1z, s * cx + p.vx * 0.9, s * cz + p.vz * 0.9, p);
  else addTear(p.e2x, p.e2y, p.e2z, s * cx + p.vx * 0.9, s * cz + p.vz * 0.9, p);
}

// 외로운 사람들은 서로를 잠깐 살핀 뒤 동시에 외면하고, 건강한 사람에게 다시 운다.
function socialCrowdActive(p) {
  return p.state === 'chase' || p.state === 'press' || p.state === 'rise' || p.state === 'cling';
}

function socialQuiet(p) {
  return socialCrowdActive(p) && (!!p.socialFriend || (!!p.social && p.social.t < 1.6));
}

function hushSocialPerson(p) {
  if (p.vo && !p.vo.stopped) p.vo.stop(0.035);
  p.vo = null;
  if (p.bubble) removeBubble(p.bubble);
  setFace(p, 4);
  for (let i = 0; i < TEAR_MAX; i++) {
    const d = tearS[i];
    if (d.on && d.owner === p) {
      d.on = false;
      tears.setMatrixAt(i, _zeroM);
    }
  }
  tears.instanceMatrix.needsUpdate = true;
}

function resumeSocialPerson(p, plea) {
  if (!socialCrowdActive(p)) return;
  setFace(p, p.state === 'cling' ? 2 : 0);
  p.tearT = 0;
  p.speakCD = plea ? rand(0.02, 0.15) : rand(0.18, 0.7);
  p.socialReturn = 0.65;
  p.socialPlea = plea;
}

function beginSocialPair(a, b) {
  const pair = {
    a,
    b,
    t: 0,
    signA: wrapAngle(Math.atan2(b.x - a.x, b.z - a.z) - a.yaw) >= 0 ? 1 : -1,
    signB: wrapAngle(Math.atan2(a.x - b.x, a.z - b.z) - b.yaw) >= 0 ? 1 : -1
  };
  a.social = b.social = pair;
  a.socialCD = b.socialCD = rand(7, 11);
  hushSocialPerson(a);
  hushSocialPerson(b);
  CROWD_SOCIAL.pairs.push(pair);
  return pair;
}

function crowdSocialTick(dt) {
  for (let i = CROWD_SOCIAL.pairs.length - 1; i >= 0; i--) {
    const pair = CROWD_SOCIAL.pairs[i];
    pair.t += dt;
    if (pair.t < 2.0 && socialCrowdActive(pair.a) && socialCrowdActive(pair.b)) continue;
    for (const p of [pair.a, pair.b]) {
      if (p.social === pair) {
        p.social = null;
        if (!p.socialFriend) resumeSocialPerson(p, true);
      }
    }
    CROWD_SOCIAL.pairs.splice(i, 1);
  }
  for (const p of live) {
    p.socialReturn = Math.max(0, p.socialReturn - dt);
    if (G.state === 'play') p.socialCD = Math.max(0, p.socialCD - dt);
    if (!p.socialFriend) continue;
    p.socialFriend.t += dt;
    if (p.socialFriend.t >= 1.05 || !socialCrowdActive(p)) {
      p.socialFriend = null;
      resumeSocialPerson(p, false);
    }
  }
  if (G.state !== 'play' || G.freeze) return;
  CROWD_SOCIAL.scanT -= dt;
  if (CROWD_SOCIAL.scanT > 0 || CROWD_SOCIAL.pairs.length >= 2) return;
  CROWD_SOCIAL.scanT = rand(0.8, 1.3);
  const candidates = [];
  for (const p of live) {
    if (!socialCrowdActive(p) || p.state === 'rise' || p.social || p.socialFriend || p.socialCD > 0) continue;
    if (Math.hypot(p.x - ME.x, p.z - ME.z) > 9 || !onScreen(p.hx, p.hy, p.hz)) continue;
    candidates.push(p);
  }
  // 같은 사람에게 매달린 이웃 얼굴을 우선한다. 그다음은 걷다 서로 스치는 사람들.
  for (const attached of [true, false]) {
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      if ((a.state === 'cling') !== attached || a.social || a.socialFriend) continue;
      for (let j = i + 1; j < candidates.length; j++) {
        const b = candidates[j];
        if ((b.state === 'cling') !== attached || b.social || b.socialFriend) continue;
        if (attached && (a.host !== b.host || a.clingT < 0.3 || b.clingT < 0.3)) continue;
        const dx = a.hx - b.hx,
          dz = a.hz - b.hz;
        if (dx * dx + dz * dz > (attached ? 0.7 * 0.7 : 0.88 * 0.88) || Math.abs(a.hy - b.hy) > 0.36) continue;
        const ya = wrapAngle(Math.atan2(b.x - a.x, b.z - a.z) - a.yaw);
        const yb = wrapAngle(Math.atan2(a.x - b.x, a.z - b.z) - b.yaw);
        if (Math.abs(ya) > 1.8 || Math.abs(yb) > 1.8) continue;
        beginSocialPair(a, b);
        return;
      }
    }
  }
}

function crowdSocialPose(p, o) {
  if (!socialCrowdActive(p)) return;
  if (p.socialFriend) {
    const f = p.socialFriend,
      w = Math.min(THREE.MathUtils.clamp(f.t / 0.12, 0, 1), THREE.MathUtils.clamp((1.05 - f.t) / 0.15, 0, 1));
    const yaw = THREE.MathUtils.clamp(wrapAngle(Math.atan2(f.x - p.x, f.z - p.z) - p.yaw - o[P.SY]), -1.55, 1.55);
    const pitch = THREE.MathUtils.clamp(-Math.atan2(f.y - p.hy, Math.hypot(f.x - p.hx, f.z - p.hz) || 0.001) - o[P.SX], -0.8, 0.5);
    o[P.HW] = THREE.MathUtils.lerp(o[P.HW], yaw, w);
    o[P.HX] = THREE.MathUtils.lerp(o[P.HX], pitch, w);
    o[P.HZ] *= 1 - w;
    return;
  }
  const pair = p.social;
  if (!pair) {
    if (p.socialReturn > 0) lookAtMe(p, o, THREE.MathUtils.clamp(p.socialReturn / 0.2, 0, 1));
    return;
  }
  const other = pair.a === p ? pair.b : pair.a;
  const sign = pair.a === p ? pair.signA : pair.signB;
  const t = pair.t;
  const toward = THREE.MathUtils.clamp(wrapAngle(Math.atan2(other.x - p.x, other.z - p.z) - p.yaw - o[P.SY]), -1.45, 1.45);
  const away = -sign * 1.3;
  const turn = easeOutCubic(THREE.MathUtils.clamp((t - 1.0) / 0.2, 0, 1));
  const enter = easeOutCubic(THREE.MathUtils.clamp(t / 0.2, 0, 1));
  const back = easeInOutSine(THREE.MathUtils.clamp((t - 1.6) / 0.4, 0, 1));
  // 목만 움직인다. 상대 얼굴을 위아래로 천천히 훑고(0.25~1.0초), 두 사람은 같은 순간 고개를 홱 돌린다(1.0초). 2초에 다시 나를 본다.
  const scan = THREE.MathUtils.lerp(-0.18, 0.18, THREE.MathUtils.clamp((t - 0.25) / 0.75, 0, 1));
  if (back > 0) lookAtMe(p, o, 1);
  o[P.HW] = THREE.MathUtils.lerp(o[P.HW], THREE.MathUtils.lerp(toward, away, turn), enter * (1 - back));
  o[P.HX] = THREE.MathUtils.lerp(o[P.HX], THREE.MathUtils.lerp(scan, -0.02, turn), enter * (1 - back));
  o[P.HZ] *= 1 - enter * (1 - back);
}

function noticeFriendship() {
  if (G.state !== 'play' || G.freeze) return;
  const pt = ME.five && ME.five.pt;
  const x = pt ? pt.x : ME.x,
    y = pt ? pt.y : 1.6,
    z = pt ? pt.z : ME.z;
  // 죽는 사람과 화면 밖 인원은 건드리지 않는다. 타이머·스폰·총알·동료는 그대로 흐른다.
  for (const p of live) {
    if (!socialCrowdActive(p) || !onScreen(p.hx, p.hy, p.hz)) continue;
    if (p.social) {
      const pair = p.social;
      for (const q of [pair.a, pair.b]) {
        if (q.social === pair) {
          q.social = null;
          resumeSocialPerson(q, false);
        }
      }
      const i = CROWD_SOCIAL.pairs.indexOf(pair);
      if (i >= 0) CROWD_SOCIAL.pairs.splice(i, 1);
    }
    p.socialFriend = {
      t: 0,
      x,
      y,
      z
    };
    p.socialCD = Math.max(p.socialCD, 3);
    hushSocialPerson(p);
  }
}

// ───────────────────────── 생성 ─────────────────────────
function spawnRingPos(angle) {
  // 화면 위쪽(먼 쪽)은 하얀 안개 속에서 나타나고, 옆·아래는 화면 밖에서 들어온다
  const north = Math.max(0, Math.cos(angle));
  const r = THREE.MathUtils.lerp(10.5, 19, north * north);
  return {
    x: ME.x + Math.sin(angle) * r,
    z: ME.z - Math.cos(angle) * r
  };
}

function spawnAngle(north = 0.72) {
  // 얼굴이 보이는 쪽(화면 위쪽)에서 더 많이 온다
  return Math.random() < north ? rand(-1.9, 1.9) : rand(1.9, TAU - 1.9);
}
// 동료가 늘면 조금 더 몰려오지만, 구조 보상을 삼키는 급격한 증가는 피한다. 한 화면에 100명까지.
// 붙잡혀 손을 못 쓰는 친구는 세지 않는다 (도움도 못 주는데 사람만 더 오는 일이 없게)
function squadN() {
  let n = 0;
  for (const a of ALLIES)
    if ((a.state === 'fight' || a.state === 'five' || a.state === 'freed') && !a.pinned) n++;
  return n;
}

function maxAlive() {
  return Math.min(100, MAX_ALIVE + 12 * squadN() + overT() * 0.25);
}

function waveNow(T) {
  const w = WAVES.find((x) => T >= x.t0 && T < x.t1);
  if (w) return w;
  const o = T - OVER_T;
  return {
    every: Math.max(0.3, 0.62 - o * 0.006),
    run: Math.min(0.9, 0.78 + o * 0.003),
    north: Math.max(0.3, 0.4 - o * 0.003)
  };
}

function spawnRing(n0) {
  const n = Math.round(n0 * (1 + 0.2 * squadN())),
    a0 = rand(0, TAU); // 친구 몫만큼만 더 (친구를 구하자마자 밀리지 않게)
  const near = THREE.MathUtils.lerp(14, 11.5, Math.min(1, overT() / 45));
  for (let k = 0; k < n; k++) {
    if (aliveCount >= maxAlive()) break;
    const a = a0 + k / n * TAU + rand(-0.12, 0.12),
      r = rand(near, near + 2.5);
    const x = ME.x + Math.sin(a) * r,
      z = ME.z - Math.cos(a) * r;
    const p = newPerson(x, z, {
      kind: Math.random() < 0.78 ? 1 : 0,
      state: 'chase',
      yaw: Math.atan2(ME.x - x, ME.z - z)
    });
    if (p) p.speakCD = rand(0.5, 3);
  }
}

function recycleFarChaser(pos) {
  // 정기 단일 생성이 막힐 때만 뒤처진 추격자 한 명을 옮긴다.
  // 같은 사람의 속도·종류·외형·인원·슬롯을 보존하며, 큰 웨이브의 정원은 비우지 않는다.
  let p = null,
    far2 = 32 * 32;
  for (const q of live) {
    if (q.state !== 'chase') continue;
    const dx = q.x - ME.x,
      dz = q.z - ME.z,
      d2 = dx * dx + dz * dz;
    if (d2 <= far2 || onScreen(q.x, 1.4, q.z)) continue;
    if (q.host !== ME && hostActive(q.host) && Math.hypot(q.x - q.host.x, q.z - q.host.z) < 8) continue;
    p = q;
    far2 = d2;
  }
  if (!p) return null;
  if (p.vo && !p.vo.stopped) p.vo.stop(0.05);
  p.vo = null;
  if (p.bubble) removeBubble(p.bubble);
  const dx = pos.x - p.x,
    dz = pos.z - p.z;
  p.x = pos.x;
  p.z = pos.z;
  p.hx += dx;
  p.hz += dz;
  p.tx += dx;
  p.tz += dz;
  p.e1x += dx;
  p.e1z += dz;
  p.e2x += dx;
  p.e2z += dz;
  p.vx = p.vz = p.spd = 0;
  p.yaw = Math.atan2(ME.x - p.x, ME.z - p.z);
  p.host = ME;
  p.hostT = 0.35;
  p.speakCD = Math.max(1.5, p.speakCD);
  p.pleaCD = 0;
  return p;
}

function spawnOne(kind, angle) {
  if (aliveCount >= maxAlive()) {
    const a = angle === undefined ? spawnAngle() : angle;
    return recycleFarChaser(spawnRingPos(a));
  }
  const a = angle === undefined ? spawnAngle() : angle;
  const pos = spawnRingPos(a);
  const p = newPerson(pos.x, pos.z, {
    kind,
    state: 'chase',
    yaw: Math.atan2(ME.x - pos.x, ME.z - pos.z)
  });
  if (p) p.speakCD = rand(1.5, 4.5);
  return p;
}
// 양쪽에서 동시에 뛰어온다. 한쪽만 계속 쏘면 반대쪽이 빈틈을 파고든다.
function spawnFlanks() {
  const n = 4 + Math.floor(squadN() / 2);
  const moving = Math.hypot(ME.vx, ME.vz) > 0.4;
  const a0 = moving ? Math.atan2(ME.vx, -ME.vz) + Math.PI / 2 : rand(0, TAU);
  for (let side = 0; side < 2; side++)
    for (let j = 0; j < n; j++) {
      if (aliveCount >= maxAlive()) return;
      const a = a0 + side * Math.PI + (j - (n - 1) / 2) * 0.18 + rand(-0.05, 0.05);
      const r = rand(12, 13.5),
        x = ME.x + Math.sin(a) * r,
        z = ME.z - Math.cos(a) * r;
      const p = newPerson(x, z, {
        kind: 1,
        yaw: Math.atan2(ME.x - x, ME.z - z)
      });
      if (p) p.speakCD = rand(0.5, 2);
    }
}

function spawnUpdate(dt) {
  if (G.spawnDone) return;
  const T = G.playT;
  while (G.ringNext < RINGS.length && T >= RINGS[G.ringNext][0]) {
    spawnRing(RINGS[G.ringNext][1]);
    G.ringNext++;
  }
  if (G.ringNext >= RINGS.length && T >= G.ringT) {
    spawnRing(26 + overT() * 0.45);
    G.ringT += 10;
  }
  const w = waveNow(T);
  const friends = squadN();
  G.spawnAcc += dt * (1 + 0.3 * friends);
  if (G.spawnAcc >= w.every) {
    G.spawnAcc -= w.every;
    spawnOne(Math.random() < w.run ? 1 : 0, spawnAngle(w.north === undefined ? 0.72 : w.north));
  }
  if (T >= 22) {
    G.groupAcc += dt;
    const gap = Math.max(6.5, 9.5 - friends * 0.5 - overT() * 0.015);
    if (G.groupAcc >= gap) {
      G.groupAcc -= gap;
      spawnFlanks();
    }
  }
}

function placeIdleCrowd(n = 16) {
  // 게임 카메라 자리에서 화면에 들어오는 곳을 골라 배치 (일부는 화면 밖)
  const save = {
    p: camera.position.clone(),
    q: camera.quaternion.clone(),
    fov: camera.fov
  };
  camGameTarget(_cp, _cl);
  camera.position.copy(_cp);
  camera.lookAt(_cl);
  camera.fov = 36;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const pts = [];
  let tries = 0;
  const wantIn = Math.round(n * 0.75);
  while (pts.length < n && tries < 2000) {
    tries++;
    const a = rand(0, TAU),
      r = rand(3.0, 10.5);
    const x = ME.x + Math.sin(a) * r * 0.85,
      z = ME.z - Math.cos(a) * r;
    if (z > ME.z + 2.6 && Math.abs(x - ME.x) < 2.2) continue;
    if (pts.some((q) => Math.hypot(q.x - x, q.z - z) < 1.9)) continue;
    toScreen(x, 1.0, z, _sc);
    const vis = _sc.z < 1 && _sc.x > 30 && _sc.x < VW - 30 && _sc.y > 90 && _sc.y < VH - 40;
    const nIn = pts.filter((q) => q.vis).length;
    if (vis && nIn >= wantIn) continue;
    if (!vis && pts.length - nIn >= n - wantIn) continue;
    pts.push({
      x,
      z,
      vis
    });
  }
  camera.position.copy(save.p);
  camera.quaternion.copy(save.q);
  camera.fov = save.fov;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  pts.sort((a, b) => Math.hypot(a.x - ME.x, a.z - ME.z) - Math.hypot(b.x - ME.x, b.z - ME.z));
  return pts.map((q, k) => {
    const r = Math.random();
    const p = newPerson(q.x, q.z, {
      state: 'idle',
      idle: r < 0.45 ? 0 : r < 0.8 ? 1 : 2,
      kind: k > 3 && Math.random() < 0.12 ? 1 : 0,
      yaw: rand(0, TAU)
    });
    computePose(p, 0, p.pose);
    return p;
  });
}

// ───────────────────────── 주인공 ─────────────────────────
function meSim(dt) {
  let ix = G.input.x,
    iz = G.input.z;
  const m = Math.min(1, Math.hypot(ix, iz));
  let dx = 0,
    dz = 0;
  if (m > 0.02) {
    dx = ix / Math.hypot(ix, iz);
    dz = iz / Math.hypot(ix, iz);
  }
  const eff = Math.pow(m, 1.5);
  const mul = SPEED_MUL[Math.min(ME.clingers.length, SPEED_MUL.length - 1)];
  // 사격 중에도 방향을 바꿀 수 있지만, 러너를 따돌리려면 공격을 놓고 달려야 한다.
  ME.aimStance = approach(ME.aimStance || 0, G.firing && G.ctrl && !ME.clingers.length ? 1 : 0, 10, dt);
  const sp = G.ctrl ? ME.speed * eff * mul * THREE.MathUtils.lerp(1, 0.45, ME.aimStance) : 0;
  ME.vx = approach(ME.vx, dx * sp, 9, dt);
  ME.vz = approach(ME.vz, dz * sp, 9, dt);
  ME.x += ME.vx * dt;
  ME.z += ME.vz * dt;
  if (HOUSE.on && G.state !== 'enter' && !GAME_MOD.noclip) {
    const n = houseCollide(ME, 0.3);
    if (n) {
      const vn = ME.vx * n.x + ME.vz * n.z;
      if (vn < 0) {
        ME.vx -= vn * n.x;
        ME.vz -= vn * n.z;
      }
    }
  }
  const v = Math.hypot(ME.vx, ME.vz);
  ME.phase += v * dt / 0.6 * Math.PI;
  ME.walk = approach(ME.walk, THREE.MathUtils.clamp(v / 2.4, 0, 1), 8, dt);
  for (const h of [0, 1]) {
    ME.recoil[h] = Math.max(0, ME.recoil[h] - dt * 8);
    if (G.t - ME.lastShot[h] > 0.6) ME.aim[h] = approach(ME.aim[h], 0, 5, dt);
  }
  // 몸통은 조준 쪽으로 살짝, 얼굴은 늘 정면
  let want = 0;
  const lastH = ME.lastShot[0] > ME.lastShot[1] ? 0 : 1;
  if (G.t - ME.lastShot[lastH] < 0.6) {
    const ap = ME.aimPt[lastH];
    want = THREE.MathUtils.clamp(Math.atan2(ap.x - ME.x, ap.z - ME.z), -0.45, 0.45);
    if (Math.abs(Math.atan2(ap.x - ME.x, ap.z - ME.z)) > 2.2) want = 0;
  }
  ME.spineYaw = approach(ME.spineYaw, want, 6, dt);
  if (ME.stab) {
    ME.stab.t += dt;
    if (!ME.stab.done && ME.stab.t >= 0.065) {
      ME.stab.done = true;
      stabHit(ME.stab.target);
    }
    if (ME.stab.t > 0.2) ME.stab = null;
  }
}
const _q1 = new THREE.Quaternion(),
  _q2 = new THREE.Quaternion(),
  _mb = new THREE.Matrix4();
const _ax = new THREE.Vector3(),
  _ay = new THREE.Vector3(),
  _az = new THREE.Vector3(),
  _sp = new THREE.Vector3(),
  _f = new THREE.Vector3();
const _idQ = new THREE.Quaternion();

function aimArm(h, target, blend, lift, elbow, raw) {
  const sh = h === 0 ? MR.shL : MR.shR,
    el = h === 0 ? MR.elL : MR.elR;
  sh.updateWorldMatrix(true, false);
  _sp.setFromMatrixPosition(sh.matrixWorld);
  _f.copy(target).sub(_sp);
  _f.normalize();
  // 등 뒤를 쏠 때는 팔을 어깨 너머로 들어 올려 보이게
  const behind = raw ? 0 : THREE.MathUtils.clamp(-(_f.z) - 0.15, 0, 1);
  _f.y += lift + behind * 1.0;
  _f.x += behind * 0.55 * (h === 0 ? 1 : -1);
  _f.normalize();
  _ay.copy(_f).negate();
  _az.set(0, 1, 0);
  if (Math.abs(_f.y) > 0.92) _az.set(0, 0, 1);
  _az.addScaledVector(_f, -_f.dot(_az)).normalize();
  _ax.crossVectors(_ay, _az).normalize();
  _mb.makeBasis(_ax, _ay, _az);
  _q1.setFromRotationMatrix(_mb);
  sh.parent.getWorldQuaternion(_q2);
  _q2.invert().multiply(_q1);
  sh.quaternion.slerp(_q2, blend);
  if (elbow) {
    _q1.setFromEuler(_e.set(elbow, 0, 0));
    el.quaternion.slerp(_q1, blend);
  } else el.quaternion.slerp(_idQ, blend);
}
const _tgtV = new THREE.Vector3();

function meAnimate(dt) {
  if (POSTER.on) {
    mePosterAnimate(dt);
    return;
  }
  const o = ME.tgt;
  o.fill(0);
  const w = ME.walk,
    v = Math.hypot(ME.vx, ME.vz);
  const s = Math.sin(ME.phase),
    c = Math.cos(ME.phase);
  const mx = v > 0.05 ? ME.vx / v : 0,
    mz = v > 0.05 ? ME.vz / v : 0;
  const amp = 0.55 * w;
  o[P.HY] = M.HIP_Y - Math.abs(c) * 0.03 * w + Math.sin(G.t * 2.1) * 0.004;
  o[P.LHX] = -s * amp * mz;
  o[P.RHX] = s * amp * mz;
  o[P.LHZ] = s * amp * mx * 0.75 + 0.03;
  o[P.RHZ] = -s * amp * mx * 0.75 - 0.03;
  o[P.LKX] = Math.max(0, c) * amp * 1.1 + 0.03;
  o[P.RKX] = Math.max(0, -c) * amp * 1.1 + 0.03;
  o[P.SX] = -0.04 + w * 0.02;
  o[P.SY] = ME.spineYaw + s * 0.05 * w * mz;
  o[P.SZ] = -s * 0.03 * w;
  o[P.HW] = -o[P.SY];
  o[P.HX] = -0.03 + Math.sin(G.t * 1.6) * 0.012;
  o[P.HZ] = 0.07;
  o[P.LSX] = s * 0.32 * w * mz + 0.04;
  o[P.RSX] = -s * 0.32 * w * mz + 0.04;
  o[P.LSZ] = 0.13;
  o[P.RSZ] = -0.13;
  o[P.LEX] = -0.4;
  o[P.REX] = -0.4;
  for (let i = 0; i < NPOSE; i++) ME.pose[i] = approach(ME.pose[i], o[i], 16, dt);
  ME.pose[P.LIFT] = 0;
  ME.turn = angleApproach(ME.turn, ME.turnTo, 10, dt);
  applyRig(MR, ME.pose, ME.x, ME.z, ME.turn);
  // 조준 / 칼질 덮어쓰기
  for (const h of [0, 1]) {
    const stabbing = ME.stab && ME.stab.hand === h;
    const fiving = ME.five && ME.five.h === h;
    const sg = h === 1 && SG.on;
    KNIVES[h].visible = !fiving && (stabbing || (ME.clingers.length > 0 && ((h === 0 && ME.clingers.some((p) => SLOTS[p.slot].x >= 0)) || (h === 1 && ME.clingers.some((p) => SLOTS[p.slot].x < 0)))));
    GUNS[h].visible = !fiving && !KNIVES[h].visible && !sg;
    if (h === 1) SG.model.visible = SG.on && !fiving && !KNIVES[1].visible;
    if (fiving) {
      const f = ME.five;
      aimArm(h, f.pt, f.blend, 0, -0.25);
    } else if (stabbing) {
      const st = ME.stab,
        k = THREE.MathUtils.clamp(st.t / 0.2, 0, 1);
      const ext = Math.sin(Math.min(1, k * 1.6) * Math.PI * 0.5);
      const back = 1 - Math.sin(k * Math.PI);
      const tp = st.target;
      _tgtV.set(tp.tx, tp.ty, tp.tz);
      aimArm(h, _tgtV, 1, 0.1 * back, -1.7 * (1 - ext) * 0.9);
    } else {
      // 산탄총은 쏘지 않을 땐 옆으로 비스듬히 내려 든다
      if (sg && ME.aim[1] < 0.999) {
        _tgtV.set(ME.x - 1.5, 0.12, ME.z + 0.9);
        aimArm(1, _tgtV, 1, 0, -0.22);
      }
      if (ME.aim[h] > 0.01) aimArm(h, ME.aimPt[h], ME.aim[h], ME.recoil[h] * (sg ? 0.45 : 0.9), -0.06);
    }
  }
  MR.root.updateMatrixWorld(true);
  for (const h of [0, 1]) {
    ME.muzzle[h].copy(MUZZLE_LOCAL).applyMatrix4(GUNS[h].matrixWorld);
  }
  if (SG.on) SG.muzzleW.copy(SG_MUZZLE).applyMatrix4(SG.model.matrixWorld);
  meSparkles(dt);
}

function meSparkles(dt) {
  // 반짝이
  const camD = camera.position.distanceTo(MR.neck.getWorldPosition(_v2));
  const base = THREE.MathUtils.lerp(0.06, 0.17, THREE.MathUtils.clamp((camD - 1) / 18, 0, 1));
  SPARKS.forEach((sp, k) => {
    const tw = 0.75 + 0.35 * Math.sin(G.t * 5.5 + k * 2.1) + 0.25 * Math.max(0, Math.sin(G.t * 1.7 + k)) ** 8;
    sp.scale.setScalar(base * tw);
    sp.material.rotation = G.t * 0.6 + k;
  });
  if (BIG_SPARK.visible) {
    BIG_SPARK.userData.t += dt;
    const k = BIG_SPARK.userData.t / 0.7;
    BIG_SPARK.scale.setScalar(THREE.MathUtils.lerp(0.05, 0.55, Math.sin(THREE.MathUtils.clamp(k, 0, 1) * Math.PI)) * (camD < 4 ? 1 : 2.4));
    BIG_SPARK.material.rotation = k * 1.4;
    if (k >= 1) BIG_SPARK.visible = false;
  }
}

function bigSparkle() {
  BIG_SPARK.visible = true;
  BIG_SPARK.userData.t = 0;
  BIG_SPARK.position.set(0.24, M.HEAD_UP + 0.17, M.HEAD_R * 0.7);
}

// ───────────────────────── 전투 ─────────────────────────
function findTarget() {
  let best = null,
    bd = RANGE * RANGE;
  for (const p of live) {
    if (!shootable(p)) continue;
    if (HOUSE.on) {
      const dx = p.x - ME.x,
        dz = p.z - ME.z,
        d = Math.hypot(dx, dz) || 1;
      if (houseRayT(ME.x, ME.z, dx / d, dz / d) < d) continue;
    } // 집 뒤에 가린 사람은 안 겨눔
    // 화면에 보이는 사람만 겨눈다
    toScreen(p.tx, p.ty, p.tz, _sc);
    if (_sc.z > 1 || _sc.x < 4 || _sc.x > VW - 4 || _sc.y < 4 || _sc.y > VH - 4) continue;
    const d = (p.x - ME.x) ** 2 + (p.z - ME.z) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

function rayHits(ox, oz, dx, dz, maxT) {
  const out = [];
  for (const p of live) {
    if (!shootable(p)) continue;
    const rx = p.x - ox,
      rz = p.z - oz,
      t = rx * dx + rz * dz;
    if (t < 0.1 || t > maxT) continue;
    const px = rx - dx * t,
      pz = rz - dz * t;
    if (px * px + pz * pz < 0.36 * 0.36) out.push({
      p,
      t
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}
// 필드 아이템: 같은 것은 지속시간만 갱신하고, 서로 다른 것은 함께 쓴다.
const ITEM_DEFS = [{
  key: 'pierce',
  name: '관통탄',
  short: '관통',
  color: '#168d9b'
},
{
  key: 'impact',
  name: '충격탄',
  short: '파괴',
  color: '#d56b24'
},
{
  key: 'spread',
  name: '산탄',
  short: '산탄',
  color: '#8660be'
},
];
const ITEM_DURATION = 10,
  ITEM_MAX = 3;
const POWERS = {
  pierce: 0,
  impact: 0,
  spread: 0
};
const itemStatusEl = $('powerStatus'),
  itemNoticeEl = $('itemNotice');
let itemSpawnT = 5,
  itemNextKind = 0,
  itemNoticeT = 0,
  itemStatusText = '';

function makeItemTex(def, existing) {
  const c = cnv(192, 224),
    g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.strokeStyle = '#1f1a24';
  g.lineWidth = 7;
  g.beginPath();
  g.roundRect(18, 15, 156, 187, 24);
  g.fill();
  g.stroke();
  g.fillStyle = def.color;
  g.fillRect(33, 30, 126, 109);
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  g.lineWidth = 8;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (def.key === 'pierce') {
    for (const x of [70, 96, 122]) {
      g.beginPath();
      g.moveTo(x, 57);
      g.lineTo(x, 113);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(44, 85);
    g.lineTo(151, 85);
    g.moveTo(137, 70);
    g.lineTo(151, 85);
    g.lineTo(137, 100);
    g.stroke();
  } else if (def.key === 'impact') {
    g.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 8,
        r = i % 2 ? 19 : 42;
      const x = 96 + Math.cos(a) * r,
        y = 85 + Math.sin(a) * r;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.closePath();
    g.fill();
  } else {
    for (const x of [50, 73, 96, 119, 142]) {
      g.beginPath();
      g.moveTo(96, 119);
      g.lineTo(x, 55 + Math.abs(x - 96) * .2);
      g.stroke();
    }
  }
  // 탄종 표시 위에 붙은 작은 원형 상표. 판정서와 같은 온이 얼굴을 쓴다.
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(145, 45, 24, 0, TAU);
  g.fill();
  drawAgencyMark(g, 145, 45, 48, def.color);
  g.fillStyle = '#1f1a24';
  g.font = '900 29px "Noto Sans KR", "Malgun Gothic", Gulim, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(def.name, 96, 172);
  if (existing) {
    existing.image = c;
    existing.needsUpdate = true;
    return existing;
  }
  return texOf(c);
}
const ITEM_TEXTURES = ITEM_DEFS.map(def => makeItemTex(def));
if (document.fonts && document.fonts.load) {
  document.fonts.load('900 29px "Noto Sans KR"', ITEM_DEFS.map(def => def.name).join('')).then(() => {
    ITEM_DEFS.forEach((def, i) => makeItemTex(def, ITEM_TEXTURES[i]));
  }, () => { });
}
const itemRingGeo = new THREE.RingGeometry(.34, .43, 28);
itemRingGeo.rotateX(-Math.PI / 2);
const FIELD_ITEMS = Array.from({
  length: ITEM_MAX
}, () => {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ITEM_TEXTURES[0],
    transparent: true,
    depthWrite: false,
    fog: true
  }));
  sp.scale.set(.73, .85, 1);
  sp.visible = false;
  sp.renderOrder = 3;
  scene.add(sp);
  const ring = new THREE.Mesh(itemRingGeo, new THREE.MeshBasicMaterial({
    color: ITEM_DEFS[0].color,
    transparent: true,
    opacity: .55,
    depthWrite: false
  }));
  ring.visible = false;
  scene.add(ring);
  return {
    on: false,
    kind: 0,
    x: 0,
    z: 0,
    age: 0,
    sp,
    ring
  };
});
const impactRingGeo = new THREE.RingGeometry(.88, 1, 40);
impactRingGeo.rotateX(-Math.PI / 2);
const IMPACT_PULSES = Array.from({
  length: 4
}, () => {
  const m = new THREE.Mesh(impactRingGeo, new THREE.MeshBasicMaterial({
    color: '#f0a03b',
    transparent: true,
    opacity: .8,
    depthWrite: false
  }));
  m.visible = false;
  scene.add(m);
  return {
    m,
    t: 0
  };
});
let impactPulseNext = 0;

function impactPulse(x, z) {
  const r = IMPACT_PULSES[impactPulseNext];
  impactPulseNext = (impactPulseNext + 1) % IMPACT_PULSES.length;
  r.t = 0;
  r.m.position.set(x, .028, z);
  r.m.scale.setScalar(.12);
  r.m.material.opacity = .85;
  r.m.visible = true;
}

function hideFieldItem(item) {
  item.on = false;
  item.sp.visible = item.ring.visible = false;
}

function clearItems() {
  for (const item of FIELD_ITEMS) hideFieldItem(item);
  for (const r of IMPACT_PULSES) r.m.visible = false;
  for (const def of ITEM_DEFS) POWERS[def.key] = GAME_MOD.allPowers ? Infinity : 0;
  itemSpawnT = 5;
  itemNextKind = 0;
  itemNoticeT = 0;
  itemStatusText = '';
  itemStatusEl.textContent = '';
  itemStatusEl.hidden = itemNoticeEl.hidden = true;
}

function takePower(kind) {
  const def = typeof kind === 'string' ? ITEM_DEFS.find(d => d.key === kind) : ITEM_DEFS[kind];
  if (!def || G.state !== 'play') return false;
  POWERS[def.key] = GAME_MOD.allPowers ? Infinity : ITEM_DURATION;
  itemNoticeEl.textContent = `${def.name} · ${ITEM_DURATION}초`;
  itemNoticeEl.hidden = false;
  itemNoticeT = 1.35;
  sfxItemPickup();
  updateItemStatus();
  return true;
}

function updateItemStatus() {
  const text = ITEM_DEFS.filter(d => POWERS[d.key] > 0).map(d => d.short + ' ' + (POWERS[d.key] === Infinity ? '∞' : Math.ceil(POWERS[d.key]))).join(' · ');
  if (text !== itemStatusText) {
    itemStatusText = text;
    itemStatusEl.textContent = text;
    itemStatusEl.hidden = !text;
  }
}

function spawnItem(kind = itemNextKind, x, z) {
  if (G.state !== 'play') return null;
  const item = FIELD_ITEMS.find(i => !i.on),
    def = typeof kind === 'string' ? ITEM_DEFS.find(d => d.key === kind) : ITEM_DEFS[kind];
  if (!item || !def) return null;
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    let found = false;
    for (let n = 0; n < 36; n++) {
      const a = rand(0, TAU), r = rand(2.7, 4.7);
      x = ME.x + Math.sin(a) * r;
      z = ME.z + Math.cos(a) * r;
      if (FIELD_ITEMS.some(i => i.on && Math.hypot(i.x - x, i.z - z) < 1.5) || houseNear(x, z, 0.6)) continue;
      toScreen(x, .65, z, _sc);
      if (_sc.z > 1 || _sc.x < 42 || _sc.x > VW - 42 || _sc.y < VH * .20 || _sc.y > VH * .73) continue;
      found = true;
      break;
    }
    if (!found) return null;
  }
  item.kind = ITEM_DEFS.indexOf(def);
  item.x = x;
  item.z = z;
  item.age = 0;
  item.on = true;
  item.sp.material.map = ITEM_TEXTURES[item.kind];
  item.sp.material.needsUpdate = true;
  item.sp.material.opacity = 1;
  item.sp.position.set(x, .63, z);
  item.sp.visible = true;
  item.ring.material.color.set(def.color);
  item.ring.material.opacity = .55;
  item.ring.position.set(x, .021, z);
  item.ring.visible = true;
  return item;
}

function updateItems(dt) {
  if (G.state !== 'play') return;
  for (const def of ITEM_DEFS) POWERS[def.key] = GAME_MOD.allPowers ? Infinity : Math.max(0, POWERS[def.key] - dt);
  if (itemNoticeT > 0) {
    itemNoticeT -= dt;
    if (itemNoticeT <= 0) itemNoticeEl.hidden = true;
  }
  for (const item of FIELD_ITEMS) {
    if (!item.on) continue;
    item.age += dt;
    const d = Math.hypot(item.x - ME.x, item.z - ME.z);
    if (item.age > 20 || d > 16) {
      hideFieldItem(item);
      continue;
    }
    if (G.ctrl && d < .72) {
      takePower(item.kind);
      hideFieldItem(item);
    }
  }
  itemSpawnT -= dt;
  if (itemSpawnT <= 0) {
    if (spawnItem()) {
      itemNextKind = (itemNextKind + 1) % ITEM_DEFS.length;
      itemSpawnT = 5.5;
    } else itemSpawnT = 1;
  }
  updateItemStatus();
}

function animateItems(dt) {
  for (const item of FIELD_ITEMS) {
    if (!item.on) continue;
    item.sp.position.y = .63 + Math.sin(G.t * 3.4 + item.kind * 2) * .055;
    const alpha = item.age > 17 ? .5 + .5 * Math.sin(G.t * 12) : 1;
    item.sp.material.opacity = alpha;
    item.ring.material.opacity = .45 * alpha;
    item.ring.scale.setScalar(1 + Math.sin(G.t * 3.4 + item.kind * 2) * .07);
  }
  for (const r of IMPACT_PULSES) {
    if (!r.m.visible) continue;
    r.t += dt;
    const k = r.t / .22;
    if (k >= 1) {
      r.m.visible = false;
      continue;
    }
    r.m.scale.setScalar(THREE.MathUtils.lerp(.12, 1.35, easeOutCubic(k)));
    r.m.material.opacity = .85 * (1 - k);
  }
}

function poweredKill(p, dx, dz, impact) {
  if (!shootable(p)) return false;
  kill(p, dx, dz, 'shot');
  if (impact) {
    p.kbx *= 2.1;
    p.kbz *= 2.1;
    p.fly = .34;
    p.spin *= 1.8;
    p.fallT = Math.max(p.fallT, .6);
  }
  return true;
}

function fireRay(mz, dx, dz, maxT, pierce, impact, splash, shotgun) {
  if (HOUSE.on) maxT = Math.min(maxT, houseRayT(mz.x, mz.z, dx, dz));
  const hits = rayHits(mz.x, mz.z, dx, dz, maxT);
  let endT = Math.min(RANGE, maxT);
  const cap = pierce ? 5 : shotgun ? 1 : 2;
  let struck = 0;
  for (let i = 0; i < hits.length && struck < cap; i++) {
    if (!pierce && i && hits[i].t - hits[0].t >= 1.3) break;
    const p = hits[i].p;
    if (!poweredKill(p, dx, dz, impact)) continue;
    struck++;
    endT = hits[i].t;
    if (impact && !splash.done) {
      splash.done = true;
      impactPulse(p.x, p.z);
      const nearby = live.filter(q => shootable(q) && (q.x - p.x) ** 2 + (q.z - p.z) ** 2 < 1.3 ** 2);
      nearby.sort((a, b) => (a.x - p.x) ** 2 + (a.z - p.z) ** 2 - (b.x - p.x) ** 2 - (b.z - p.z) ** 2);
      for (const q of nearby.slice(0, 2)) {
        const rx = q.x - p.x,
          rz = q.z - p.z,
          d = Math.hypot(rx, rz);
        poweredKill(q, d > .001 ? rx / d : dx, d > .001 ? rz / d : dz, true);
      }
    }
  }
  if (pierce) endT = maxT;
  addTracer(mz.x, mz.y, mz.z, mz.x + dx * endT, THREE.MathUtils.lerp(mz.y, .86, .85), mz.z + dz * endT);
}

function weaponDown() {
  G.firing = true;
  if (G.state !== 'play' || !G.ctrl) return;
  // 짧게 눌렀다 떼어도 다음 프레임을 기다리지 않고 바로 반응한다.
  if (ME.clingers.length) {
    if (ME.stab && !ME.stab.done) return; // 이미 시작한 찌르기의 명중 시점을 되돌리지 않는다.
    stab();
    if (!GAME_MOD.auto) G.fireCD = 0.20;
  } else {
    shoot();
    if (!GAME_MOD.auto) G.fireCD = POWERS.spread > 0 ? 0.32 : 0.235;
  }
}

function weaponUp() {
  G.firing = false;
}

function combatSim(dt) {
  G.fireCD -= dt;
  if (!GAME_MOD.aimbot || G.state !== 'play' || !G.ctrl) return;
  if (G.fireCD > 0 && !GAME_MOD.auto) return;
  if (ME.clingers.length) {
    stab();
    if (!GAME_MOD.auto) G.fireCD = 0.20;
    return;
  }
  if (!findTarget()) return;
  shoot();
  if (!GAME_MOD.auto) G.fireCD = POWERS.spread > 0 ? 0.32 : 0.235;
}

function shoot(forced) {
  const tgt = forced || findTarget();
  let ax, ay, az;
  if (tgt) {
    ax = tgt.x;
    ay = 0.86;
    az = tgt.z;
  } else {
    const v = Math.hypot(ME.vx, ME.vz);
    const dx = v > 0.3 ? ME.vx / v : 0,
      dz = v > 0.3 ? ME.vz / v : 1;
    ax = ME.x + dx * 8;
    ay = 0.9;
    az = ME.z + dz * 8;
  }
  // 산탄총은 겨눌 사람이 있을 때만 (허공에 버리지 않게)
  if (SG.on && tgt && !forced && SG.cd <= 0 && SG.dropT < 0 && !(ME.five && ME.five.h === 1)) {
    shootShotgunOut(ax, ay, az);
    return;
  }
  const relx = ax - ME.x;
  let h = relx >= 0 ? 0 : 1;
  if (G.t - ME.lastShot[h] < 0.1 && G.t - ME.lastShot[1 - h] > 0.12) h = 1 - h;
  if (ME.five && ME.five.h === h) h = 1 - h; // 하이파이브 중인 손은 쉰다
  if (SG.on) {
    if (ME.five && ME.five.h === 0) return;
    h = 0;
  } // 오른손엔 산탄총
  ME.lastShot[h] = G.t;
  G.lastShotT = G.t;
  ME.aim[h] = 1;
  ME.aimPt[h].set(ax, ay, az);
  ME.recoil[h] = GAME_MOD.noRecoil ? 0 : 1;
  if (!G.firedOnce) {
    G.firedOnce = true;
    $('weapon').classList.remove('pulse');
  }
  // 총구 위치는 직전 프레임 값
  const mz = ME.muzzle[h];
  let dx = ax - mz.x,
    dz = az - mz.z;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl;
  dz /= dl;
  const powered = G.state === 'play',
    pierce = powered && POWERS.pierce > 0,
    impact = powered && POWERS.impact > 0,
    spread = powered && POWERS.spread > 0;
  const splash = {
    done: false
  },
    pan = THREE.MathUtils.clamp((mz.x - CAMX) / 5, -1, 1);
  // 중앙 탄환부터, 같은 상대는 한 번만. 각 탄환은 가까운 명중부터 처리한다.
  fireRay(mz, dx, dz, RANGE + 2, pierce, impact, splash, spread);
  if (spread) {
    for (const a of [-.24, -.12, .12, .24]) {
      const c = Math.cos(a), s = Math.sin(a);
      fireRay(mz, dx * c + dz * s, dz * c - dx * s, pierce ? RANGE + 2 : 6.7, pierce, impact, splash, true);
    }
  }
  FLASHES[h].sp.visible = true;
  FLASHES[h].t = 0.05;
  FLASHES[h].sp.material.rotation = rand(0, TAU);
  ejectShell(mz.x, mz.y, mz.z, dx, dz);
  if (!GAME_MOD.silencer) sfxGun(pan);
  if (!GAME_MOD.noRecoil) CAM.shake = Math.max(CAM.shake, 0.035);
}

function kill(p, dx, dz, how, by, quiet) {
  if (p.state === 'dying' || p.state === 'dead') return;
  if (p.state === 'cling') {
    const H = p.host || ME;
    H.slotOcc[p.slot] = null;
    const k = H.clingers.indexOf(p);
    if (k >= 0) H.clingers.splice(k, 1);
    p.slot = -1;
  }
  p.state = 'dying';
  p.how = how;
  p.dieT = 0;
  p.landed = false;
  p.poolPending = -1;
  aliveCount--;
  const rel = Math.atan2(dx, dz) - p.yaw;
  p.back = Math.cos(rel) < 0.2;
  p.fallRoll = Math.sin(rel) * 0.5 + rand(-0.2, 0.2);
  const bat = how === 'bat';
  p.fallT = how === 'stab' ? 0.62 : bat ? rand(0.6, 0.72) : rand(0.42, 0.55);
  const kb = how === 'stab' ? rand(0.9, 1.4) : bat ? rand(4.6, 6.4) : rand(2.4, 3.6);
  p.kbx = dx * kb;
  p.kbz = dz * kb;
  p.fly = bat ? rand(0.3, 0.6) : 0;
  p.spin = how === 'stab' ? rand(-0.6, 0.6) : bat ? rand(-6, 6) : rand(-1.6, 1.6);
  p.corpse = makeCorpse(p.back);
  // 맞는 순간 고개가 꺾임
  p.pose[P.HX] += p.back ? -0.7 : 0.5;
  p.pose[P.SX] -= 0.25;
  setFace(p, 3);
  if (p.vo && !p.vo.stopped) p.vo.stop(0.008);
  p.vo = null;
  if (p.bubble) {
    cutBubble(p.bubble);
    p.bubble = null;
  }
  if (quiet) {
    p.quiet = true;
    return;
  }
  const hy = how === 'stab' ? 0.85 : rand(0.78, 1.25);
  const far = Math.hypot(p.x - ME.x, p.z - ME.z);
  const vfar = THREE.MathUtils.clamp(1.25 - far * 0.06, 0.35, 1);
  bloodBurst(p.x - dx * 0.1, hy, p.z - dz * 0.1, dx, dz, how === 'stab' ? 18 : bat ? 12 : 16, how === 'stab' ? 0.7 : 1);
  if (how === 'shot') bloodSpurt(p.x + dx * 0.15, hy, p.z + dz * 0.15, dx, 0.2, dz, 8);
  addDecal(p.x + dx * rand(0.4, 1.1), p.z + dz * rand(0.4, 1.1), rand(0.7, 1.2), 2, Math.atan2(dx, dz) - Math.PI / 2 + rand(-0.3, 0.3));
  const pan = screenPan(p.x, p.z);
  if (bat) sfxBat(pan, vfar);
  else sfxFlesh((how === 'stab' ? 1 : 0.85) * (by ? vfar : 1), pan);
  if (by) {
    by.kills++;
    G.allyKills++;
  } else {
    G.kills++;
    hudKill();
  }
}

function stab() {
  const c = ME.clingers[0];
  if (!c) return;
  let hand = SLOTS[c.slot].x >= 0 ? 0 : 1;
  if (ME.five && ME.five.h === hand) hand = 1 - hand;
  ME.stab = {
    hand,
    t: 0,
    target: c,
    done: false
  };
  sfxStab(hand === 0 ? 0.3 : -0.3);
  if (!G.stabbedOnce) {
    G.stabbedOnce = true;
    $('weapon').classList.remove('pulse');
  }
}

function stabHit(c) {
  if (c.state !== 'cling') return;
  const dx = c.x - ME.x,
    dz = c.z - ME.z,
    d = Math.hypot(dx, dz) || 1;
  kill(c, dx / d, dz / d, 'stab');
  bloodSpurt(c.tx, c.ty, c.tz, -dx / d * 0.5, 0.5, -dz / d * 0.5 + 0.3, 10);
  addShirtBlood(Math.floor(rand(2, 5)));
  if (Math.random() < 0.6) addMeFaceBlood(Math.floor(rand(1, 4)));
  CAM.shake = Math.max(CAM.shake, 0.07);
}

// ── 집에서 들고 나온 산탄총 (오른손) ──
// 장전되면 한 방에 아홉 알을 부채꼴로 쏜다. 한 알이 둘까지 쓰러뜨리고, 맞은 사람은 멀리 날아간다. 다 쓰면 버리고 다시 쌍권총.
const SG_CD = 0.46,
  SG_PELLETS = 9,
  SG_SPREAD = 0.31,
  SG_RANGE = 8.2; // 권총 한 발 사이에 한 방씩: 쾅-탕-쾅-탕
const sgNEl = $('sgN');

function sgBadge(pop) {
  sgNEl.hidden = !SG.on;
  if (!SG.on) return;
  sgNEl.textContent = GAME_MOD.infiniteAmmo ? '∞' : SG.shells;
  if (pop) {
    sgNEl.classList.remove('pop');
    void sgNEl.offsetWidth;
    sgNEl.classList.add('pop');
  }
}

function sgEquip(n) {
  SG.on = true;
  SG.shells = n;
  SG.cd = 0;
  SG.dropT = -1;
  SG.ejectT = -1;
  SG.pumpT = 9;
  SG.flashT = 0;
  weaponEl.classList.add('sgon');
  sgBadge(false);
}

function shootShotgunOut(ax, ay, az) {
  ME.lastShot[1] = G.t;
  G.lastShotT = G.t;
  ME.aim[1] = 1;
  ME.aimPt[1].set(ax, ay, az);
  ME.recoil[1] = GAME_MOD.noRecoil ? 0 : 1.0;
  // 맞는 판정은 몸 중심에서 (총열이 길어 코앞의 사람을 지나치지 않게), 궤적은 총구에서
  const mz = SG.muzzleW;
  let dx = ax - ME.x,
    dz = az - ME.z;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl;
  dz /= dl;
  const cap = POWERS.pierce > 0 ? 4 : 2;
  for (let i = 0; i < SG_PELLETS; i++) {
    const a = (i / (SG_PELLETS - 1) - 0.5) * 2 * SG_SPREAD + rand(-0.03, 0.03);
    const c = Math.cos(a),
      sn = Math.sin(a);
    const rx = dx * c + dz * sn,
      rz = dz * c - dx * sn;
    const wall = houseRayT(ME.x, ME.z, rx, rz);
    const hits = rayHits(ME.x, ME.z, rx, rz, Math.min(SG_RANGE, wall));
    let n = 0,
      endT = Math.min(SG_RANGE * rand(0.72, 1), wall);
    for (let j = 0; j < hits.length && n < cap; j++) {
      const p = hits[j].p;
      if (!shootable(p)) continue;
      kill(p, rx, rz, 'shot');
      p.kbx *= 2.2;
      p.kbz *= 2.2;
      p.fly = 0.38;
      p.spin *= 1.6;
      p.fallT = Math.max(p.fallT, 0.58);
      n++;
      endT = hits[j].t;
    }
    if (endT > 1.1) addTracer(mz.x, mz.y, mz.z, ME.x + rx * endT, THREE.MathUtils.lerp(mz.y, 0.86, 0.85), ME.z + rz * endT);
  }
  SG.flash.visible = true;
  SG.flashT = 0.07;
  SG.flash.material.rotation = rand(0, TAU);
  if (!GAME_MOD.infiniteAmmo) SG.shells--;
  if (!GAME_MOD.auto) SG.cd = SG_CD;
  SG.pumpT = 0;
  if (!GAME_MOD.silencer) sfxShotgunOut(THREE.MathUtils.clamp((mz.x - CAMX) / 5, -1, 1));
  if (GAME_MOD.infiniteAmmo || SG.shells > 0) {
    sfxPumpOut(0.16);
    SG.ejectT = 0.2;
  } else {
    SG.dropT = 0.5;
    SG.pumpT = 9;
  }
  if (!GAME_MOD.noRecoil) CAM.shake = Math.max(CAM.shake, 0.09);
  sgBadge(true);
}

function sgTick(dt) {
  if (!SG.on) return;
  if (GAME_MOD.infiniteAmmo) {
    SG.dropT = -1;
  }
  SG.cd -= dt;
  if (SG.ejectT > 0) {
    SG.ejectT -= dt;
    if (SG.ejectT <= 0) {
      // 펌프를 당기면 빈 탄피가 옆으로 튄다
      _v2.set(0, 0.05 * SG_S, 0.1 * SG_S).applyMatrix4(SG.model.matrixWorld);
      const ap = ME.aimPt[1],
        ex = ap.x - ME.x,
        ez = ap.z - ME.z,
        el = Math.hypot(ex, ez) || 1;
      ejectShell(_v2.x, _v2.y, _v2.z, ex / el, ez / el);
    }
  }
  if (SG.dropT > 0) {
    SG.dropT -= dt;
    if (SG.dropT <= 0) sgDiscard(false);
  }
}

function sgDiscard(quiet) {
  if (!SG.on) return;
  SG.on = false;
  SG.dropT = -1;
  SG.ejectT = -1;
  SG.model.visible = false;
  SG.flash.visible = false;
  // 오른손 높이에서 떨어뜨리고, 그 손에는 다시 권총
  MR.wrR.getWorldPosition(_v2);
  sgDropAt(_v2.x, _v2.z, Math.max(0.25, _v2.y - 0.1));
  if (!quiet) sfxGunDrop(screenPan(_v2.x, _v2.z), 0.28);
  weaponEl.classList.remove('sgon');
  sgBadge(false);
}

function sgReset() {
  SG.on = false;
  SG.shells = 0;
  SG.cd = 0;
  SG.dropT = -1;
  SG.ejectT = -1;
  SG.pumpT = 9;
  SG.flashT = 0;
  SG.model.visible = false;
  SG.flash.visible = false;
  for (const g of SG.dropped) {
    scene.remove(g);
    g.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material && n.material !== OUT_MAT) n.material.dispose();
    });
  }
  SG.dropped.length = 0;
  weaponEl.classList.remove('sgon');
  sgBadge(false);
}

function sgAnimate(dt) {
  if (SG.flashT > 0) {
    SG.flashT -= dt;
    if (SG.flashT <= 0) SG.flash.visible = false;
  }
  SG.pumpT += dt;
  const t = SG.pumpT,
    k = t < 0.16 ? 0 : t < 0.26 ? (t - 0.16) / 0.1 : t < 0.38 ? 1 - (t - 0.26) / 0.12 : 0;
  SG.pump.position.z = SG.pumpZ - k * 0.1 * SG_S;
  for (const g of SG.dropped) {
    const f = g.userData.fall;
    if (!f || f.t >= 1) continue;
    f.t = Math.min(1, f.t + dt / 0.3);
    const e = easeInQuad(f.t);
    g.position.y = THREE.MathUtils.lerp(f.y0, 0.045, e);
    g.rotation.z = THREE.MathUtils.lerp(f.r0, Math.PI / 2, e);
  }
}

// ───────────────────────── 붙잡혀 버티면 끝: 주변을 다 쓸어버리고 "싫어." ─────────────────────────
const DANGER_N = 5; // 이만큼 매달린 채로
const DANGER_T = 3.0; // 이 시간이 지나면 끝
// 아주 오래 버티면 조금씩 더 적은 인원에도 붙잡힘 (친구들이 지켜 줘도 판이 끝없이 이어지지 않게)
function dangerN() {
  return G.playT < 200 ? DANGER_N : G.playT < 240 ? DANGER_N - 1 : DANGER_N - 2;
}

function dangerSim(dt) {
  if (G.state !== 'play') {
    G.danger = Math.max(0, G.danger - dt * 3);
    return;
  }
  // 처음 10초는 안 차고(조작을 익히는 동안), 20초까지는 천천히 차오름
  if (ME.clingers.length >= dangerN()) G.danger = Math.min(DANGER_T, G.danger + dt * (G.playT < 10 ? 0 : G.playT < 20 ? 0.5 : 1));
  else G.danger = Math.max(0, G.danger - dt * 1.6);
  if (G.danger >= DANGER_T) startOutburst();
}

function burstSim(dt) {
  const b = G.burst;
  if (!b) return;
  b.t += dt;
  if (b.phase === 'knife') {
    // 매달린 사람부터 칼로 차례차례
    b.cd -= dt;
    if (b.cd <= 0 && ME.clingers.length) {
      if (!GAME_MOD.auto) b.cd = 0.075;
      const c = ME.clingers[0];
      const hand = SLOTS[c.slot].x >= 0 ? 0 : 1;
      ME.stab = {
        hand,
        t: 0.03,
        target: c,
        done: true
      };
      sfxStab(hand === 0 ? 0.3 : -0.3);
      stabHit(c);
    }
  } else if (b.phase === 'guns') {
    // 쌍권총 난사: 가까운 사람부터, 화면 밖이어도
    b.cd -= dt;
    while (b.cd <= 0) {
      b.cd += 1 / 18;
      let best = null, bd = 16 * 16;
      for (const p of live) {
        if (p.state === 'dying' || p.state === 'dead') continue;
        const d = (p.x - ME.x) ** 2 + (p.z - ME.z) ** 2;
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (!best) {
        burstDone();
        break;
      }
      if (best.state === 'cling' && best.host === ME) {
        stabHit(best);
        continue;
      }
      shoot(best);
      if (best.state !== 'dying') {
        const dx = best.x - ME.x, dz = best.z - ME.z, dl = Math.hypot(dx, dz) || 1;
        kill(best, dx / dl, dz / dl, 'shot');
      }
    }
    if (b.t > 5.4) burstDone();
  }
}
// 가까운 사람을 다 쏜 뒤: 멀리 남은 사람은 화면 밖에서 조용히 정리
function burstDone() {
  const b = G.burst;
  if (!b || b.phase === 'done') return;
  b.phase = 'done';
  b.doneT = b.t;
  for (const p of [...live])
    if (p.state !== 'dying' && p.state !== 'dead') kill(p, 0, 1, 'shot', null, true);
}

// ───────────────────────── 카메라 ─────────────────────────
const CAM = {
  mode: 'game',
  pos: new THREE.Vector3(),
  look: new THREE.Vector3(),
  shake: 0,
  fov: 36,
  from: null,
  t: 0,
  dur: 1,
  zoom: 1,
  zoomTo: 1
};
const CAM_PITCH = THREE.MathUtils.degToRad(35);

function camDist() {
  const a = VW / VH,
    t = Math.tan(THREE.MathUtils.degToRad(36 / 2));
  return THREE.MathUtils.clamp(Math.max(2.25 / (t * a), 10.8), 9.5, 16);
}

function camGameTarget(pos, look) {
  const z = CAM.zoom;
  const L = camDist() * z;
  const ahead = (VW / VH < 1 ? 1.3 : 0.6) * Math.min(1, z);
  const ly = 0.72 + (1 - Math.min(1, z)) * 0.5;
  look.set(ME.x, ly, ME.z - ahead);
  pos.set(ME.x, ly + L * Math.sin(CAM_PITCH), ME.z - ahead + L * Math.cos(CAM_PITCH));
}

function camCloseTarget(pos, look) {
  MR.neck.updateWorldMatrix(true, false);
  _v.set(0, M.HEAD_UP, 0).applyMatrix4(MR.neck.matrixWorld);
  const a = VW / VH,
    t2 = 2 * Math.tan(THREE.MathUtils.degToRad(15));
  const d = Math.max(0.6 / (0.78 * t2 * a), 0.6 / (0.44 * t2));
  look.copy(_v).add(_v2.set(0, -0.1, 0));
  pos.set(_v.x + 0.03, _v.y + 0.02, _v.z + d);
}

function camEndTarget(pos, look, k) {
  look.set(ME.x, 1.18, ME.z);
  const back = VW / VH < 0.8 ? THREE.MathUtils.lerp(3.3, 2.5, k) : THREE.MathUtils.lerp(2.7, 2.0, k);
  pos.set(ME.x + THREE.MathUtils.lerp(0.5, 0.25, k), THREE.MathUtils.lerp(1.55, 1.42, k), ME.z + back);
}
const _cp = new THREE.Vector3(),
  _cl = new THREE.Vector3(),
  _cp2 = new THREE.Vector3(),
  _cl2 = new THREE.Vector3();

function camUpdate(dt) {
  CAM.t += dt;
  let fov = 36;
  CAM.zoom = approach(CAM.zoom, CAM.zoomTo, 3.2, dt);
  if (CAM.mode === 'game') {
    camGameTarget(_cp, _cl);
    CAM.pos.x = approach(CAM.pos.x, _cp.x, 7, dt);
    CAM.pos.y = approach(CAM.pos.y, _cp.y, 7, dt);
    CAM.pos.z = approach(CAM.pos.z, _cp.z, 7, dt);
    CAM.look.x = approach(CAM.look.x, _cl.x, 7, dt);
    CAM.look.y = _cl.y;
    CAM.look.z = approach(CAM.look.z, _cl.z, 7, dt);
  } else if (CAM.mode === 'close') {
    camCloseTarget(CAM.pos, CAM.look);
    fov = 30;
  } else if (CAM.mode === 'crane') {
    const k = easeInOutCubic(CAM.t / CAM.dur);
    camCloseTarget(_cp, _cl);
    camGameTarget(_cp2, _cl2);
    CAM.pos.lerpVectors(_cp, _cp2, k);
    CAM.look.lerpVectors(_cl, _cl2, k);
    fov = THREE.MathUtils.lerp(30, 36, k);
    if (CAM.t >= CAM.dur) CAM.mode = 'game';
  } else if (CAM.mode === 'manual') {
    fov = CAM.fov;
  } else if (CAM.mode === 'poster') {
    // 아주 천천히 숨 쉬듯 흔들림
    const s = Math.sin(CAM.t * 0.35),
      c = Math.cos(CAM.t * 0.27);
    CAM.pos.copy(POSTER.camPos).add(_v.set(s * 0.05, c * 0.025, 0));
    CAM.look.copy(POSTER.camLook);
    fov = POSTER.fov;
  } else if (CAM.mode === 'end') {
    const k = easeInOutCubic(CAM.t / CAM.dur);
    camEndTarget(_cp2, _cl2, easeInOutSine(THREE.MathUtils.clamp((CAM.t - CAM.dur) / 6, 0, 1)));
    CAM.pos.lerpVectors(CAM.from.pos, _cp2, k);
    CAM.look.lerpVectors(CAM.from.look, _cl2, k);
    fov = THREE.MathUtils.lerp(36, 32, k);
  }
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
  CAM.shake *= Math.exp(-dt * 18);
  camera.position.copy(CAM.pos);
  if (CAM.shake > 0.002) camera.position.add(_v.set(rand(-1, 1) * CAM.shake, rand(-1, 1) * CAM.shake, 0));
  camera.lookAt(CAM.look);
  camera.updateMatrixWorld();
  CAMX = camera.position.x;
  const L = camera.position.distanceTo(CAM.look);
  if (CAM.mode === 'poster') {
    scene.fog.near = POSTER.fogNear;
    scene.fog.far = POSTER.fogFar;
  } else {
    scene.fog.near = L + 4;
    scene.fog.far = L + 30;
  }
  sun.position.set(ME.x + SUN_OFF.x, SUN_OFF.y, ME.z + SUN_OFF.z);
  sun.target.position.set(ME.x, 0, ME.z);
}

function setCam(mode, dur = 1) {
  if (mode === 'end') CAM.from = {
    pos: CAM.pos.clone(),
    look: CAM.look.clone()
  };
  CAM.mode = mode;
  CAM.t = 0;
  CAM.dur = dur;
  if (mode === 'game') {
    camGameTarget(CAM.pos, CAM.look);
  }
}
const _proj = new THREE.Vector3();

function toScreen(x, y, z, out) {
  _proj.set(x, y, z).project(camera);
  out.x = (_proj.x + 1) / 2 * VW;
  out.y = (1 - _proj.y) / 2 * VH;
  out.z = _proj.z;
  return out;
}
const _sc = {
  x: 0,
  y: 0,
  z: 0
};

function onScreen(x, y, z) {
  toScreen(x, y, z, _sc);
  return _sc.z < 1 && _sc.x > -40 && _sc.x < VW + 40 && _sc.y > -40 && _sc.y < VH + 40;
}

function screenPan(x, z) {
  toScreen(x, 1, z, _sc);
  return THREE.MathUtils.clamp((_sc.x / VW) * 2 - 1, -1, 1) * 0.8;
}

// ───────────────────────── 동료: 정신건강 2급·3급 ─────────────────────────
// 화살표만 말없이 나타난다. 가서 매달린 사람들을 떼어 주면, 다가와서 말없이 하이파이브.
// 그 뒤로는 아무 말 없이 옆에서 같이 싸운다.
const ALLY_DEFS = [{
  shirt: '#8fdcbf',
  hair: '#3b2a20',
  bob: false
}, // 2급
{
  shirt: '#c6b6f2',
  hair: '#2a2024',
  bob: true
}, // 3급
{
  shirt: '#f7bccf',
  hair: '#5a3a28',
  bob: true
}, // 2급
{
  shirt: '#f1da86',
  hair: '#1d1a1c',
  bob: false
}, // 3급 (안경)
];
const ALLY_AT = [14, 38, 62, 86]; // 갇힌 동료가 나타나는 시각
const ALLY_GAP = 10; // 앞 동료와 하이파이브한 뒤 최소 간격
const ALLY_LAST = 116; // 이 뒤로는 새로 나타나지 않음
const ALLY_DIR = [0.55, -0.7, -0.2, 0.95]; // 나타나는 방향 (0 = 화면 위쪽). 세로 화면에서도 멀리서 보이게 위쪽 위주
const LINE = [
  [0.62, -0.5],
  [-0.62, -0.5],
  [1.2, -1.0],
  [-1.2, -1.0]
]; // 마지막 장면 자리
// 싸울 때: 내 주위를 둘러싸고 바깥을 보며 다가오는 사람을 막는다
const GUARD_R = 1.4; // 내 주위 자리 반지름
const GUARD_REACH = 3.1; // 내게서 이 안으로 들어온 사람을 막으러 나감
const GUARD_LEASH = 2.5; // 막으러 나가도 내게서 이보다 멀어지지 않음
const GUARD_HELP_CD = 1.7; // 내게 매달린 사람을 떼어 준 뒤 쉬는 시간
// 위협 방향(0)을 기준으로 한 자리 각도 (0 = 위협 쪽, 시계 방향)
const GUARD_SETS = [
  [],
  [0],
  [-0.95, 0.95],
  [0, 2.2, -2.2],
  [-0.75, 0.75, 2.4, -2.4]
];
const GUARD_PERMS = [
  [
    []
  ],
  [
    [0]
  ],
  [
    [0, 1],
    [1, 0]
  ],
  [],
  []
];
(function perms() {
  const go = (n, cur, out) => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++)
      if (!cur.includes(i)) {
        cur.push(i);
        go(n, cur, out);
        cur.pop();
      }
  };
  go(3, [], GUARD_PERMS[3] = []);
  go(4, [], GUARD_PERMS[4] = []);
})();
const GUARD = {
  bear: 0,
  n: 0,
  helper: null
};

function guardUpdate(dt) {
  const guards = ALLIES.filter((a) => a.state === 'fight' && !a.pinned);
  const n = Math.min(4, guards.length);
  if (!n) {
    GUARD.n = 0;
    return;
  }
  // 위협 방향: 다가오는 사람들 쪽 (가까울수록 무겁게)
  let sx = 0,
    sz = 0;
  for (const p of live) {
    if (p.state !== 'chase' && p.state !== 'press' && p.state !== 'rise') continue;
    const dx = p.x - ME.x,
      dz = p.z - ME.z,
      d = Math.hypot(dx, dz);
    if (d > 9 || d < 0.05) continue;
    const w = (9 - d) * (9 - d) / d;
    sx += dx * w;
    sz += dz * w;
  }
  if (sx * sx + sz * sz > 1e-4) GUARD.bear = angleApproach(GUARD.bear, Math.atan2(sx, -sz), 1.4, dt);
  const set = GUARD_SETS[n];
  let best = null,
    bc = 1e9;
  for (const perm of GUARD_PERMS[n]) {
    let c = 0,
      same = GUARD.n === n;
    for (let i = 0; i < n; i++) {
      const g = guards[i],
        cur = Math.atan2(g.x - ME.x, -(g.z - ME.z));
      const d = wrapAngle(GUARD.bear + set[perm[i]] - cur);
      c += d * d;
      if (g.postIdx !== perm[i]) same = false;
    }
    if (same) c -= 0.9; // 자리를 자꾸 바꾸지 않게
    if (c < bc) {
      bc = c;
      best = perm;
    }
  }
  for (let i = 0; i < n; i++) {
    const g = guards[i];
    g.postIdx = best[i];
    g.post = GUARD.bear + set[best[i]];
    g.sector = n === 1 ? Math.PI : Math.PI / n + 0.4;
  }
  GUARD.n = n;
  // 둘 이상 매달리면 가장 가까운 친구 하나가 먼저 떼어 주러 옴
  GUARD.helper = null;
  if (ME.clingers.length >= 2) {
    let bd = 1e9;
    for (const g of guards) {
      if (g.helpCD > 0 || g.clingers.length || g.swing) continue;
      const d = Math.hypot(g.x - ME.x, g.z - ME.z);
      if (d < bd) {
        bd = d;
        GUARD.helper = g;
      }
    }
  }
}

function guardTargetOk(t) {
  return allyTargetOk(t) && Math.hypot(t.x - ME.x, t.z - ME.z) < GUARD_REACH + 0.7;
}

function guardTarget(a) {
  let best = null,
    bs = 1e9;
  for (const p of live) {
    if (!allyTargetOk(p)) continue;
    const dx = p.x - ME.x,
      dz = p.z - ME.z,
      dm = Math.hypot(dx, dz);
    if (dm > GUARD_REACH) continue;
    if (Math.abs(wrapAngle(Math.atan2(dx, -dz) - a.post)) > a.sector) continue;
    let taken = false;
    for (const b of ALLIES)
      if (b !== a && b.target === p) {
        taken = true;
        break;
      }
    const sc = dm + Math.hypot(p.x - a.x, p.z - a.z) * 0.6 + (taken ? 1.6 : 0);
    if (sc < bs) {
      bs = sc;
      best = p;
    }
  }
  return best;
}
// 이 친구가 떼어 줄 사람: 내게 매달린 사람(가까울 때), 그리고 붙잡힌 다른 친구에게 매달린 사람
function guardHelpTarget(a) {
  let best = null,
    bd = 1e9;
  const consider = (c, limit) => {
    if (c.state !== 'cling') return;
    for (const b of ALLIES)
      if (b !== a && b.stab && b.stab.target === c) return;
    const d = Math.hypot(c.x - a.x, c.z - a.z);
    if (d < limit && d < bd) {
      bd = d;
      best = c;
    }
  };
  for (const c of ME.clingers) consider(c, 2.6);
  for (const b of ALLIES) {
    if (b === a || !b.pinned || (b.state !== 'fight' && b.state !== 'freed')) continue;
    if (Math.hypot(b.x - ME.x, b.z - ME.z) > 9) continue;
    for (const c of b.clingers) consider(c, 7);
  }
  return best;
}

function makeAlly(k) {
  return {
    k,
    def: ALLY_DEFS[k],
    grade: ALLY_LOOK[k].grade,
    state: 'off',
    isAlly: true,
    rescued: false,
    pinned: false,
    pinT: 0,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    yaw: 0,
    phase: 0,
    walk: 0,
    spd: 0,
    pose: new Float32Array(NPOSE),
    tgt: new Float32Array(NPOSE),
    slotOcc: new Array(SLOTS.length).fill(null),
    clingers: [],
    swing: null,
    stab: null,
    cd: 0,
    target: null,
    tgtT: 0,
    freeT: 0,
    five: null,
    kills: 0,
    post: 0,
    postIdx: -1,
    sector: Math.PI,
    helpCD: 0,
    helping: null,
    ready: 0,
    hideBat: false,
    hideKnife: false,
    seed: rand(0, 100),
    hx: 0,
    hy: 1.7,
    hz: 0,
  };
}
const ALLIES = [0, 1, 2, 3].map(makeAlly);
ALLIES.forEach((a) => setAllyColors(a.k, {
  shirt: a.def.shirt,
  hair: a.def.hair
}));
// 눈 반짝이: 2급은 작게 두 개, 3급은 더 작게 한 개
const ALLY_SPARKS = ALLIES.map((a) => {
  const arr = [];
  for (let i = 0; i < (a.grade === 2 ? 2 : 1); i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: starTex,
      transparent: true,
      depthWrite: false,
      fog: false
    }));
    sp.renderOrder = 5;
    sp.visible = false;
    scene.add(sp);
    arr.push(sp);
  }
  return arr;
});

function resetAllies() {
  for (const a of ALLIES) {
    a.state = 'off';
    a.slotOcc.fill(null);
    a.clingers.length = 0;
    a.rescued = false;
    a.pinned = false;
    a.pinT = 0;
    a.swing = a.stab = a.five = a.target = null;
    a.kills = 0;
    a.hideBat = a.hideKnife = false;
    a.postIdx = -1;
    a.helpCD = 0;
    a.helping = null;
    a.ready = 0;
    hideAllyInstance(a.k);
    setAllyFace(a.k, false);
    for (const sp of ALLY_SPARKS[a.k]) sp.visible = false;
  }
  flushAllies();
  ME.five = null;
  G.allyNext = 0;
  G.allyT = ALLY_AT[0];
  G.allyKills = 0;
  G.trapped = null;
  G.helped = 0;
}
const allyOn = (a) => a.state !== 'off';
const allyVol = (a) => THREE.MathUtils.clamp(1.25 - Math.hypot(a.x - ME.x, a.z - ME.z) * 0.07, 0.3, 0.85);

// ── 등장: 사람들에게 둘러싸여 붙잡힌 채로 ──
function allySpawnUpdate() {
  if (G.allyNext >= ALLIES.length) return;
  if (G.playT < G.allyT || G.playT > ALLY_LAST + (HOUSE.used ? 24 : 0)) return;
  if (ALLIES.some((a) => a.state === 'trapped' || a.state === 'freed' || a.state === 'five')) return;
  spawnTrapped(ALLIES[G.allyNext]);
  G.allyNext++;
}

function spawnTrapped(a) {
  let ang = ALLY_DIR[a.k] + rand(-0.2, 0.2);
  const r = rand(11.5, 13);
  for (let i = 0; i < 12 && houseNear(ME.x + Math.sin(ang) * r, ME.z - Math.cos(ang) * r, 3.2); i++) ang += 0.45; // 집 자리는 피해서
  a.x = ME.x + Math.sin(ang) * r;
  a.z = ME.z - Math.cos(ang) * r;
  a.vx = a.vz = 0;
  a.walk = 0;
  a.yaw = Math.atan2(ME.x - a.x, ME.z - a.z);
  a.state = 'trapped';
  a.freeT = 0;
  a.cd = 0;
  a.target = null;
  a.pose.fill(0);
  a.pose[P.HY] = M.HIP_Y;
  a.hideBat = a.hideKnife = false;
  setAllyFace(a.k, true);
  // 여섯이 매달려 있고, 셋이 더 다가오는 중
  const order = [7, 1, 2, 3, 4, 0, 5, 6];
  for (let i = 0; i < 6; i++) {
    const s = order[i];
    const p = newPerson(a.x + SLOTS[s].x, a.z + SLOTS[s].z, {
      state: 'cling',
      host: a,
      slot: s,
      yaw: Math.atan2(-SLOTS[s].x, -SLOTS[s].z)
    });
    if (!p) break;
    a.slotOcc[s] = p;
    a.clingers.push(p);
    p.speakCD = rand(0.3, 2.5);
  }
  for (let i = 0; i < 3; i++) {
    const t = rand(0, TAU),
      rr = rand(1.9, 2.7);
    const p = newPerson(a.x + Math.sin(t) * rr, a.z + Math.cos(t) * rr, {
      state: 'chase',
      host: a,
      yaw: t + Math.PI
    });
    if (p) p.speakCD = rand(0.5, 2);
  }
  G.trapped = a;
  allyAnimate(a, 1);
}

function onAllyFreed(a) {
  a.state = 'freed';
  if (G.state === 'play') a.rescued = true;
  setAllyFace(a.k, false);
  if (G.trapped === a) G.trapped = null;
}

// ── 하이파이브 ──
function startFive(a, side) {
  a.state = 'five';
  // 카메라 쪽 손으로 (오른편에 서면 왼손, 왼편에 서면 오른손)
  a.five = {
    t: 0,
    side,
    hand: side > 0 ? 'L' : 'R',
    contact: false,
    k: 0
  };
  if (a.five.hand === 'L') a.hideKnife = true;
  else a.hideBat = true;
  ME.five = {
    h: side > 0 ? 0 : 1,
    pt: new THREE.Vector3(),
    blend: 0,
    ally: a
  };
  a.vx = a.vz = 0;
  a.swing = null;
  a.stab = null;
}

function fiveSim(a, dt) {
  const f = a.five;
  f.t += dt;
  const ox = ME.x + f.side * 0.78,
    oz = ME.z + 0.05;
  a.x = approach(a.x, ox, 14, dt);
  a.z = approach(a.z, oz, 14, dt);
  a.yaw = angleApproach(a.yaw, Math.atan2(ME.x - a.x, ME.z - a.z), 16, dt);
  const m = ME.five;
  m.pt.set((ME.x + a.x) / 2, 1.6, (ME.z + a.z) / 2 + 0.08);
  const k = f.t < 0.26 ? easeOutCubic(f.t / 0.26) : f.t < 0.48 ? 1 : 1 - easeInOutSine((f.t - 0.48) / 0.36);
  m.blend = f.k = THREE.MathUtils.clamp(k, 0, 1);
  if (!f.contact && f.t >= 0.26) {
    f.contact = true;
    sfxClap();
    popBurst(m.pt.x, m.pt.y + 0.04, m.pt.z, 0.72);
    CAM.shake = Math.max(CAM.shake, 0.06);
    showToast();
  }
  if (f.t >= 0.84) {
    a.state = 'fight';
    a.five = null;
    a.hideBat = a.hideKnife = false;
    ME.five = null;
    a.cd = 0.15;
    a.tgtT = 0;
    a.fightAt = G.playT;
    G.allyT = Math.max(ALLY_AT[Math.min(G.allyNext, ALLY_AT.length - 1)], G.playT + ALLY_GAP);
  }
}

// ── 싸움 ──
function allyTargetOk(t) {
  return !!t && (t.state === 'chase' || t.state === 'press' || t.state === 'rise');
}

function startSwing(a, t) {
  a.swing = {
    t: 0,
    hit: false,
    dir: Math.atan2(t.x - a.x, t.z - a.z)
  };
  sfxSwing(screenPan(a.x, a.z), allyVol(a));
}

function allySwingHit(a) {
  const dir = a.swing.dir,
    fx = Math.sin(dir),
    fz = Math.cos(dir);
  const lx = Math.cos(dir),
    lz = -Math.sin(dir); // 휘두르는 쪽 (왼쪽)
  const hits = [];
  for (const p of live) {
    if (!allyTargetOk(p)) continue;
    const dx = p.x - a.x,
      dz = p.z - a.z,
      d = Math.hypot(dx, dz);
    if (d > 1.5 || d < 0.05) continue;
    if ((dx * fx + dz * fz) / d < 0.3) continue;
    hits.push({
      p,
      d
    });
  }
  hits.sort((u, v) => u.d - v.d);
  const n = hits.length > 1 && hits[1].d < 1.25 && Math.random() < 0.25 ? 2 : Math.min(1, hits.length);
  for (let i = 0; i < n; i++) {
    const {
      p,
      d
    } = hits[i];
    let kx = (p.x - a.x) / d * 0.75 + lx * 0.65,
      kz = (p.z - a.z) / d * 0.75 + lz * 0.65;
    const kl = Math.hypot(kx, kz) || 1;
    kx /= kl;
    kz /= kl;
    kill(p, kx, kz, 'bat', a);
  }
  if (n) CAM.shake = Math.max(CAM.shake, 0.035 * allyVol(a));
}

function allyKnife(a) {
  if (a.stab || a.cd > 0 || !a.clingers.length) return;
  a.stab = {
    t: 0,
    target: a.clingers[0],
    done: false
  };
  sfxStab(screenPan(a.x, a.z), allyVol(a) * 0.8);
}

function allyStabHit(a, c) {
  if (c.state !== 'cling') return; // 자기 몸, 내 몸, 다른 친구의 몸에 매달린 사람 모두
  if (c.host === ME) G.helped++;
  const dx = c.x - a.x,
    dz = c.z - a.z,
    d = Math.hypot(dx, dz) || 1;
  kill(c, dx / d, dz / d, 'stab', a);
  bloodSpurt(c.tx, c.ty, c.tz, -dx / d * 0.5, 0.5, -dz / d * 0.5, 8);
}

function idleFacing(a) {
  let best = null,
    bd = 64;
  for (const p of live) {
    if (!allyTargetOk(p)) continue;
    const d = (p.x - a.x) ** 2 + (p.z - a.z) ** 2;
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best ? Math.atan2(best.x - a.x, best.z - a.z) : 0;
}

function allySim(dt) {
  guardUpdate(dt);
  for (const a of ALLIES) {
    if (!allyOn(a) || a.state === 'poster') continue;
    // 함께 싸우던 친구도 여러 사람에게 오래 붙잡히면 손을 쓸 수 없다.
    // 한 명 이하로 떼어 주면 다시 자기 몸을 추스르고 싸운다.
    if (a.rescued && (a.state === 'fight' || a.state === 'freed') && G.state === 'play') {
      a.pinT = a.clingers.length >= 3 ? a.pinT + dt : Math.max(0, a.pinT - dt * 2);
      if (!a.pinned && a.pinT >= 0.6) {
        a.pinned = true;
        a.target = null;
        setAllyFace(a.k, true);
      }
      if (a.pinned && a.clingers.length <= 1) {
        a.pinned = false;
        a.pinT = 0;
        a.cd = Math.max(a.cd, 0.15);
        setAllyFace(a.k, false);
      }
    }
    if (a.state === 'freed' && G.state !== 'play') a.state = 'fight'; // 마지막 난장판에서는 하이파이브 생략
    a.cd -= dt;
    if (a.stab) {
      a.stab.t += dt;
      if (!a.stab.done && a.stab.t >= 0.1) {
        a.stab.done = true;
        allyStabHit(a, a.stab.target);
      }
      if (a.stab.t >= 0.28) {
        a.stab = null;
        a.cd = Math.max(a.cd, a.pinned ? 0.45 : 0.1);
      } // 붙잡힌 채로는 느리게
    }
    if (a.swing) {
      a.swing.t += dt;
      if (!a.swing.hit && a.swing.t >= 0.15) {
        a.swing.hit = true;
        allySwingHit(a);
      }
      if (a.swing.t >= 0.44) {
        a.swing = null;
        a.cd = Math.max(a.cd, rand(0.75, 1.1));
      }
    }
    let tx = a.x,
      tz = a.z,
      spd = 0,
      face = null,
      fiveApproach = false;
    if (a.state === 'trapped') {
      if (a.clingers.length === 0) {
        a.freeT += dt;
        if (a.freeT > 0.25) onAllyFreed(a);
      } else a.freeT = 0;
      face = Math.atan2(ME.x - a.x, ME.z - a.z);
    } else if (a.state === 'freed') {
      if (a.pinned) {
        a.target = null;
        allyKnife(a);
      } // 붙잡혀도 버둥대며 한 명씩 떼어 낸다
      else if (a.clingers.length) allyKnife(a);
      else if (!a.stab) {
        const side = a.x >= ME.x ? 1 : -1;
        tx = ME.x + side * 0.78;
        tz = ME.z + 0.05;
        spd = ME.speed * 1.6;
        fiveApproach = true;
        if (Math.hypot(tx - a.x, tz - a.z) < 0.3 && !ME.five) startFive(a, side);
      }
    } else if (a.state === 'five') {
      fiveSim(a, dt);
    } else if (a.state === 'fight') {
      // 내 주위 자리를 지키며 바깥을 봄. 다가오는 사람은 막으러 나가고, 내게 매달린 사람은 떼어 줌
      a.helpCD -= dt;
      a.helping = null;
      if (a.pinned) {
        a.target = null;
        allyKnife(a);
      } // 붙잡혀도 버둥대며 한 명씩 떼어 낸다
      else if (a.clingers.length) allyKnife(a);
      else {
        a.tgtT -= dt;
        if (a.tgtT <= 0 || !guardTargetOk(a.target)) {
          a.tgtT = rand(0.15, 0.25);
          a.target = guardTarget(a);
        }
        const t = a.target;
        const px = ME.x + Math.sin(a.post) * GUARD_R,
          pz = ME.z - Math.cos(a.post) * GUARD_R;
        const hc = (!t || GUARD.helper === a) && !a.swing && !a.stab && a.helpCD <= 0 ? guardHelpTarget(a) : null;
        if (t && !hc) {
          const d = Math.hypot(t.x - a.x, t.z - a.z);
          face = Math.atan2(t.x - a.x, t.z - a.z);
          if (d > 0.95) {
            let gx = t.x,
              gz = t.z;
            const ox = gx - ME.x,
              oz = gz - ME.z,
              ol = Math.hypot(ox, oz);
            if (ol > GUARD_LEASH) {
              gx = ME.x + ox / ol * GUARD_LEASH;
              gz = ME.z + oz / ol * GUARD_LEASH;
            }
            tx = gx;
            tz = gz;
            spd = 4.6;
          }
          if (d < 1.3 && !a.swing && !a.stab && a.cd <= 0) startSwing(a, t);
        } else if (hc) {
          // 매달린 사람의 바깥쪽에 서서 칼로 떼어 냄
          a.helping = hc;
          const ox = hc.x - ME.x,
            oz = hc.z - ME.z,
            ol = Math.hypot(ox, oz) || 1;
          tx = hc.x + ox / ol * 0.5;
          tz = hc.z + oz / ol * 0.5;
          spd = 4.8;
          face = Math.atan2(hc.x - a.x, hc.z - a.z);
          if (Math.hypot(hc.x - a.x, hc.z - a.z) < 0.78) {
            a.stab = { t: 0, target: hc, done: false };
            a.helpCD = GUARD_HELP_CD;
            sfxStab(screenPan(a.x, a.z), allyVol(a) * 0.8);
          }
        } else {
          tx = px;
          tz = pz;
          const dp = Math.hypot(px - a.x, pz - a.z);
          spd = dp > 0.12 ? Math.min(5.2, 1.2 + dp * 5) : 0;
          if (dp < 0.6) face = Math.atan2(Math.sin(a.post), -Math.cos(a.post));
        }
      }
    } else if (a.state === 'end') {
      const l = LINE[a.k];
      tx = ME.x + l[0];
      tz = ME.z + l[1];
      const d = Math.hypot(tx - a.x, tz - a.z);
      spd = d > 0.04 ? Math.min(5, d * 4) : 0;
      if (d < 0.4) face = 0;
    }
    if (a.state !== 'five') {
      let wx = 0,
        wz = 0;
      const dx = tx - a.x,
        dz = tz - a.z,
        d = Math.hypot(dx, dz);
      const mul = a.state === 'trapped' || a.pinned || a.stab ? 0 : SPEED_MUL[Math.min(a.clingers.length, SPEED_MUL.length - 1)] * (a.swing ? 0.3 : 1);
      if (d > 0.02 && spd > 0) {
        const v = Math.min(spd, d * 6) * mul;
        wx = dx / d * v;
        wz = dz / d * v;
      }
      // 움직이는 손자리의 속도도 따라가야 가까이서 감속해도 하이파이브에 닿는다.
      if (fiveApproach) {
        wx += ME.vx;
        wz += ME.vz;
      }
      if (a.state !== 'trapped' && !a.pinned) {
        const push = (ox, oz, r, k) => {
          const ex = a.x - ox,
            ez = a.z - oz,
            e = Math.hypot(ex, ez);
          if (e < r && e > 1e-4) {
            const f = (r - e) / r * k;
            wx += ex / e * f;
            wz += ez / e * f;
          }
        };
        if (a.state !== 'end') push(ME.x, ME.z, a.helping ? 0.62 : 0.95, 6);
        for (const b of ALLIES)
          if (b !== a && allyOn(b)) push(b.x, b.z, 0.9, 5);
        if (!a.clingers.length && a.state !== 'end')
          for (const p of live)
            if (p.state === 'chase' || p.state === 'press') push(p.x, p.z, 0.62, 5);
      }
      if (fiveApproach) {
        const v = Math.hypot(wx, wz),
          limit = ME.speed * 1.6;
        if (v > limit) {
          wx *= limit / v;
          wz *= limit / v;
        }
      }
      a.vx = approach(a.vx, wx, 10, dt);
      a.vz = approach(a.vz, wz, 10, dt);
      a.x += a.vx * dt;
      a.z += a.vz * dt;
      if (HOUSE.on) {
        const n = houseCollide(a, 0.3);
        if (n) {
          const vn = a.vx * n.x + a.vz * n.z;
          if (vn < 0) {
            a.vx -= vn * n.x;
            a.vz -= vn * n.z;
          }
        }
      }
    }
    a.spd = a.state === 'five' ? 0 : Math.hypot(a.vx, a.vz);
    a.phase += a.spd * dt / 0.6 * Math.PI;
    a.walk = approach(a.walk, THREE.MathUtils.clamp(a.spd / 2.6, 0, 1), 8, dt);
    // 자리를 지키고 서 있을 때는 방망이를 들고 경계 자세
    const guarding = a.state === 'fight' && !a.target && !a.helping && !a.swing && !a.stab && !a.clingers.length;
    a.ready = approach(a.ready, guarding ? 1 : 0, 6, dt);
    if (a.swing) face = a.swing.dir;
    else if (a.stab) face = Math.atan2(a.stab.target.x - a.x, a.stab.target.z - a.z);
    if (face === null) face = a.spd > 0.5 ? Math.atan2(a.vx, a.vz) : idleFacing(a);
    if (a.state !== 'five') a.yaw = angleApproach(a.yaw, face, a.swing ? 22 : a.state === 'trapped' ? 2 : 9, dt);
  }
}

// ── 자세 ──
const _aw = [0, 0];

function armToward(a, left, x, y, z) {
  const lx = left ? M.SH_X : -M.SH_X;
  const cs = Math.cos(a.yaw),
    sn = Math.sin(a.yaw);
  const sx = a.x + lx * cs,
    sz = a.z - lx * sn,
    sy = M.HIP_Y + 0.03 + M.SH_Y;
  const dx = x - sx,
    dy = y - sy,
    dz = z - sz;
  const dlx = dx * cs - dz * sn,
    dlz = dx * sn + dz * cs;
  const L = Math.hypot(dlx, dy, dlz) || 1;
  _aw[0] = -Math.acos(THREE.MathUtils.clamp(-dy / L, -1, 1));
  _aw[1] = Math.atan2(dlx, dlz);
  return _aw;
}

function allyPose(a, t, o) {
  if (a.state === 'poster') {
    posterFriendPose(a, t, o);
    return;
  }
  o.fill(0);
  const w = a.walk,
    s = Math.sin(a.phase),
    c = Math.cos(a.phase);
  const amp = 0.6 * w;
  o[P.HY] = M.HIP_Y - Math.abs(c) * 0.035 * w - 0.015 + Math.sin(t * 2.2 + a.seed) * 0.004;
  o[P.LHX] = -s * amp;
  o[P.RHX] = s * amp;
  o[P.LHZ] = 0.04;
  o[P.RHZ] = -0.04;
  o[P.LKX] = Math.max(0, c) * amp * 1.2 + 0.06;
  o[P.RKX] = Math.max(0, -c) * amp * 1.2 + 0.06;
  o[P.SX] = 0.05 + w * 0.08;
  o[P.SY] = -s * 0.08 * w;
  o[P.HX] = -0.02;
  o[P.HW] = -o[P.SY];
  // 방망이(오른손)는 살짝 들고, 칼(왼손)은 아래로
  o[P.RSX] = -0.35 + s * 0.25 * w;
  o[P.RSZ] = -0.22;
  o[P.REX] = -0.55;
  o[P.LSX] = -0.15 - s * 0.25 * w;
  o[P.LSZ] = 0.14;
  o[P.LEX] = -0.35;
  if (a.state === 'trapped' || a.pinned) {
    // 붙잡혀서 버둥
    const k1 = Math.sin(t * 9.5 + a.seed),
      k2 = Math.sin(t * 6.3 + a.seed * 2),
      k3 = Math.sin(t * 13 + a.seed);
    o[P.SY] = k1 * 0.32;
    o[P.SZ] = k2 * 0.12;
    o[P.SX] = 0.12 + k3 * 0.05;
    o[P.HW] = -k1 * 0.45;
    o[P.HZ] = k2 * 0.2;
    o[P.HX] = -0.12;
    o[P.RSX] = 0.15 + k2 * 0.15;
    o[P.RSZ] = -0.1 - Math.abs(k1) * 0.14;
    o[P.REX] = -0.25;
    o[P.LSX] = 0.15 - k2 * 0.15;
    o[P.LSZ] = 0.1 + Math.abs(k1) * 0.14;
    o[P.LEX] = -0.25;
    o[P.HY] = M.HIP_Y - 0.03 + Math.abs(k3) * 0.02;
    o[P.LKX] = 0.15 + Math.max(0, k1) * 0.2;
    o[P.RKX] = 0.15 + Math.max(0, -k1) * 0.2;
  }
  if (a.ready > 0.01) {
    const k = a.ready * (1 - a.walk * 0.6);
    o[P.RSX] = THREE.MathUtils.lerp(o[P.RSX], -0.85, k);
    o[P.RSZ] = THREE.MathUtils.lerp(o[P.RSZ], -0.5, k);
    o[P.REX] = THREE.MathUtils.lerp(o[P.REX], -1.55, k);
    o[P.LSX] = THREE.MathUtils.lerp(o[P.LSX], -0.55, k);
    o[P.LSZ] = THREE.MathUtils.lerp(o[P.LSZ], 0.3, k);
    o[P.LEX] = THREE.MathUtils.lerp(o[P.LEX], -1.1, k);
    o[P.HY] -= 0.045 * k;
    o[P.LKX] += 0.2 * k;
    o[P.RKX] += 0.2 * k;
    o[P.LHX] -= 0.12 * k;
    o[P.RHX] -= 0.12 * k;
    o[P.LHZ] += 0.08 * k;
    o[P.RHZ] -= 0.08 * k;
    o[P.SX] += 0.1 * k;
    o[P.HW] += Math.sin(t * 0.8 + a.seed) * 0.4 * k;
  }
  if (a.state === 'end') {
    o[P.SX] = 0;
    o[P.HX] = 0;
    o[P.HW] = 0;
    o[P.SY] = 0;
    o[P.RSX] = -0.12;
    o[P.RSZ] = -0.12;
    o[P.REX] = -0.3;
    o[P.LSX] = -0.08;
    o[P.LSZ] = 0.1;
    o[P.LEX] = -0.3;
  }
  if (a.swing) {
    const k = THREE.MathUtils.clamp(a.swing.t / 0.44, 0, 1);
    let sw;
    if (k < 0.3) sw = -easeOutCubic(k / 0.3);
    else if (k < 0.55) sw = -1 + 2.15 * easeInQuad((k - 0.3) / 0.25);
    else sw = THREE.MathUtils.lerp(1.15, 0.6, easeInOutSine((k - 0.55) / 0.45));
    o[P.RSX] = -1.4;
    o[P.RSZ] = 0;
    o[P.RSY] = sw * 1.25 - 0.1;
    o[P.REX] = -0.25 + Math.abs(sw) * 0.1;
    o[P.SY] = sw * 0.55;
    o[P.HW] = -sw * 0.4;
    o[P.SX] = 0.12;
    o[P.LSX] = -0.5;
    o[P.LSZ] = 0.35;
    o[P.HY] = M.HIP_Y - 0.05;
    o[P.LKX] += 0.2;
    o[P.RKX] += 0.2;
    o[P.LHX] -= 0.1;
    o[P.RHX] -= 0.1;
  }
  if (a.stab) {
    const k = THREE.MathUtils.clamp(a.stab.t / 0.28, 0, 1);
    const ext = Math.sin(Math.min(1, k * 1.7) * Math.PI * 0.5) * (1 - Math.max(0, k - 0.6) / 0.4);
    const tp = a.stab.target;
    const r = armToward(a, true, tp.tx, tp.ty - 0.05, tp.tz);
    o[P.LSX] = THREE.MathUtils.lerp(-0.6, r[0], ext);
    o[P.LSY] = THREE.MathUtils.lerp(0, r[1], ext);
    o[P.LSZ] = 0;
    o[P.LEX] = THREE.MathUtils.lerp(-1.6, -0.1, ext);
    o[P.SY] = 0.25 * ext;
    o[P.SX] = 0.2;
  }
  if (a.five && ME.five) {
    const f = a.five,
      k = f.k,
      pt = ME.five.pt,
      L = f.hand === 'L';
    const r = armToward(a, L, pt.x, pt.y, pt.z);
    if (L) {
      o[P.LSX] = THREE.MathUtils.lerp(o[P.LSX], r[0], k);
      o[P.LSY] = THREE.MathUtils.lerp(0, r[1], k);
      o[P.LSZ] = THREE.MathUtils.lerp(o[P.LSZ], 0, k);
      o[P.LEX] = THREE.MathUtils.lerp(o[P.LEX], -0.12, k);
    } else {
      o[P.RSX] = THREE.MathUtils.lerp(o[P.RSX], r[0], k);
      o[P.RSY] = THREE.MathUtils.lerp(0, r[1], k);
      o[P.RSZ] = THREE.MathUtils.lerp(o[P.RSZ], 0, k);
      o[P.REX] = THREE.MathUtils.lerp(o[P.REX], -0.12, k);
    }
    o[P.SZ] = (L ? -1 : 1) * 0.1 * k;
    o[P.SX] = 0.02;
  }
}

function allyAnimate(a, dt) {
  allyPose(a, G.t, a.tgt);
  const rate = a.swing || a.stab || a.five ? 30 : 16;
  for (let i = 0; i < NPOSE; i++) a.pose[i] = approach(a.pose[i], a.tgt[i], rate, dt);
  a.pose[P.LIFT] = 0;
  applyRig(HR, a.pose, a.x, a.z, a.yaw);
  if (a.state === 'poster') {
    const T = POSTER.C.fr;
    if (T.bat) pointWrist(HR.wrR, BAT_DIR, T.bat, a.yaw);
    if (T.kn) pointWrist(HR.wrL, TOOL_DOWN, T.kn, a.yaw, KNIFE_FACE);
  } else if (HR.wrR.quaternion.w !== 1 || HR.wrL.quaternion.w !== 1) {
    resetWrists();
    HR.root.updateMatrixWorld(true);
  }
  for (const part of HS.parts) {
    let hide = false;
    if (part.toggle === 'hairA') hide = a.def.bob;
    else if (part.toggle === 'hairB') hide = !a.def.bob;
    else if (part.toggle === 'bat') hide = a.hideBat;
    else if (part.toggle === 'knife') hide = a.hideKnife;
    part.m.setMatrixAt(a.k, hide ? _zeroM : HR[part.node].matrixWorld);
  }
  _hv.set(0, M.HEAD_UP + 0.1, 0).applyMatrix4(HR.neck.matrixWorld);
  a.hx = _hv.x;
  a.hy = _hv.y;
  a.hz = _hv.z;
  const sps = ALLY_SPARKS[a.k];
  const camD = camera.position.distanceTo(_hv);
  const base = THREE.MathUtils.lerp(0.06, 0.17, THREE.MathUtils.clamp((camD - 1) / 18, 0, 1)) * (a.grade === 2 ? 0.62 : 0.45);
  sps.forEach((sp, i) => {
    const sx = sps.length === 2 ? (i ? 1 : -1) : 1;
    _hv.set(sx * 0.104 - 0.012, M.HEAD_UP + 0.028, M.HEAD_R + 0.03).applyMatrix4(HR.neck.matrixWorld);
    sp.position.copy(_hv);
    sp.scale.setScalar(base * (0.75 + 0.35 * Math.sin(G.t * 5.5 + i * 2.1 + a.seed)));
    sp.material.rotation = G.t * 0.6 + i + a.seed;
    sp.visible = a.state !== 'trapped'; // 버둥댈 땐 눈을 질끈 감고 있음
  });
}

function alliesAnimate(dt) {
  let any = false;
  for (const a of ALLIES)
    if (allyOn(a)) {
      allyAnimate(a, dt);
      any = true;
    }
  if (any) flushAllies();
}

// ───────────────────────── 말풍선 ─────────────────────────
const bubbleLayer = $('bubbles');
const bubbles = new Set();

function bubbleCount() {
  let n = 0;
  for (const b of bubbles)
    if (!b.ending) n++;
  return n;
}

function pleaBubbleTick(p, dt, d) {
  // 말풍선은 음성 슬롯이 차 있어도 표시하되, 게임의 난수는 소비하지 않는다.
  p.pleaCD = Math.max(0, (p.pleaCD || 0) - dt);
  if (p.pleaCD > 0 || d > 14 || (p.bubble && !p.bubble.ending)) return;
  const cling = p.state === 'cling', mine = p.host === ME;
  if (cling && mine && !p.socialPlea) return;
  if (!onScreen(p.hx, p.hy + 0.18, p.hz) || _sc.y < 56 || _sc.y > VH - 55 || _sc.x < 4 || _sc.x > VW - 4) return;
  if (houseHides(p.hx, p.hy + 0.18, p.hz)) return;
  if (bubbleCount() >= (cling ? 4 : 5)) return;
  if (p.bubble) removeBubble(p.bubble);
  const txt = cling ? '친구해주세요…' : (p.kind === 1 ? '친구해주세요!' : '친구해주세요…');
  p.bubble = makeBubble(p, txt, null, 'plea', 1.4);
  p.pleaCD = 2 + (p.seed % 1);
}

function makeBubble(owner, text, voice, cls = '', fixedDur = 0) {
  const wrap = document.createElement('div');
  wrap.className = 'bwrap';
  const el = document.createElement('div');
  el.className = 'bubble ' + cls;
  wrap.appendChild(el);
  bubbleLayer.appendChild(wrap);
  const b = {
    owner,
    text,
    voice,
    wrap,
    el,
    t: 0,
    dur: voice ? voice.dur : fixedDur,
    shown: 0,
    plea: cls === 'plea',
    ending: false,
    et: 0
  };
  bubbles.add(b);
  return b;
}

function removeBubble(b) {
  b.wrap.remove();
  bubbles.delete(b);
  if (b.owner && b.owner.bubble === b) b.owner.bubble = null;
}

function cutBubble(b) {
  if (b.ending) return;
  b.ending = true;
  b.et = 0;
  if (b.shown < b.text.length - 1) {
    b.el.textContent = b.text.slice(0, Math.max(1, b.shown)) + '—';
    b.el.classList.add('cut');
  } else b.el.classList.add('fade');
}

function fadeBubble(b) {
  if (b.ending) return;
  b.ending = true;
  b.et = 0;
  b.el.classList.add('fade');
}

function clearBubbles() {
  for (const b of [...bubbles]) removeBubble(b);
}
const _bs = {
  x: 0,
  y: 0,
  z: 0
};

function updateBubbles(dt) {
  for (const b of [...bubbles]) {
    b.t += dt;
    if (b.ending) {
      b.et += dt;
      if (b.et > 0.55) {
        removeBubble(b);
        continue;
      }
    } else {
      const prog = b.voice ? b.voice.progress() : THREE.MathUtils.clamp(b.t / b.dur, 0, 1);
      const n = b.instant ? b.text.length : THREE.MathUtils.clamp(Math.floor(prog * 1.12 * b.text.length) + 1, 1, b.text.length);
      if (n !== b.shown) {
        b.shown = n;
        b.el.textContent = b.text.slice(0, n);
      }
      if (b.t > b.dur + 0.45 || (b.voice && b.voice.stopped && b.t > 0.2 && b.shown >= b.text.length)) fadeBubble(b);
    }
    const o = b.owner;
    if (!o) continue;
    const y = o === ME ? 1.75 : o.hy + 0.18;
    const x = o === ME ? ME.x : o.hx,
      z = o === ME ? ME.z : o.hz;
    toScreen(x, y, z, _bs);
    if (b.plea && (_bs.z < -1 || _bs.z > 1 || _bs.x < -40 || _bs.x > VW + 40 || _bs.y < 0 || _bs.y > VH + 40)) {
      removeBubble(b);
      continue;
    }
    if (_bs.z > 1 || (o !== ME && houseHides(x, y, z))) {
      b.wrap.style.visibility = 'hidden';
      continue;
    }
    b.wrap.style.visibility = '';
    if (b.wcache !== b.shown) {
      b.wcache = b.shown;
      b.hw = b.el.offsetWidth / 2;
    }
    const bx = THREE.MathUtils.clamp(_bs.x, b.hw + 6, VW - b.hw - 6);
    const by = Math.max(_bs.y, b.instant ? b.el.offsetHeight + 14 : 44);
    b.wrap.style.transform = `translate3d(${bx.toFixed(1)}px, ${by.toFixed(1)}px, 0)`;
  }
}

// ───────────────────────── HUD ─────────────────────────
const killEl = $('killN');

function hudKill() {
  killEl.textContent = G.kills;
  killEl.classList.remove('pop');
  void killEl.offsetWidth;
  killEl.classList.add('pop');
}

function showSub(text) {
  const s = $('sub');
  s.textContent = text;
  s.hidden = false;
}

function hideSub() {
  $('sub').hidden = true;
}

// 친구를 새로 사귀면 화면 위에 SNS 알림처럼
const toastEl = $('toast');
let toastTimer = 0;

function showToast() {
  noticeFriendship();
  toastEl.hidden = false;
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  sfxChime();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    toastEl.classList.remove('show');
  }, 3300);
}

function hideToast() {
  clearTimeout(toastTimer);
  toastEl.hidden = true;
  toastEl.classList.remove('show');
}
// 알림을 누르면 사라짐. 누른 손가락이 밑의 소리 버튼까지 누르지 않게 click에서 닫는다
toastEl.addEventListener('pointerdown', (e) => e.stopPropagation());
toastEl.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  hideToast();
});

// 붙잡혀 위험할 때: 발밑 고리 + 화면 가장자리 붉은 기운 + 심장 소리
const dangerEl = $('danger');
let heartT = 0, dangerOp = -1;

function dangerFx(dt) {
  const k = THREE.MathUtils.clamp(G.danger / DANGER_T, 0, 1);
  const on = G.state === 'play' && k > 0.003;
  dangerRing.visible = on;
  if (on) {
    dangerRing.position.set(ME.x, 0.025, ME.z);
    dangerRing.material.uniforms.uProg.value = k;
    dangerRing.material.uniforms.uAlpha.value = Math.min(1, k * 8);
  }
  const op = on ? Math.round(k * (0.62 + 0.38 * Math.sin(G.t * (6 + k * 9))) * 100) / 100 : 0;
  if (op !== dangerOp) {
    dangerOp = op;
    dangerEl.style.opacity = op;
  }
  if (on && k > 0.02) {
    heartT -= dt;
    if (heartT <= 0) {
      heartT = THREE.MathUtils.lerp(0.8, 0.38, k);
      sfxHeart(0.45 + 0.55 * k);
    }
  } else heartT = 0;
}

// 끝: 붙잡힌 채로 버티면 — 반짝, 칼로 매달린 사람부터, 쌍권총으로 주변을 다 쓸어버린 뒤 "싫어."
function startOutburst() {
  if (G.state !== 'play') return;
  sgDiscard(true);
  for (const a of ALLIES)
    if (a.state === 'trapped' && !a.clingers.length) a.rescued = true;
  G.state = 'over';
  G.ctrl = false;
  G.firing = false;
  G.freeze = true;
  G.spawnDone = true;
  clearItems();
  weaponUp();
  weaponEl.classList.remove('down', 'pulse');
  weaponEl.hidden = true;
  $('hint').hidden = true;
  stickEl.hidden = true;
  stickId = null;
  G.stick.x = G.stick.z = 0;
  arrowEl.hidden = true;
  arrowShown = false;
  musicStop(true);
  ME.five = null;
  for (const a of ALLIES) {
    if (a.state === 'five') {
      a.state = 'fight';
      a.five = null;
      a.hideBat = a.hideKnife = false;
    } else if (a.state === 'freed') a.state = 'fight';
  }
  CAM.zoomTo = 0.58;
  CAM.shake = Math.max(CAM.shake, 0.05);
  G.burst = {
    t: 0,
    phase: 'hold',
    cd: 0,
    doneT: -1
  };
  runSeq([
    [0.8, () => {
      bigSparkle();
      sfxSparkle(1);
    }],
    [1.25, () => {
      G.burst.phase = 'knife';
      G.burst.cd = 0;
    }],
    [2.05, () => {
      if (G.burst.phase === 'knife') {
        G.burst.phase = 'guns';
        G.burst.cd = 0;
        CAM.zoomTo = 1.12;
      }
    }],
  ]);
}

// 갇힌 동료 쪽을 가리키는 화살표 (글자 없음)
const arrowEl = $('arrow'),
  rescueNoticeEl = $('rescueNotice');
let arrowShown = false;
let arrowTarget = null;
const _as = {
  x: 0,
  y: 0,
  z: 0
},
 _as2 = {
   x: 0,
   y: 0,
   z: 0
 };

function updateArrow() {
  const pinned = ALLIES.filter((a) => a.rescued && a.pinned && a.clingers.length > 1 && a.pinT > 2.6);
  const urgent = G.state === 'play' && pinned.length > 0;
  let a = urgent ? (pinned.includes(arrowTarget) ? arrowTarget : pinned.reduce((best, p) => !best || Math.hypot(p.x - ME.x, p.z - ME.z) < Math.hypot(best.x - ME.x, best.z - ME.z) ? p : best, null)) : G.trapped;
  let want = !!a && (urgent || a.state === 'trapped') && G.state === 'play';
  if (!want && G.state === 'play' && HOUSE.on && !HOUSE.used) {
    a = HOUSE.arrow;
    want = true;
  }
  rescueNoticeEl.hidden = !urgent;
  arrowEl.classList.toggle('urgent', urgent);
  if (!want) {
    arrowTarget = null;
    if (arrowShown) {
      arrowEl.hidden = true;
      arrowShown = false;
    }
    return;
  }
  arrowTarget = a;
  if (!arrowShown) {
    arrowEl.hidden = false;
    arrowShown = true;
    arrowEl.classList.remove('in');
    void arrowEl.offsetWidth;
    arrowEl.classList.add('in');
  }
  const bob = Math.sin(G.t * 7.5) * 6;
  const m = 34,
    top = 84,
    bottom = VH - 150;
  toScreen(a.x, a.hy + 0.5, a.z, _as);
  let x, y, ang;
  if (_as.z < 1 && _as.x > m && _as.x < VW - m && _as.y > top && _as.y < bottom) {
    x = _as.x;
    y = _as.y - 16 + bob;
    ang = Math.PI;
  } else {
    toScreen(ME.x, 1.0, ME.z, _as);
    const ox = _as.x,
      oy = _as.y;
    const dxw = a.x - ME.x,
      dzw = a.z - ME.z,
      L = Math.hypot(dxw, dzw) || 1;
    toScreen(ME.x + dxw / L * 2, 1.0, ME.z + dzw / L * 2, _as2);
    let dx = _as2.x - ox,
      dy = _as2.y - oy;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl;
    dy /= dl;
    let t = 1e9;
    if (dx > 1e-4) t = Math.min(t, (VW - m - ox) / dx);
    else if (dx < -1e-4) t = Math.min(t, (m - ox) / dx);
    if (dy > 1e-4) t = Math.min(t, (bottom - oy) / dy);
    else if (dy < -1e-4) t = Math.min(t, (top - oy) / dy);
    t = Math.max(0, t);
    x = THREE.MathUtils.clamp(ox + dx * (t - 6 - bob), m, VW - m);
    y = THREE.MathUtils.clamp(oy + dy * (t - 6 - bob), top, bottom);
    ang = Math.atan2(dx, -dy);
  }
  arrowEl.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${ang.toFixed(3)}rad)`;
}

// ───────────────────────── 입력 ─────────────────────────
const stickEl = $('stick'), knobEl = stickEl.querySelector('.knob')
const STICK_R = 56;
let stickId = null,
  sx0 = 0,
  sy0 = 0;

function stickShow(x, y) {
  stickEl.hidden = false;
  stickEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  knobEl.style.transform = 'translate(0px, 0px)';
}

function stickMove(e) {
  let dx = e.clientX - sx0, dy = e.clientY - sy0;
  const l = Math.hypot(dx, dy);
  if (l > STICK_R) {
    // 손가락이 멀리 가면 받침도 따라감
    const over = l - STICK_R;
    sx0 += dx / l * over;
    sy0 += dy / l * over;
    dx = e.clientX - sx0;
    dy = e.clientY - sy0;
    stickEl.style.transform = `translate3d(${sx0}px, ${sy0}px, 0)`;
  }
  knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
  G.stick.x = dx / STICK_R;
  G.stick.z = dy / STICK_R;
  if (Math.hypot(dx, dy) > 10) gotMove();
}
// 실제로 터치가 들어오면 터치 모드로 (키보드 안내 숨김)
window.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch' && !IS_TOUCH) {
    IS_TOUCH = true;
    document.body.classList.remove('desk');
    const h = $('hint');
    if (!h.hidden) h.classList.remove('keys');
  }
}, true);
canvas.addEventListener('pointerdown', (e) => {
  if (!G.ctrl || stickId !== null) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  stickId = e.pointerId;
  sx0 = e.clientX;
  sy0 = e.clientY;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch { }
  stickShow(sx0, sy0);
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId === stickId) stickMove(e);
});

function stickEnd(e) {
  if (e.pointerId !== stickId) return;
  stickId = null;
  G.stick.x = 0;
  G.stick.z = 0;
  stickEl.hidden = true;
}
canvas.addEventListener('pointerup', stickEnd);
canvas.addEventListener('pointercancel', stickEnd);
canvas.addEventListener('lostpointercapture', stickEnd);
window.addEventListener('contextmenu', (e) => e.preventDefault());

const weaponEl = $('weapon');
let weaponId = null;
weaponEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  weaponId = e.pointerId;
  try {
    weaponEl.setPointerCapture(e.pointerId);
  } catch { }
  weaponEl.classList.add('down');
  weaponDown();
});

function weaponRelease(e) {
  if (e.pointerId !== weaponId) return;
  weaponId = null;
  weaponEl.classList.remove('down');
  weaponUp();
}
weaponEl.addEventListener('pointerup', weaponRelease);
weaponEl.addEventListener('pointercancel', weaponRelease);
weaponEl.addEventListener('lostpointercapture', weaponRelease);

const KEYS = new Set();
const MOVE_KEYS = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0]
};
const FIRE_KEYS = new Set(['Space', 'KeyJ', 'KeyK', 'Enter', 'NumpadEnter']);

function keysToVec() {
  let x = 0,
    z = 0;
  for (const k of KEYS) {
    const v = MOVE_KEYS[k];
    if (v) {
      x += v[0];
      z += v[1];
    }
  }
  const l = Math.hypot(x, z);
  G.keys.x = l ? x / l : 0;
  G.keys.z = l ? z / l : 0;
  if (l) gotMove();
}
const modMenu = $('modMenu');
const modClose = $('modClose');
const modInfinite = $('modInfinite');
const modRecoil = $('modRecoil');
const aimbot = $('aimbot');
const modAuto = $('modAuto');
const silencer = $('silencer');
const modNoclip = $('modNoclip');
const modAllPowers = $('modAllPowers');
const modMenuBtn = $('modmenubtn');

function setModMenu(open) {
  modMenu.hidden = !open;
}

function syncMainMods() {
  GAME_MOD.infiniteAmmo = modInfinite.checked;
  GAME_MOD.noRecoil = modRecoil.checked;
  GAME_MOD.aimbot = aimbot.checked;
  GAME_MOD.auto = modAuto.checked;
  GAME_MOD.silencer = silencer.checked;
  GAME_MOD.noclip = modNoclip.checked;
  const wasAllPowers = GAME_MOD.allPowers;
  GAME_MOD.allPowers = modAllPowers.checked;
  if (GAME_MOD.infiniteAmmo && SG.on) {
    SG.dropT = -1;
    sgBadge(true);
  }
  if (GAME_MOD.allPowers) for (const def of ITEM_DEFS) POWERS[def.key] = Infinity;
  else if (wasAllPowers) for (const def of ITEM_DEFS) POWERS[def.key] = ITEM_DURATION;
  updateItemStatus();
}
for (const control of [modInfinite, modRecoil, aimbot, modAuto, modNoclip, modAllPowers, silencer]) control.addEventListener('change', syncMainMods);
modClose.addEventListener('click', () => setModMenu(false));
$('modRepel').addEventListener('click', () => G.modRepelT = 5);
$('killAll').addEventListener('click', () => {
  for (const p of [...live]) kill(p, 0, 1, 'shot');
});
modMenuBtn.addEventListener('click', () => setModMenu(modMenu.hidden));
modMenuBtn.style.display = IS_TOUCH ? 'block' : 'none';

window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') {
    e.preventDefault();
    setModMenu(modMenu.hidden);
    return;
  }
  if (modMenu.contains(e.target) && e.target.matches('input')) return;
  if (e.repeat && !MOVE_KEYS[e.code]) return;
  if (MOVE_KEYS[e.code]) {
    KEYS.add(e.code);
    keysToVec();
    e.preventDefault();
  } else if (FIRE_KEYS.has(e.code)) {
    if (G.state === 'play') {
      e.preventDefault();
      if (!e.repeat || GAME_MOD.aimbot) {
        weaponEl.classList.add('down');
        weaponDown();
      }
    }
  } else if (e.code === 'KeyM') setMuted(!MUTED);
  if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) {
    if (G.state === 'title' && !$('start').disabled) {
      e.preventDefault();
      startIntro();
    } else if (G.state === 'end') {
      e.preventDefault();
      restart();
    }
  }
});
window.addEventListener('keyup', (e) => {
  if (MOVE_KEYS[e.code]) {
    KEYS.delete(e.code);
    keysToVec();
  } else if (FIRE_KEYS.has(e.code)) {
    weaponEl.classList.remove('down');
    weaponUp();
  }
});
window.addEventListener('blur', () => {
  KEYS.clear();
  keysToVec();
  weaponUp();
  weaponEl.classList.remove('down');
});

function gotMove() {
  if (!G.movedOnce && G.ctrl) {
    G.movedOnce = true;
    $('hint').hidden = true;
  }
}

// ───────────────────────── 타이틀 포스터 ─────────────────────────
// 총을 든 나와 방망이를 든 친구(2급)가 나란히 서 있고, 울면서 손을 뻗는 사람들이 둘러싼 구도
const POSTER = {
  on: false,
  victim: null,
  aimPt: new THREE.Vector3(),
  C: null,
  camPos: new THREE.Vector3(),
  camLook: new THREE.Vector3(),
  fov: 32,
  fogNear: 6,
  fogFar: 22,
  dist: 5,
  tanH: 0.5,
  T: {
    // 나: 왼손 총으로 오른쪽 사람을 겨누고, 오른손 총은 얼굴 옆에 세워 듦 (aim: 겨누는 손 0 왼손, 1 오른손, -1 없음)
    me: {
      x: 0.3,
      z: 0.12,
      yaw: 0.1,
      sy: 0.2,
      sz: 0.0,
      hw: -0.26,
      hx: -0.08,
      hz: -0.06,
      aim: 0,
      L: { sx: -0.3, sy: 0, sz: 0.7, ex: -2.5, ez: 1.1, gun: [0.1, 1, 0.05] },
      R: { sx: -0.3, sy: 0, sz: -0.7, ex: -2.5, ez: -1.1, gun: [-0.6, 1, 0.1] }
    },
    // 친구: 오른손 방망이를 어깨 위로 들고, 왼손 칼은 앞으로
    fr: {
      x: -0.36,
      z: -0.26,
      yaw: -0.3,
      sy: -0.1,
      sz: 0.0,
      hw: 0.3,
      hx: -0.06,
      hz: 0.05,
      r: { sx: -0.5, sy: 0, sz: -0.9, ex: -2.2, ez: 0 },
      l: { sx: -0.6, sy: 0, sz: 0.15, ex: -1.3, ez: 0 },
      bat: [-0.6, 1, -0.2],
      kn: [0.5, -0.2, 0.8],
      knife: true
    },
    victim: {
      k: 0.62,
      z: -1.9
    },
    // 카메라: 화각, 내려다보는 각, 두 사람이 들어갈 화면 높이(위·아래, -1~1)
    cam: {
      fov: 36,
      pitch: 16,
      top: 0.64,
      bot: -0.44,
      lookY: 1.15
    },
    clear: {
      x: 1.15,
      z: -3.0
    },
    fog: {
      near: 1.0,
      far: 12
    },
    nearZ: -0.9,
    seed: 41793,
    // 세로 화면: 친구가 반 걸음 뒤에 서고, 나는 두 총을 모두 세워 듦 (팔을 옆으로 뻗으면 두 사람이 작아짐)
    port: {
      me: {
        x: 0.16,
        z: 0.2,
        yaw: 0.05,
        sy: 0.05,
        hw: -0.08,
        aim: -1,
        L: { gun: [0.9, 0.6, 0.2] },
        R: { gun: [-0.9, 0.6, 0.2] }
      },
      fr: {
        x: -0.34,
        z: -0.48,
        yaw: -0.2
      },
      cam: {
        fov: 36,
        pitch: 20,
        top: 0.42,
        bot: -0.62
      },
    },
    // 가로 화면: 양옆 사람들을 한 줄 뒤로 물려 두 사람이 더 커 보이게
    land: {
      clear: {
        x: 1.4,
        z: -2.6
      },
      nearZ: -1.6,
    },
  },
};
POSTER.T0 = JSON.parse(JSON.stringify(POSTER.T));
// 손에 든 물건이 원하는 쪽을 향하도록 손목을 돌림 (포스터 전용, 놀이 중에는 손목을 돌리지 않음)
const BAT_DIR = new THREE.Vector3(0, -0.818, 0.574).normalize(),
  TOOL_DOWN = new THREE.Vector3(0, -1, 0);
const _wq = new THREE.Quaternion(),
  _wd = new THREE.Vector3();
const GUN_SIDE = new THREE.Vector3(1, 0, 0),
  KNIFE_FACE = new THREE.Vector3(0, 0, 1);
const _wm = new THREE.Matrix4(),
  _wn = new THREE.Matrix4(),
  _wsd = new THREE.Vector3(),
  _wu = new THREE.Vector3(),
  _wtu = new THREE.Vector3(),
  _wp = new THREE.Vector3();
// side: 물건의 옆면 축. 주면 그 옆면이 카메라를 보도록 돌려서 모양이 잘 보이게 함
function pointWrist(wr, tool, dir, yaw, side) {
  _wd.set(dir[0], dir[1], dir[2]).normalize().applyAxisAngle(_up, yaw);
  wr.parent.getWorldQuaternion(_wq);
  if (side) {
    wr.getWorldPosition(_wp);
    _wsd.subVectors(POSTER.camPos, _wp).normalize();
    _wsd.addScaledVector(_wd, -_wsd.dot(_wd)).normalize();
    _wu.crossVectors(_wd, _wsd);
    _wtu.crossVectors(tool, side);
    _wm.makeBasis(_wd, _wsd, _wu);
    _wn.makeBasis(tool, side, _wtu).transpose();
    _wm.multiply(_wn);
    wr.quaternion.setFromRotationMatrix(_wm).premultiply(_wq.invert());
  } else {
    _wd.applyQuaternion(_wq.invert());
    wr.quaternion.setFromUnitVectors(tool, _wd);
  }
  wr.updateMatrixWorld(true);
}

function resetWrists() {
  for (const R of [MR, HR]) {
    R.wrL.quaternion.identity();
    R.wrR.quaternion.identity();
  }
}

const _pc = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
const _pv = new THREE.Vector3();
// 세로로 길거나 정사각형에 가까운 화면은 세로 구도
const posterPort = () => VW / VH < 1.2;
// 두 사람(무릎부터 머리 위까지)이 화면의 정해진 칸에 들어오도록 거리와 시점을 맞춤
function posterCamFit() {
  const K = POSTER.C.cam,
    a = VW / VH;
  const fov = K.fov,
    pitch = THREE.MathUtils.degToRad(K.pitch),
    top = K.top,
    bot = K.bot;
  const side = posterPort() ? 0.95 : 0.8;
  const me = POSTER.C.me,
    fr = POSTER.C.fr;
  // 총을 뻗은 쪽은 팔 길이만큼 더 넓게
  const x0 = Math.min(me.x, fr.x) - (me.aim === 1 ? 0.9 : 0.6),
    x1 = Math.max(me.x, fr.x) + (me.aim === 0 ? 0.9 : 0.6);
  const box = [];
  for (const x of [x0, x1])
    for (const y of [0.4, 1.95])
      for (const z of [0.2, -0.35]) box.push([x, y, z]);
  _pc.fov = fov;
  _pc.aspect = a;
  _pc.updateProjectionMatrix();
  const look = new THREE.Vector3((x0 + x1) / 2, K.lookY, -0.05);
  const place = (d) => {
    _pc.position.set(look.x, look.y + Math.sin(pitch) * d, look.z + Math.cos(pitch) * d);
    _pc.lookAt(look);
    _pc.updateMatrixWorld();
  };
  const measure = () => {
    const r = {
      x0: 9,
      x1: -9,
      y0: 9,
      y1: -9
    };
    for (const c of box) {
      _pv.set(c[0], c[1], c[2]).project(_pc);
      r.x0 = Math.min(r.x0, _pv.x);
      r.x1 = Math.max(r.x1, _pv.x);
      r.y0 = Math.min(r.y0, _pv.y);
      r.y1 = Math.max(r.y1, _pv.y);
    }
    return r;
  };
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  let d = 5;
  for (let it = 0; it < 4; it++) {
    let lo = 1.2,
      hi = 60;
    for (let i = 0; i < 32; i++) {
      const m = (lo + hi) / 2;
      place(m);
      const r = measure();
      if (r.y1 - r.y0 <= top - bot && r.x1 - r.x0 <= side * 2) hi = m;
      else lo = m;
    }
    d = hi;
    place(d);
    const r = measure();
    look.y += ((r.y0 + r.y1) / 2 - (top + bot) / 2) * tanV * d;
    look.x += ((r.x0 + r.x1) / 2) * tanV * a * d;
  }
  place(d);
  POSTER.camPos.copy(_pc.position);
  POSTER.camLook.copy(look);
  POSTER.fov = fov;
  POSTER.dist = d;
  POSTER.tanH = tanV * a;
  POSTER.fogNear = d + POSTER.C.fog.near;
  POSTER.fogFar = d + POSTER.C.fog.far;
}

function posterCrowd() {
  POSTER.victim = null;
  const rnd = seeded(POSTER.C.seed);
  const me = POSTER.C.me, fr = POSTER.C.fr, V = POSTER.C.victim;
  const cx = (me.x + fr.x) / 2, cz = (me.z + fr.z) / 2;
  const heroes = [
    [me.x, me.z],
    [fr.x, fr.z]
  ];
  const camZ = POSTER.camPos.z,
    tanH = POSTER.tanH;
  const pts = [];
  const free = (x, z, r) => !pts.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < r * r) && !heroes.some((h) => (h[0] - x) ** 2 + (h[1] - z) ** 2 < 0.72 * 0.72);
  // 내가 겨누는 사람: 총을 뻗은 쪽, 나보다 조금 뒤
  if (me.aim >= 0) pts.push({
    x: cx + (me.aim === 1 ? -1 : 1) * tanH * (camZ - V.z) * V.k,
    z: V.z,
    pv: 0
  });
  let z = POSTER.C.nearZ,
    row = 0;
  while (z > -15.5 && pts.length < 96) {
    const half = tanH * (camZ - z) * 1.04 + 0.4;
    const sp = 0.72 + (cz - z) * 0.06;
    const off = (row % 2) * sp * 0.5;
    for (let x = cx - half + off; x <= cx + half; x += sp) {
      const px = x + (rnd() - 0.5) * sp * 0.6, pz = z + (rnd() - 0.5) * 0.45;
      const r = rnd();
      // 두 사람 바로 뒤 가까운 곳은 비움
      if (pz > POSTER.C.clear.z && Math.abs(px - cx) < POSTER.C.clear.x) continue;
      if (!free(px, pz, 0.66)) continue;
      pts.push({
        x: px,
        z: pz,
        pv: r < 0.56 ? 0 : r < 0.72 ? 1 : r < 0.9 ? 2 : 3
      });
    }
    z -= 0.8 + (cz - z) * 0.07;
    row++;
  }
  for (const q of pts) {
    const yaw = Math.atan2(cx - q.x, cz - q.z) + (rnd() - 0.5) * 0.4;
    const p = newPerson(q.x, q.z, {
      state: 'poster',
      yaw,
      kind: 0
    });
    if (!p) break;
    p.pv = q.pv;
    p.r1 = rnd() - 0.5;
    p.r2 = rnd() - 0.5;
    p.seed = rnd() * 100;
    setCrowdColors(p.i, {
      shirt: pick(CROWD_COLORS.shirt),
      pants: pick(CROWD_COLORS.pants),
      shoe: pick(CROWD_COLORS.shoe),
      hair: pick(CROWD_COLORS.hair),
      skin: pick(CROWD_COLORS.skin)
    });
    setFace(p, rnd() < 0.3 ? 1 : 0);
    computePose(p, 0, p.pose);
    if (q === pts[0] && me.aim >= 0) POSTER.victim = p;
  }
}

function posePoster(p, t, o) {
  o.fill(0);
  const hic = Math.pow(Math.max(0, Math.sin(t * 4.4 + p.seed * 3)), 3);
  const sw = Math.sin(t * 1.25 + p.seed);
  const tr = Math.sin(t * 8.5 + p.seed) * 0.035;
  o[P.HY] = C.HIP_Y - 0.015 - hic * 0.006;
  o[P.SX] = 0.34 + hic * 0.07 + sw * 0.02;
  o[P.SZ] = sw * 0.035;
  o[P.LHX] = -0.04;
  o[P.RHX] = -0.06;
  o[P.LKX] = 0.1;
  o[P.RKX] = 0.12;
  o[P.LHZ] = 0.05;
  o[P.RHZ] = -0.05;
  if (p.pv === 0) {
    // 두 팔을 뻗음
    o[P.LSX] = -1.62 + tr + p.r1 * 0.25;
    o[P.RSX] = -1.55 - tr + p.r2 * 0.25;
    o[P.LSZ] = 0.1;
    o[P.RSZ] = -0.1;
    o[P.LSY] = -0.08;
    o[P.RSY] = 0.08;
    o[P.LEX] = -0.22;
    o[P.REX] = -0.28;
  } else if (p.pv === 1) {
    // 한 팔은 뻗고 한 손으로 눈물을 닦음
    o[P.LSX] = -1.6 + tr;
    o[P.LSZ] = 0.1;
    o[P.LEX] = -0.25;
    o[P.RSX] = -1.05;
    o[P.RSY] = 0.42;
    o[P.REX] = -2.25;
    o[P.RSZ] = -0.05;
  } else if (p.pv === 2) {
    // 축 처져서 흐느낌
    o[P.SX] = 0.5 + hic * 0.1;
    o[P.LSX] = -0.42;
    o[P.RSX] = -0.42;
    o[P.LSZ] = 0.05;
    o[P.RSZ] = -0.05;
    o[P.LEX] = -0.18;
    o[P.REX] = -0.18;
  } else {
    // 자기 몸을 끌어안음
    o[P.SX] = 0.28 + hic * 0.06;
    o[P.LSX] = -0.95;
    o[P.RSX] = -0.95;
    o[P.LSY] = -0.55;
    o[P.RSY] = 0.55;
    o[P.LEZ] = -1.1;
    o[P.REZ] = 1.1;
    o[P.LEX] = -0.3;
    o[P.REX] = -0.3;
  }
  // 두 사람 쪽을 바라봄
  const me = POSTER.C.me,
    fr = POSTER.C.fr;
  const dx = (me.x + fr.x) / 2 - p.x,
    dz = (me.z + fr.z) / 2 - p.z,
    dist = Math.hypot(dx, dz) || 0.001;
  o[P.HW] = THREE.MathUtils.clamp(wrapAngle(Math.atan2(dx, dz) - p.yaw), -1.1, 1.1);
  o[P.HX] = p.pv === 2 ? 0.3 : THREE.MathUtils.clamp(-Math.atan2(0.25, dist) - 0.1 - o[P.SX], -0.9, 0.6) + hic * 0.05;
  o[P.HZ] = p.r1 * 0.45;
}

function mePosterAnimate(dt) {
  const T = POSTER.C.me,
    o = ME.tgt;
  o.fill(0);
  const br = Math.sin(G.t * 1.8) * 0.01;
  o[P.HY] = M.HIP_Y - 0.035 + br;
  o[P.LHX] = 0.05;
  o[P.RHX] = -0.14;
  o[P.LHZ] = 0.17;
  o[P.RHZ] = -0.13;
  o[P.LKX] = 0.12;
  o[P.RKX] = 0.24;
  o[P.SX] = -0.03 + br;
  o[P.SY] = T.sy;
  o[P.SZ] = T.sz;
  o[P.HW] = T.hw;
  o[P.HX] = T.hx + br;
  o[P.HZ] = T.hz;
  const AL = T.L, AR = T.R;
  o[P.LSX] = AL.sx;
  o[P.LSY] = AL.sy;
  o[P.LSZ] = AL.sz;
  o[P.LEX] = AL.ex;
  o[P.LEZ] = AL.ez;
  o[P.RSX] = AR.sx;
  o[P.RSY] = AR.sy;
  o[P.RSZ] = AR.sz;
  o[P.REX] = AR.ex;
  o[P.REZ] = AR.ez;
  const k = 1 - Math.exp(-14 * dt);
  for (let i = 0; i < NPOSE; i++) ME.pose[i] = THREE.MathUtils.lerp(ME.pose[i], o[i], k);
  ME.pose[P.LIFT] = 0;
  ME.x = T.x;
  ME.z = T.z;
  applyRig(MR, ME.pose, ME.x, ME.z, T.yaw);
  // 한 손 총으로 우는 사람을 겨눔
  if (T.aim >= 0) {
    const v = POSTER.victim;
    if (v) POSTER.aimPt.set(v.hx, v.hy - 0.1, v.hz);
    else POSTER.aimPt.set(T.x + (T.aim === 1 ? -2 : 2), 1.35, T.z - 1);
    aimArm(T.aim, POSTER.aimPt, 1, 0, -0.04, true);
  }
  if (T.aim !== 0 && AL.gun) pointWrist(MR.wrL, TOOL_DOWN, AL.gun, T.yaw, GUN_SIDE);
  if (T.aim !== 1 && AR.gun) pointWrist(MR.wrR, TOOL_DOWN, AR.gun, T.yaw, GUN_SIDE);
  // 포스터에서는 손잡이 중심이 주먹 안에 오도록 총만 손에 맞춘다.
  for (const h of [0, 1]) {
    GUNS[h].position.set(0, 0.064, 0.057);
    GUNS[h].visible = true;
    KNIVES[h].visible = false;
    GUNS[h].updateWorldMatrix(true, false);
    titleGripSide.setFromMatrixColumn(GUNS[h].matrixWorld, 0);
    titleGripView.setFromMatrixPosition(GUNS[h].matrixWorld).negate().add(POSTER.camPos);
    TITLE_HANDS[h].scale.x = titleGripSide.dot(titleGripView) >= 0 ? 1 : -1;
    ME_PARTS.hands[h].visible = false;
    TITLE_HANDS[h].visible = true;
  }
  MR.root.updateMatrixWorld(true);
  meSparkles(dt);
}

function posterFriendPose(a, t, o) {
  const T = POSTER.C.fr;
  o.fill(0);
  const br = Math.sin(t * 1.7 + 1.3) * 0.01;
  o[P.HY] = M.HIP_Y - 0.05 + br;
  o[P.LHX] = -0.22;
  o[P.RHX] = 0.1;
  o[P.LHZ] = 0.16;
  o[P.RHZ] = -0.2;
  o[P.LKX] = 0.3;
  o[P.RKX] = 0.16;
  o[P.SX] = 0.04 + br;
  o[P.SY] = T.sy;
  o[P.SZ] = T.sz;
  o[P.HW] = T.hw;
  o[P.HX] = T.hx;
  o[P.HZ] = T.hz;
  o[P.RSX] = T.r.sx;
  o[P.RSY] = T.r.sy;
  o[P.RSZ] = T.r.sz;
  o[P.REX] = T.r.ex;
  o[P.REZ] = T.r.ez;
  o[P.LSX] = T.l.sx;
  o[P.LSY] = T.l.sy;
  o[P.LSZ] = T.l.sz;
  o[P.LEX] = T.l.ex;
  o[P.LEZ] = T.l.ez;
  a.hideKnife = !T.knife;
}

function deepMerge(dst, src) {
  for (const k in src) {
    if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k])) {
      if (!dst[k] || typeof dst[k] !== 'object') dst[k] = {};
      deepMerge(dst[k], src[k]);
    } else dst[k] = src[k];
  }
  return dst;
}

function posterLayout() {
  resetWrists();
  clearCrowd();
  persons.length = 0;
  live.length = 0;
  aliveCount = 0;
  // 세로 화면과 가로 화면은 구도를 따로 씀
  const T = POSTER.C = deepMerge(JSON.parse(JSON.stringify(POSTER.T)), posterPort() ? POSTER.T.port : POSTER.T.land);
  ME.x = T.me.x;
  ME.z = T.me.z;
  POSTER.on = true;
  posterCamFit();
  if (T.crowd !== false) posterCrowd();
  const a = ALLIES[2];
  a.state = 'poster';
  a.x = T.fr.x;
  a.z = T.fr.z;
  a.yaw = T.fr.yaw;
  a.vx = a.vz = 0;
  a.walk = 0;
  a.spd = 0;
  a.swing = a.stab = a.five = a.target = null;
  a.hideBat = false;
  setAllyFace(a.k, false);
  setCam('poster');
  for (let i = 0; i < 4; i++) animate(0.5);
}

function posterSetup() {
  resetWorld();
  G.state = 'title';
  posterLayout();
}
let posterRT = 0;
window.addEventListener('resize', () => {
  if (!POSTER.on) return;
  posterCamFit();
  clearTimeout(posterRT);
  posterRT = setTimeout(() => {
    if (POSTER.on) posterLayout();
  }, 150);
});

// ───────────────────────── 흐름 ─────────────────────────
let SEQ = [];
function runSeq(items) {
  const base = G.t;
  for (const [t, fn] of items) SEQ.push({ at: base + t, fn });
  SEQ.sort((a, b) => a.at - b.at);
}

function updateSeq() {
  while (SEQ.length && SEQ[0].at <= G.t) {
    const s = SEQ.shift();
    s.fn();
  }
}
const typers = [];
const typeLayouts = new WeakMap();

function prepareTypeLine(el, text) {
  el.textContent = '';
  const chars = text.split('').map((ch) => {
    const span = document.createElement('span');
    span.textContent = ch;
    span.style.visibility = 'hidden';
    el.append(span);
    return span;
  });
  typeLayouts.set(el, { text, chars });
  return chars;
}

function placeTypeCaret(ty) {
  const ch = ty.chars[Math.max(0, ty.i - 1)];
  if (!ch) return;
  const base = ty.el.getBoundingClientRect(),
    r = ch.getBoundingClientRect();
  ty.caret.style.left = `${(ty.i ? r.right : r.left) - base.left}px`;
  ty.caret.style.top = `${r.top - base.top}px`;
}

function typeLine(el, text, speed = 0.05) {
  const layout = typeLayouts.get(el);
  const chars = layout && layout.text === text ? layout.chars : prepareTypeLine(el, text);
  chars.forEach((ch) => {
    ch.style.visibility = 'hidden';
  });
  const caret = document.createElement('span');
  caret.className = 'caret';
  el.append(caret);
  const ty = {
    el,
    chars,
    caret,
    text,
    i: 0,
    t: 0,
    speed
  };
  placeTypeCaret(ty);
  typers.push(ty);
}

function updateTypers(dt) {
  for (let k = typers.length - 1; k >= 0; k--) {
    const ty = typers[k];
    ty.t += dt;
    while (ty.t >= ty.speed && ty.i < ty.text.length) {
      ty.t -= ty.speed;
      ty.i++;
      ty.chars[ty.i - 1].style.visibility = 'visible';
      if (ty.text[ty.i - 1] !== ' ') sfxType();
    }
    placeTypeCaret(ty);
    if (ty.i >= ty.text.length && ty.t > 0.6) {
      ty.caret.remove();
      typers.splice(k, 1);
    }
  }
}

function todayStr() {
  const d = new Date();
  return `20XX년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function certNo() {
  const d = new Date();
  return `제 20XX-${String(4000 + ((d.getDate() * 137 + d.getMonth() * 53) % 5000)).padStart(5, '0')}호`;
}

function resetWorld() {
  clearItems();
  POSTER.on = false;
  for (const h of [0, 1]) {
    GUNS[h].position.set(0, 0, 0);
    ME_PARTS.hands[h].visible = true;
    TITLE_HANDS[h].visible = false;
  }
  resetWrists();
  SEQ = [];
  typers.length = 0;
  stopAllVoices();
  clearBubbles();
  clearCrowd();
  persons.length = 0;
  live.length = 0;
  aliveCount = 0;
  CROWD_SOCIAL.pairs.length = 0;
  CROWD_SOCIAL.scanT = 0.5;
  ME.slotOcc.fill(null);
  ME.clingers.length = 0;
  ME.stab = null;
  resetAllies();
  hideToast();
  arrowEl.hidden = true;
  arrowShown = false;
  arrowTarget = null;
  rescueNoticeEl.hidden = true;
  G.danger = 0;
  G.freeze = false;
  G.burst = null;
  G.ringT = 134;
  CAM.zoom = CAM.zoomTo = 1;
  dangerRing.visible = false;
  dangerOp = -1;
  dangerEl.style.opacity = 0;
  fxClearAll();
  drawMeFace();
  drawShirt();
  ME.x = 0;
  ME.z = 0;
  carePosterCellX = carePosterCellZ = Infinity;
  ME.vx = 0;
  ME.vz = 0;
  ME.walk = 0;
  ME.aim[0] = ME.aim[1] = 0;
  ME.spineYaw = 0;
  ME.pose.fill(0);
  ME.pose[P.HY] = M.HIP_Y;
  G.kills = 0;
  killEl.textContent = '0';
  G.playT = 0;
  G.spawnAcc = 0;
  G.groupAcc = 0;
  G.ringNext = 0;
  G.spawnDone = false;
  G.firing = false;
  G.ctrl = false;
  G.stick.x = G.stick.z = 0;
  weaponEl.classList.remove('knife', 'pulse', 'down');
  houseHide();
  sgReset();
  ME.turn = ME.turnTo = 0;
  backHintEl.hidden = true;
}

function hideAllOverlays() {
  for (const id of ['intro', 'certA', 'result', 'slam', 'sub', 'title']) $(id).hidden = true;
  RES.on = false;
}

function startIntro() {
  audioInit();
  document.body.classList.add('intro-stage');
  resetWorld();
  hideAllOverlays();
  G.state = 'intro';
  $('intro').hidden = false;
  $('intro').classList.remove('out');
  $('hud').hidden = true;
  weaponEl.hidden = true;
  $('certDateA').textContent = todayStr();
  $('certNoA').textContent = certNo();
  const lines = $('intro').querySelectorAll('p');
  // 전체 문장의 줄바꿈과 높이를 먼저 확보하고, 타이핑은 글자의 표시만 바꾼다.

  lines.forEach((l, i) => prepareTypeLine(l, introText[i]));
  placeIdleCrowd();
  setCam('close');
  runSeq([
    [0.35, () => typeLine(lines[0], introText[0])],
    [1.9, () => typeLine(lines[1], introText[1])],
    [3.5, () => typeLine(lines[2], introText[2], 0.048)],
    [7.0, () => { $('intro').classList.add('out'); }],
    [7.5, () => {
      $('intro').hidden = true;
      showCert('certA');
    }],
    [8.55, () => { stampIt('stampA', 'certA'); }],
    [10.0, () => { $('certA').querySelector('.cert').classList.add('out'); }],
    [10.45, () => {
      $('certA').hidden = true;
      setCam('close');
    }],
    [10.8, () => {
      bigSparkle();
      sfxSparkle(1);
    }],
    [11.3, () => {
      playVoice('p_line', {
        gain: 1.0,
        verb: 0.12
      });
      showSub('나는 정신건강 0급이다.');
    }],
    [13.3, () => {
      hideSub();
      setCam('crane', 2.5);
    }],
    ...noticeSteps(15.7),
  ]);
}

function noticeSteps(t0) {
  return [
    [t0, () => {
      // 가장 가까운 사람이 먼저 알아봄
      const idle = live.filter((p) => p.state === 'idle').sort((a, b) => Math.hypot(a.x - ME.x, a.z - ME.z) - Math.hypot(b.x - ME.x, b.z - ME.z));
      // 얼굴이 보이는 쪽(주인공보다 위쪽)에 있고 화면 안쪽인 사람이 먼저 알아봄
      const inView = (p) => {
        toScreen(p.hx, p.hy, p.hz, _bs);
        return _bs.z < 1 && _bs.x > 90 && _bs.x < VW - 90 && _bs.y > 110 && _bs.y < VH - 60;
      };
      const first = idle.find((p) => p.z < ME.z - 0.8 && inView(p)) || idle.find(inView) || idle[0];
      if (!first) return;
      first.look = 1;
      const key = pick(N_KEYS);
      const h = playVoice(key, {
        gain: 1.0,
        sob: 0.01,
        pan: screenPan(first.x, first.z)
      });
      first.vo = h;
      first.bubble = makeBubble(first, '정신건강한 사람이다…!', h, 'big', 1.3);
      setFace(first, 1);
      G.firstNotice = first;
    }],
    [t0 + 1.0, () => {
      live.filter((p) => p.state === 'idle').forEach((p, k) => p.lookDelay = k * 0.07 );
      if (G.firstNotice) setFace(G.firstNotice, 0);
    }],
    [t0 + 1.5, () => {
      const c = live.filter((p) => p.state === 'idle' && p !== G.firstNotice).slice(0, 3);
      c.forEach((p, k) => runSeq([
        [k * 0.35, () => {
          p.speakCD = 0;
          speechTick(p, 0, Math.hypot(p.x - ME.x, p.z - ME.z));
        }]
      ]));
    }],
    [t0 + 1.55, () => {
      if (ok()) sfxRiser(ac.currentTime, SPB * 4);
    }],
    [t0 + 1.55 + SPB * 4, () => drop()],
  ];
}

function showCert(id) {
  const w = $(id);
  w.hidden = false;
  const card = w.querySelector('.cert');
  card.classList.remove('out', 'shake');
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
  const st = w.querySelector('.stamp');
  st.classList.remove('hit');
}

function stampIt(stampId, certId) {
  const st = $(stampId);
  st.classList.remove('hit');
  void st.offsetWidth;
  st.classList.add('hit');
  setTimeout(() => {
    sfxStamp();
    const c = $(certId).querySelector('.cert');
    c.classList.remove('shake');
    void c.offsetWidth;
    c.classList.add('shake');
  }, 120);
}

function drop() {
  SEQ = [];
  document.body.classList.remove('intro-stage');
  hideAllOverlays();
  if (CAM.mode !== 'game' && CAM.mode !== 'crane') setCam('game');
  G.state = 'play';
  G.ctrl = true;
  G.playT = 0;
  const t = ok() ? ac.currentTime + 0.03 : 0;
  if (ok()) {
    sfxImpact(t);
    musicStart(t, 32);
  }
  const slam = $('slam');
  slam.hidden = false;
  const sp = slam.querySelector('.gold');
  sp.style.animation = 'none';
  void sp.offsetWidth;
  sp.style.animation = '';
  const fl = $('flash');
  fl.classList.remove('go');
  void fl.offsetWidth;
  fl.classList.add('go');
  CAM.shake = 0.12;
  // 모두 알아보고 일어남
  // 로고가 떠 있는 동안(1.9초)은 고개만 돌려 쳐다보고, 로고가 사라진 뒤에 일어나 걸어온다
  for (const p of live)
    if (p.state === 'idle') {
      p.noticeT = 2.0 + Math.hypot(p.x - ME.x, p.z - ME.z) * 0.06 + rand(0, 0.35);
      p.look = 1;
    }
  $('hud').hidden = false;
  weaponEl.hidden = false;
  if (!G.firedOnce) weaponEl.classList.add('pulse');
  runSeq([
    [1.9, () => {
      slam.hidden = true;
      if (!G.movedOnce) {
        const h = $('hint');
        h.hidden = false;
        h.classList.toggle('keys', !IS_TOUCH);
      }
    }],
  ]);
}

function startEnding() {
  document.body.classList.remove('intro-stage');
  G.state = 'ending';
  G.ctrl = false;
  G.firing = false;
  clearItems();
  weaponEl.classList.remove('down');
  weaponUp();
  musicStop(true);
  stopAllVoices();
  clearBubbles();
  weaponEl.hidden = true;
  $('hint').hidden = true;
  stickEl.hidden = true;
  stickId = null;
  G.stick.x = G.stick.z = 0;
  $('hud').hidden = true;
  $('again').classList.remove('show');
  arrowEl.hidden = true;
  arrowShown = false;
  // 동료들은 말없이 옆에 와서 선다
  ME.five = null;
  for (const a of ALLIES)
    if (allyOn(a)) {
      a.swing = a.stab = a.five = a.target = null;
      a.pinned = false;
      a.pinT = 0;
      if (a.rescued) {
        a.state = 'end';
        a.hideBat = a.hideKnife = false;
        setAllyFace(a.k, false);
      } else {
        a.state = 'off';
        hideAllyInstance(a.k);
        for (const sp of ALLY_SPARKS[a.k]) sp.visible = false;
      }
    }
  flushAllies();
  G.trapped = null;
  dangerRing.visible = false;
  dangerEl.style.opacity = 0;
  dangerOp = 0;
  runSeq([
    [0.7, () => setCam('end', 2.4)],
    [2.9, () => {
      bigSparkle();
      sfxSparkle(1);
    }],
    [3.4, () => {
      playVoice('p_no', {
        gain: 1.0,
        verb: 0.12
      });
      const b = makeBubble(ME, '싫어.', null, 'big refusal', 1.5);
      b.instant = true;
    }],
    [4.9, () => {
      clearBubbles();
      hideSub();
      showResult();
    }],
  ]);
}
// 끝 화면: 거절한 횟수를 세어 올린 뒤 다시하기
const RES = {
  on: false,
  t: 0,
  dur: 1,
  shown: -1,
  tickT: 0,
  done: false,
  btnT: 0
};

function showResult() {
  const n = G.kills;
  RES.on = true;
  RES.t = 0;
  RES.shown = -1;
  RES.tickT = 0;
  RES.done = false;
  RES.btnT = 0;
  RES.dur = THREE.MathUtils.clamp(0.45 + n * 0.004, 0.6, 1.5);
  const b = $('endN');
  b.textContent = '0';
  b.classList.remove('pop');
  $('again').classList.remove('show');
  $('result').hidden = false;
}

function updateResult(dt) {
  if (!RES.on) return;
  RES.t += dt;
  const n = G.kills,
    b = $('endN');
  if (!RES.done) {
    const k = THREE.MathUtils.clamp((RES.t - 0.35) / RES.dur, 0, 1);
    const v = Math.round(easeOutCubic(k) * n);
    RES.tickT -= dt;
    if (v !== RES.shown) {
      RES.shown = v;
      b.textContent = v;
      if (RES.tickT <= 0 && v > 0 && k < 1) {
        RES.tickT = 0.045;
        sfxType();
      }
    }
    if (k >= 1) {
      RES.done = true;
      RES.btnT = RES.t;
      b.textContent = n;
      b.classList.remove('pop');
      void b.offsetWidth;
      b.classList.add('pop');
      sfxStamp();
    }
  } else if (G.state !== 'end' && RES.t - RES.btnT > 0.45) {
    $('again').classList.add('show');
    G.state = 'end';
  }
}

function restart() {
  audioInit();
  document.body.classList.add('intro-stage');
  resetWorld();
  hideAllOverlays();
  G.state = 'intro';
  placeIdleCrowd();
  setCam('game');
  runSeq(noticeSteps(0.35));
}
$('again').addEventListener('click', () => {
  if (G.state === 'end') restart();
});
$('start').addEventListener('click', () => {
  if (G.state === 'title') startIntro();
});
$('mute').addEventListener('click', () => {
  audioInit();
  setMuted(!MUTED);
});
setMuted(MUTED);
if (!IS_TOUCH) document.body.classList.add('desk');

// ───────────────────────── 집 드나들기 ─────────────────────────
// 둘째 친구와 하이파이브하고 조금 뒤(못 구했어도 80초에는) 앞쪽 안개 속에 집이 선다. 화살표가 말없이 가리키고, 들어갈지는 마음대로.
// 문 앞에서 문 쪽으로 밀면 화면이 어두워지고 gosiwon.html(1인칭 고시원)로 넘어간다. 나오면 이 페이지로 돌아와 그 자리에서 이어진다.
const HOUSE_T0 = 48, HOUSE_T1 = 80;
const linkFadeEl = $('linkFade'), backHintEl = $('backHint');

function linkFade(color, to, dur) {
  const el = linkFadeEl;
  el.style.transition = 'none';
  el.style.background = color;
  el.style.visibility = 'visible';
  void el.offsetWidth;
  el.style.transition = `opacity ${dur}s ${to > 0 ? 'ease-in' : 'ease-out'}`;
  el.style.opacity = to;
  clearTimeout(el._t);
  if (to <= 0) el._t = setTimeout(() => el.style.visibility = 'hidden', dur * 1000 + 60);
}

function houseWanted() {
  if (HOUSE.on || HOUSE.used || G.state !== 'play' || G.burst) return false;
  const a = ALLIES[1];
  return (a.rescued && a.state === 'fight' && G.playT >= Math.max(HOUSE_T0, (a.fightAt || 0) + 2.5)) || G.playT >= HOUSE_T1;
}
// 집(지붕 포함)이 지금 화면에 걸리는지
function houseSeen(x, z) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1])
      for (const y of [0, HH + ROOF_UP + 0.25]) {
        toScreen(x + sx * (HW / 2 + 0.45), y, z + sz * (HD / 2 + EAVE), _sc);
        if (_sc.z >= 1) return true;
        x0 = Math.min(x0, _sc.x);
        x1 = Math.max(x1, _sc.x);
        y0 = Math.min(y0, _sc.y);
        y1 = Math.max(y1, _sc.y);
      }
  return x1 > -8 && x0 < VW + 8 && y1 > -8 && y0 < VH + 8;
}

function houseAppear() {
  // 화면 위쪽 바깥(안개 속)에 세운다. 다가가면 안개를 뚫고 보이기 시작한다.
  const x = ME.x + rand(-3, 3);
  let z = ME.z - 18 - rand(0, 2);
  for (let i = 0; i < 14 && houseSeen(x, z); i++) z -= 1.5;
  housePlace(x, z);
  HOUSE.at = G.playT;
  // 들어갈 때 기다리지 않게 집 안 페이지를 미리 받아 둔다
  try {
    const l = document.createElement('link');
    l.rel = 'prefetch';
    l.href = './gosiwon.html' + location.search;
    document.head.appendChild(l);
  } catch { }
}

function houseUpdate(dt) {
  const H = HOUSE;
  if (houseWanted()) houseAppear();
  if (!H.on) return;
  if (H.enter) {
    enterTick(dt);
    return;
  }
  // 문 앞에서 문 쪽으로 밀면 들어간다 (붙잡혀 있을 때, 하이파이브 중에는 안 됨)
  if (G.state === 'play' && !H.used && G.ctrl && !ME.clingers.length && !ME.five) {
    const front = H.z + HD / 2;
    if (Math.abs(ME.x - H.dx) < 0.48 && ME.z < front + 0.62 && G.input.z < -0.35) startEnterHouse();
  }
}

function houseAnimate(dt) {
  const H = HOUSE;
  if (!H.on) return;
  H.door = approach(H.door, H.doorTo, H.doorTo > H.door ? 3.2 : 18, dt);
  H.leaf.rotation.y = 1.72 * H.door;
  // 문 밑 형광등 빛이 가끔 파르르 떨린다
  H.glowT -= dt;
  if (H.glowT <= 0) {
    H.glowT = rand(2.2, 5.5);
    H.flk = rand(0.14, 0.3);
  }
  let lv = 1;
  if (H.flk > 0) {
    H.flk -= dt;
    lv = Math.sin(H.flk * 64) > 0.2 ? 0.3 : 1;
  }
  H.leak.material.color.setRGB(0.89 * lv, lv, 0.84 * lv);
  H.leak.visible = H.door < 0.05;
  // 집 뒤로 돌아가면 반투명하게 (주인공이 가려지지 않게)
  const behind = G.state !== 'enter' && (houseBlocks(ME.x, 1.0, ME.z, 0.3, HH + ROOF_UP) || houseBlocks(ME.x, 1.7, ME.z, 0.3, HH + ROOF_UP));
  // 카메라가 집 속으로 들어가면(붙잡혀 끝날 때 다가가는 카메라, 마지막 장면) 집을 아예 감춘다
  const cp = camera.position;
  const camIn = cp.y < HH + ROOF_UP + 0.5 && Math.abs(cp.x - H.x) < HW / 2 + 0.7 && Math.abs(cp.z - H.z) < HD / 2 + 0.7;
  // 붙잡혀 끝나는 장면에서 집이 가리면 반투명 대신 아예 걷어 낸다 (원래 장면 그대로 보이게)
  // (한 번 걷어 냈으면 장면이 끝날 때까지 다시 나타나지 않게)
  const cine = G.state === 'over' || G.state === 'ending' || G.state === 'end';
  H.cineHide = cine && (H.cineHide || behind);
  const hide = camIn || H.cineHide;
  H.fk = approach(H.fk, hide ? 0 : behind ? 0.2 : 1, hide ? 14 : 7, dt);
  houseFade(H.fk > 0.996 ? 1 : H.fk);
  H.group.visible = H.fk > 0.02;
  H.pool.material.opacity = (0.62 + 0.3 * H.door) * H.fade * lv;
}

function startEnterHouse() {
  const H = HOUSE;
  G.state = 'enter';
  G.ctrl = false;
  G.firing = false;
  G.freeze = true;
  H.enter = {
    t: 0,
    x0: ME.x,
    z0: ME.z,
    fade: false,
    gone: false
  };
  weaponUp();
  weaponEl.classList.remove('down', 'pulse');
  stickEl.hidden = true;
  stickId = null;
  G.stick.x = G.stick.z = 0;
  $('hint').hidden = true;
  arrowEl.hidden = true;
  arrowShown = false;
  rescueNoticeEl.hidden = true;
  hideToast();
  clearItems();
  musicStop(false);
  CAM.zoomTo = 0.84;
}

function enterTick(dt) {
  // 문 앞으로 다가서서 문을 마주 보면 화면이 어두워진다
  const H = HOUSE, E = H.enter, front = H.z + HD / 2;
  E.t += dt;
  const k = easeInOutSine(E.t / 0.55);
  const x = THREE.MathUtils.lerp(E.x0, H.dx, k), z = THREE.MathUtils.lerp(E.z0, front + 0.32, k);
  ME.vx = (x - ME.x) / Math.max(dt, 1e-3);
  ME.vz = (z - ME.z) / Math.max(dt, 1e-3);
  ME.x = x;
  ME.z = z;
  ME.turnTo = E.t > 0.12 ? Math.PI : 0;
  if (E.t > 0.42 && !E.fade) {
    E.fade = true;
    linkFade('#000', 1, 0.6);
  }
  if (E.t > 1.1 && !E.gone) {
    E.gone = true;
    goInside();
  }
}

function goInside() {
  // 갇혀 있던 친구는 돌아온 뒤에 다시 나타난다
  let allyNext = G.allyNext;
  for (const a of ALLIES)
    if (a.state === 'trapped') allyNext = Math.min(allyNext, a.k);
  const main = {
    playT: G.playT,
    ringNext: G.ringNext,
    ringT: G.ringT,
    allyNext,
    allyT: G.allyT,
    allyKills: G.allyKills,
    helped: G.helped,
    allies: ALLIES.filter((a) => a.rescued && (a.state === 'fight' || a.state === 'five' || a.state === 'freed')).map((a) => ({
      k: a.k,
      kills: a.kills
    })),
    face: faceBloodN,
    shirt: shirtBloodN,
  };
  const hash = Link.write({
    dir: 'in',
    kills: G.kills,
    main
  });
  stopAllVoices();
  musicStop(true);
  G.paused = true;
  location.replace('./gosiwon.html' + location.search + hash);
}
// 집에서 막 나온 장면: 문은 열린 채, 친구들은 문 앞을 막아 서 있고, 사람들은 집 앞에 모여 기다린다. 처음 누르면 이어진다.
function placeWaitingCrowd(n) {
  const pts = [];
  for (let tries = 0; pts.length < n && tries < 4000; tries++) {
    const th = rand(-1.85, 1.85), r = rand(4.2, 9.0);
    const x = ME.x + Math.sin(th) * r * 1.12, z = ME.z + Math.cos(th) * r;
    if (houseNear(x, z, 0.85)) continue;
    if (pts.some((q) => (q.x - x) ** 2 + (q.z - z) ** 2 < 0.95 * 0.95)) continue;
    pts.push({ x, z });
  }
  pts.sort((a, b) => Math.hypot(a.x - ME.x, a.z - ME.z) - Math.hypot(b.x - ME.x, b.z - ME.z));
  for (const q of pts) {
    const p = newPerson(q.x, q.z, {
      state: 'idle',
      idle: 0,
      kind: Math.random() < 0.2 ? 1 : 0,
      yaw: Math.atan2(ME.x - q.x, ME.z - q.z) + rand(-0.25, 0.25)
    });
    if (!p) break;
    p.look = 1;
    p.speakCD = rand(0.2, 1.4);
    computePose(p, 0, p.pose);
  }
}

function setupReturn(L) {
  resetWorld();
  hideAllOverlays();
  document.body.classList.remove('intro-stage');
  const m = L.main || {};
  G.state = 'back';
  G.ctrl = false;
  G.freeze = true;
  G.playT = Math.max(0, +m.playT || 0);
  G.ringNext = THREE.MathUtils.clamp(m.ringNext | 0, 0, RINGS.length);
  G.ringT = Number.isFinite(+m.ringT) ? +m.ringT : 134;
  G.allyNext = THREE.MathUtils.clamp(m.allyNext | 0, 0, ALLIES.length);
  G.allyT = Math.max(+m.allyT || 0, G.playT + 12);
  G.allyKills = m.allyKills | 0;
  G.helped = m.helped | 0;
  G.kills = Math.max(0, L.kills | 0);
  killEl.textContent = G.kills;
  G.movedOnce = G.firedOnce = G.stabbedOnce = true;
  // 집은 등 뒤에, 문은 열린 채로
  housePlace(-DOOR_OFF, -HD / 2 - 0.55);
  HOUSE.used = true;
  HOUSE.door = HOUSE.doorTo = 1;
  HOUSE.leaf.rotation.y = 1.72;
  // 친구들은 문 앞을 막아 서 있다
  const seen = new Set();
  const saved = (Array.isArray(m.allies) ? m.allies : []).filter((q) => q && Number.isInteger(q.k) && ALLIES[q.k] && !seen.has(q.k) && seen.add(q.k)).slice(0, 4);
  const spots = [
    [1.15, 1.15],
    [-1.35, 1.2],
    [2.25, 0.55],
    [-2.4, 0.5]
  ];
  saved.forEach((q, i) => {
    const a = ALLIES[q.k];
    a.state = 'fight';
    a.rescued = true;
    a.kills = q.kills | 0;
    a.x = ME.x + spots[i][0];
    a.z = ME.z + spots[i][1];
    a.vx = a.vz = 0;
    a.walk = 0;
    a.spd = 0;
    a.ready = 1;
    a.yaw = Math.atan2(spots[i][0] * 0.35, 1);
    a.cd = 0.25;
    a.tgtT = 0;
    a.helpCD = 0;
    a.fightAt = 0;
    a.pose.fill(0);
    a.pose[P.HY] = M.HIP_Y;
    setAllyFace(a.k, false);
  });
  GUARD.bear = Math.PI;
  placeWaitingCrowd(18 + 4 * saved.length);
  // 집 안에서 들고 나온 산탄총
  sgEquip(THREE.MathUtils.clamp(L.shells | 0, 6, 30));
  if (m.face) addMeFaceBlood(THREE.MathUtils.clamp(m.face | 0, 0, 34));
  if (m.shirt) addShirtBlood(THREE.MathUtils.clamp(m.shirt | 0, 0, 60));
  $('hud').hidden = false;
  weaponEl.hidden = false;
  CAM.zoom = CAM.zoomTo = 1.12;
  setCam('game');
  for (let i = 0; i < 4; i++) animate(0.3);
  camUpdate(0.016);
  backHintEl.textContent = IS_TOUCH ? '화면을 누르면 이어집니다' : '클릭하거나 키를 누르면 이어집니다';
  backHintEl.hidden = false;
  // 하얗게 나온 화면에서 서서히
  linkFadeEl.style.transition = 'none';
  linkFadeEl.style.background = '#fff';
  linkFadeEl.style.opacity = 1;
  linkFadeEl.style.visibility = 'visible';
  document.documentElement.classList.remove('linkout');
  requestAnimationFrame(() => requestAnimationFrame(() => linkFade('#fff', 0, 0.9)));
}

function resumeFromHouse() {
  if (G.state !== 'back') return;
  audioInit();
  G.state = 'play';
  G.ctrl = true;
  G.freeze = false;
  backHintEl.hidden = true;
  CAM.zoomTo = 1;
  CAM.shake = Math.max(CAM.shake, 0.1);
  HOUSE.doorTo = 0;
  for (const p of live)
    if (p.state === 'idle') {
      p.noticeT = G.playT + 0.25 + Math.hypot(p.x - ME.x, p.z - ME.z) * 0.06;
      p.look = 1;
    }
  const fl = $('flash');
  fl.classList.remove('go');
  void fl.offsetWidth;
  fl.classList.add('go');
  // 소리: 휴대폰은 손을 뗄 때 켜지기도 하므로, 켜지는 순간에 맞춰 문 소리와 음악을 낸다
  let kicked = false;
  const kick = () => {
    if (kicked || !ok()) return;
    kicked = true;
    const t = ac.currentTime + 0.03;
    sfxDoorSlamOut();
    sfxImpact(t);
    musicStart(t, 32);
  };
  if (ok()) kick();
  else if (ac) {
    const onState = () => {
      if (!ok()) return;
      ac.removeEventListener('statechange', onState);
      if (G.state === 'play') kick();
    };
    ac.addEventListener('statechange', onState);
    try {
      const pr = ac.resume();
      if (pr && pr.catch) pr.catch(() => { });
    } catch { }
  }
}
window.addEventListener('pointerdown', (e) => {
  if (G.state !== 'back') return;
  if (e.target && e.target.closest && e.target.closest('#mute, #toast')) return;
  resumeFromHouse();
}, true);
window.addEventListener('keydown', (e) => {
  if (G.state !== 'back' || e.repeat) return;
  if (/^(KeyM|Tab|Shift|Control|Alt|Meta|Escape|F\d)/.test(e.code)) return;
  resumeFromHouse();
}, true);

// 다 쓰러지고 잠깐 조용해지면 마지막 장면으로
function checkEnd() {
  if (G.state !== 'over' || !G.burst || G.burst.phase !== 'done') return;
  if (G.burst.t - G.burst.doneT < 0.7) return;
  if (live.some((p) => p.state === 'dying')) return;
  startEnding();
}

// ───────────────────────── 루프 ─────────────────────────
function simulate(dt) {
  G.t += dt;
  updateSeq();
  updateTypers(dt);
  updateResult(dt);
  // 입력 합치기
  let ix = G.stick.x + G.keys.x, iz = G.stick.z + G.keys.z;
  const l = Math.hypot(ix, iz);
  if (l > 1) {
    ix /= l;
    iz /= l;
  }
  G.input.x = ix;
  G.input.z = iz;
  // 고개 돌리는 순서
  for (const p of live)
    if (p.lookDelay !== undefined && p.state === 'idle') {
      p.lookDelay -= dt;
      if (p.lookDelay <= 0) {
        p.look = approach(p.look, 1, 4, dt);
      }
    }
  if (G.state === 'play') {
    G.playT += dt;
    spawnUpdate(dt);
    allySpawnUpdate();
  }
  meSim(dt);
  houseUpdate(dt);
  updateItems(dt);
  crowdSim(dt);
  if (G.state !== 'back' && G.state !== 'enter') allySim(dt);
  if (G.state === 'play') {
    combatSim(dt);
    sgTick(dt);
  }
  dangerSim(dt);
  burstSim(dt);
  // 무기 버튼 모양
  const knife = ME.clingers.length > 0;
  if (knife !== weaponEl.classList.contains('knife')) weaponEl.classList.toggle('knife', knife);
  if (knife && !G.stabbedOnce) weaponEl.classList.add('pulse');
  checkEnd();
}

function animate(dt) {
  updateCarePosters();
  animateItems(dt);
  for (const p of live) animatePerson(p, dt);
  flushCrowd();
  meAnimate(dt);
  alliesAnimate(dt);
  houseAnimate(dt);
  sgAnimate(dt);
  fxUpdate(dt);
  dangerFx(dt);
}
let lastNow = performance.now();
let frameAvg = 16, perfT = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - lastNow) / 1000;
  lastNow = now;
  if (G.paused) return;
  if (dt > 0.25) dt = 0.25;
  if (dt <= 0) return;
  // 프레임이 느려져도 인트로·전투 시간이 오디오와 함께 흐르도록 나누어 계산한다.
  const steps = Math.ceil(dt / 0.05), tick = dt / steps;
  for (let i = 0; i < steps; i++) simulate(tick);
  animate(dt);
  camUpdate(dt);
  updateBubbles(dt);
  updateArrow();
  renderer.render(scene, camera);
  audioWatch(dt);
  // 느린 기기는 단계적으로 가볍게: 해상도 → 군중 그림자 → 해상도 → 시체 윤곽선
  frameAvg = THREE.MathUtils.lerp(frameAvg, dt * 1000, 0.05);
  perfT += dt;
  if (perfT > 2.5 && frameAvg > 24) {
    perfT = 0;
    lowerQuality();
  }
}
const QSTEPS = [
  () => setPR(1.5),
  () => {
    if (!CA.parts[0].m.castShadow) return false;
    for (const part of CA.parts) part.m.castShadow = false;
    return true;
  },
  () => setPR(1.25),
  () => setPR(1),
  () => {
    if (!CD.parts[0].o.visible) return false;
    for (const part of CD.parts) part.o.visible = false;
    return true;
  },
];
let qStep = 0;

function setPR(v) {
  if (PR <= v) return false;
  PR = v;
  onResize();
  return true;
}

function lowerQuality() {
  while (qStep < QSTEPS.length) {
    if (QSTEPS[qStep++]()) return;
  }
}
// 소리가 멈춰 있으면 화면을 만질 때마다 다시 켬
for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, () => audioPoke(), true);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    G.paused = true;
    if (ac && ac.state === 'running') ac.suspend();
  } else {
    G.paused = false;
    lastNow = performance.now();
    if (ac && G.state !== 'title') ac.resume();
  }
});

// 시작 준비: 글꼴을 기다렸다가 버튼 활성화
function ready() {
  $('start').disabled = false;
}
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => {
  makeCareBookAtlas(careBookTex);
  makeCarePosterAtlas(carePosterTex);
});
(document.fonts && document.fonts.ready ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]) : Promise.resolve()).then(ready);
// 첫 화면: 포스터 (집에서 막 나온 참이면 그 자리에서 이어서)
if (RETURN) setupReturn(RETURN);
else posterSetup();
camUpdate(0.016);
requestAnimationFrame(frame);