// Game runtime extracted from the original page.
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import VOICE_DATA from './voice-data.js';
window.__fhReady = true;

// ───────────────────────── 기본 도구 ─────────────────────────
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const TAU = Math.PI * 2;
const approach = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const easeInQuad = (t) => { t = clamp(t, 0, 1); return t * t; };
const easeInOutSine = (t) => { t = clamp(t, 0, 1); return -(Math.cos(Math.PI * t) - 1) / 2; };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장이 막힌 환경 */ } },
};
const QS = new URLSearchParams(location.search);
// 처음엔 주 입력장치로 짐작하고, 실제로 손가락·마우스가 들어오면 그쪽으로 바꾼다
let IS_TOUCH = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
if (QS.has('desk')) IS_TOUCH = false;
if (QS.has('touch')) IS_TOUCH = true;
document.body.classList.toggle('touch', IS_TOUCH);
// 밖(원래 게임, index.html)과 오가며 넘겨받는 판 상태. 같은 탭 안에서만 쓰고, 막힌 브라우저는 주소 뒤에 붙여 넘긴다.
const LINK_KEY = 'fh_link';
function linkRead() {
  let v = null;
  try { v = JSON.parse(sessionStorage.getItem(LINK_KEY) || 'null'); } catch (e) { v = null; }
  if (!v) { const m = location.hash.match(/[#&]s=([^&]+)/); if (m) { try { v = JSON.parse(decodeURIComponent(m[1])); } catch (e) { v = null; } } }
  return v && v.v === 1 && Date.now() - (v.at || 0) < 6 * 3600e3 ? v : null;
}
function linkWrite(o) {
  const v = Object.assign({ v: 1, at: Date.now() }, o);
  try { sessionStorage.setItem(LINK_KEY, JSON.stringify(v)); return ''; } catch (e) { return '#s=' + encodeURIComponent(JSON.stringify(v)); }
}
function linkClear() { try { sessionStorage.removeItem(LINK_KEY); } catch (e) { /* 무시 */ } if (location.hash) history.replaceState(null, '', location.pathname + location.search); }
// 밖에서 들어온 판이면 그 판의 거절 횟수를 이어서 센다
const LINK = (() => { const l = linkRead(); return l && l.dir === 'in' ? l : null; })();
const LINK_KILLS = LINK ? Math.max(0, LINK.kills | 0) : 0;
// 다시하기·처음부터: 원래 게임의 시작 화면으로
function goMainTitle() { linkClear(); location.replace('./' + location.search); }

// ───────────────────────── 렌더러 / 장면 ─────────────────────────
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const PR_MAX = Math.min(window.devicePixelRatio || 1, 2);
let PR = PR_MAX;
renderer.setPixelRatio(PR);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.autoClear = false;
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.04, 70);
camera.rotation.order = 'YXZ';
scene.add(camera);
// 손과 총은 따로 그린다 (벽에 파묻히지 않게)
const vmScene = new THREE.Scene();
const vmCamera = new THREE.PerspectiveCamera(56, 1, 0.01, 10);
// 문 여는 장면
const doorScene = new THREE.Scene();
const doorCamera = new THREE.PerspectiveCamera(42, 1, 0.05, 30);

// 윤곽선: 화면 픽셀 단위로 일정한 두께
const OUTLINE = { px: { value: 2.0 }, res: { value: new THREE.Vector2(1, 1) } };

let VW = 1, VH = 1;
const _bufSize = new THREE.Vector2();
function fovFor(aspect, landscapeV, portraitH, cap) {
  // 가로 화면은 세로 시야각 고정, 좁은 화면은 가로 시야각이 너무 좁아지지 않게 세로를 넓힌다
  const needV = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(portraitH) / 2) / aspect);
  return Math.min(cap, Math.max(landscapeV, THREE.MathUtils.radToDeg(needV)));
}
function onResize() {
  VW = window.innerWidth; VH = window.innerHeight;
  renderer.setPixelRatio(PR);
  renderer.setSize(VW, VH, false);
  const a = VW / VH;
  camera.aspect = a; camera.fov = fovFor(a, 64, 70, 120); camera.updateProjectionMatrix();
  vmCamera.aspect = a; vmCamera.fov = fovFor(a, 52, 48, 78); vmCamera.updateProjectionMatrix();
  doorCamera.aspect = a; doorCamera.fov = fovFor(a, 42, 34, 74); doorCamera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(_bufSize);
  OUTLINE.res.value.copy(_bufSize);
  OUTLINE.px.value = 1.5 * PR;
  if (typeof vmLayout === 'function') vmLayout();
}
window.addEventListener('resize', onResize);

// 느린 휴대폰: 해상도를 조금씩 낮춘다
const PERF = { ema: 16, slowT: 0, fastT: 0 };
function perfTick(rawDt) {
  PERF.ema = lerp(PERF.ema, rawDt * 1000, 0.05);
  if (PERF.ema > 26) { PERF.slowT += rawDt; PERF.fastT = 0; } else if (PERF.ema < 14) { PERF.fastT += rawDt; PERF.slowT = 0; } else { PERF.slowT = Math.max(0, PERF.slowT - rawDt); PERF.fastT = 0; }
  if (PERF.slowT > 2.5 && PR > 1) { PR = Math.max(1, PR - 0.25); PERF.slowT = 0; onResize(); }
  if (PERF.fastT > 6 && PR < PR_MAX) { PR = Math.min(PR_MAX, PR + 0.25); PERF.fastT = 0; onResize(); }
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler();
const _zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
const _col = new THREE.Color();


// ───────────────────────── 소리 ─────────────────────────
let ac = null;
const A = {};
let MUTED = !!store.get('fh_muted', false);
const VO = {};
const activeVoices = new Set();

function audioInit() {
  if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ac = new AC({ latencyHint: 'interactive' });
  A.master = ac.createGain(); A.master.gain.value = MUTED ? 0 : 0.95;
  A.comp = ac.createDynamicsCompressor();
  A.comp.threshold.value = -12; A.comp.knee.value = 8; A.comp.ratio.value = 4.5; A.comp.attack.value = 0.002; A.comp.release.value = 0.16;
  A.comp.connect(A.master); A.master.connect(ac.destination);
  A.sfx = ac.createGain(); A.sfx.gain.value = 0.95; A.sfx.connect(A.comp);
  A.voice = ac.createGain(); A.voice.gain.value = 1.08; A.voice.connect(A.comp);
  // 좁은 실내 울림
  A.ir = makeIR(1.5, 3.1);
  A.verb = ac.createConvolver(); A.verb.buffer = A.ir;
  A.verbOut = ac.createGain(); A.verbOut.gain.value = 0.5; A.verb.connect(A.verbOut); A.verbOut.connect(A.comp);
  A.noise = makeNoise(2.5);
  A.shaper = makeCurve(2.4);
  A.shaperHard = makeCurve(4.5);
  decodeVoices();
  if (ac.state === 'suspended') ac.resume();
}
function setMuted(m) {
  MUTED = m; store.set('fh_muted', m);
  $('mute').classList.toggle('muted', m);
  $('mute').setAttribute('aria-label', m ? '소리 켜기' : '소리 끄기');
  if (ac) { const t = ac.currentTime; A.master.gain.cancelScheduledValues(t); A.master.gain.setTargetAtTime(m ? 0 : 0.95, t, 0.03); }
}
function makeNoise(sec) {
  const n = Math.floor(ac.sampleRate * sec), b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function makeIR(sec, decay) {
  const n = Math.floor(ac.sampleRate * sec), b = ac.createBuffer(2, n, ac.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      // 앞부분은 벽에 부딪힌 짧은 반사들
      const er = i < ac.sampleRate * 0.06 && Math.random() < 0.004 ? (Math.random() * 2 - 1) * 1.6 : 0;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * (i < 120 ? i / 120 : 1) + er;
    }
  }
  return b;
}
function makeCurve(k) {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(x * k) / Math.tanh(k); }
  return c;
}
function b64ToBuf(b64) {
  const s = atob(b64), n = s.length, u = new Uint8Array(n);
  for (let i = 0; i < n; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
function decodeVoices() {
  let data = {};
  try { data = VOICE_DATA; } catch (e) { data = {}; }
  for (const k of Object.keys(data)) {
    const ab = b64ToBuf(data[k].b);
    try {
      const p = ac.decodeAudioData(ab, (buf) => { VO[k] = buf; }, () => { });
      if (p && p.catch) p.catch(() => { });
    } catch (e) { /* 디코드 실패는 무음으로 */ }
  }
}

function gainN(v) { const g = ac.createGain(); g.gain.value = v; return g; }
function filt(type, f, q) { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q !== undefined) b.Q.value = q; return b; }
function oscN(type, f) { const o = ac.createOscillator(); o.type = type; o.frequency.value = f; return o; }
function noiseN(rate) { const s = ac.createBufferSource(); s.buffer = A.noise; s.loop = true; if (rate) s.playbackRate.value = rate; return s; }
function envAD(param, t, a, peak, d) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0.0001, t);
  param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
  param.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function outChain(vol, pan, verb, lp) {
  const g = gainN(vol);
  let head = g, tail = g;
  if (lp) { const f = filt('lowpass', lp, 0.7); f.connect(g); head = f; }
  if (pan && Math.abs(pan) > 0.04 && ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); tail = p; }
  tail.connect(A.sfx);
  if (verb && verb > 0.05) { const s = gainN(verb); g.connect(s); s.connect(A.verb); }
  return head;
}
let OFFLINE = false;
const ok = () => ac && (OFFLINE || ac.state === 'running');
// 동시에 너무 많이 울리면 휴대폰 소리 엔진이 버티지 못한다.
const SFX_MAX = 22;
const sfxEnds = [];
let sfxWinT = -1, sfxWinN = 0;
function sfxGate(prio, dur) {
  if (!ok()) return false;
  const now = ac.currentTime;
  for (let i = sfxEnds.length - 1; i >= 0; i--) if (sfxEnds[i] <= now) sfxEnds.splice(i, 1);
  if (now - sfxWinT > 0.05) { sfxWinT = now; sfxWinN = 0; }
  if (prio < 3) {
    const cap = prio === 2 ? SFX_MAX + 4 : prio === 1 ? SFX_MAX : SFX_MAX - 8;
    const win = prio === 2 ? 7 : prio === 1 ? 4 : 2;
    if (sfxEnds.length >= cap || sfxWinN >= win) return false;
  }
  sfxEnds.push(now + dur); sfxWinN++;
  return true;
}

// ── 총 ──
function sfxPistol(pan = 0) {
  if (!sfxGate(2, 0.6)) return;
  const t = ac.currentTime + 0.002, r = rand(0.93, 1.07);
  const out = outChain(0.95, pan * 0.5, 0.85);
  const sh = ac.createWaveShaper(); sh.curve = A.shaper; sh.connect(out);
  const n1 = noiseN(rand(0.9, 1.15)); const hp = filt('highpass', 2300, 0.7); const g1 = gainN(0);
  envAD(g1.gain, t, 0.0007, 1.0, 0.05); n1.connect(hp).connect(g1).connect(sh); n1.start(t, rand(0, 2)); n1.stop(t + 0.08);
  const n2 = noiseN(); const lp = filt('lowpass', 6500, 0.8);
  lp.frequency.setValueAtTime(7200 * r, t); lp.frequency.exponentialRampToValueAtTime(240, t + 0.24);
  const g2 = gainN(0); envAD(g2.gain, t, 0.0015, 1.0, 0.26); n2.connect(lp).connect(g2).connect(sh); n2.start(t, rand(0, 2)); n2.stop(t + 0.32);
  const o = oscN('sine', 160 * r); o.frequency.setValueAtTime(170 * r, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
  const g3 = gainN(0); envAD(g3.gain, t, 0.002, 1.2, 0.18); o.connect(g3).connect(sh); o.start(t); o.stop(t + 0.24);
  // 기계음 (슬라이드가 튕기는 짧은 쇳소리)
  const o2 = oscN('square', 2900 * r); const b2 = filt('bandpass', 3100, 6); const g4 = gainN(0);
  envAD(g4.gain, t + 0.012, 0.001, 0.08, 0.03); o2.connect(b2).connect(g4).connect(out); o2.start(t + 0.01); o2.stop(t + 0.06);
}
function sfxShotgun() {
  if (!sfxGate(3, 0.9)) return;
  const t = ac.currentTime + 0.002;
  const out = outChain(1.15, 0, 1.0);
  const sh = ac.createWaveShaper(); sh.curve = A.shaperHard; sh.connect(out);
  const n1 = noiseN(rand(0.85, 1.0)); const hp = filt('highpass', 1600, 0.6); const g1 = gainN(0);
  envAD(g1.gain, t, 0.0008, 1.0, 0.08); n1.connect(hp).connect(g1).connect(sh); n1.start(t, rand(0, 2)); n1.stop(t + 0.12);
  const n2 = noiseN(0.8); const lp = filt('lowpass', 5000, 0.7);
  lp.frequency.setValueAtTime(5200, t); lp.frequency.exponentialRampToValueAtTime(160, t + 0.45);
  const g2 = gainN(0); envAD(g2.gain, t, 0.002, 1.2, 0.48); n2.connect(lp).connect(g2).connect(sh); n2.start(t, rand(0, 2)); n2.stop(t + 0.55);
  const o = oscN('sine', 90); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.3);
  const g3 = gainN(0); envAD(g3.gain, t, 0.003, 1.5, 0.34); o.connect(g3).connect(sh); o.start(t); o.stop(t + 0.4);
  const o2 = oscN('triangle', 55); const g5 = gainN(0); envAD(g5.gain, t + 0.01, 0.01, 0.7, 0.5); o2.connect(g5).connect(out); o2.start(t); o2.stop(t + 0.6);
}
function sfxClick(t, f, v, dur = 0.02, q = 5) {
  const out = outChain(v, 0, 0.12);
  const n = noiseN(rand(0.9, 1.2)); const bp = filt('bandpass', f, q); const g = gainN(0);
  envAD(g.gain, t, 0.0008, 1, dur); n.connect(bp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + dur + 0.03);
  const o = oscN('square', f * 0.5); const g2 = gainN(0); envAD(g2.gain, t, 0.0005, 0.12, dur * 0.6);
  o.connect(g2).connect(out); o.start(t); o.stop(t + dur + 0.02);
}
function sfxMagOut(d = 0) { if (!sfxGate(2, 0.2)) return; const t = ac.currentTime + d; sfxClick(t, 2200, 0.45, 0.025); sfxClick(t + 0.05, 1300, 0.3, 0.04, 3); }
function sfxMagIn(d = 0) { if (!sfxGate(2, 0.2)) return; const t = ac.currentTime + d; sfxClick(t, 1500, 0.55, 0.03, 3); sfxClick(t + 0.045, 3200, 0.5, 0.02, 7); }
function sfxSlide(d = 0) { if (!sfxGate(2, 0.25)) return; const t = ac.currentTime + d; sfxClick(t, 2600, 0.5, 0.03, 4); sfxClick(t + 0.09, 3800, 0.65, 0.025, 8); }
function sfxPump(d = 0) {
  if (!sfxGate(2, 0.4)) return;
  const t = ac.currentTime + d;
  sfxClick(t, 1100, 0.75, 0.05, 2.5); sfxClick(t + 0.02, 2600, 0.4, 0.03, 6);
  sfxClick(t + 0.2, 1400, 0.85, 0.05, 2.5); sfxClick(t + 0.215, 3400, 0.55, 0.03, 8);
}
function sfxShellIn(d = 0) { if (!sfxGate(2, 0.15)) return; const t = ac.currentTime + d; sfxClick(t, 1800, 0.5, 0.03, 3); sfxClick(t + 0.035, 900, 0.35, 0.04, 2); }
function sfxSwitch() { if (!sfxGate(2, 0.3)) return; const t = ac.currentTime; sfxClick(t, 1700, 0.3, 0.04, 2); sfxClick(t + 0.16, 2600, 0.35, 0.03, 5); }
let tinkBudget = 0;
function sfxTink(v = 1, pan = 0) {
  if (tinkBudget > 3 || !sfxGate(0, 0.17)) return;
  tinkBudget++;
  const t = ac.currentTime, r = rand(0.88, 1.12);
  const out = outChain(0.14 * v, pan * 0.5, 0.1);
  for (const [f, d, a] of [[3150, 0.16, 1], [6820, 0.07, 0.5]]) {
    const o = oscN('sine', f * r); const g = gainN(0); envAD(g.gain, t, 0.0008, a, d * rand(0.8, 1.2));
    o.connect(g).connect(out); o.start(t); o.stop(t + d + 0.05);
  }
}
// 벽에 박히는 소리: 석고보드 '퍽' + 부스러기
function sfxWallHit(v = 1, pan = 0) {
  if (!sfxGate(0, 0.12)) return;
  const t = ac.currentTime + 0.01;
  const out = outChain(0.4 * v, pan * 0.5, 0.25);
  const n = noiseN(rand(0.8, 1.1)); const bp = filt('bandpass', rand(900, 1400), 1.2); const g = gainN(0);
  envAD(g.gain, t, 0.001, 0.9, 0.05); n.connect(bp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.08);
  const n2 = noiseN(1.4); const hp = filt('highpass', 3500, 0.7); const g2 = gainN(0);
  envAD(g2.gain, t + 0.02, 0.004, 0.25, 0.09); n2.connect(hp).connect(g2).connect(out); n2.start(t, rand(0, 2)); n2.stop(t + 0.14);
}
function sfxAmmo() {
  if (!ok()) return;
  const t = ac.currentTime + 0.002, out = outChain(0.42, 0, 0.1);
  [[1318.51, 0, 0.07], [1760, 0.075, 0.07], [2637.02, 0.15, 0.16]].forEach(([f, d, decay]) => {
    const tt = t + d;
    const o = oscN('triangle', f), g = gainN(0);
    const ov = oscN('sine', f * 2), og = gainN(0);
    envAD(g.gain, tt, 0.002, 0.68, decay); envAD(og.gain, tt, 0.001, 0.14, decay * 0.65);
    o.connect(g).connect(out); ov.connect(og).connect(out);
    o.start(tt); ov.start(tt); o.stop(tt + decay + 0.03); ov.stop(tt + decay + 0.03);
  });
  sfxClick(t, 1400, 0.3, 0.04, 2);
}

// ── 몸 ──
function sfxFlesh(v = 1, pan = 0, lp = 0) {
  if (!sfxGate(1, 0.14)) return;
  const t = ac.currentTime + 0.004;
  const out = outChain(0.85 * v, pan * 0.5, 0.2, lp);
  const n = noiseN(rand(0.7, 0.9)); const l = filt('lowpass', 1100, 1.4); const g = gainN(0);
  envAD(g.gain, t, 0.002, 0.9, 0.07); n.connect(l).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.12);
  const o = oscN('sine', 95); o.frequency.exponentialRampToValueAtTime(52, t + 0.09); const g2 = gainN(0);
  envAD(g2.gain, t, 0.002, 0.9, 0.1); o.connect(g2).connect(out); o.start(t); o.stop(t + 0.14);
  const n2 = noiseN(rand(1, 1.3)); const bp = filt('bandpass', 1500, 1.6); const g3 = gainN(0);
  envAD(g3.gain, t + 0.012, 0.002, 0.55, 0.06); n2.connect(bp).connect(g3).connect(out); n2.start(t + 0.01, rand(0, 2)); n2.stop(t + 0.1);
}
function sfxHead(pan = 0) {
  if (!sfxGate(2, 0.2)) return;
  const t = ac.currentTime + 0.006;
  const out = outChain(0.9, pan * 0.5, 0.3);
  // 껍질이 깨지는 '빡' + 젖은 터짐
  const n = noiseN(rand(1.1, 1.3)); const bp = filt('bandpass', 2400, 2); const g = gainN(0);
  envAD(g.gain, t, 0.0006, 1.0, 0.03); n.connect(bp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.05);
  const n2 = noiseN(0.7); const lp = filt('lowpass', 1800, 4); lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.14);
  const g2 = gainN(0); envAD(g2.gain, t + 0.008, 0.002, 1.0, 0.13); n2.connect(lp).connect(g2).connect(out); n2.start(t, rand(0, 2)); n2.stop(t + 0.2);
  const o = oscN('sine', 140); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
  const g3 = gainN(0); envAD(g3.gain, t, 0.002, 1.0, 0.13); o.connect(g3).connect(out); o.start(t); o.stop(t + 0.18);
}
function sfxHitTick(kill) {
  if (!ok()) return;
  const t = ac.currentTime + 0.01;
  const out = outChain(kill ? 0.3 : 0.2, 0, 0);
  const o = oscN('triangle', kill ? 1650 : 2300); const g = gainN(0); envAD(g.gain, t, 0.0008, 1, kill ? 0.07 : 0.035);
  o.connect(g).connect(out); o.start(t); o.stop(t + 0.1);
}
function sfxSplat(v = 1, pan = 0) {
  if (!sfxGate(0, 0.1)) return;
  const t = ac.currentTime;
  const out = outChain(0.42 * v, pan * 0.5, 0.05);
  for (let i = 0; i < 2; i++) {
    const tt = t + i * rand(0.012, 0.03);
    const n = noiseN(rand(0.8, 1.4)); const bp = filt('bandpass', rand(700, 1400), 2.2); const g = gainN(0);
    envAD(g.gain, tt, 0.001, rand(0.4, 0.8), rand(0.03, 0.06)); n.connect(bp).connect(g).connect(out); n.start(tt, rand(0, 2)); n.stop(tt + 0.1);
  }
}
function sfxFall(v = 1, pan = 0, lp = 0) {
  if (!sfxGate(0, 0.25)) return;
  const t = ac.currentTime;
  const out = outChain(0.8 * v, pan * 0.5, 0.15, lp);
  const o = oscN('sine', 78); o.frequency.setValueAtTime(82, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.16);
  const g = gainN(0); envAD(g.gain, t, 0.003, 1, 0.2); o.connect(g).connect(out); o.start(t); o.stop(t + 0.26);
  const n = noiseN(0.6); const l = filt('lowpass', 380, 0.8); const g2 = gainN(0);
  envAD(g2.gain, t, 0.002, 0.75, 0.12); n.connect(l).connect(g2).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.16);
}
function sfxStab(pan = 0, v = 1) {
  if (!sfxGate(2, 0.2)) return;
  const t = ac.currentTime;
  const out = outChain(0.95 * v, pan * 0.4, 0.2);
  const n = noiseN(); const bp = filt('bandpass', 900, 2.4); bp.frequency.setValueAtTime(900, t); bp.frequency.exponentialRampToValueAtTime(4200, t + 0.07);
  const g = gainN(0); envAD(g.gain, t, 0.01, 0.5, 0.06); n.connect(bp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.1);
  const t2 = t + 0.055;
  const n2 = noiseN(0.8); const lp = filt('lowpass', 2000, 9); lp.frequency.setValueAtTime(2200, t2); lp.frequency.exponentialRampToValueAtTime(320, t2 + 0.13);
  const g2 = gainN(0); envAD(g2.gain, t2, 0.002, 1.0, 0.14); n2.connect(lp).connect(g2).connect(out); n2.start(t2, rand(0, 2)); n2.stop(t2 + 0.2);
  const o = oscN('sine', 120); o.frequency.setValueAtTime(130, t2); o.frequency.exponentialRampToValueAtTime(55, t2 + 0.1);
  const g3 = gainN(0); envAD(g3.gain, t2, 0.002, 0.95, 0.12); o.connect(g3).connect(out); o.start(t2); o.stop(t2 + 0.16);
  const o2 = oscN('triangle', 5200); const g4 = gainN(0); envAD(g4.gain, t2 - 0.01, 0.001, 0.05, 0.05);
  o2.connect(g4).connect(out); o2.start(t2 - 0.01); o2.stop(t2 + 0.06);
}
function sfxSwing(v = 1) {
  if (!sfxGate(1, 0.25)) return;
  const t = ac.currentTime;
  const out = outChain(0.42 * v, 0, 0);
  const n = noiseN(rand(0.9, 1.1)); const bp = filt('bandpass', 450, 1.6);
  bp.frequency.setValueAtTime(420, t); bp.frequency.exponentialRampToValueAtTime(2300, t + 0.11); bp.frequency.exponentialRampToValueAtTime(900, t + 0.2);
  const g = gainN(0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.9, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  n.connect(bp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.24);
}
// 붙잡히는 소리: 몸이 부딪히는 '쿵' + 옷을 움켜쥐는 '부스럭' + 짧은 '헉'
function sfxGrab(pan = 0, v = 1) {
  if (!sfxGate(v >= 1 ? 2 : 0, 0.18)) return;
  const t = ac.currentTime;
  const out = outChain(1.05 * v, pan * 0.5, 0.12);
  const n = noiseN(0.5); const lp = filt('lowpass', 700, 1); const g = gainN(0);
  envAD(g.gain, t, 0.008, 0.85, 0.11); n.connect(lp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.16);
  const o = oscN('sine', 140); o.frequency.exponentialRampToValueAtTime(85, t + 0.08); const g2 = gainN(0);
  envAD(g2.gain, t, 0.004, 0.75, 0.09); o.connect(g2).connect(out); o.start(t); o.stop(t + 0.12);
  const n2 = noiseN(rand(1.0, 1.3)); const bp = filt('bandpass', 1300, 1.2); bp.frequency.setValueAtTime(1700, t); bp.frequency.exponentialRampToValueAtTime(650, t + 0.1); const g3 = gainN(0);
  envAD(g3.gain, t + 0.004, 0.003, 0.85, 0.09); n2.connect(bp).connect(g3).connect(out); n2.start(t, rand(0, 2)); n2.stop(t + 0.15);
  const o2 = oscN('triangle', 330); o2.frequency.setValueAtTime(360, t + 0.01); o2.frequency.exponentialRampToValueAtTime(180, t + 0.1); const g4 = gainN(0);
  envAD(g4.gain, t + 0.01, 0.006, 0.4, 0.1); o2.connect(g4).connect(out); o2.start(t + 0.01); o2.stop(t + 0.16);
}
function sfxHeart(v = 1) {
  if (!sfxGate(3, 0.4)) return;
  const t = ac.currentTime + 0.005;
  const out = outChain(0.95 * v, 0, 0);
  for (const [d, a] of [[0, 1], [0.16, 0.7]]) {
    const o = oscN('sine', 62); o.frequency.setValueAtTime(70, t + d); o.frequency.exponentialRampToValueAtTime(42, t + d + 0.12);
    const g = gainN(0); envAD(g.gain, t + d, 0.006, a, 0.14); o.connect(g).connect(out); o.start(t + d); o.stop(t + d + 0.18);
  }
}
// 발소리: 장판(탁 + 가끔 쩍 달라붙음), 카펫(먹먹), 마루(딱딱하고 가벼움), 타일(또각)
function sfxStep(surface, v = 1) {
  if (!sfxGate(0, 0.12)) return;
  const t = ac.currentTime;
  const out = outChain(v, rand(-0.12, 0.12), surface === 'carpet' ? 0.04 : 0.12);
  if (surface === 'vinyl') {
    const n = noiseN(rand(0.55, 0.7)); const lp = filt('lowpass', rand(280, 360), 0.8); const g = gainN(0);
    envAD(g.gain, t, 0.005, 1.05, 0.08); n.connect(lp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.12);
    const n2 = noiseN(rand(0.9, 1.15)); const bp = filt('bandpass', rand(1250, 1600), 1.6); const g2 = gainN(0);
    envAD(g2.gain, t + 0.004, 0.002, 0.5, 0.035); n2.connect(bp).connect(g2).connect(out); n2.start(t, rand(0, 2)); n2.stop(t + 0.07);
    if (Math.random() < 0.35) { const n3 = noiseN(1.2); const hp = filt('bandpass', rand(2600, 3400), 2.2); const g3 = gainN(0); envAD(g3.gain, t + rand(0.05, 0.08), 0.003, 0.14, 0.022); n3.connect(hp).connect(g3).connect(out); n3.start(t, rand(0, 2)); n3.stop(t + 0.13); }
  } else if (surface === 'carpet') {
    // 젖은 카펫: 둔한 쿵 + 휴대폰 스피커에서도 들리게 눅눅한 '척' 대역 + 천 스치는 소리
    const n = noiseN(rand(0.5, 0.7)); const lp = filt('lowpass', rand(380, 520), 0.8); const g = gainN(0);
    envAD(g.gain, t, 0.008, 0.8, 0.1); n.connect(lp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.16);
    const n3 = noiseN(rand(0.85, 1.1)); const bp3 = filt('bandpass', rand(820, 1050), 1.3); const g3 = gainN(0);
    envAD(g3.gain, t + 0.012, 0.004, 0.2, 0.05); n3.connect(bp3).connect(g3).connect(out); n3.start(t, rand(0, 2)); n3.stop(t + 0.09);
    const n2 = noiseN(1.1); const bp = filt('bandpass', 1900, 1.5); const g2 = gainN(0);
    envAD(g2.gain, t + 0.025, 0.01, 0.09, 0.07); n2.connect(bp).connect(g2).connect(out); n2.start(t, rand(0, 2)); n2.stop(t + 0.12);
  } else {
    const hard = surface === 'tile';
    const n = noiseN(rand(0.9, 1.2)); const bp = filt('bandpass', hard ? rand(2400, 3000) : rand(1100, 1500), hard ? 3 : 2); const g = gainN(0);
    envAD(g.gain, t, 0.001, hard ? 0.5 : 0.4, hard ? 0.03 : 0.04); n.connect(bp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.06);
    const o = oscN('sine', hard ? 180 : 120); o.frequency.exponentialRampToValueAtTime(70, t + 0.06); const g2 = gainN(0);
    envAD(g2.gain, t, 0.002, 0.35, 0.06); o.connect(g2).connect(out); o.start(t); o.stop(t + 0.09);
  }
}

// 다가오는 사람 발소리: 젖은 카펫을 끄는 소리 (뛰는 사람은 짧고 세게)
function sfxCrowdStep(v, pan, runner) {
  if (!sfxGate(0, 0.12)) return;
  const t = ac.currentTime;
  const out = outChain(v, pan, 0.1);
  const n = noiseN(rand(0.5, 0.7)); const lp = filt('lowpass', rand(420, 560), 0.8); const g = gainN(0);
  envAD(g.gain, t, runner ? 0.004 : 0.012, 0.85, runner ? 0.07 : 0.12); n.connect(lp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.18);
  const n2 = noiseN(rand(0.85, 1.05)); const bp = filt('bandpass', rand(850, 1150), 1.2); const g2 = gainN(0);
  envAD(g2.gain, t + 0.01, 0.004, runner ? 0.3 : 0.22, 0.05); n2.connect(bp).connect(g2).connect(out); n2.start(t, rand(0, 2)); n2.stop(t + 0.1);
  if (!runner) { const n3 = noiseN(1); const bp3 = filt('bandpass', 2200, 1.4); const g3 = gainN(0); envAD(g3.gain, t + 0.05, 0.03, 0.06, 0.09); n3.connect(bp3).connect(g3).connect(out); n3.start(t, rand(0, 2)); n3.stop(t + 0.2); }
}

// ── 누운 사람이 장판 위로 끌려오는 소리 ──
// 몸이 비닐 장판에 쓸리는 '쓰으윽'이 끊기지 않고 이어지고, 가끔 살갗이 장판에 붙었다 떨어지며 '찌익'
const DRAG = { v: [] };
function dragVoice() {
  const t = ac.currentTime;
  const n = noiseN(rand(0.85, 1.1));
  const body = filt('bandpass', 560, 0.75), low = filt('lowpass', 240, 0.7), lowG = gainN(0.9);
  const lp = filt('lowpass', 2400, 0.7), g = gainN(0);
  n.connect(body).connect(lp); n.connect(low).connect(lowG).connect(lp);
  // 찌익: 톱니파를 좁은 대역으로 (평소엔 꺼 둠)
  const sq = oscN('sawtooth', 900), sqB = filt('bandpass', 1500, 7), sqG = gainN(0);
  sq.connect(sqB).connect(sqG).connect(lp);
  lp.connect(g);
  let pn = null;
  if (ac.createStereoPanner) { pn = ac.createStereoPanner(); g.connect(pn); pn.connect(A.sfx); } else g.connect(A.sfx);
  const vs = gainN(0.3); g.connect(vs); vs.connect(A.verb);
  n.start(t, rand(0, 2)); sq.start(t);
  return { n, sq, sqB, sqG, lp, g, pn, p: null, lv: 0, target: 0, pan: 0, occl: false, ph: rand(0, 10), sqT: rand(0.4, 1.5) };
}
function dragAssign(items, dt = 1 / 60) {
  if (!ok() || OFFLINE) return;
  const t = ac.currentTime;
  for (const v of DRAG.v) if (v.p && !items.some((it) => it.p === v.p)) v.p = null;
  for (const it of items) {
    let v = DRAG.v.find((q) => q.p === it.p);
    if (!v) {
      v = DRAG.v.find((q) => !q.p && q.lv < 0.03);
      if (!v && DRAG.v.length < 3) { v = dragVoice(); DRAG.v.push(v); }
      if (!v) continue;
      v.p = it.p;
    }
    v.target = it.lv; v.pan = it.pan; v.occl = it.occl;
  }
  for (const v of DRAG.v) {
    const tgt = v.p ? v.target : 0;
    v.lv += (tgt - v.lv) * (1 - Math.exp(-dt * (tgt > v.lv ? 9 : 5)));
    // 고르지 않게 미끄러짐: 느리게 출렁이고 가끔 턱 걸린다
    v.ph += dt * (1.2 + v.lv * 2.6);
    const wob = 0.66 + 0.34 * Math.sin(v.ph * 2.3) * Math.sin(v.ph * 0.71 + 1.3);
    v.g.gain.setTargetAtTime(v.lv * 0.62 * wob, t, 0.045);
    v.lp.frequency.setTargetAtTime(v.occl ? 650 : 2600, t, 0.12);
    if (v.pn) v.pn.pan.setTargetAtTime(clamp(v.pan, -1, 1), t, 0.05);
    v.sqT -= dt;
    if (v.sqT <= 0) {
      v.sqT = rand(0.5, 1.8);
      if (v.lv > 0.08) {
        const f = rand(700, 1150), d = rand(0.07, 0.17);
        v.sq.frequency.cancelScheduledValues(t); v.sq.frequency.setValueAtTime(f, t); v.sq.frequency.exponentialRampToValueAtTime(f * rand(0.62, 0.8), t + d);
        v.sqB.frequency.setValueAtTime(f * 1.6, t);
        v.sqG.gain.cancelScheduledValues(t); v.sqG.gain.setValueAtTime(0.0001, t); v.sqG.gain.exponentialRampToValueAtTime(0.42 * Math.min(1, v.lv * 1.6), t + 0.012);
        v.sqG.gain.setValueAtTime(0.3 * Math.min(1, v.lv * 1.6), t + d * 0.6); v.sqG.gain.exponentialRampToValueAtTime(0.0001, t + d);
      }
    }
  }
}
function sfxDragStop(p) {
  if (!ac) return;
  for (const v of DRAG.v) if (v.p === p) { v.p = null; v.lv = 0; try { v.g.gain.setTargetAtTime(0, ac.currentTime, 0.03); } catch (e) { /* 무시 */ } }
}
function sfxDragAllStop() { if (!ac) return; for (const v of DRAG.v) { v.p = null; v.lv = 0; try { v.g.gain.setTargetAtTime(0, ac.currentTime, 0.03); } catch (e) { /* 무시 */ } } }
// 소리 확인용 (오프라인): 한 번 쓰윽 끌려오는 소리
function sfxDragDemo(dur = 1.4) {
  const v = dragVoice(), t = ac.currentTime;
  v.g.gain.setValueAtTime(0.0001, t); v.g.gain.linearRampToValueAtTime(0.55, t + 0.25); v.g.gain.setValueAtTime(0.55, t + dur - 0.3); v.g.gain.linearRampToValueAtTime(0.0001, t + dur);
  v.sq.frequency.setValueAtTime(950, t + 0.5); v.sq.frequency.exponentialRampToValueAtTime(640, t + 0.62);
  v.sqG.gain.setValueAtTime(0.0001, t + 0.5); v.sqG.gain.exponentialRampToValueAtTime(0.4, t + 0.512); v.sqG.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
  v.n.stop(t + dur + 0.05); v.sq.stop(t + dur + 0.05);
}
// 방문이 벽까지 쾅 열림: 나무 울림 + 낮은 쿵 + 손잡이 덜컹
function sfxDoorBang(pan = 0, v = 1, lp = 0) {
  if (!sfxGate(2, 0.5)) return;
  const t = ac.currentTime + 0.005;
  const out = outChain(1.1 * v, pan * 0.7, 0.55, lp);
  const o = oscN('sine', 92); o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.22);
  const g = gainN(0); envAD(g.gain, t, 0.003, 1.0, 0.26); o.connect(g).connect(out); o.start(t); o.stop(t + 0.32);
  const n = noiseN(rand(0.8, 1.0)); const bp = filt('bandpass', rand(620, 760), 1.4); const g2 = gainN(0);
  envAD(g2.gain, t, 0.002, 1.0, 0.16); n.connect(bp).connect(g2).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.22);
  const n2 = noiseN(0.5); const l2 = filt('lowpass', 400, 0.8); const g3 = gainN(0);
  envAD(g3.gain, t, 0.004, 0.8, 0.3); n2.connect(l2).connect(g3).connect(out); n2.start(t, rand(0, 2)); n2.stop(t + 0.36);
  for (const [d, f, a] of [[0.05, 2600, 0.5], [0.09, 3400, 0.35], [0.14, 2200, 0.25]]) sfxClick(t + d, f, a * v, 0.02, 6);
}
// 의자에서 일어남: 바퀴 의자 끼익 + 바퀴 구르는 소리
function sfxChair(pan = 0, v = 1) {
  if (!sfxGate(1, 0.6)) return;
  const t = ac.currentTime;
  const out = outChain(0.5 * v, pan * 0.7, 0.3);
  const o = oscN('sawtooth', 520); o.frequency.setValueAtTime(480, t); o.frequency.linearRampToValueAtTime(690, t + 0.12); o.frequency.linearRampToValueAtTime(560, t + 0.26);
  const b = filt('bandpass', 1300, 5), g = gainN(0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.03); g.gain.setValueAtTime(0.35, t + 0.18); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o.connect(b).connect(g).connect(out); o.start(t); o.stop(t + 0.32);
  const n = noiseN(0.7), l = filt('bandpass', 380, 1.1), g2 = gainN(0); g2.gain.setValueAtTime(0.0001, t + 0.08); g2.gain.exponentialRampToValueAtTime(0.45, t + 0.16); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
  n.connect(l).connect(g2).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.66);
}

// ── 문 ──
// 디지털 도어락 '띠리리릭' → 모터 → 걸쇠
function sfxLock(t) {
  if (!ok()) return;
  const out = outChain(0.32, 0, 0.12);
  [1318.5, 1568, 1975.5, 2637].forEach((f, i) => {
    const tt = t + i * 0.07;
    const o = oscN('square', f), g = gainN(0); envAD(g.gain, tt, 0.002, 0.5, 0.06);
    const lp = filt('lowpass', 5000, 0.7);
    o.connect(lp).connect(g).connect(out); o.start(tt); o.stop(tt + 0.09);
  });
  const tm = t + 0.34;
  const m = oscN('sawtooth', 150); m.frequency.setValueAtTime(140, tm); m.frequency.linearRampToValueAtTime(210, tm + 0.26);
  const mb = filt('bandpass', 900, 2); const mg = gainN(0); mg.gain.setValueAtTime(0.0001, tm); mg.gain.exponentialRampToValueAtTime(0.25, tm + 0.04); mg.gain.setValueAtTime(0.25, tm + 0.22); mg.gain.exponentialRampToValueAtTime(0.0001, tm + 0.28);
  m.connect(mb).connect(mg).connect(out); m.start(tm); m.stop(tm + 0.3);
  sfxClick(tm + 0.3, 1200, 0.8, 0.04, 2); sfxClick(tm + 0.33, 2600, 0.5, 0.025, 6);
}
function sfxLatch(t, v = 1) {
  if (!ok()) return;
  sfxClick(t, 900, 0.7 * v, 0.05, 2); sfxClick(t + 0.03, 2400, 0.45 * v, 0.03, 6);
}
// 잠긴 현관문 손잡이를 덜컹덜컹
function sfxRattle() {
  if (!ok()) return;
  const t = ac.currentTime + 0.01;
  for (const [d, v] of [[0, 1], [0.12, 0.85], [0.23, 0.6]]) {
    const out = outChain(0.6 * v, 0, 0.3);
    const n = noiseN(0.75); const lp = filt('lowpass', 950, 1.4); const g = gainN(0);
    envAD(g.gain, t + d, 0.002, 1, 0.075); n.connect(lp).connect(g).connect(out); n.start(t + d, rand(0, 2)); n.stop(t + d + 0.11);
    const o = oscN('sine', 120); o.frequency.setValueAtTime(150, t + d); o.frequency.exponentialRampToValueAtTime(70, t + d + 0.06);
    const g2 = gainN(0); envAD(g2.gain, t + d, 0.002, 0.7, 0.07); o.connect(g2).connect(out); o.start(t + d); o.stop(t + d + 0.1);
    sfxClick(t + d + 0.004, 1700, 0.55 * v, 0.03, 4); sfxClick(t + d + 0.02, 3100, 0.32 * v, 0.02, 7);
  }
}
// 경첩이 끼익: 마찰음이 띄엄띄엄 미끄러지는 소리
function sfxCreak(t, dur, v = 1, f0 = 150) {
  if (!ok()) return;
  const out = outChain(0.55 * v, 0, 0.45);
  const N = 256;
  const fc = new Float32Array(N), gc = new Float32Array(N);
  let fr = f0, stick = 0;
  for (let i = 0; i < N; i++) {
    const k = i / (N - 1);
    fr += rand(-14, 14); fr = clamp(fr, f0 * 0.7, f0 * 1.6);
    stick = Math.random() < 0.18 ? rand(0.2, 1) : stick * 0.8;
    fc[i] = fr * (1 + 0.35 * Math.sin(k * 9.0));
    gc[i] = Math.max(0.0001, (0.25 + 0.75 * stick) * Math.sin(Math.PI * Math.min(1, k * 1.08)) * (k < 0.04 ? k / 0.04 : 1));
  }
  const o = oscN('sawtooth', f0); o.frequency.setValueCurveAtTime(fc, t, dur);
  const b1 = filt('bandpass', 950, 7), b2 = filt('bandpass', 2300, 9), g = gainN(0);
  g.gain.setValueCurveAtTime(gc, t, dur);
  const mix = gainN(1); o.connect(b1).connect(mix); o.connect(b2).connect(mix); mix.connect(g).connect(out);
  o.start(t); o.stop(t + dur + 0.05);
  const n = noiseN(0.4); const l = filt('lowpass', 260, 0.7); const g2 = gainN(0); envAD(g2.gain, t, 0.3, 0.12, dur);
  n.connect(l).connect(g2).connect(out); n.start(t, rand(0, 2)); n.stop(t + dur + 0.4);
}
// 센서등 '딸깍' + 켜지는 잡음
function sfxSensor(t) {
  if (!ok()) return;
  sfxClick(t, 3200, 0.45, 0.012, 9); sfxClick(t + 0.018, 1400, 0.25, 0.02, 4);
}
// 형광등이 깜빡일 때 지직
function sfxFlick(v = 1, pan = 0) {
  if (!sfxGate(0, 0.18)) return;
  const t = ac.currentTime;
  const out = outChain(0.22 * v, pan * 0.6, 0.15);
  const n = noiseN(rand(0.9, 1.4)); const bp = filt('bandpass', rand(2600, 4200), 2.5); const g = gainN(0);
  g.gain.setValueAtTime(0.0001, t);
  let tt = t;
  for (let i = 0; i < 5; i++) { g.gain.setValueAtTime(rand(0.3, 1), tt); tt += rand(0.008, 0.025); g.gain.setValueAtTime(0.0001, tt); tt += rand(0.004, 0.02); }
  n.connect(bp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(tt + 0.02);
  const o = oscN('sawtooth', 120); const ob = filt('bandpass', 480, 3); const og = gainN(0); envAD(og.gain, t, 0.004, 0.35, 0.1);
  o.connect(ob).connect(og).connect(out); o.start(t); o.stop(t + 0.14);
}
// 차단기가 떨어짐: '텅' + 전기 튀는 소리
function sfxBreaker() {
  if (!ok()) return;
  const t = ac.currentTime + 0.01;
  const out = outChain(1.15, 0, 1.2);
  const o = oscN('sine', 58); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.7);
  const g = gainN(0); envAD(g.gain, t, 0.004, 1.4, 0.9); o.connect(g).connect(out); o.start(t); o.stop(t + 1.1);
  const n = noiseN(0.6); const l = filt('lowpass', 900, 0.8); l.frequency.setValueAtTime(1600, t); l.frequency.exponentialRampToValueAtTime(90, t + 0.6);
  const g2 = gainN(0); envAD(g2.gain, t, 0.002, 1.0, 0.55); n.connect(l).connect(g2).connect(out); n.start(t, rand(0, 2)); n.stop(t + 0.8);
  const z = noiseN(1.6); const zb = filt('bandpass', 3800, 1.5); zb.frequency.setValueAtTime(5200, t); zb.frequency.exponentialRampToValueAtTime(700, t + 0.35);
  const zg = gainN(0); zg.gain.setValueAtTime(0.0001, t);
  let tt = t;
  for (let i = 0; i < 9; i++) { zg.gain.setValueAtTime(rand(0.2, 0.7), tt); tt += rand(0.01, 0.04); zg.gain.setValueAtTime(0.0001, tt); tt += rand(0.004, 0.02); }
  z.connect(zb).connect(zg).connect(out); z.start(t, rand(0, 2)); z.stop(tt + 0.05);
}
// 무기를 집어 듦: 펌프 + 짧은 낮은 울림
function sfxGetGun() {
  if (!ok()) return;
  const t = ac.currentTime;
  sfxPump(0.05);
  const out = outChain(0.8, 0, 0.9);
  const o = oscN('sawtooth', 55); const l = filt('lowpass', 420, 2); const g = gainN(0); envAD(g.gain, t, 0.02, 0.6, 1.4);
  o.connect(l).connect(g).connect(out); o.start(t); o.stop(t + 1.6);
  const o2 = oscN('sine', 82.4); const g2 = gainN(0); envAD(g2.gain, t, 0.02, 0.5, 1.6); o2.connect(g2).connect(out); o2.start(t); o2.stop(t + 1.8);
}
// 문 밖 하얀 공간으로 나갈 때
function sfxOut() {
  if (!ok()) return;
  const t = ac.currentTime;
  sfxLatch(t, 1.2);
  const out = outChain(0.6, 0, 0.7);
  const n = noiseN(); const bp = filt('bandpass', 400, 0.8); bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(5000, t + 1.1);
  const g = gainN(0); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7, t + 0.9); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
  n.connect(bp).connect(g).connect(out); n.start(t, rand(0, 2)); n.stop(t + 1.6);
}

// ── 형광등 웅 ──
const HUM = { on: false };
function humStart() {
  if (HUM.on || !ac) return;
  const t = ac.currentTime;
  HUM.g = gainN(0); HUM.lp = filt('lowpass', 380, 0.5);
  const o1 = oscN('sawtooth', 120); const b1 = filt('bandpass', 360, 0.9); const g1 = gainN(0.22);
  o1.connect(b1).connect(g1).connect(HUM.lp);
  const o2 = oscN('square', 240); const b2 = filt('bandpass', 960, 3.5); const g2 = gainN(0.05);
  o2.connect(b2).connect(g2).connect(HUM.lp);
  const o3 = oscN('sine', 120); const g3 = gainN(0.2); o3.connect(g3).connect(HUM.lp);
  const n = noiseN(); const hp = filt('highpass', 5200, 0.7); const g4 = gainN(0.014); n.connect(hp).connect(g4).connect(HUM.lp);
  HUM.lp.connect(HUM.g); HUM.g.connect(A.sfx);
  const lfo = oscN('sine', 0.23); const lg = gainN(0.012); lfo.connect(lg).connect(HUM.g.gain);
  for (const s of [o1, o2, o3, n, lfo]) s.start(t);
  HUM.src = [o1, o2, o3, n, lfo]; HUM.tone = [o1, o2, o3];
  HUM.on = true; HUM.dead = false;
}
function humSet(level, open) {
  if (!HUM.on) return;
  const t = ac.currentTime;
  HUM.g.gain.setTargetAtTime(HUM.dead ? 0 : level * 0.17, t, 0.07);
  HUM.lp.frequency.setTargetAtTime(open ? 3600 : 330, t, 0.25);
}
function humKill() {
  if (!HUM.on || HUM.dead) return;
  HUM.dead = true;
  const t = ac.currentTime;
  for (const o of HUM.tone) { o.frequency.cancelScheduledValues(t); o.frequency.setValueAtTime(o.frequency.value, t); o.frequency.exponentialRampToValueAtTime(o.frequency.value * 0.45, t + 0.8); }
  HUM.g.gain.cancelScheduledValues(t); HUM.g.gain.setValueAtTime(HUM.g.gain.value, t); HUM.g.gain.linearRampToValueAtTime(0, t + 0.85);
}
function humStop() {
  if (!HUM.on) return;
  const t = ac.currentTime;
  try { for (const s of HUM.src) s.stop(t + 0.05); } catch (e) { /* 무시 */ }
  HUM.on = false;
}

// ── 목소리 ──
function voicesPlaying() { let n = 0; for (const h of activeVoices) if (!h.stopped) n++; return n; }
function playVoice(key, o = {}) {
  if (!ok() || !VO[key]) return null;
  const buf = VO[key];
  const rate = o.rate || 1;
  const src = ac.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
  const g = gainN(o.gain === undefined ? 1 : o.gain);
  let node = src;
  let lfo = null, lfo2 = null;
  if (o.sob) {
    lfo = oscN('sine', rand(5.6, 7.4)); const lg = gainN(o.sob * rate); lfo.connect(lg); lg.connect(src.playbackRate);
    const trem = gainN(0.78); lfo2 = oscN('sine', rand(4.5, 6)); const tg = gainN(0.22); lfo2.connect(tg); tg.connect(trem.gain);
    node.connect(trem); node = trem;
    lfo.start(); lfo2.start();
  }
  if (o.lp) { const f = filt('lowpass', o.lp, 0.7); node.connect(f); node = f; }
  node.connect(g);
  let tail = g;
  if (ac.createStereoPanner) { const p = ac.createStereoPanner(); p.pan.value = clamp(o.pan || 0, -1, 1); g.connect(p); tail = p; }
  tail.connect(A.voice);
  const vs = gainN(o.verb === undefined ? 0.3 : o.verb); g.connect(vs); vs.connect(A.verb);
  const t0 = ac.currentTime + (o.delay || 0);
  src.start(t0);
  const h = {
    key, src, g, t0, rate, dur: buf.duration / rate, stopped: false,
    stop(fast = 0.012) {
      if (h.stopped) return; h.stopped = true;
      const t = ac.currentTime;
      try { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + fast); src.stop(t + fast + 0.01); } catch (e) { /* 이미 끝남 */ }
      try { if (lfo) lfo.stop(t + fast + 0.02); if (lfo2) lfo2.stop(t + fast + 0.02); } catch (e) { /* 이미 끝남 */ }
    },
  };
  src.onended = () => { h.stopped = true; activeVoices.delete(h); try { if (lfo) lfo.stop(); if (lfo2) lfo2.stop(); } catch (e) { /* 무시 */ } };
  activeVoices.add(h);
  return h;
}
function stopAllVoices() { for (const h of activeVoices) h.stop(0.05); activeVoices.clear(); }


// ───────────────────────── 캔버스 텍스처 ─────────────────────────
function cnv(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function texOf(c, o = {}) {
  const t = new THREE.CanvasTexture(c);
  if (o.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (o.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 4);
  return t;
}
// 시드 있는 난수 (텍스처가 매번 같은 모양이 되게)
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// 이어지는 값 잡음 (타일링)
function tileNoise(n, cells, seed) {
  const R = rng(seed), g = [];
  for (let i = 0; i < cells * cells; i++) g.push(R());
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const fx = x / n * cells, fy = y / n * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const at = (i, j) => g[((j % cells) * cells + (i % cells))];
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    out[y * n + x] = lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
  }
  return out;
}
function grain(g, w, h, amt, seed, mono = true) {
  const R = rng(seed);
  const img = g.getImageData(0, 0, w, h), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (R() - 0.5) * amt;
    if (mono) { d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    else { d[i] += n; d[i + 1] += (R() - 0.5) * amt; d[i + 2] += (R() - 0.5) * amt * 0.6; }
  }
  g.putImageData(img, 0, 0);
}

// ── 고시원 ──
// 장판: 꿀색 비닐 바닥에 결무늬와 얼룩, 1.8m마다 이음매 (2m × 2m)
function makeFloorTex() {
  const N = 512, c = cnv(N, N), g = c.getContext('2d');
  g.fillStyle = '#d39a4a'; g.fillRect(0, 0, N, N);
  const nz = tileNoise(N, 6, 15), nz2 = tileNoise(N, 17, 16);
  const img = g.getImageData(0, 0, N, N), d = img.data, R = rng(17);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    // 비스듬한 나뭇결 + 큰 얼룩
    const grainv = Math.sin((x * 0.9 + y * 0.35) * 0.11 + nz2[i] * 6.0) * 0.5 + 0.5;
    const f = (grainv - 0.5) * 26 + (nz[i] - 0.5) * 30 + (R() - 0.5) * 10;
    d[i * 4] += f; d[i * 4 + 1] += f * 0.8; d[i * 4 + 2] += f * 0.45;
  }
  g.putImageData(img, 0, 0);
  // 오래 밟혀 반들반들해진 자국과 담뱃불 자국 같은 점
  for (let i = 0; i < 26; i++) { const x = R() * N, y = R() * N, r = 10 + R() * 30; const gr = g.createRadialGradient(x, y, 1, x, y, r); gr.addColorStop(0, 'rgba(255, 220, 150, 0.16)'); gr.addColorStop(1, 'rgba(255, 220, 150, 0)'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); }
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(90, 50, 15, ${0.15 + R() * 0.25})`; g.beginPath(); g.arc(R() * N, R() * N, 1 + R() * 2.5, 0, TAU); g.fill(); }
  // 이음매
  g.fillStyle = 'rgba(110, 66, 22, 0.55)'; g.fillRect(0, 0, N, 2); g.fillStyle = 'rgba(255, 225, 160, 0.25)'; g.fillRect(0, 2, N, 1);
  return texOf(c, { repeat: true });
}
// 복도 벽지: 누렇게 바랜 크림색 바탕에 마름모 다마스크 (1m)
function makeCorWallTex() {
  const N = 512, c = cnv(N, N), g = c.getContext('2d');
  g.fillStyle = '#e9dcbf'; g.fillRect(0, 0, N, N);
  const R = rng(81);
  g.strokeStyle = 'rgba(176, 150, 104, 0.5)'; g.lineWidth = 2;
  for (let row = -1; row < 9; row++) for (let col = -1; col < 9; col++) {
    const cx = col * 64 + (row % 2 ? 32 : 0), cy = row * 64;
    g.beginPath(); g.moveTo(cx, cy - 26); g.lineTo(cx + 22, cy); g.lineTo(cx, cy + 26); g.lineTo(cx - 22, cy); g.closePath(); g.stroke();
    g.fillStyle = 'rgba(176, 150, 104, 0.35)'; g.beginPath(); g.arc(cx, cy, 3.2, 0, TAU); g.fill();
    for (const [dx, dy] of [[0, -14], [10, 0], [0, 14], [-10, 0]]) { g.beginPath(); g.arc(cx + dx, cy + dy, 1.4, 0, TAU); g.fill(); }
  }
  for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(140, 116, 80, ${R() * 0.08})`; g.fillRect(R() * N, R() * N, R() * 14 + 2, 1); }
  grain(g, N, N, 8, 82, false);
  const t = texOf(c, { repeat: true }); t.generateMipmaps = true;
  return t;
}
// 방 벽지: 작은 꽃무늬 (1m)
function makeRoomWallTex() {
  const N = 512, c = cnv(N, N), g = c.getContext('2d');
  g.fillStyle = '#e6e1cf'; g.fillRect(0, 0, N, N);
  const R = rng(91);
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const cx = col * 64 + (row % 2 ? 32 : 0) + 4, cy = row * 64 + 30;
    g.strokeStyle = 'rgba(112, 140, 96, 0.55)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(cx, cy + 14); g.quadraticCurveTo(cx + 6, cy + 4, cx, cy - 4); g.stroke();
    g.fillStyle = 'rgba(112, 140, 96, 0.5)'; g.beginPath(); g.ellipse(cx + 6, cy + 8, 5, 2.4, -0.6, 0, TAU); g.fill();
    g.fillStyle = (row + col) % 3 ? 'rgba(206, 116, 128, 0.62)' : 'rgba(120, 140, 200, 0.55)';
    for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; g.beginPath(); g.arc(cx + Math.cos(a) * 4.5, cy - 6 + Math.sin(a) * 4.5, 3.4, 0, TAU); g.fill(); }
    g.fillStyle = 'rgba(240, 210, 120, 0.9)'; g.beginPath(); g.arc(cx, cy - 6, 2.2, 0, TAU); g.fill();
  }
  grain(g, N, N, 7, 92, false);
  const t = texOf(c, { repeat: true }); t.generateMipmaps = true;
  return t;
}
// 천장 텍스 (0.6m 판)
function makeCeilingTex() {
  const N = 256, c = cnv(N, N), g = c.getContext('2d');
  g.fillStyle = '#ece8dc'; g.fillRect(0, 0, N, N);
  const R = rng(33);
  for (let i = 0; i < 4000; i++) { g.fillStyle = `rgba(120, 110, 90, ${R() * 0.3})`; g.fillRect(R() * N, R() * N, R() * 1.6 + 0.5, R() * 1.6 + 0.5); }
  g.fillStyle = 'rgba(150, 140, 120, 0.6)'; g.fillRect(0, 0, N, 3); g.fillRect(0, 0, 3, N);
  return texOf(c, { repeat: true });
}
// 형광등 (가운데 관은 밝고 양옆은 철판)
function makeTubeTex() {
  const c = cnv(256, 64), g = c.getContext('2d');
  g.fillStyle = '#b9b8b0'; g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#ffffff'; g.fillRect(10, 22, 236, 20);
  g.fillStyle = '#d8d6cc'; g.fillRect(0, 0, 256, 6); g.fillRect(0, 58, 256, 6);
  g.fillStyle = '#8f8d84'; g.fillRect(0, 18, 12, 28); g.fillRect(244, 18, 12, 28);
  return texOf(c);
}
// 방문: 짙은 나뭇결 + 테두리 홈
function makeGosiDoorTex() {
  const c = cnv(256, 512), g = c.getContext('2d');
  g.fillStyle = '#7b5234'; g.fillRect(0, 0, 256, 512);
  const R = rng(101);
  for (let i = 0; i < 70; i++) { const x = R() * 256; g.strokeStyle = `rgba(${R() < 0.5 ? '60, 36, 20' : '150, 104, 66'}, ${0.12 + R() * 0.18})`; g.lineWidth = 1 + R() * 2.5; g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + R() * 16 - 8, 170, x + R() * 16 - 8, 340, x + R() * 10 - 5, 512); g.stroke(); }
  g.strokeStyle = 'rgba(40, 24, 12, 0.55)'; g.lineWidth = 4; g.strokeRect(26, 26, 204, 460);
  g.strokeStyle = 'rgba(190, 140, 96, 0.35)'; g.lineWidth = 2; g.strokeRect(30, 30, 204, 460);
  grain(g, 256, 512, 8, 102);
  return texOf(c);
}
// 호수 판 (301~396)
const NUM_COLS = 12, NUM_ROWS = 8;
function makeNumAtlas() {
  const c = cnv(1536, 512), g = c.getContext('2d');
  const cw = 1536 / NUM_COLS, ch = 512 / NUM_ROWS;
  for (let k = 0; k < NUM_COLS * NUM_ROWS; k++) {
    const x = (k % NUM_COLS) * cw, y = Math.floor(k / NUM_COLS) * ch;
    g.fillStyle = '#e9e5d8'; g.fillRect(x + 4, y + 4, cw - 8, ch - 8);
    g.strokeStyle = '#4a4238'; g.lineWidth = 3; g.strokeRect(x + 6, y + 6, cw - 12, ch - 12);
    g.fillStyle = '#1f1a17'; g.font = '900 40px "Noto Sans KR", "Malgun Gothic", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(301 + k), x + cw / 2, y + ch / 2 + 2);
  }
  return texOf(c);
}
// 주방 벽: 아래는 흰 타일, 위는 페인트 (전체 높이 2.4m를 한 장에)
function makeKitchenWallTex() {
  const c = cnv(256, 512), g = c.getContext('2d');
  g.fillStyle = '#dfe6d6'; g.fillRect(0, 0, 256, 512);
  const tileTop = 512 - 512 * (1.25 / 2.4);
  g.fillStyle = '#f4f3ee'; g.fillRect(0, tileTop, 256, 512 - tileTop);
  g.fillStyle = 'rgba(150, 150, 140, 0.8)';
  for (let x = 0; x < 256; x += 51.2) g.fillRect(x, tileTop, 2, 512 - tileTop);
  for (let y = 512; y > tileTop; y -= 21.3) g.fillRect(0, y, 256, 2);
  g.fillStyle = '#9fae96'; g.fillRect(0, tileTop - 6, 256, 6);
  grain(g, 256, 512, 6, 111);
  return texOf(c, { repeat: true });
}
// 샤워실 타일 (0.15m, 파랑·흰색)
function makeShowerTileTex() {
  const N = 256, c = cnv(N, N), g = c.getContext('2d');
  g.fillStyle = '#8fa3ad'; g.fillRect(0, 0, N, N);
  const R = rng(121);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
    const blue = (i * 3 + j * 5) % 7 === 0;
    g.fillStyle = blue ? '#7db6d9' : `rgb(${236 - R() * 10 | 0}, ${240 - R() * 8 | 0}, ${242 - R() * 6 | 0})`;
    g.fillRect(i * 32 + 1.5, j * 32 + 1.5, 29, 29);
  }
  for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(150, 120, 60, ${R() * 0.18})`; g.beginPath(); g.arc(R() * N, R() * N, R() * 8, 0, TAU); g.fill(); }
  return texOf(c, { repeat: true });
}
// 공지 게시판
function makeNoticeTex() {
  const c = cnv(512, 384), g = c.getContext('2d');
  g.fillStyle = '#b48a5a'; g.fillRect(0, 0, 512, 384);
  g.fillStyle = '#c99d6a'; g.fillRect(14, 14, 484, 356);
  const papers = [
    [30, 30, 210, 150, ['공지사항', '밤 10시 이후', '세탁기 사용 금지']],
    [260, 36, 220, 140, ['공용 주방', '사용 후 바로', '정리해 주세요']],
    [40, 200, 200, 150, ['택배는', '각자 찾아가세요']],
    [266, 196, 214, 156, ['복도에서', '통화 자제', '부탁드립니다']],
  ];
  const R = rng(131);
  for (const [x, y, w, h, lines] of papers) {
    g.save(); g.translate(x + w / 2, y + h / 2); g.rotate((R() - 0.5) * 0.08);
    g.fillStyle = '#f6f2e6'; g.fillRect(-w / 2, -h / 2, w, h);
    g.fillStyle = 'rgba(160, 140, 90, 0.25)'; g.fillRect(-w / 2, h / 2 - 18, w, 18);
    g.fillStyle = '#26211c'; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((ln, k) => { g.font = (k === 0 ? '900 30px' : '700 24px') + ' "Noto Sans KR", "Malgun Gothic", sans-serif'; g.fillText(ln, 0, -h / 2 + 34 + k * 38); });
    g.fillStyle = '#d23a3a'; g.beginPath(); g.arc(0, -h / 2 + 8, 6, 0, TAU); g.fill();
    g.restore();
  }
  return texOf(c);
}
// 이불 (체크무늬, 색은 사람마다 따로 입힘)
function makeBlanketTex() {
  const N = 256, c = cnv(N, N), g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, N, N);
  g.fillStyle = 'rgba(0, 0, 0, 0.16)';
  for (let k = 0; k < 8; k++) { g.fillRect(k * 32, 0, 12, N); g.fillRect(0, k * 32, N, 12); }
  g.fillStyle = 'rgba(0, 0, 0, 0.1)';
  for (let k = 0; k < 8; k++) { g.fillRect(k * 32 + 20, 0, 3, N); g.fillRect(0, k * 32 + 20, N, 3); }
  grain(g, N, N, 10, 141);
  return texOf(c, { repeat: true });
}
// 모니터 화면 (영상 보다 켜 둔 것처럼)
function makeScreenTex() {
  const c = cnv(256, 160), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 256, 160); gr.addColorStop(0, '#bfe3ff'); gr.addColorStop(0.55, '#8fc7ff'); gr.addColorStop(1, '#5a8fd8');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 160);
  g.fillStyle = 'rgba(255, 255, 255, 0.55)'; g.fillRect(16, 16, 150, 92);
  g.fillStyle = 'rgba(30, 60, 110, 0.35)'; for (let k = 0; k < 5; k++) g.fillRect(180, 18 + k * 18, 60, 10);
  g.fillStyle = 'rgba(30, 60, 110, 0.4)'; g.fillRect(16, 118, 224, 5); g.fillStyle = '#ff4a5e'; g.fillRect(16, 118, 92, 5);
  return texOf(c);
}
// 택배 상자
function makeBoxTex() {
  const c = cnv(256, 256), g = c.getContext('2d');
  g.fillStyle = '#c4935a'; g.fillRect(0, 0, 256, 256);
  const R = rng(151);
  for (let i = 0; i < 600; i++) { g.fillStyle = `rgba(120, 80, 40, ${R() * 0.12})`; g.fillRect(R() * 256, R() * 256, R() * 20, 1); }
  g.fillStyle = 'rgba(210, 190, 150, 0.85)'; g.fillRect(110, 0, 36, 256);
  g.fillStyle = '#f7f5ee'; g.fillRect(30, 150, 90, 60);
  g.fillStyle = 'rgba(40, 40, 40, 0.7)'; for (let k = 0; k < 4; k++) g.fillRect(38, 160 + k * 11, 60 - k * 8, 4);
  return texOf(c);
}
function makeGlowTex() {
  const c = cnv(128, 128), g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,255,255,0.5)'); gr.addColorStop(0.45, 'rgba(255,255,255,0.14)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return texOf(c, { srgb: false });
}
function makeDirtTex() {
  const N = 256, c = cnv(N, N), g = c.getContext('2d');
  const a = tileNoise(N, 4, 3), b = tileNoise(N, 11, 7), img = g.createImageData(N, N);
  for (let i = 0; i < N * N; i++) { const v = clamp(a[i] * 0.7 + b[i] * 0.3, 0, 1) * 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  return texOf(c, { repeat: true, srgb: false });
}
// 집: 실크 벽지 (1m)
function makeHomeWallTex() {
  const N = 256, c = cnv(N, N), g = c.getContext('2d');
  g.fillStyle = '#f2e3c9'; g.fillRect(0, 0, N, N);
  const R = rng(44);
  for (let i = 0; i < 1600; i++) { g.fillStyle = `rgba(150, 130, 100, ${R() * 0.12})`; g.fillRect(R() * N, R() * N, R() * 18 + 2, 1); }
  grain(g, N, N, 7, 45);
  return texOf(c, { repeat: true });
}
// 마루 (2m × 2m, 판자 폭 0.2m)
function makeWoodTex() {
  const N = 512, c = cnv(N, N), g = c.getContext('2d');
  const R = rng(55);
  for (let r = 0; r < 10; r++) {
    const y = r * 51.2, off = R() * N;
    const base = [rand(168, 190), rand(112, 128), rand(66, 80)];
    for (let k = -3; k < 3; k++) {
      const x0 = off + k * N * 0.62;
      g.fillStyle = `rgb(${base[0] | 0},${base[1] | 0},${base[2] | 0})`; g.fillRect(x0, y, N * 0.62, 51.2);
      for (let s = 0; s < 14; s++) { g.strokeStyle = `rgba(90, 50, 20, ${0.12 + R() * 0.16})`; g.lineWidth = 1 + R() * 1.5; g.beginPath(); const yy = y + 4 + R() * 44; g.moveTo(x0, yy); g.bezierCurveTo(x0 + 80, yy + R() * 6 - 3, x0 + 200, yy + R() * 6 - 3, x0 + N * 0.62, yy); g.stroke(); }
      g.fillStyle = 'rgba(60, 30, 10, 0.55)'; g.fillRect(x0, y, 2, 51.2);
    }
    g.fillStyle = 'rgba(60, 30, 10, 0.5)'; g.fillRect(0, y, N, 2);
  }
  grain(g, N, N, 10, 56);
  return texOf(c, { repeat: true });
}
// 현관 타일 (0.6m에 두 장씩)
function makeTileTex() {
  const N = 256, c = cnv(N, N), g = c.getContext('2d');
  g.fillStyle = '#8f8a82'; g.fillRect(0, 0, N, N);
  const R = rng(66);
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const v = 196 + R() * 10;
    g.fillStyle = `rgb(${v | 0},${(v - 6) | 0},${(v - 16) | 0})`; g.fillRect(i * 128 + 3, j * 128 + 3, 122, 122);
    for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(120, 110, 100, ${R() * 0.25})`; g.beginPath(); g.arc(i * 128 + 3 + R() * 122, j * 128 + 3 + R() * 122, R() * 6, 0, TAU); g.fill(); }
  }
  grain(g, N, N, 8, 67);
  return texOf(c, { repeat: true });
}
// 방문 (흰 문짝에 패널 홈)
function makeDoorTex(dark) {
  const c = cnv(256, 512), g = c.getContext('2d');
  if (dark) {
    g.fillStyle = '#5b4637'; g.fillRect(0, 0, 256, 512);
    for (let y = 30; y < 512; y += 38) { g.fillStyle = 'rgba(30, 20, 12, 0.45)'; g.fillRect(16, y, 224, 3); g.fillStyle = 'rgba(255, 230, 200, 0.08)'; g.fillRect(16, y + 3, 224, 2); }
    grain(g, 256, 512, 9, 71);
  } else {
    g.fillStyle = '#f2efe8'; g.fillRect(0, 0, 256, 512);
    g.strokeStyle = 'rgba(120, 110, 95, 0.4)'; g.lineWidth = 3;
    g.strokeRect(34, 40, 188, 190); g.strokeRect(34, 270, 188, 200);
    g.strokeStyle = 'rgba(255, 255, 255, 0.9)'; g.lineWidth = 2;
    g.strokeRect(38, 44, 188, 190); g.strokeRect(38, 274, 188, 200);
    grain(g, 256, 512, 5, 72);
  }
  return texOf(c);
}
// 신발장
function makeCabinetTex() {
  const c = cnv(512, 512), g = c.getContext('2d');
  g.fillStyle = '#f3f0ea'; g.fillRect(0, 0, 512, 512);
  g.fillStyle = 'rgba(110, 100, 90, 0.45)';
  for (const x of [170, 341]) g.fillRect(x, 0, 3, 512);
  g.fillRect(0, 300, 512, 3);
  g.fillStyle = '#b9b3a9';
  for (const x of [150, 191, 321, 362]) g.fillRect(x, 230, 6, 54);
  grain(g, 512, 512, 6, 73);
  return texOf(c);
}
// 액자 그림 (흐린 풍경)
function makePaintingTex() {
  const c = cnv(256, 192), g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 192); sky.addColorStop(0, '#9fc3e4'); sky.addColorStop(1, '#f2e2c2');
  g.fillStyle = sky; g.fillRect(0, 0, 256, 192);
  g.fillStyle = '#6d8f5a'; g.beginPath(); g.moveTo(0, 140); g.quadraticCurveTo(80, 96, 150, 126); g.quadraticCurveTo(210, 146, 256, 112); g.lineTo(256, 192); g.lineTo(0, 192); g.fill();
  g.fillStyle = '#4f6e45'; g.beginPath(); g.moveTo(0, 170); g.quadraticCurveTo(120, 140, 256, 168); g.lineTo(256, 192); g.lineTo(0, 192); g.fill();
  g.fillStyle = '#f7e9b5'; g.beginPath(); g.arc(190, 54, 16, 0, TAU); g.fill();
  g.strokeStyle = '#3d2b1f'; g.lineWidth = 12; g.strokeRect(0, 0, 256, 192);
  return texOf(c);
}
// 권총 탄약 상자
function makeAmmoTex() {
  const c = cnv(256, 128), g = c.getContext('2d');
  g.fillStyle = '#3f6b3c'; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#e8d27a'; g.fillRect(0, 34, 256, 60);
  g.fillStyle = '#2b2a24';
  for (let i = 0; i < 5; i++) {
    const x = 30 + i * 46;
    g.beginPath(); g.moveTo(x, 84); g.lineTo(x, 52); g.quadraticCurveTo(x + 9, 36, x + 18, 52); g.lineTo(x + 18, 84); g.closePath(); g.fill();
    g.fillStyle = '#a8742e'; g.fillRect(x, 70, 18, 14); g.fillStyle = '#2b2a24';
  }
  g.strokeStyle = '#1f1a17'; g.lineWidth = 6; g.strokeRect(3, 3, 250, 122);
  return texOf(c);
}
// 그림자 얼룩
function makeBlobTex() {
  const c = cnv(128, 128), g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 6, 64, 64, 62);
  gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.42)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return texOf(c, { srgb: false });
}

// ── 군중 얼굴 (3×2 아틀라스, 칸 512: 우는 얼굴 넷 + 무표정) ──
const FACE_OFF = [[0, 0.5], [1 / 3, 0.5], [0, 0], [1 / 3, 0], [2 / 3, 0.5]];
function drawTears(g, cx, ey, ex, alpha) {
  for (const sx of [-1, 1]) {
    const x0 = cx + sx * (ex + 11), y0 = ey + 15;
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = `rgba(95, 190, 255, ${0.85 * alpha})`; g.lineWidth = 11;
    g.beginPath(); g.moveTo(x0, y0);
    g.bezierCurveTo(x0 + sx * 8, y0 + 30, x0 - sx * 6, y0 + 58, x0 + sx * 6, y0 + 112);
    g.stroke();
    g.strokeStyle = `rgba(235, 250, 255, ${0.9 * alpha})`; g.lineWidth = 3.5;
    g.beginPath(); g.moveTo(x0 - sx * 2, y0 + 6);
    g.bezierCurveTo(x0 + sx * 5, y0 + 30, x0 - sx * 8, y0 + 56, x0 + sx * 3, y0 + 100);
    g.stroke();
    g.fillStyle = `rgba(95, 190, 255, ${0.9 * alpha})`;
    g.beginPath(); g.ellipse(x0 + sx * 7, y0 + 118, 6, 8, 0, 0, TAU); g.fill();
  }
}
function drawCrowdDeadEyes(g, cx, ey, ex) {
  const ink = '#2a1d26';
  for (const sx of [-1, 1]) {
    const x = cx + sx * ex, inner = x - sx * 20, outer = x + sx * 20;
    g.save();
    g.beginPath(); g.moveTo(inner, ey - 3);
    g.quadraticCurveTo(x, ey + 1, outer, ey + 8);
    g.quadraticCurveTo(x, ey + 24, inner, ey + 13); g.closePath();
    g.fillStyle = '#ddd6da'; g.fill(); g.clip();
    g.fillStyle = ink; g.beginPath(); g.ellipse(x, ey + 12, 8, 11, 0, 0, TAU); g.fill();
    g.restore();
    g.strokeStyle = ink; g.lineWidth = 7;
    g.beginPath(); g.moveTo(inner, ey - 3); g.quadraticCurveTo(x, ey + 1, outer, ey + 8); g.stroke();
    g.strokeStyle = 'rgba(70, 45, 58, 0.3)'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(inner + sx * 3, ey + 20); g.quadraticCurveTo(x, ey + 28, outer - sx * 2, ey + 22); g.stroke();
  }
}
function drawCrowdFace(g, ox, oy, st) {
  g.save(); g.translate(ox, oy);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  const cx = 128, ey = 120, ex = 40, ink = '#2a1d26';
  // Crying blush and red nose remain, but the brows and eyes are now angry.
  for (const sx of [-1, 1]) {
    const x = cx + sx * 64;
    const blush = g.createRadialGradient(x, 160, 2, x, 160, 30);
    blush.addColorStop(0, st === 2 ? 'rgba(255, 110, 140, .55)' : 'rgba(240, 80, 90, .42)');
    blush.addColorStop(1, 'rgba(240, 80, 90, 0)');
    g.fillStyle = blush; g.beginPath(); g.arc(x, 160, 30, 0, TAU); g.fill();
  }
  g.fillStyle = 'rgba(230, 85, 92, .6)';
  g.beginPath(); g.ellipse(cx, 156, 9, 6.5, 0, 0, TAU); g.fill();
  g.lineCap = 'round'; g.lineJoin = 'round';
  // Inner brow tips drop into a determined scowl.
  g.strokeStyle = ink; g.lineWidth = 8;
  for (const sx of [-1, 1]) {
    const inner = cx + sx * 14, outer = cx + sx * 64;
    g.beginPath(); g.moveTo(outer, 76); g.quadraticCurveTo(cx + sx * 40, 81, inner, 100); g.stroke();
  }
  if (st === 3) {
    g.strokeStyle = ink; g.lineWidth = 8;
    for (const sx of [-1, 1]) {
      const x = cx + sx * ex;
      g.beginPath(); g.moveTo(x - 13, ey - 13); g.lineTo(x + 13, ey + 13);
      g.moveTo(x + 13, ey - 13); g.lineTo(x - 13, ey + 13); g.stroke();
    }
  } else {
    g.fillStyle = ink;
    for (const sx of [-1, 1]) {
      const x = cx + sx * ex;
      g.beginPath(); g.moveTo(x - 19, ey - 7);
      g.quadraticCurveTo(x, ey + 3, x + 19, ey - 7);
      g.lineTo(x + 13, ey + 7); g.quadraticCurveTo(x, ey + 13, x - 13, ey + 7);
      g.closePath(); g.fill();
    }
    drawTears(g, cx, ey, ex, st === 2 ? .65 : 1);
  }
  g.strokeStyle = ink; g.lineWidth = 5;
  if (st === 2) {
    // Tight, downward-curved mouth: an angry pout under the tears.
    g.beginPath(); g.moveTo(108, 202); g.lineTo(120, 207); g.lineTo(128, 203); g.lineTo(136, 207); g.lineTo(148, 202); g.stroke();
  } else if (st === 1) {
    g.fillStyle = '#4a1724'; g.beginPath(); g.ellipse(128, 208, 16, 21, 0, 0, TAU); g.fill();
    g.fillStyle = '#fff'; g.fillRect(117, 192, 22, 5);
  } else if (st === 0) {
    g.beginPath(); g.moveTo(111, 203); g.lineTo(145, 203); g.stroke();
  } else {
    g.fillStyle = '#3a1520'; g.beginPath(); g.ellipse(128, 206, 11, 14, 0, 0, TAU); g.fill();
  }
  g.restore();
}
function drawCrowdNeutralFace(g, ox, oy) {
  g.save(); g.translate(ox, oy);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  const ink = '#2a1d26';
  g.strokeStyle = ink; g.lineCap = 'round'; g.lineWidth = 6;
  drawCrowdDeadEyes(g, 128, 120, 40);
  g.strokeStyle = ink; g.lineWidth = 6;
  for (const x of [88, 168]) { g.beginPath(); g.moveTo(x - 18, 88); g.lineTo(x + 18, 88); g.stroke(); }
  g.strokeStyle = 'rgba(120, 75, 70, 0.45)'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(124, 155); g.quadraticCurveTo(128, 159, 132, 155); g.stroke();
  g.strokeStyle = ink; g.lineWidth = 5;
  g.beginPath(); g.moveTo(109, 202); g.lineTo(147, 202); g.stroke();
  g.restore();
}
function makeCrowdFaceAtlas() {
  // 코앞에서 보이니 두 배 해상도로 그린다
  const c = cnv(1536, 1024), g = c.getContext('2d');
  g.scale(2, 2);
  drawCrowdFace(g, 0, 0, 0);
  drawCrowdFace(g, 256, 0, 1);
  drawCrowdFace(g, 0, 256, 2);
  drawCrowdFace(g, 256, 256, 3);
  drawCrowdNeutralFace(g, 512, 0);
  return texOf(c);
}

// ── 자국 아틀라스 (4×2): 0,1 튄 피 / 2 길게 튄 피 / 3 웅덩이 / 4 총알 구멍 / 5 벽에 번진 피 ──
const DEC_OFF = [];
for (let k = 0; k < 8; k++) DEC_OFF.push([(k % 4) / 4, k < 4 ? 0.5 : 0]);
function makeDecalAtlas() {
  const c = cnv(1024, 512), g = c.getContext('2d');
  const blob = (x, y, r, col) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); };
  const dark = '#8e0014', mid = '#bb0019', hi = '#e0152f';
  const cell = (k, fn) => { g.save(); g.translate((k % 4) * 256 + 128, (k < 4 ? 0 : 256) + 128); fn(); g.restore(); };
  for (const k of [0, 1]) cell(k, () => {
    g.fillStyle = mid; g.beginPath();
    for (let i = 0; i <= 40; i++) { const a = i / 40 * TAU, r = 48 + (i % 2 ? rand(10, 34) : rand(-6, 6)); const px = Math.cos(a) * r, py = Math.sin(a) * r; if (i) g.lineTo(px, py); else g.moveTo(px, py); }
    g.fill(); blob(0, 0, 44, mid);
    g.fillStyle = hi; g.beginPath(); g.ellipse(-12, -14, 20, 12, -0.5, 0, TAU); g.fill();
    for (let i = 0; i < 16; i++) { const a = rand(0, TAU), d = rand(66, 112); blob(Math.cos(a) * d, Math.sin(a) * d, rand(2.5, 8), i % 2 ? dark : mid); }
  });
  cell(2, () => {
    g.rotate(0.15); g.fillStyle = mid;
    g.beginPath(); g.ellipse(-30, 0, 44, 30, 0, 0, TAU); g.fill();
    for (let i = 0; i < 14; i++) { const d = 30 + i * 6.5, r = Math.max(2.5, 16 - i * 1.0); blob(d, rand(-10, 10), r, i % 3 ? mid : dark); }
    for (let i = 0; i < 10; i++) blob(rand(-70, 110), rand(-50, 50), rand(2, 5), dark);
  });
  cell(3, () => {
    g.fillStyle = dark; g.beginPath();
    for (let i = 0; i <= 28; i++) { const a = i / 28 * TAU, r = 92 + Math.sin(a * 3 + 1) * 10 + Math.sin(a * 7) * 6; const px = Math.cos(a) * r, py = Math.sin(a) * r; if (i) g.lineTo(px, py); else g.moveTo(px, py); }
    g.fill();
    g.fillStyle = mid; g.beginPath(); g.ellipse(-6, -6, 76, 70, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255, 120, 130, 0.45)'; g.beginPath(); g.ellipse(-30, -34, 26, 11, -0.6, 0, TAU); g.fill();
  });
  cell(4, () => {
    const gr = g.createRadialGradient(0, 0, 4, 0, 0, 60); gr.addColorStop(0, 'rgba(60, 40, 20, 0.6)'); gr.addColorStop(1, 'rgba(60, 40, 20, 0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 60, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255, 240, 200, 0.55)'; g.beginPath(); g.arc(0, 0, 26, 0, TAU); g.fill();
    g.fillStyle = '#1a120c'; g.beginPath(); for (let i = 0; i <= 12; i++) { const a = i / 12 * TAU, r = 15 + (i % 2 ? 5 : 0); if (i) g.lineTo(Math.cos(a) * r, Math.sin(a) * r); else g.moveTo(r, 0); } g.fill();
  });
  cell(5, () => {
    g.fillStyle = mid; g.beginPath(); g.ellipse(0, -30, 60, 46, 0, 0, TAU); g.fill();
    for (let i = 0; i < 7; i++) { const x = rand(-50, 50), len = rand(40, 110); g.fillStyle = i % 2 ? mid : dark; g.fillRect(x - 4, -20, rand(5, 10), len); blob(x, -20 + len, rand(5, 8), i % 2 ? mid : dark); }
    for (let i = 0; i < 14; i++) { const a = rand(0, TAU), d = rand(50, 110); blob(Math.cos(a) * d, Math.sin(a) * d * 0.8 - 30, rand(2, 6), dark); }
  });
  return texOf(c);
}
function makeFlashTex() {
  const c = cnv(128, 128), g = c.getContext('2d');
  g.translate(64, 64);
  g.fillStyle = '#ff9a1a'; g.beginPath();
  for (let i = 0; i <= 16; i++) { const a = i / 16 * TAU, r = i % 2 ? 22 : 62; const px = Math.cos(a) * r, py = Math.sin(a) * r; if (i) g.lineTo(px, py); else g.moveTo(px, py); }
  g.fill();
  g.fillStyle = '#ffe14d'; g.beginPath();
  for (let i = 0; i <= 16; i++) { const a = i / 16 * TAU + 0.2, r = i % 2 ? 14 : 40; const px = Math.cos(a) * r, py = Math.sin(a) * r; if (i) g.lineTo(px, py); else g.moveTo(px, py); }
  g.fill();
  g.fillStyle = '#ffffff'; g.beginPath(); g.arc(0, 0, 13, 0, TAU); g.fill();
  return texOf(c);
}

const TEX = {
  floor: makeFloorTex(), corWall: makeCorWallTex(), roomWall: makeRoomWallTex(), ceil: makeCeilingTex(), tube: makeTubeTex(), glow: makeGlowTex(), dirt: makeDirtTex(),
  gosiDoor: makeGosiDoorTex(), nums: makeNumAtlas(), kitchenWall: makeKitchenWallTex(), showerTile: makeShowerTileTex(), notice: makeNoticeTex(), blanket: makeBlanketTex(), screen: makeScreenTex(), box: makeBoxTex(),
  homeWall: makeHomeWallTex(), wood: makeWoodTex(), tile: makeTileTex(), doorWhite: makeDoorTex(false), doorDark: makeDoorTex(true),
  cabinet: makeCabinetTex(), painting: makePaintingTex(), ammo: makeAmmoTex(), blob: makeBlobTex(),
  face: makeCrowdFaceAtlas(), decal: makeDecalAtlas(), flash: makeFlashTex(),
};


// ───────────────────────── 빛 (바닥에 깔린 밝기 지도) ─────────────────────────
// 형광등 하나하나가 벽에 막히는 범위까지만 비춘다. 켜고 끄고 깜빡이는 대로 지도가 바뀌고,
// 벽·바닥·사람이 모두 이 지도에서 자기 자리의 밝기를 읽는다.
const CEIL = 2.4;              // 고시원 천장 (낮다)
const HOME_CEIL = 2.42;
const ENTRY_Y = -0.13;         // 현관 바닥 (한 칸 낮음)
const LF = { x0: -1.5, z0: -1.5, res: 4 };
LF.nx = Math.round((36) * LF.res);
LF.nz = Math.round((39.5) * LF.res);
LF.bv = new Uint8Array((LF.nx + 1) * LF.nz);
LF.bh = new Uint8Array(LF.nx * (LF.nz + 1));
LF.acc = new Float32Array(LF.nx * LF.nz);
LF.data = new Uint8Array(LF.nx * LF.nz);
LF.tex = new THREE.DataTexture(LF.data, LF.nx, LF.nz, THREE.RedFormat, THREE.UnsignedByteType);
LF.tex.minFilter = LF.tex.magFilter = THREE.LinearFilter; LF.tex.generateMipmaps = false; LF.tex.needsUpdate = true;
LF.norm = 1 / 3.1;
LF.dirty = true;

function lfBlockV(xw, za, zb) {
  const i = Math.round((xw - LF.x0) * LF.res);
  const j0 = Math.floor((za - LF.z0) * LF.res + 1e-6), j1 = Math.ceil((zb - LF.z0) * LF.res - 1e-6);
  for (let j = Math.max(0, j0); j < Math.min(LF.nz, j1); j++) LF.bv[j * (LF.nx + 1) + i] = 1;
}
function lfBlockH(zw, xa, xb) {
  const j = Math.round((zw - LF.z0) * LF.res);
  const i0 = Math.floor((xa - LF.x0) * LF.res + 1e-6), i1 = Math.ceil((xb - LF.x0) * LF.res - 1e-6);
  for (let i = Math.max(0, i0); i < Math.min(LF.nx, i1); i++) LF.bh[j * LF.nx + i] = 1;
}
function lfLOS(i0, j0, i1, j1) {
  const nx = LF.nx;
  let i = i0, j = j0;
  const dx = i1 - i0, dz = j1 - j0, sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx), adz = Math.abs(dz);
  let tx = adx ? 0.5 / adx : 9, tz = adz ? 0.5 / adz : 9;
  const ddx = adx ? 1 / adx : 9, ddz = adz ? 1 / adz : 9;
  let guard = 0;
  while ((i !== i1 || j !== j1) && guard++ < 400) {
    if (tx < tz - 1e-9) {
      if (LF.bv[j * (nx + 1) + (sx > 0 ? i + 1 : i)]) return false;
      i += sx; tx += ddx;
    } else if (tz < tx - 1e-9) {
      if (LF.bh[(sz > 0 ? j + 1 : j) * nx + i]) return false;
      j += sz; tz += ddz;
    } else {
      const bx = sx > 0 ? i + 1 : i, bz = sz > 0 ? j + 1 : j;
      const r1 = !LF.bv[j * (nx + 1) + bx] && !LF.bh[bz * nx + (i + sx)];
      const r2 = !LF.bh[bz * nx + i] && !LF.bv[(j + sz) * (nx + 1) + bx];
      if (!r1 || !r2) return false;
      i += sx; j += sz; tx += ddx; tz += ddz;
    }
  }
  return true;
}
function lfFootprint(fx, fz, R, gain = 1) {
  const ci = Math.floor((fx - LF.x0) * LF.res), cj = Math.floor((fz - LF.z0) * LF.res);
  const rr = Math.ceil(R * LF.res), idx = [], w = [];
  for (let j = cj - rr; j <= cj + rr; j++) {
    if (j < 0 || j >= LF.nz) continue;
    for (let i = ci - rr; i <= ci + rr; i++) {
      if (i < 0 || i >= LF.nx) continue;
      const px = LF.x0 + (i + 0.5) / LF.res, pz = LF.z0 + (j + 0.5) / LF.res;
      const d = Math.hypot(px - fx, pz - fz);
      if (d > R) continue;
      if (!lfLOS(ci, cj, i, j)) continue;
      const k = 1 - (d / R) * (d / R);
      idx.push(j * LF.nx + i); w.push(gain * k * k / (1 + (d / 2.2) * (d / 2.2)));
    }
  }
  return { idx: Int32Array.from(idx), w: Float32Array.from(w) };
}
function lfAtCPU(x, z) {
  // 이중 선형 보간 (셰이더와 같은 값)
  const fx = (x - LF.x0) * LF.res - 0.5, fz = (z - LF.z0) * LF.res - 0.5;
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const at = (a, b) => (a < 0 || b < 0 || a >= LF.nx || b >= LF.nz) ? 0 : LF.data[b * LF.nx + a] / 100;
  return lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), tz);
}

// ── 형광등 ──
const FIX = [];
function addFixture(o) {
  const f = Object.assign({ I: 0, applied: 0, mode: 'on', base: 1, ft: rand(0, 3), burst: 0, gain: 1, R: 7.5, kind: 'panel', mesh: -1, dieT: 0 }, o);
  f.foot = lfFootprint(f.x, f.z, f.R, f.gain);
  FIX.push(f);
  return f;
}
function fixApply(f, I) {
  const d = I - f.applied;
  if (Math.abs(d) < 0.004) return;
  const idx = f.foot.idx, w = f.foot.w, acc = LF.acc;
  for (let k = 0; k < idx.length; k++) acc[idx[k]] += d * w[k];
  f.applied = I;
  LF.dirty = true;
}
function lfFlush() {
  if (!LF.dirty) return;
  const acc = LF.acc, data = LF.data, s = LF.norm * 100;
  for (let k = 0; k < acc.length; k++) { const v = acc[k] * s; data[k] = v <= 0 ? 0 : v >= 255 ? 255 : v; }
  LF.tex.needsUpdate = true;
  LF.dirty = false;
}
// 깜빡임: 대부분 켜져 있다가 가끔 몇 번 툭툭 꺼진다
function fixTick(f, dt) {
  f.ft -= dt;
  let I = f.base;
  if (f.mode === 'off') I = 0;
  else if (f.mode === 'flicker' || f.mode === 'path') {
    if (f.burst > 0) {
      f.burst -= dt;
      I = (Math.sin(f.burst * 61 + f.x) > 0.1 ? 1 : 0.06) * f.base;
      if (f.burst <= 0) f.ft = f.mode === 'path' ? rand(2.5, 7) : rand(0.6, 3.2);
    } else if (f.ft <= 0) { f.burst = rand(0.12, 0.55); if (f.near && f.near < 9) sfxFlick(clamp(1.1 - f.near * 0.1, 0.25, 1), f.pan || 0); }
  } else if (f.mode === 'broken') {
    I = 0;
    if (f.burst > 0) { f.burst -= dt; I = Math.sin(f.burst * 70) > 0.4 ? f.base * 0.9 : 0; if (f.burst <= 0) f.ft = rand(3, 9); }
    else if (f.ft <= 0) { f.burst = rand(0.08, 0.3); if (f.near && f.near < 9) sfxFlick(clamp(1 - f.near * 0.1, 0.2, 0.8), f.pan || 0); }
  } else if (f.mode === 'dying') {
    f.dieT -= dt;
    I = f.dieT > 0 ? (Math.sin(f.dieT * 47 + f.z) > -0.1 ? f.base : 0.05) : 0;
    if (f.dieT <= 0) f.mode = 'off';
  }
  f.I = I;
  fixApply(f, I);
}

// ── 셰이더 ──
const LU = {
  uLF: { value: LF.tex }, uLFRect: { value: new THREE.Vector4(LF.x0, LF.z0, LF.res / LF.nx, LF.res / LF.nz) },
  uAmb: { value: 0.03 }, uFlash: { value: new THREE.Vector4(0, -50, 0, 0) },
  uFogColor: { value: new THREE.Color(0x8a8160) }, uFogNear: { value: 3.5 }, uFogFar: { value: 23 }, uFogMax: { value: 0.86 },
  uLightA: { value: new THREE.Color(0.93, 1.0, 0.86) }, uLightB: { value: new THREE.Color(1.0, 0.96, 0.88) },
  uDirt: { value: TEX.dirt },
};
const LIGHT_GLSL = `
uniform sampler2D uLF; uniform vec4 uLFRect; uniform float uAmb; uniform vec4 uFlash;
uniform vec3 uFogColor; uniform float uFogNear; uniform float uFogFar; uniform float uFogMax;
uniform vec3 uLightA; uniform vec3 uLightB;
vec3 lightTint(vec3 wp) { return wp.z < 30.0 ? uLightA : uLightB; }
float lfAt(vec2 p) { return texture2D(uLF, (p - uLFRect.xy) * uLFRect.zw).r * 2.55; }
float flashAt(vec3 wp) { vec3 d = wp - uFlash.xyz; return uFlash.w / (1.0 + dot(d, d) * 1.5); }
vec3 applyFog(vec3 col, vec3 wp, float L) {
  float ff = smoothstep(uFogNear, uFogFar, distance(wp, cameraPosition)) * uFogMax;
  return mix(col, uFogColor * clamp(L * 0.85, 0.0, 1.1), ff);
}
`;
const ENV_VS = `
varying vec2 vUv; varying vec3 vWP; varying vec3 vWN;
void main() {
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  #ifdef USE_INSTANCING
    wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  #else
    vWN = normalize(mat3(modelMatrix) * normal);
  #endif
  vWP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const ENV_FS = LIGHT_GLSL + `
uniform sampler2D map; uniform vec3 uTint; uniform float uKind; uniform float uFloorY; uniform float uCeilY; uniform float uDirtAmt; uniform float uGain;
uniform sampler2D uDirt;
varying vec2 vUv; varying vec3 vWP; varying vec3 vWN;
void main() {
  vec3 alb = texture2D(map, vUv).rgb * uTint;
  vec2 duv = abs(vWN.y) > 0.5 ? vWP.xz * 0.11 : vec2(vWP.x + vWP.z, vWP.y * 1.3) * 0.13;
  float dirt = mix(1.0 - uDirtAmt, 1.0 + uDirtAmt * 0.35, texture2D(uDirt, duv).r);
  float L = lfAt(vWP.xz + vWN.xz * 0.3);
  if (uKind < 0.5) {
    float h = vWP.y - uFloorY;
    L *= mix(0.8, 1.16, smoothstep(0.3, uCeilY - uFloorY, h));
    L *= mix(0.58, 1.0, smoothstep(0.0, 0.32, h));
    L *= mix(0.8, 1.0, smoothstep(0.0, 0.22, uCeilY - vWP.y));
  } else if (uKind > 1.5) {
    L *= 0.7;
  }
  L = L * uGain + uAmb + flashAt(vWP);
  vec3 col = alb * dirt * L * lightTint(vWP);
  col = applyFog(col, vWP, L);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;
const WHITE_TEX = (() => { const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); t.needsUpdate = true; t.colorSpace = THREE.SRGBColorSpace; return t; })();
function envMat(o = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: Object.assign({
      map: { value: o.map || WHITE_TEX }, uTint: { value: new THREE.Color(o.color === undefined ? 0xffffff : o.color) },
      uKind: { value: o.kind || 0 }, uFloorY: { value: o.floorY || 0 }, uCeilY: { value: o.ceilY || CEIL },
      uDirtAmt: { value: o.dirt === undefined ? 0.16 : o.dirt }, uGain: { value: o.gain === undefined ? 1 : o.gain },
    }, LU),
    vertexShader: ENV_VS, fragmentShader: ENV_FS,
    side: o.side || THREE.FrontSide,
  });
  if (o.polygonOffset) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; }
  return m;
}
// 형광등 판: 인스턴스 색의 빨강 칸 = 켜짐 정도
const PANEL_VS = `
varying vec2 vUv; varying vec3 vWP; varying float vI;
void main() {
  vUv = uv;
  #ifdef USE_INSTANCING_COLOR
    vI = instanceColor.r;
  #else
    vI = 1.0;
  #endif
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const PANEL_FS = LIGHT_GLSL + `
uniform sampler2D map;
varying vec2 vUv; varying vec3 vWP; varying float vI;
void main() {
  vec3 d = texture2D(map, vUv).rgb;
  float L = lfAt(vWP.xz) * 0.5 + uAmb + flashAt(vWP);
  vec3 off = d * vec3(0.72, 0.7, 0.62) * L;
  vec3 on = mix(vec3(0.95, 1.0, 0.94), d * vec3(0.96, 1.0, 0.92), 0.25);
  float k = clamp(vI, 0.0, 1.0);
  vec3 col = mix(off, on, k);
  col = applyFog(col, vWP, max(L, k * 1.2));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;
const GLOW_FS = LIGHT_GLSL + `
uniform sampler2D map; uniform vec3 uColor; uniform float uStr;
varying vec2 vUv; varying vec3 vWP; varying float vI;
void main() {
  float a = texture2D(map, vUv).r * clamp(vI, 0.0, 1.0) * uStr;
  float ff = 1.0 - smoothstep(uFogNear, uFogFar + 6.0, distance(vWP, cameraPosition)) * 0.8;
  gl_FragColor = vec4(uColor * a * ff, 1.0);
}`;
// 사람·소품용 툰 재질에 같은 빛과 안개를 넣는다
function patchLit(mat, key, outline = false, extra = null) {
  mat.onBeforeCompile = (sh) => {
    if (extra) extra(sh);
    Object.assign(sh.uniforms, LU);
    if (outline) { sh.uniforms.uPx = OUTLINE.px; sh.uniforms.uRes = OUTLINE.res; }
    let vs = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWP2;' + (outline ? '\nuniform float uPx;\nuniform vec2 uRes;' : ''));
    vs = vs.replace('#include <project_vertex>', `#include <project_vertex>
      { vec4 w4 = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          w4 = instanceMatrix * w4;
        #endif
        vWP2 = (modelMatrix * w4).xyz; }` + (outline ? `
      { vec3 oN = normal;
        #ifdef USE_INSTANCING
          oN = mat3(instanceMatrix) * oN;
        #endif
        vec3 oV = normalize(normalMatrix * oN);
        vec2 oD = oV.xy; float oL = length(oD);
        oD = oL > 0.0001 ? oD / oL : vec2(0.0);
        gl_Position.xy += oD * uPx * 2.0 / uRes * gl_Position.w; }` : ''));
    sh.vertexShader = vs;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP2;\n' + LIGHT_GLSL)
      .replace('#include <opaque_fragment>', `float Lc = lfAt(vWP2.xz) + uAmb + flashAt(vWP2);
        outgoingLight = applyFog(outgoingLight * ${outline ? 'min(Lc, 1.0)' : 'Lc * lightTint(vWP2)'}, vWP2, Lc);
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}
function makeGradient(stops) {
  const d = new Uint8Array(stops.length * 4);
  stops.forEach((v, i) => { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; });
  const t = new THREE.DataTexture(d, stops.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
const GRAD = makeGradient([118, 196, 255]);
function toonLit(color, extra = {}, key = 'toonlit') { return patchLit(new THREE.MeshToonMaterial({ color, gradientMap: GRAD, ...extra }), key); }
const OUT_LIT = patchLit(new THREE.MeshBasicMaterial({ color: 0x221a2b, side: THREE.BackSide }), 'outline-lit', true);

// 사람을 비추는 빛 (벽은 밝기 지도만 쓰고 이 빛은 툰 재질만 받는다)
const hemi = new THREE.HemisphereLight(0xffffff, 0x8f7a46, 1.35);
scene.add(hemi);
const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
scene.add(keyLight, keyLight.target);


// ───────────────────────── 고시원 ─────────────────────────
// 평면도는 mkgosi.py가 만든다 (복도·방·주방·샤워실·끝방, 벽 면 목록, 형광등 자리)
const GOSI = { "G": 8, "NX": 264, "NZ": 240, "W": 33.0, "H": 30.0, "regions": [{ "id": 1, "type": "cor", "rect": [3.25, 21.375, 32.0, 22.875], "name": "H1" }, { "id": 2, "type": "cor", "rect": [1.0, 14.5, 32.0, 16.0], "name": "H2" }, { "id": 3, "type": "cor", "rect": [1.0, 7.625, 29.5, 9.125], "name": "H3" }, { "id": 4, "type": "cor", "rect": [6.25, 0.75, 27.25, 2.25], "name": "H4" }, { "id": 5, "type": "cor", "rect": [15.75, 16.0, 17.25, 27.0], "name": "MAIN" }, { "id": 6, "type": "cor", "rect": [1.0, 9.125, 2.5, 14.5], "name": "VW" }, { "id": 7, "type": "cor", "rect": [30.5, 16.0, 32.0, 21.375], "name": "VE" }, { "id": 8, "type": "cor", "rect": [19.75, 2.25, 21.25, 7.625], "name": "C34" }, { "id": 9, "type": "lobby", "rect": [14.75, 27.0, 18.25, 30.0] }, { "id": 10, "type": "kitchen", "rect": [22.0, 9.25, 27.0, 14.375], "num": "공용 주방" }, { "id": 11, "type": "shower", "rect": [5.75, 18.75, 10.0, 21.25], "num": "샤워실" }, { "id": 12, "type": "gun", "rect": [3.625, 0.625, 6.125, 3.25], "num": "끝방" }, { "id": 13, "type": "room", "rect": [6.25, 2.375, 8.375, 4.875], "num": "301", "cor": "H4" }, { "id": 14, "type": "door", "rect": [6.5, 2.25, 7.375, 2.375], "room": 13 }, { "id": 15, "type": "room", "rect": [8.5, 2.375, 10.625, 4.875], "num": "302", "cor": "H4" }, { "id": 16, "type": "door", "rect": [9.5, 2.25, 10.375, 2.375], "room": 15 }, { "id": 17, "type": "room", "rect": [10.75, 2.375, 12.875, 4.875], "num": "303", "cor": "H4" }, { "id": 18, "type": "door", "rect": [11.0, 2.25, 11.875, 2.375], "room": 17 }, { "id": 19, "type": "room", "rect": [13.0, 2.375, 15.125, 4.875], "num": "304", "cor": "H4" }, { "id": 20, "type": "door", "rect": [14.0, 2.25, 14.875, 2.375], "room": 19 }, { "id": 21, "type": "room", "rect": [15.25, 2.375, 17.375, 4.875], "num": "305", "cor": "H4" }, { "id": 22, "type": "door", "rect": [15.5, 2.25, 16.375, 2.375], "room": 21 }, { "id": 23, "type": "room", "rect": [17.5, 2.375, 19.625, 4.875], "num": "306", "cor": "H4" }, { "id": 24, "type": "door", "rect": [18.5, 2.25, 19.375, 2.375], "room": 23 }, { "id": 25, "type": "room", "rect": [21.375, 2.375, 23.5, 4.875], "num": "307", "cor": "H4" }, { "id": 26, "type": "door", "rect": [21.625, 2.25, 22.5, 2.375], "room": 25 }, { "id": 27, "type": "room", "rect": [23.625, 2.375, 25.75, 4.875], "num": "308", "cor": "H4" }, { "id": 28, "type": "door", "rect": [24.625, 2.25, 25.5, 2.375], "room": 27 }, { "id": 29, "type": "room", "rect": [1.0, 5.0, 3.125, 7.5], "num": "309", "cor": "H3" }, { "id": 30, "type": "door", "rect": [1.25, 7.5, 2.125, 7.625], "room": 29 }, { "id": 31, "type": "room", "rect": [3.25, 5.0, 5.375, 7.5], "num": "310", "cor": "H3" }, { "id": 32, "type": "door", "rect": [4.25, 7.5, 5.125, 7.625], "room": 31 }, { "id": 33, "type": "room", "rect": [5.5, 5.0, 7.625, 7.5], "num": "311", "cor": "H3" }, { "id": 34, "type": "door", "rect": [5.75, 7.5, 6.625, 7.625], "room": 33 }, { "id": 35, "type": "room", "rect": [7.75, 5.0, 9.875, 7.5], "num": "312", "cor": "H3" }, { "id": 36, "type": "door", "rect": [8.75, 7.5, 9.625, 7.625], "room": 35 }, { "id": 37, "type": "room", "rect": [10.0, 5.0, 12.125, 7.5], "num": "313", "cor": "H3" }, { "id": 38, "type": "door", "rect": [10.25, 7.5, 11.125, 7.625], "room": 37 }, { "id": 39, "type": "room", "rect": [12.25, 5.0, 14.375, 7.5], "num": "314", "cor": "H3" }, { "id": 40, "type": "door", "rect": [13.25, 7.5, 14.125, 7.625], "room": 39 }, { "id": 41, "type": "room", "rect": [14.5, 5.0, 16.625, 7.5], "num": "315", "cor": "H3" }, { "id": 42, "type": "door", "rect": [14.75, 7.5, 15.625, 7.625], "room": 41 }, { "id": 43, "type": "room", "rect": [16.75, 5.0, 18.875, 7.5], "num": "316", "cor": "H3" }, { "id": 44, "type": "door", "rect": [17.75, 7.5, 18.625, 7.625], "room": 43 }, { "id": 45, "type": "room", "rect": [21.375, 5.0, 23.5, 7.5], "num": "317", "cor": "H3" }, { "id": 46, "type": "door", "rect": [21.625, 7.5, 22.5, 7.625], "room": 45 }, { "id": 47, "type": "room", "rect": [23.625, 5.0, 25.75, 7.5], "num": "318", "cor": "H3" }, { "id": 48, "type": "door", "rect": [24.625, 7.5, 25.5, 7.625], "room": 47 }, { "id": 49, "type": "room", "rect": [25.875, 5.0, 28.0, 7.5], "num": "319", "cor": "H3" }, { "id": 50, "type": "door", "rect": [26.125, 7.5, 27.0, 7.625], "room": 49 }, { "id": 51, "type": "room", "rect": [2.625, 9.25, 4.75, 11.75], "num": "320", "cor": "H3" }, { "id": 52, "type": "door", "rect": [3.625, 9.125, 4.5, 9.25], "room": 51 }, { "id": 53, "type": "room", "rect": [4.875, 9.25, 7.0, 11.75], "num": "321", "cor": "H3" }, { "id": 54, "type": "door", "rect": [5.125, 9.125, 6.0, 9.25], "room": 53 }, { "id": 55, "type": "room", "rect": [7.125, 9.25, 9.25, 11.75], "num": "322", "cor": "H3" }, { "id": 56, "type": "door", "rect": [8.125, 9.125, 9.0, 9.25], "room": 55 }, { "id": 57, "type": "room", "rect": [9.375, 9.25, 11.5, 11.75], "num": "323", "cor": "H3" }, { "id": 58, "type": "door", "rect": [9.625, 9.125, 10.5, 9.25], "room": 57 }, { "id": 59, "type": "room", "rect": [11.625, 9.25, 13.75, 11.75], "num": "324", "cor": "H3" }, { "id": 60, "type": "door", "rect": [12.625, 9.125, 13.5, 9.25], "room": 59 }, { "id": 61, "type": "room", "rect": [13.875, 9.25, 16.0, 11.75], "num": "325", "cor": "H3" }, { "id": 62, "type": "door", "rect": [14.125, 9.125, 15.0, 9.25], "room": 61 }, { "id": 63, "type": "room", "rect": [16.125, 9.25, 18.25, 11.75], "num": "326", "cor": "H3" }, { "id": 64, "type": "door", "rect": [17.125, 9.125, 18.0, 9.25], "room": 63 }, { "id": 65, "type": "room", "rect": [18.375, 9.25, 20.5, 11.75], "num": "327", "cor": "H3" }, { "id": 66, "type": "door", "rect": [18.625, 9.125, 19.5, 9.25], "room": 65 }, { "id": 67, "type": "room", "rect": [27.125, 9.25, 29.25, 11.75], "num": "328", "cor": "H3" }, { "id": 68, "type": "door", "rect": [28.125, 9.125, 29.0, 9.25], "room": 67 }, { "id": 69, "type": "room", "rect": [2.625, 11.875, 4.75, 14.375], "num": "329", "cor": "H2" }, { "id": 70, "type": "door", "rect": [2.875, 14.375, 3.75, 14.5], "room": 69 }, { "id": 71, "type": "room", "rect": [4.875, 11.875, 7.0, 14.375], "num": "330", "cor": "H2" }, { "id": 72, "type": "door", "rect": [5.875, 14.375, 6.75, 14.5], "room": 71 }, { "id": 73, "type": "room", "rect": [7.125, 11.875, 9.25, 14.375], "num": "331", "cor": "H2" }, { "id": 74, "type": "door", "rect": [7.375, 14.375, 8.25, 14.5], "room": 73 }, { "id": 75, "type": "room", "rect": [9.375, 11.875, 11.5, 14.375], "num": "332", "cor": "H2" }, { "id": 76, "type": "door", "rect": [10.375, 14.375, 11.25, 14.5], "room": 75 }, { "id": 77, "type": "room", "rect": [11.625, 11.875, 13.75, 14.375], "num": "333", "cor": "H2" }, { "id": 78, "type": "door", "rect": [11.875, 14.375, 12.75, 14.5], "room": 77 }, { "id": 79, "type": "room", "rect": [13.875, 11.875, 16.0, 14.375], "num": "334", "cor": "H2" }, { "id": 80, "type": "door", "rect": [14.875, 14.375, 15.75, 14.5], "room": 79 }, { "id": 81, "type": "room", "rect": [16.125, 11.875, 18.25, 14.375], "num": "335", "cor": "H2" }, { "id": 82, "type": "door", "rect": [16.375, 14.375, 17.25, 14.5], "room": 81 }, { "id": 83, "type": "room", "rect": [18.375, 11.875, 20.5, 14.375], "num": "336", "cor": "H2" }, { "id": 84, "type": "door", "rect": [19.375, 14.375, 20.25, 14.5], "room": 83 }, { "id": 85, "type": "room", "rect": [27.125, 11.875, 29.25, 14.375], "num": "337", "cor": "H2" }, { "id": 86, "type": "door", "rect": [27.375, 14.375, 28.25, 14.5], "room": 85 }, { "id": 87, "type": "room", "rect": [29.375, 11.875, 31.5, 14.375], "num": "338", "cor": "H2" }, { "id": 88, "type": "door", "rect": [30.375, 14.375, 31.25, 14.5], "room": 87 }, { "id": 89, "type": "room", "rect": [1.0, 16.125, 3.125, 18.625], "num": "339", "cor": "H2" }, { "id": 90, "type": "door", "rect": [1.25, 16.0, 2.125, 16.125], "room": 89 }, { "id": 91, "type": "room", "rect": [3.25, 16.125, 5.375, 18.625], "num": "340", "cor": "H2" }, { "id": 92, "type": "door", "rect": [4.25, 16.0, 5.125, 16.125], "room": 91 }, { "id": 93, "type": "room", "rect": [5.5, 16.125, 7.625, 18.625], "num": "341", "cor": "H2" }, { "id": 94, "type": "door", "rect": [5.75, 16.0, 6.625, 16.125], "room": 93 }, { "id": 95, "type": "room", "rect": [7.75, 16.125, 9.875, 18.625], "num": "342", "cor": "H2" }, { "id": 96, "type": "door", "rect": [8.75, 16.0, 9.625, 16.125], "room": 95 }, { "id": 97, "type": "room", "rect": [10.0, 16.125, 12.125, 18.625], "num": "343", "cor": "H2" }, { "id": 98, "type": "door", "rect": [10.25, 16.0, 11.125, 16.125], "room": 97 }, { "id": 99, "type": "room", "rect": [12.25, 16.125, 14.375, 18.625], "num": "344", "cor": "H2" }, { "id": 100, "type": "door", "rect": [13.25, 16.0, 14.125, 16.125], "room": 99 }, { "id": 101, "type": "room", "rect": [17.375, 16.125, 19.5, 18.625], "num": "345", "cor": "H2" }, { "id": 102, "type": "door", "rect": [17.625, 16.0, 18.5, 16.125], "room": 101 }, { "id": 103, "type": "room", "rect": [19.625, 16.125, 21.75, 18.625], "num": "346", "cor": "H2" }, { "id": 104, "type": "door", "rect": [20.625, 16.0, 21.5, 16.125], "room": 103 }, { "id": 105, "type": "room", "rect": [21.875, 16.125, 24.0, 18.625], "num": "347", "cor": "H2" }, { "id": 106, "type": "door", "rect": [22.125, 16.0, 23.0, 16.125], "room": 105 }, { "id": 107, "type": "room", "rect": [24.125, 16.125, 26.25, 18.625], "num": "348", "cor": "H2" }, { "id": 108, "type": "door", "rect": [25.125, 16.0, 26.0, 16.125], "room": 107 }, { "id": 109, "type": "room", "rect": [26.375, 16.125, 28.5, 18.625], "num": "349", "cor": "H2" }, { "id": 110, "type": "door", "rect": [26.625, 16.0, 27.5, 16.125], "room": 109 }, { "id": 111, "type": "room", "rect": [3.25, 18.75, 5.375, 21.25], "num": "350", "cor": "H1" }, { "id": 112, "type": "door", "rect": [4.25, 21.25, 5.125, 21.375], "room": 111 }, { "id": 113, "type": "room", "rect": [10.125, 18.75, 12.25, 21.25], "num": "351", "cor": "H1" }, { "id": 114, "type": "door", "rect": [10.375, 21.25, 11.25, 21.375], "room": 113 }, { "id": 115, "type": "room", "rect": [12.375, 18.75, 14.5, 21.25], "num": "352", "cor": "H1" }, { "id": 116, "type": "door", "rect": [13.375, 21.25, 14.25, 21.375], "room": 115 }, { "id": 117, "type": "room", "rect": [17.375, 18.75, 19.5, 21.25], "num": "353", "cor": "H1" }, { "id": 118, "type": "door", "rect": [17.625, 21.25, 18.5, 21.375], "room": 117 }, { "id": 119, "type": "room", "rect": [19.625, 18.75, 21.75, 21.25], "num": "354", "cor": "H1" }, { "id": 120, "type": "door", "rect": [20.625, 21.25, 21.5, 21.375], "room": 119 }, { "id": 121, "type": "room", "rect": [21.875, 18.75, 24.0, 21.25], "num": "355", "cor": "H1" }, { "id": 122, "type": "door", "rect": [22.125, 21.25, 23.0, 21.375], "room": 121 }, { "id": 123, "type": "room", "rect": [24.125, 18.75, 26.25, 21.25], "num": "356", "cor": "H1" }, { "id": 124, "type": "door", "rect": [25.125, 21.25, 26.0, 21.375], "room": 123 }, { "id": 125, "type": "room", "rect": [26.375, 18.75, 28.5, 21.25], "num": "357", "cor": "H1" }, { "id": 126, "type": "door", "rect": [26.625, 21.25, 27.5, 21.375], "room": 125 }, { "id": 127, "type": "room", "rect": [3.25, 23.0, 5.375, 25.5], "num": "358", "cor": "H1" }, { "id": 128, "type": "door", "rect": [4.25, 22.875, 5.125, 23.0], "room": 127 }, { "id": 129, "type": "room", "rect": [5.5, 23.0, 7.625, 25.5], "num": "359", "cor": "H1" }, { "id": 130, "type": "door", "rect": [5.75, 22.875, 6.625, 23.0], "room": 129 }, { "id": 131, "type": "room", "rect": [7.75, 23.0, 9.875, 25.5], "num": "360", "cor": "H1" }, { "id": 132, "type": "door", "rect": [8.75, 22.875, 9.625, 23.0], "room": 131 }, { "id": 133, "type": "room", "rect": [10.0, 23.0, 12.125, 25.5], "num": "361", "cor": "H1" }, { "id": 134, "type": "door", "rect": [10.25, 22.875, 11.125, 23.0], "room": 133 }, { "id": 135, "type": "room", "rect": [12.25, 23.0, 14.375, 25.5], "num": "362", "cor": "H1" }, { "id": 136, "type": "door", "rect": [13.25, 22.875, 14.125, 23.0], "room": 135 }, { "id": 137, "type": "room", "rect": [17.375, 23.0, 19.5, 25.5], "num": "363", "cor": "H1" }, { "id": 138, "type": "door", "rect": [17.625, 22.875, 18.5, 23.0], "room": 137 }, { "id": 139, "type": "room", "rect": [19.625, 23.0, 21.75, 25.5], "num": "364", "cor": "H1" }, { "id": 140, "type": "door", "rect": [20.625, 22.875, 21.5, 23.0], "room": 139 }, { "id": 141, "type": "room", "rect": [21.875, 23.0, 24.0, 25.5], "num": "365", "cor": "H1" }, { "id": 142, "type": "door", "rect": [22.125, 22.875, 23.0, 23.0], "room": 141 }, { "id": 143, "type": "room", "rect": [24.125, 23.0, 26.25, 25.5], "num": "366", "cor": "H1" }, { "id": 144, "type": "door", "rect": [25.125, 22.875, 26.0, 23.0], "room": 143 }, { "id": 145, "type": "room", "rect": [26.375, 23.0, 28.5, 25.5], "num": "367", "cor": "H1" }, { "id": 146, "type": "door", "rect": [26.625, 22.875, 27.5, 23.0], "room": 145 }, { "id": 147, "type": "room", "rect": [28.625, 23.0, 30.75, 25.5], "num": "368", "cor": "H1" }, { "id": 148, "type": "door", "rect": [29.625, 22.875, 30.5, 23.0], "room": 147 }, { "id": 149, "type": "door", "rect": [23.125, 9.125, 24.0, 9.25], "room": 10 }, { "id": 150, "type": "door", "rect": [25.125, 14.375, 26.0, 14.5], "room": 10 }, { "id": 151, "type": "door", "rect": [7.375, 21.25, 8.25, 21.375], "room": 11 }, { "id": 152, "type": "door", "rect": [6.125, 1.0, 6.25, 1.875], "room": 12 }], "rooms": [{ "id": 13, "rect": [6.25, 2.375, 8.375, 4.875], "num": "301", "door": { "x0": 6.5, "x1": 7.375, "z0": 2.25, "z1": 2.375, "axis": "x", "side": "n", "left": true } }, { "id": 15, "rect": [8.5, 2.375, 10.625, 4.875], "num": "302", "door": { "x0": 9.5, "x1": 10.375, "z0": 2.25, "z1": 2.375, "axis": "x", "side": "n", "left": false } }, { "id": 17, "rect": [10.75, 2.375, 12.875, 4.875], "num": "303", "door": { "x0": 11.0, "x1": 11.875, "z0": 2.25, "z1": 2.375, "axis": "x", "side": "n", "left": true } }, { "id": 19, "rect": [13.0, 2.375, 15.125, 4.875], "num": "304", "door": { "x0": 14.0, "x1": 14.875, "z0": 2.25, "z1": 2.375, "axis": "x", "side": "n", "left": false } }, { "id": 21, "rect": [15.25, 2.375, 17.375, 4.875], "num": "305", "door": { "x0": 15.5, "x1": 16.375, "z0": 2.25, "z1": 2.375, "axis": "x", "side": "n", "left": true } }, { "id": 23, "rect": [17.5, 2.375, 19.625, 4.875], "num": "306", "door": { "x0": 18.5, "x1": 19.375, "z0": 2.25, "z1": 2.375, "axis": "x", "side": "n", "left": false } }, { "id": 25, "rect": [21.375, 2.375, 23.5, 4.875], "num": "307", "door": { "x0": 21.625, "x1": 22.5, "z0": 2.25, "z1": 2.375, "axis": "x", "side": "n", "left": true } }, { "id": 27, "rect": [23.625, 2.375, 25.75, 4.875], "num": "308", "door": { "x0": 24.625, "x1": 25.5, "z0": 2.25, "z1": 2.375, "axis": "x", "side": "n", "left": false } }, { "id": 29, "rect": [1.0, 5.0, 3.125, 7.5], "num": "309", "door": { "x0": 1.25, "x1": 2.125, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": true } }, { "id": 31, "rect": [3.25, 5.0, 5.375, 7.5], "num": "310", "door": { "x0": 4.25, "x1": 5.125, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": false } }, { "id": 33, "rect": [5.5, 5.0, 7.625, 7.5], "num": "311", "door": { "x0": 5.75, "x1": 6.625, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": true } }, { "id": 35, "rect": [7.75, 5.0, 9.875, 7.5], "num": "312", "door": { "x0": 8.75, "x1": 9.625, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": false } }, { "id": 37, "rect": [10.0, 5.0, 12.125, 7.5], "num": "313", "door": { "x0": 10.25, "x1": 11.125, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": true } }, { "id": 39, "rect": [12.25, 5.0, 14.375, 7.5], "num": "314", "door": { "x0": 13.25, "x1": 14.125, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": false } }, { "id": 41, "rect": [14.5, 5.0, 16.625, 7.5], "num": "315", "door": { "x0": 14.75, "x1": 15.625, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": true } }, { "id": 43, "rect": [16.75, 5.0, 18.875, 7.5], "num": "316", "door": { "x0": 17.75, "x1": 18.625, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": false } }, { "id": 45, "rect": [21.375, 5.0, 23.5, 7.5], "num": "317", "door": { "x0": 21.625, "x1": 22.5, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": true } }, { "id": 47, "rect": [23.625, 5.0, 25.75, 7.5], "num": "318", "door": { "x0": 24.625, "x1": 25.5, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": false } }, { "id": 49, "rect": [25.875, 5.0, 28.0, 7.5], "num": "319", "door": { "x0": 26.125, "x1": 27.0, "z0": 7.5, "z1": 7.625, "axis": "x", "side": "s", "left": true } }, { "id": 51, "rect": [2.625, 9.25, 4.75, 11.75], "num": "320", "door": { "x0": 3.625, "x1": 4.5, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": false } }, { "id": 53, "rect": [4.875, 9.25, 7.0, 11.75], "num": "321", "door": { "x0": 5.125, "x1": 6.0, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": true } }, { "id": 55, "rect": [7.125, 9.25, 9.25, 11.75], "num": "322", "door": { "x0": 8.125, "x1": 9.0, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": false } }, { "id": 57, "rect": [9.375, 9.25, 11.5, 11.75], "num": "323", "door": { "x0": 9.625, "x1": 10.5, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": true } }, { "id": 59, "rect": [11.625, 9.25, 13.75, 11.75], "num": "324", "door": { "x0": 12.625, "x1": 13.5, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": false } }, { "id": 61, "rect": [13.875, 9.25, 16.0, 11.75], "num": "325", "door": { "x0": 14.125, "x1": 15.0, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": true } }, { "id": 63, "rect": [16.125, 9.25, 18.25, 11.75], "num": "326", "door": { "x0": 17.125, "x1": 18.0, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": false } }, { "id": 65, "rect": [18.375, 9.25, 20.5, 11.75], "num": "327", "door": { "x0": 18.625, "x1": 19.5, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": true } }, { "id": 67, "rect": [27.125, 9.25, 29.25, 11.75], "num": "328", "door": { "x0": 28.125, "x1": 29.0, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n", "left": false } }, { "id": 69, "rect": [2.625, 11.875, 4.75, 14.375], "num": "329", "door": { "x0": 2.875, "x1": 3.75, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": true } }, { "id": 71, "rect": [4.875, 11.875, 7.0, 14.375], "num": "330", "door": { "x0": 5.875, "x1": 6.75, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": false } }, { "id": 73, "rect": [7.125, 11.875, 9.25, 14.375], "num": "331", "door": { "x0": 7.375, "x1": 8.25, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": true } }, { "id": 75, "rect": [9.375, 11.875, 11.5, 14.375], "num": "332", "door": { "x0": 10.375, "x1": 11.25, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": false } }, { "id": 77, "rect": [11.625, 11.875, 13.75, 14.375], "num": "333", "door": { "x0": 11.875, "x1": 12.75, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": true } }, { "id": 79, "rect": [13.875, 11.875, 16.0, 14.375], "num": "334", "door": { "x0": 14.875, "x1": 15.75, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": false } }, { "id": 81, "rect": [16.125, 11.875, 18.25, 14.375], "num": "335", "door": { "x0": 16.375, "x1": 17.25, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": true } }, { "id": 83, "rect": [18.375, 11.875, 20.5, 14.375], "num": "336", "door": { "x0": 19.375, "x1": 20.25, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": false } }, { "id": 85, "rect": [27.125, 11.875, 29.25, 14.375], "num": "337", "door": { "x0": 27.375, "x1": 28.25, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": true } }, { "id": 87, "rect": [29.375, 11.875, 31.5, 14.375], "num": "338", "door": { "x0": 30.375, "x1": 31.25, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s", "left": false } }, { "id": 89, "rect": [1.0, 16.125, 3.125, 18.625], "num": "339", "door": { "x0": 1.25, "x1": 2.125, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": true } }, { "id": 91, "rect": [3.25, 16.125, 5.375, 18.625], "num": "340", "door": { "x0": 4.25, "x1": 5.125, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": false } }, { "id": 93, "rect": [5.5, 16.125, 7.625, 18.625], "num": "341", "door": { "x0": 5.75, "x1": 6.625, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": true } }, { "id": 95, "rect": [7.75, 16.125, 9.875, 18.625], "num": "342", "door": { "x0": 8.75, "x1": 9.625, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": false } }, { "id": 97, "rect": [10.0, 16.125, 12.125, 18.625], "num": "343", "door": { "x0": 10.25, "x1": 11.125, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": true } }, { "id": 99, "rect": [12.25, 16.125, 14.375, 18.625], "num": "344", "door": { "x0": 13.25, "x1": 14.125, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": false } }, { "id": 101, "rect": [17.375, 16.125, 19.5, 18.625], "num": "345", "door": { "x0": 17.625, "x1": 18.5, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": true } }, { "id": 103, "rect": [19.625, 16.125, 21.75, 18.625], "num": "346", "door": { "x0": 20.625, "x1": 21.5, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": false } }, { "id": 105, "rect": [21.875, 16.125, 24.0, 18.625], "num": "347", "door": { "x0": 22.125, "x1": 23.0, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": true } }, { "id": 107, "rect": [24.125, 16.125, 26.25, 18.625], "num": "348", "door": { "x0": 25.125, "x1": 26.0, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": false } }, { "id": 109, "rect": [26.375, 16.125, 28.5, 18.625], "num": "349", "door": { "x0": 26.625, "x1": 27.5, "z0": 16.0, "z1": 16.125, "axis": "x", "side": "n", "left": true } }, { "id": 111, "rect": [3.25, 18.75, 5.375, 21.25], "num": "350", "door": { "x0": 4.25, "x1": 5.125, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s", "left": false } }, { "id": 113, "rect": [10.125, 18.75, 12.25, 21.25], "num": "351", "door": { "x0": 10.375, "x1": 11.25, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s", "left": true } }, { "id": 115, "rect": [12.375, 18.75, 14.5, 21.25], "num": "352", "door": { "x0": 13.375, "x1": 14.25, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s", "left": false } }, { "id": 117, "rect": [17.375, 18.75, 19.5, 21.25], "num": "353", "door": { "x0": 17.625, "x1": 18.5, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s", "left": true } }, { "id": 119, "rect": [19.625, 18.75, 21.75, 21.25], "num": "354", "door": { "x0": 20.625, "x1": 21.5, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s", "left": false } }, { "id": 121, "rect": [21.875, 18.75, 24.0, 21.25], "num": "355", "door": { "x0": 22.125, "x1": 23.0, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s", "left": true } }, { "id": 123, "rect": [24.125, 18.75, 26.25, 21.25], "num": "356", "door": { "x0": 25.125, "x1": 26.0, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s", "left": false } }, { "id": 125, "rect": [26.375, 18.75, 28.5, 21.25], "num": "357", "door": { "x0": 26.625, "x1": 27.5, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s", "left": true } }, { "id": 127, "rect": [3.25, 23.0, 5.375, 25.5], "num": "358", "door": { "x0": 4.25, "x1": 5.125, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": false } }, { "id": 129, "rect": [5.5, 23.0, 7.625, 25.5], "num": "359", "door": { "x0": 5.75, "x1": 6.625, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": true } }, { "id": 131, "rect": [7.75, 23.0, 9.875, 25.5], "num": "360", "door": { "x0": 8.75, "x1": 9.625, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": false } }, { "id": 133, "rect": [10.0, 23.0, 12.125, 25.5], "num": "361", "door": { "x0": 10.25, "x1": 11.125, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": true } }, { "id": 135, "rect": [12.25, 23.0, 14.375, 25.5], "num": "362", "door": { "x0": 13.25, "x1": 14.125, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": false } }, { "id": 137, "rect": [17.375, 23.0, 19.5, 25.5], "num": "363", "door": { "x0": 17.625, "x1": 18.5, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": true } }, { "id": 139, "rect": [19.625, 23.0, 21.75, 25.5], "num": "364", "door": { "x0": 20.625, "x1": 21.5, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": false } }, { "id": 141, "rect": [21.875, 23.0, 24.0, 25.5], "num": "365", "door": { "x0": 22.125, "x1": 23.0, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": true } }, { "id": 143, "rect": [24.125, 23.0, 26.25, 25.5], "num": "366", "door": { "x0": 25.125, "x1": 26.0, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": false } }, { "id": 145, "rect": [26.375, 23.0, 28.5, 25.5], "num": "367", "door": { "x0": 26.625, "x1": 27.5, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": true } }, { "id": 147, "rect": [28.625, 23.0, 30.75, 25.5], "num": "368", "door": { "x0": 29.625, "x1": 30.5, "z0": 22.875, "z1": 23.0, "axis": "x", "side": "n", "left": false } }], "specialDoors": [{ "room": 10, "x0": 23.125, "x1": 24.0, "z0": 9.125, "z1": 9.25, "axis": "x", "side": "n" }, { "room": 10, "x0": 25.125, "x1": 26.0, "z0": 14.375, "z1": 14.5, "axis": "x", "side": "s" }, { "room": 11, "x0": 7.375, "x1": 8.25, "z0": 21.25, "z1": 21.375, "axis": "x", "side": "s" }, { "room": 12, "x0": 6.125, "x1": 6.25, "z0": 1.0, "z1": 1.875, "axis": "z", "side": "e" }], "segs": [["s", 0.625, 3.625, 6.125, "gun"], ["s", 0.75, 6.25, 27.25, "cor"], ["s", 1.0, 6.125, 6.25, "door"], ["n", 1.875, 6.125, 6.25, "door"], ["n", 2.25, 6.25, 6.5, "cor"], ["n", 2.25, 7.375, 9.5, "cor"], ["n", 2.25, 10.375, 11.0, "cor"], ["n", 2.25, 11.875, 14.0, "cor"], ["n", 2.25, 14.875, 15.5, "cor"], ["n", 2.25, 16.375, 18.5, "cor"], ["n", 2.25, 19.375, 19.75, "cor"], ["n", 2.25, 21.25, 21.625, "cor"], ["n", 2.25, 22.5, 24.625, "cor"], ["n", 2.25, 25.5, 27.25, "cor"], ["s", 2.375, 6.25, 6.5, "room"], ["s", 2.375, 7.375, 8.375, "room"], ["s", 2.375, 8.5, 9.5, "room"], ["s", 2.375, 10.375, 10.625, "room"], ["s", 2.375, 10.75, 11.0, "room"], ["s", 2.375, 11.875, 12.875, "room"], ["s", 2.375, 13.0, 14.0, "room"], ["s", 2.375, 14.875, 15.125, "room"], ["s", 2.375, 15.25, 15.5, "room"], ["s", 2.375, 16.375, 17.375, "room"], ["s", 2.375, 17.5, 18.5, "room"], ["s", 2.375, 19.375, 19.625, "room"], ["s", 2.375, 21.375, 21.625, "room"], ["s", 2.375, 22.5, 23.5, "room"], ["s", 2.375, 23.625, 24.625, "room"], ["s", 2.375, 25.5, 25.75, "room"], ["n", 3.25, 3.625, 6.125, "gun"], ["n", 4.875, 6.25, 8.375, "room"], ["n", 4.875, 8.5, 10.625, "room"], ["n", 4.875, 10.75, 12.875, "room"], ["n", 4.875, 13.0, 15.125, "room"], ["n", 4.875, 15.25, 17.375, "room"], ["n", 4.875, 17.5, 19.625, "room"], ["n", 4.875, 21.375, 23.5, "room"], ["n", 4.875, 23.625, 25.75, "room"], ["s", 5.0, 1.0, 3.125, "room"], ["s", 5.0, 3.25, 5.375, "room"], ["s", 5.0, 5.5, 7.625, "room"], ["s", 5.0, 7.75, 9.875, "room"], ["s", 5.0, 10.0, 12.125, "room"], ["s", 5.0, 12.25, 14.375, "room"], ["s", 5.0, 14.5, 16.625, "room"], ["s", 5.0, 16.75, 18.875, "room"], ["s", 5.0, 21.375, 23.5, "room"], ["s", 5.0, 23.625, 25.75, "room"], ["s", 5.0, 25.875, 28.0, "room"], ["n", 7.5, 1.0, 1.25, "room"], ["n", 7.5, 2.125, 3.125, "room"], ["n", 7.5, 3.25, 4.25, "room"], ["n", 7.5, 5.125, 5.375, "room"], ["n", 7.5, 5.5, 5.75, "room"], ["n", 7.5, 6.625, 7.625, "room"], ["n", 7.5, 7.75, 8.75, "room"], ["n", 7.5, 9.625, 9.875, "room"], ["n", 7.5, 10.0, 10.25, "room"], ["n", 7.5, 11.125, 12.125, "room"], ["n", 7.5, 12.25, 13.25, "room"], ["n", 7.5, 14.125, 14.375, "room"], ["n", 7.5, 14.5, 14.75, "room"], ["n", 7.5, 15.625, 16.625, "room"], ["n", 7.5, 16.75, 17.75, "room"], ["n", 7.5, 18.625, 18.875, "room"], ["n", 7.5, 21.375, 21.625, "room"], ["n", 7.5, 22.5, 23.5, "room"], ["n", 7.5, 23.625, 24.625, "room"], ["n", 7.5, 25.5, 25.75, "room"], ["n", 7.5, 25.875, 26.125, "room"], ["n", 7.5, 27.0, 28.0, "room"], ["s", 7.625, 1.0, 1.25, "cor"], ["s", 7.625, 2.125, 4.25, "cor"], ["s", 7.625, 5.125, 5.75, "cor"], ["s", 7.625, 6.625, 8.75, "cor"], ["s", 7.625, 9.625, 10.25, "cor"], ["s", 7.625, 11.125, 13.25, "cor"], ["s", 7.625, 14.125, 14.75, "cor"], ["s", 7.625, 15.625, 17.75, "cor"], ["s", 7.625, 18.625, 19.75, "cor"], ["s", 7.625, 21.25, 21.625, "cor"], ["s", 7.625, 22.5, 24.625, "cor"], ["s", 7.625, 25.5, 26.125, "cor"], ["s", 7.625, 27.0, 29.5, "cor"], ["n", 9.125, 2.5, 3.625, "cor"], ["n", 9.125, 4.5, 5.125, "cor"], ["n", 9.125, 6.0, 8.125, "cor"], ["n", 9.125, 9.0, 9.625, "cor"], ["n", 9.125, 10.5, 12.625, "cor"], ["n", 9.125, 13.5, 14.125, "cor"], ["n", 9.125, 15.0, 17.125, "cor"], ["n", 9.125, 18.0, 18.625, "cor"], ["n", 9.125, 19.5, 23.125, "cor"], ["n", 9.125, 24.0, 28.125, "cor"], ["n", 9.125, 29.0, 29.5, "cor"], ["s", 9.25, 2.625, 3.625, "room"], ["s", 9.25, 4.5, 4.75, "room"], ["s", 9.25, 4.875, 5.125, "room"], ["s", 9.25, 6.0, 7.0, "room"], ["s", 9.25, 7.125, 8.125, "room"], ["s", 9.25, 9.0, 9.25, "room"], ["s", 9.25, 9.375, 9.625, "room"], ["s", 9.25, 10.5, 11.5, "room"], ["s", 9.25, 11.625, 12.625, "room"], ["s", 9.25, 13.5, 13.75, "room"], ["s", 9.25, 13.875, 14.125, "room"], ["s", 9.25, 15.0, 16.0, "room"], ["s", 9.25, 16.125, 17.125, "room"], ["s", 9.25, 18.0, 18.25, "room"], ["s", 9.25, 18.375, 18.625, "room"], ["s", 9.25, 19.5, 20.5, "room"], ["s", 9.25, 22.0, 23.125, "kitchen"], ["s", 9.25, 24.0, 27.0, "kitchen"], ["s", 9.25, 27.125, 28.125, "room"], ["s", 9.25, 29.0, 29.25, "room"], ["n", 11.75, 2.625, 4.75, "room"], ["n", 11.75, 4.875, 7.0, "room"], ["n", 11.75, 7.125, 9.25, "room"], ["n", 11.75, 9.375, 11.5, "room"], ["n", 11.75, 11.625, 13.75, "room"], ["n", 11.75, 13.875, 16.0, "room"], ["n", 11.75, 16.125, 18.25, "room"], ["n", 11.75, 18.375, 20.5, "room"], ["n", 11.75, 27.125, 29.25, "room"], ["s", 11.875, 2.625, 4.75, "room"], ["s", 11.875, 4.875, 7.0, "room"], ["s", 11.875, 7.125, 9.25, "room"], ["s", 11.875, 9.375, 11.5, "room"], ["s", 11.875, 11.625, 13.75, "room"], ["s", 11.875, 13.875, 16.0, "room"], ["s", 11.875, 16.125, 18.25, "room"], ["s", 11.875, 18.375, 20.5, "room"], ["s", 11.875, 27.125, 29.25, "room"], ["s", 11.875, 29.375, 31.5, "room"], ["n", 14.375, 2.625, 2.875, "room"], ["n", 14.375, 3.75, 4.75, "room"], ["n", 14.375, 4.875, 5.875, "room"], ["n", 14.375, 6.75, 7.0, "room"], ["n", 14.375, 7.125, 7.375, "room"], ["n", 14.375, 8.25, 9.25, "room"], ["n", 14.375, 9.375, 10.375, "room"], ["n", 14.375, 11.25, 11.5, "room"], ["n", 14.375, 11.625, 11.875, "room"], ["n", 14.375, 12.75, 13.75, "room"], ["n", 14.375, 13.875, 14.875, "room"], ["n", 14.375, 15.75, 16.0, "room"], ["n", 14.375, 16.125, 16.375, "room"], ["n", 14.375, 17.25, 18.25, "room"], ["n", 14.375, 18.375, 19.375, "room"], ["n", 14.375, 20.25, 20.5, "room"], ["n", 14.375, 22.0, 25.125, "kitchen"], ["n", 14.375, 26.0, 27.0, "kitchen"], ["n", 14.375, 27.125, 27.375, "room"], ["n", 14.375, 28.25, 29.25, "room"], ["n", 14.375, 29.375, 30.375, "room"], ["n", 14.375, 31.25, 31.5, "room"], ["s", 14.5, 2.5, 2.875, "cor"], ["s", 14.5, 3.75, 5.875, "cor"], ["s", 14.5, 6.75, 7.375, "cor"], ["s", 14.5, 8.25, 10.375, "cor"], ["s", 14.5, 11.25, 11.875, "cor"], ["s", 14.5, 12.75, 14.875, "cor"], ["s", 14.5, 15.75, 16.375, "cor"], ["s", 14.5, 17.25, 19.375, "cor"], ["s", 14.5, 20.25, 25.125, "cor"], ["s", 14.5, 26.0, 27.375, "cor"], ["s", 14.5, 28.25, 30.375, "cor"], ["s", 14.5, 31.25, 32.0, "cor"], ["n", 16.0, 1.0, 1.25, "cor"], ["n", 16.0, 2.125, 4.25, "cor"], ["n", 16.0, 5.125, 5.75, "cor"], ["n", 16.0, 6.625, 8.75, "cor"], ["n", 16.0, 9.625, 10.25, "cor"], ["n", 16.0, 11.125, 13.25, "cor"], ["n", 16.0, 14.125, 15.75, "cor"], ["n", 16.0, 17.25, 17.625, "cor"], ["n", 16.0, 18.5, 20.625, "cor"], ["n", 16.0, 21.5, 22.125, "cor"], ["n", 16.0, 23.0, 25.125, "cor"], ["n", 16.0, 26.0, 26.625, "cor"], ["n", 16.0, 27.5, 30.5, "cor"], ["s", 16.125, 1.0, 1.25, "room"], ["s", 16.125, 2.125, 3.125, "room"], ["s", 16.125, 3.25, 4.25, "room"], ["s", 16.125, 5.125, 5.375, "room"], ["s", 16.125, 5.5, 5.75, "room"], ["s", 16.125, 6.625, 7.625, "room"], ["s", 16.125, 7.75, 8.75, "room"], ["s", 16.125, 9.625, 9.875, "room"], ["s", 16.125, 10.0, 10.25, "room"], ["s", 16.125, 11.125, 12.125, "room"], ["s", 16.125, 12.25, 13.25, "room"], ["s", 16.125, 14.125, 14.375, "room"], ["s", 16.125, 17.375, 17.625, "room"], ["s", 16.125, 18.5, 19.5, "room"], ["s", 16.125, 19.625, 20.625, "room"], ["s", 16.125, 21.5, 21.75, "room"], ["s", 16.125, 21.875, 22.125, "room"], ["s", 16.125, 23.0, 24.0, "room"], ["s", 16.125, 24.125, 25.125, "room"], ["s", 16.125, 26.0, 26.25, "room"], ["s", 16.125, 26.375, 26.625, "room"], ["s", 16.125, 27.5, 28.5, "room"], ["n", 18.625, 1.0, 3.125, "room"], ["n", 18.625, 3.25, 5.375, "room"], ["n", 18.625, 5.5, 7.625, "room"], ["n", 18.625, 7.75, 9.875, "room"], ["n", 18.625, 10.0, 12.125, "room"], ["n", 18.625, 12.25, 14.375, "room"], ["n", 18.625, 17.375, 19.5, "room"], ["n", 18.625, 19.625, 21.75, "room"], ["n", 18.625, 21.875, 24.0, "room"], ["n", 18.625, 24.125, 26.25, "room"], ["n", 18.625, 26.375, 28.5, "room"], ["s", 18.75, 3.25, 5.375, "room"], ["s", 18.75, 5.75, 10.0, "shower"], ["s", 18.75, 10.125, 12.25, "room"], ["s", 18.75, 12.375, 14.5, "room"], ["s", 18.75, 17.375, 19.5, "room"], ["s", 18.75, 19.625, 21.75, "room"], ["s", 18.75, 21.875, 24.0, "room"], ["s", 18.75, 24.125, 26.25, "room"], ["s", 18.75, 26.375, 28.5, "room"], ["n", 21.25, 3.25, 4.25, "room"], ["n", 21.25, 5.125, 5.375, "room"], ["n", 21.25, 5.75, 7.375, "shower"], ["n", 21.25, 8.25, 10.0, "shower"], ["n", 21.25, 10.125, 10.375, "room"], ["n", 21.25, 11.25, 12.25, "room"], ["n", 21.25, 12.375, 13.375, "room"], ["n", 21.25, 14.25, 14.5, "room"], ["n", 21.25, 17.375, 17.625, "room"], ["n", 21.25, 18.5, 19.5, "room"], ["n", 21.25, 19.625, 20.625, "room"], ["n", 21.25, 21.5, 21.75, "room"], ["n", 21.25, 21.875, 22.125, "room"], ["n", 21.25, 23.0, 24.0, "room"], ["n", 21.25, 24.125, 25.125, "room"], ["n", 21.25, 26.0, 26.25, "room"], ["n", 21.25, 26.375, 26.625, "room"], ["n", 21.25, 27.5, 28.5, "room"], ["s", 21.375, 3.25, 4.25, "cor"], ["s", 21.375, 5.125, 7.375, "cor"], ["s", 21.375, 8.25, 10.375, "cor"], ["s", 21.375, 11.25, 13.375, "cor"], ["s", 21.375, 14.25, 15.75, "cor"], ["s", 21.375, 17.25, 17.625, "cor"], ["s", 21.375, 18.5, 20.625, "cor"], ["s", 21.375, 21.5, 22.125, "cor"], ["s", 21.375, 23.0, 25.125, "cor"], ["s", 21.375, 26.0, 26.625, "cor"], ["s", 21.375, 27.5, 30.5, "cor"], ["n", 22.875, 3.25, 4.25, "cor"], ["n", 22.875, 5.125, 5.75, "cor"], ["n", 22.875, 6.625, 8.75, "cor"], ["n", 22.875, 9.625, 10.25, "cor"], ["n", 22.875, 11.125, 13.25, "cor"], ["n", 22.875, 14.125, 15.75, "cor"], ["n", 22.875, 17.25, 17.625, "cor"], ["n", 22.875, 18.5, 20.625, "cor"], ["n", 22.875, 21.5, 22.125, "cor"], ["n", 22.875, 23.0, 25.125, "cor"], ["n", 22.875, 26.0, 26.625, "cor"], ["n", 22.875, 27.5, 29.625, "cor"], ["n", 22.875, 30.5, 32.0, "cor"], ["s", 23.0, 3.25, 4.25, "room"], ["s", 23.0, 5.125, 5.375, "room"], ["s", 23.0, 5.5, 5.75, "room"], ["s", 23.0, 6.625, 7.625, "room"], ["s", 23.0, 7.75, 8.75, "room"], ["s", 23.0, 9.625, 9.875, "room"], ["s", 23.0, 10.0, 10.25, "room"], ["s", 23.0, 11.125, 12.125, "room"], ["s", 23.0, 12.25, 13.25, "room"], ["s", 23.0, 14.125, 14.375, "room"], ["s", 23.0, 17.375, 17.625, "room"], ["s", 23.0, 18.5, 19.5, "room"], ["s", 23.0, 19.625, 20.625, "room"], ["s", 23.0, 21.5, 21.75, "room"], ["s", 23.0, 21.875, 22.125, "room"], ["s", 23.0, 23.0, 24.0, "room"], ["s", 23.0, 24.125, 25.125, "room"], ["s", 23.0, 26.0, 26.25, "room"], ["s", 23.0, 26.375, 26.625, "room"], ["s", 23.0, 27.5, 28.5, "room"], ["s", 23.0, 28.625, 29.625, "room"], ["s", 23.0, 30.5, 30.75, "room"], ["n", 25.5, 3.25, 5.375, "room"], ["n", 25.5, 5.5, 7.625, "room"], ["n", 25.5, 7.75, 9.875, "room"], ["n", 25.5, 10.0, 12.125, "room"], ["n", 25.5, 12.25, 14.375, "room"], ["n", 25.5, 17.375, 19.5, "room"], ["n", 25.5, 19.625, 21.75, "room"], ["n", 25.5, 21.875, 24.0, "room"], ["n", 25.5, 24.125, 26.25, "room"], ["n", 25.5, 26.375, 28.5, "room"], ["n", 25.5, 28.625, 30.75, "room"], ["s", 27.0, 14.75, 15.75, "lobby"], ["s", 27.0, 17.25, 18.25, "lobby"], ["e", 1.0, 5.0, 7.5, "room"], ["e", 1.0, 7.625, 16.0, "cor"], ["e", 1.0, 16.125, 18.625, "room"], ["e", 1.25, 7.5, 7.625, "door"], ["e", 1.25, 16.0, 16.125, "door"], ["w", 2.125, 7.5, 7.625, "door"], ["w", 2.125, 16.0, 16.125, "door"], ["w", 2.5, 9.125, 14.5, "cor"], ["e", 2.625, 9.25, 11.75, "room"], ["e", 2.625, 11.875, 14.375, "room"], ["e", 2.875, 14.375, 14.5, "door"], ["w", 3.125, 5.0, 7.5, "room"], ["w", 3.125, 16.125, 18.625, "room"], ["e", 3.25, 5.0, 7.5, "room"], ["e", 3.25, 16.125, 18.625, "room"], ["e", 3.25, 18.75, 21.25, "room"], ["e", 3.25, 21.375, 22.875, "cor"], ["e", 3.25, 23.0, 25.5, "room"], ["e", 3.625, 0.625, 3.25, "gun"], ["e", 3.625, 9.125, 9.25, "door"], ["w", 3.75, 14.375, 14.5, "door"], ["e", 4.25, 7.5, 7.625, "door"], ["e", 4.25, 16.0, 16.125, "door"], ["e", 4.25, 21.25, 21.375, "door"], ["e", 4.25, 22.875, 23.0, "door"], ["w", 4.5, 9.125, 9.25, "door"], ["w", 4.75, 9.25, 11.75, "room"], ["w", 4.75, 11.875, 14.375, "room"], ["e", 4.875, 9.25, 11.75, "room"], ["e", 4.875, 11.875, 14.375, "room"], ["w", 5.125, 7.5, 7.625, "door"], ["e", 5.125, 9.125, 9.25, "door"], ["w", 5.125, 16.0, 16.125, "door"], ["w", 5.125, 21.25, 21.375, "door"], ["w", 5.125, 22.875, 23.0, "door"], ["w", 5.375, 5.0, 7.5, "room"], ["w", 5.375, 16.125, 18.625, "room"], ["w", 5.375, 18.75, 21.25, "room"], ["w", 5.375, 23.0, 25.5, "room"], ["e", 5.5, 5.0, 7.5, "room"], ["e", 5.5, 16.125, 18.625, "room"], ["e", 5.5, 23.0, 25.5, "room"], ["e", 5.75, 7.5, 7.625, "door"], ["e", 5.75, 16.0, 16.125, "door"], ["e", 5.75, 18.75, 21.25, "shower"], ["e", 5.75, 22.875, 23.0, "door"], ["e", 5.875, 14.375, 14.5, "door"], ["w", 6.0, 9.125, 9.25, "door"], ["w", 6.125, 0.625, 1.0, "gun"], ["w", 6.125, 1.875, 3.25, "gun"], ["e", 6.25, 0.75, 1.0, "cor"], ["e", 6.25, 1.875, 2.25, "cor"], ["e", 6.25, 2.375, 4.875, "room"], ["e", 6.5, 2.25, 2.375, "door"], ["w", 6.625, 7.5, 7.625, "door"], ["w", 6.625, 16.0, 16.125, "door"], ["w", 6.625, 22.875, 23.0, "door"], ["w", 6.75, 14.375, 14.5, "door"], ["w", 7.0, 9.25, 11.75, "room"], ["w", 7.0, 11.875, 14.375, "room"], ["e", 7.125, 9.25, 11.75, "room"], ["e", 7.125, 11.875, 14.375, "room"], ["w", 7.375, 2.25, 2.375, "door"], ["e", 7.375, 14.375, 14.5, "door"], ["e", 7.375, 21.25, 21.375, "door"], ["w", 7.625, 5.0, 7.5, "room"], ["w", 7.625, 16.125, 18.625, "room"], ["w", 7.625, 23.0, 25.5, "room"], ["e", 7.75, 5.0, 7.5, "room"], ["e", 7.75, 16.125, 18.625, "room"], ["e", 7.75, 23.0, 25.5, "room"], ["e", 8.125, 9.125, 9.25, "door"], ["w", 8.25, 14.375, 14.5, "door"], ["w", 8.25, 21.25, 21.375, "door"], ["w", 8.375, 2.375, 4.875, "room"], ["e", 8.5, 2.375, 4.875, "room"], ["e", 8.75, 7.5, 7.625, "door"], ["e", 8.75, 16.0, 16.125, "door"], ["e", 8.75, 22.875, 23.0, "door"], ["w", 9.0, 9.125, 9.25, "door"], ["w", 9.25, 9.25, 11.75, "room"], ["w", 9.25, 11.875, 14.375, "room"], ["e", 9.375, 9.25, 11.75, "room"], ["e", 9.375, 11.875, 14.375, "room"], ["e", 9.5, 2.25, 2.375, "door"], ["w", 9.625, 7.5, 7.625, "door"], ["e", 9.625, 9.125, 9.25, "door"], ["w", 9.625, 16.0, 16.125, "door"], ["w", 9.625, 22.875, 23.0, "door"], ["w", 9.875, 5.0, 7.5, "room"], ["w", 9.875, 16.125, 18.625, "room"], ["w", 9.875, 23.0, 25.5, "room"], ["e", 10.0, 5.0, 7.5, "room"], ["e", 10.0, 16.125, 18.625, "room"], ["w", 10.0, 18.75, 21.25, "shower"], ["e", 10.0, 23.0, 25.5, "room"], ["e", 10.125, 18.75, 21.25, "room"], ["e", 10.25, 7.5, 7.625, "door"], ["e", 10.25, 16.0, 16.125, "door"], ["e", 10.25, 22.875, 23.0, "door"], ["w", 10.375, 2.25, 2.375, "door"], ["e", 10.375, 14.375, 14.5, "door"], ["e", 10.375, 21.25, 21.375, "door"], ["w", 10.5, 9.125, 9.25, "door"], ["w", 10.625, 2.375, 4.875, "room"], ["e", 10.75, 2.375, 4.875, "room"], ["e", 11.0, 2.25, 2.375, "door"], ["w", 11.125, 7.5, 7.625, "door"], ["w", 11.125, 16.0, 16.125, "door"], ["w", 11.125, 22.875, 23.0, "door"], ["w", 11.25, 14.375, 14.5, "door"], ["w", 11.25, 21.25, 21.375, "door"], ["w", 11.5, 9.25, 11.75, "room"], ["w", 11.5, 11.875, 14.375, "room"], ["e", 11.625, 9.25, 11.75, "room"], ["e", 11.625, 11.875, 14.375, "room"], ["w", 11.875, 2.25, 2.375, "door"], ["e", 11.875, 14.375, 14.5, "door"], ["w", 12.125, 5.0, 7.5, "room"], ["w", 12.125, 16.125, 18.625, "room"], ["w", 12.125, 23.0, 25.5, "room"], ["e", 12.25, 5.0, 7.5, "room"], ["e", 12.25, 16.125, 18.625, "room"], ["w", 12.25, 18.75, 21.25, "room"], ["e", 12.25, 23.0, 25.5, "room"], ["e", 12.375, 18.75, 21.25, "room"], ["e", 12.625, 9.125, 9.25, "door"], ["w", 12.75, 14.375, 14.5, "door"], ["w", 12.875, 2.375, 4.875, "room"], ["e", 13.0, 2.375, 4.875, "room"], ["e", 13.25, 7.5, 7.625, "door"], ["e", 13.25, 16.0, 16.125, "door"], ["e", 13.25, 22.875, 23.0, "door"], ["e", 13.375, 21.25, 21.375, "door"], ["w", 13.5, 9.125, 9.25, "door"], ["w", 13.75, 9.25, 11.75, "room"], ["w", 13.75, 11.875, 14.375, "room"], ["e", 13.875, 9.25, 11.75, "room"], ["e", 13.875, 11.875, 14.375, "room"], ["e", 14.0, 2.25, 2.375, "door"], ["w", 14.125, 7.5, 7.625, "door"], ["e", 14.125, 9.125, 9.25, "door"], ["w", 14.125, 16.0, 16.125, "door"], ["w", 14.125, 22.875, 23.0, "door"], ["w", 14.25, 21.25, 21.375, "door"], ["w", 14.375, 5.0, 7.5, "room"], ["w", 14.375, 16.125, 18.625, "room"], ["w", 14.375, 23.0, 25.5, "room"], ["e", 14.5, 5.0, 7.5, "room"], ["w", 14.5, 18.75, 21.25, "room"], ["e", 14.75, 7.5, 7.625, "door"], ["e", 14.75, 27.0, 30.0, "lobby"], ["w", 14.875, 2.25, 2.375, "door"], ["e", 14.875, 14.375, 14.5, "door"], ["w", 15.0, 9.125, 9.25, "door"], ["w", 15.125, 2.375, 4.875, "room"], ["e", 15.25, 2.375, 4.875, "room"], ["e", 15.5, 2.25, 2.375, "door"], ["w", 15.625, 7.5, 7.625, "door"], ["w", 15.75, 14.375, 14.5, "door"], ["e", 15.75, 16.0, 21.375, "cor"], ["e", 15.75, 22.875, 27.0, "cor"], ["w", 16.0, 9.25, 11.75, "room"], ["w", 16.0, 11.875, 14.375, "room"], ["e", 16.125, 9.25, 11.75, "room"], ["e", 16.125, 11.875, 14.375, "room"], ["w", 16.375, 2.25, 2.375, "door"], ["e", 16.375, 14.375, 14.5, "door"], ["w", 16.625, 5.0, 7.5, "room"], ["e", 16.75, 5.0, 7.5, "room"], ["e", 17.125, 9.125, 9.25, "door"], ["w", 17.25, 14.375, 14.5, "door"], ["w", 17.25, 16.0, 21.375, "cor"], ["w", 17.25, 22.875, 27.0, "cor"], ["w", 17.375, 2.375, 4.875, "room"], ["e", 17.375, 16.125, 18.625, "room"], ["e", 17.375, 18.75, 21.25, "room"], ["e", 17.375, 23.0, 25.5, "room"], ["e", 17.5, 2.375, 4.875, "room"], ["e", 17.625, 16.0, 16.125, "door"], ["e", 17.625, 21.25, 21.375, "door"], ["e", 17.625, 22.875, 23.0, "door"], ["e", 17.75, 7.5, 7.625, "door"], ["w", 18.0, 9.125, 9.25, "door"], ["w", 18.25, 9.25, 11.75, "room"], ["w", 18.25, 11.875, 14.375, "room"], ["w", 18.25, 27.0, 30.0, "lobby"], ["e", 18.375, 9.25, 11.75, "room"], ["e", 18.375, 11.875, 14.375, "room"], ["e", 18.5, 2.25, 2.375, "door"], ["w", 18.5, 16.0, 16.125, "door"], ["w", 18.5, 21.25, 21.375, "door"], ["w", 18.5, 22.875, 23.0, "door"], ["w", 18.625, 7.5, 7.625, "door"], ["e", 18.625, 9.125, 9.25, "door"], ["w", 18.875, 5.0, 7.5, "room"], ["w", 19.375, 2.25, 2.375, "door"], ["e", 19.375, 14.375, 14.5, "door"], ["w", 19.5, 9.125, 9.25, "door"], ["w", 19.5, 16.125, 18.625, "room"], ["w", 19.5, 18.75, 21.25, "room"], ["w", 19.5, 23.0, 25.5, "room"], ["w", 19.625, 2.375, 4.875, "room"], ["e", 19.625, 16.125, 18.625, "room"], ["e", 19.625, 18.75, 21.25, "room"], ["e", 19.625, 23.0, 25.5, "room"], ["e", 19.75, 2.25, 7.625, "cor"], ["w", 20.25, 14.375, 14.5, "door"], ["w", 20.5, 9.25, 11.75, "room"], ["w", 20.5, 11.875, 14.375, "room"], ["e", 20.625, 16.0, 16.125, "door"], ["e", 20.625, 21.25, 21.375, "door"], ["e", 20.625, 22.875, 23.0, "door"], ["w", 21.25, 2.25, 7.625, "cor"], ["e", 21.375, 2.375, 4.875, "room"], ["e", 21.375, 5.0, 7.5, "room"], ["w", 21.5, 16.0, 16.125, "door"], ["w", 21.5, 21.25, 21.375, "door"], ["w", 21.5, 22.875, 23.0, "door"], ["e", 21.625, 2.25, 2.375, "door"], ["e", 21.625, 7.5, 7.625, "door"], ["w", 21.75, 16.125, 18.625, "room"], ["w", 21.75, 18.75, 21.25, "room"], ["w", 21.75, 23.0, 25.5, "room"], ["e", 21.875, 16.125, 18.625, "room"], ["e", 21.875, 18.75, 21.25, "room"], ["e", 21.875, 23.0, 25.5, "room"], ["e", 22.0, 9.25, 14.375, "kitchen"], ["e", 22.125, 16.0, 16.125, "door"], ["e", 22.125, 21.25, 21.375, "door"], ["e", 22.125, 22.875, 23.0, "door"], ["w", 22.5, 2.25, 2.375, "door"], ["w", 22.5, 7.5, 7.625, "door"], ["w", 23.0, 16.0, 16.125, "door"], ["w", 23.0, 21.25, 21.375, "door"], ["w", 23.0, 22.875, 23.0, "door"], ["e", 23.125, 9.125, 9.25, "door"], ["w", 23.5, 2.375, 4.875, "room"], ["w", 23.5, 5.0, 7.5, "room"], ["e", 23.625, 2.375, 4.875, "room"], ["e", 23.625, 5.0, 7.5, "room"], ["w", 24.0, 9.125, 9.25, "door"], ["w", 24.0, 16.125, 18.625, "room"], ["w", 24.0, 18.75, 21.25, "room"], ["w", 24.0, 23.0, 25.5, "room"], ["e", 24.125, 16.125, 18.625, "room"], ["e", 24.125, 18.75, 21.25, "room"], ["e", 24.125, 23.0, 25.5, "room"], ["e", 24.625, 2.25, 2.375, "door"], ["e", 24.625, 7.5, 7.625, "door"], ["e", 25.125, 14.375, 14.5, "door"], ["e", 25.125, 16.0, 16.125, "door"], ["e", 25.125, 21.25, 21.375, "door"], ["e", 25.125, 22.875, 23.0, "door"], ["w", 25.5, 2.25, 2.375, "door"], ["w", 25.5, 7.5, 7.625, "door"], ["w", 25.75, 2.375, 4.875, "room"], ["w", 25.75, 5.0, 7.5, "room"], ["e", 25.875, 5.0, 7.5, "room"], ["w", 26.0, 14.375, 14.5, "door"], ["w", 26.0, 16.0, 16.125, "door"], ["w", 26.0, 21.25, 21.375, "door"], ["w", 26.0, 22.875, 23.0, "door"], ["e", 26.125, 7.5, 7.625, "door"], ["w", 26.25, 16.125, 18.625, "room"], ["w", 26.25, 18.75, 21.25, "room"], ["w", 26.25, 23.0, 25.5, "room"], ["e", 26.375, 16.125, 18.625, "room"], ["e", 26.375, 18.75, 21.25, "room"], ["e", 26.375, 23.0, 25.5, "room"], ["e", 26.625, 16.0, 16.125, "door"], ["e", 26.625, 21.25, 21.375, "door"], ["e", 26.625, 22.875, 23.0, "door"], ["w", 27.0, 7.5, 7.625, "door"], ["w", 27.0, 9.25, 14.375, "kitchen"], ["e", 27.125, 9.25, 11.75, "room"], ["e", 27.125, 11.875, 14.375, "room"], ["w", 27.25, 0.75, 2.25, "cor"], ["e", 27.375, 14.375, 14.5, "door"], ["w", 27.5, 16.0, 16.125, "door"], ["w", 27.5, 21.25, 21.375, "door"], ["w", 27.5, 22.875, 23.0, "door"], ["w", 28.0, 5.0, 7.5, "room"], ["e", 28.125, 9.125, 9.25, "door"], ["w", 28.25, 14.375, 14.5, "door"], ["w", 28.5, 16.125, 18.625, "room"], ["w", 28.5, 18.75, 21.25, "room"], ["w", 28.5, 23.0, 25.5, "room"], ["e", 28.625, 23.0, 25.5, "room"], ["w", 29.0, 9.125, 9.25, "door"], ["w", 29.25, 9.25, 11.75, "room"], ["w", 29.25, 11.875, 14.375, "room"], ["e", 29.375, 11.875, 14.375, "room"], ["w", 29.5, 7.625, 9.125, "cor"], ["e", 29.625, 22.875, 23.0, "door"], ["e", 30.375, 14.375, 14.5, "door"], ["e", 30.5, 16.0, 21.375, "cor"], ["w", 30.5, 22.875, 23.0, "door"], ["w", 30.75, 23.0, 25.5, "room"], ["w", 31.25, 14.375, 14.5, "door"], ["w", 31.5, 11.875, 14.375, "room"], ["w", 32.0, 14.5, 22.875, "cor"]], "lights": [{ "x": 4.847222222222222, "z": 22.125, "rot": 0, "kind": "tube", "mode": "flicker" }, { "x": 8.041666666666668, "z": 22.125, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 11.23611111111111, "z": 22.125, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 14.430555555555557, "z": 22.125, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 17.625, "z": 22.125, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 20.819444444444446, "z": 22.125, "rot": 0, "kind": "tube", "mode": "broken" }, { "x": 24.01388888888889, "z": 22.125, "rot": 0, "kind": "tube", "mode": "broken" }, { "x": 27.208333333333336, "z": 22.125, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 30.40277777777778, "z": 22.125, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 2.55, "z": 15.25, "rot": 0, "kind": "tube", "mode": "flicker" }, { "x": 5.65, "z": 15.25, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 8.75, "z": 15.25, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 11.85, "z": 15.25, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 14.950000000000001, "z": 15.25, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 18.05, "z": 15.25, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 21.150000000000002, "z": 15.25, "rot": 0, "kind": "tube", "mode": "flicker" }, { "x": 24.25, "z": 15.25, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 27.35, "z": 15.25, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 30.45, "z": 15.25, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 2.583333333333333, "z": 8.375, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 5.75, "z": 8.375, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 8.916666666666666, "z": 8.375, "rot": 0, "kind": "tube", "mode": "broken" }, { "x": 12.083333333333332, "z": 8.375, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 15.25, "z": 8.375, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 18.416666666666664, "z": 8.375, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 21.583333333333332, "z": 8.375, "rot": 0, "kind": "tube", "mode": "broken" }, { "x": 24.75, "z": 8.375, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 27.916666666666664, "z": 8.375, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 7.75, "z": 1.5, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 10.75, "z": 1.5, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 13.75, "z": 1.5, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 16.75, "z": 1.5, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 19.75, "z": 1.5, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 22.75, "z": 1.5, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 25.75, "z": 1.5, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 16.5, "z": 18.6875, "rot": 1, "kind": "tube", "mode": "on" }, { "x": 16.5, "z": 24.9375, "rot": 1, "kind": "tube", "mode": "on" }, { "x": 1.75, "z": 11.8125, "rot": 1, "kind": "tube", "mode": "broken" }, { "x": 31.25, "z": 18.6875, "rot": 1, "kind": "tube", "mode": "flicker" }, { "x": 20.5, "z": 4.9375, "rot": 1, "kind": "tube", "mode": "flicker" }, { "x": 16.5, "z": 28.4, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 23.5, "z": 11.0, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 25.5, "z": 12.8, "rot": 0, "kind": "tube", "mode": "on" }, { "x": 7.9, "z": 20.0, "rot": 0, "kind": "tube", "mode": "flicker" }, { "x": 4.9, "z": 1.9, "rot": 0, "kind": "bulb", "mode": "flicker" }], "cor": { "H1": [3.25, 21.375, 32.0, 22.875], "H2": [1.0, 14.5, 32.0, 16.0], "H3": [1.0, 7.625, 29.5, 9.125], "H4": [6.25, 0.75, 27.25, 2.25], "MAIN": [15.75, 16.0, 17.25, 27.0], "VW": [1.0, 9.125, 2.5, 14.5], "VE": [30.5, 16.0, 32.0, 21.375], "C34": [19.75, 2.25, 21.25, 7.625] } };
const T = 0.14;               // 집 벽 두께
const DOOR = { x: 16.5, z: 30, w: 0.9, h: 2.03 };
const FRONT = { x: 16.5, z: 36.5, w: 1.0, h: 2.1 };
const HALL = { x0: 15.75, x1: 17.25, z0: 30.07, z1: 34.25 };
const ENTRY = { x0: 15.25, x1: 17.75, z0: 34.25, z1: 36.5 };
const GD_W = 0.875, GD_H = 2.0;   // 고시원 방문
function regionAt(x, z) { return z < 30 ? 'back' : z < HALL.z1 ? 'hall' : 'entry'; }
function floorAt(x, z) { return z >= ENTRY.z0 && z < ENTRY.z1 + 0.5 ? ENTRY_Y : 0; }
function ceilAt(x, z) { return z < 30 ? CEIL : HOME_CEIL; }
function inRect(r, x, z, m = 0) { return x >= r[0] - m && x <= r[2] + m && z >= r[1] - m && z <= r[3] + m; }
// 고시원 바닥: 주방·로비·샤워실은 타일, 나머지는 장판
function floorKindAt(x, z) {
  for (const r of GOSI.regions) if ((r.type === 'kitchen' || r.type === 'lobby' || r.type === 'shower') && inRect(r.rect, x, z)) return 'tile';
  return 'vinyl';
}

// ── 벽 목록 (충돌·총알·시야) ──
const WALLS = [];
function addWall(x0, x1, z0, z1, y0 = -0.3, y1 = CEIL, kind = 'wall') {
  const w = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), y0, y1, kind, off: false };
  WALLS.push(w); return w;
}

// ── 면 쌓기 ──
class GB {
  constructor() { this.p = []; this.n = []; this.u = []; this.i = []; this.c = 0; }
  quad(a, b, c, d, n, ua, ub, uc, ud) {
    for (const v of [a, b, c, d]) this.p.push(v[0], v[1], v[2]);
    for (let k = 0; k < 4; k++) this.n.push(n[0], n[1], n[2]);
    for (const uv of [ua, ub, uc, ud]) this.u.push(uv[0], uv[1]);
    const o = this.c; this.i.push(o, o + 1, o + 2, o, o + 2, o + 3); this.c += 4;
  }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.i); g.computeBoundingSphere();
    return g;
  }
}
function boxSides(gb, x0, x1, z0, z1, y0, y1, faces = 'nsew', us = 1, vs = 1) {
  if (faces.includes('s')) gb.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], [x0 * us, y0 * vs], [x1 * us, y0 * vs], [x1 * us, y1 * vs], [x0 * us, y1 * vs]);
  if (faces.includes('n')) gb.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], [-x1 * us, y0 * vs], [-x0 * us, y0 * vs], [-x0 * us, y1 * vs], [-x1 * us, y1 * vs]);
  if (faces.includes('e')) gb.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], [-z1 * us, y0 * vs], [-z0 * us, y0 * vs], [-z0 * us, y1 * vs], [-z1 * us, y1 * vs]);
  if (faces.includes('w')) gb.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], [z0 * us, y0 * vs], [z1 * us, y0 * vs], [z1 * us, y1 * vs], [z0 * us, y1 * vs]);
}
function flatUp(gb, x0, x1, z0, z1, y, us, vs, ox = 0, oz = 0) {
  gb.quad([x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0], [0, 1, 0], [(x0 + ox) * us, -(z1 + oz) * vs], [(x1 + ox) * us, -(z1 + oz) * vs], [(x1 + ox) * us, -(z0 + oz) * vs], [(x0 + ox) * us, -(z0 + oz) * vs]);
}
function flatDown(gb, x0, x1, z0, z1, y, us, vs, ox = 0, oz = 0) {
  gb.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, -1, 0], [(x0 + ox) * us, (z0 + oz) * vs], [(x1 + ox) * us, (z0 + oz) * vs], [(x1 + ox) * us, (z1 + oz) * vs], [(x0 + ox) * us, (z1 + oz) * vs]);
}
// 고정 좌표 f에 선 벽 한 장. nrm: 면이 바라보는 쪽 (n:-z s:+z w:-x e:+x), [a,b] 구간
function wallFace(gb, nrm, f, a, b, y0, y1, us = 1, vs = 1) {
  if (nrm === 'n') gb.quad([b, y0, f], [a, y0, f], [a, y1, f], [b, y1, f], [0, 0, -1], [-b * us, y0 * vs], [-a * us, y0 * vs], [-a * us, y1 * vs], [-b * us, y1 * vs]);
  else if (nrm === 's') gb.quad([a, y0, f], [b, y0, f], [b, y1, f], [a, y1, f], [0, 0, 1], [a * us, y0 * vs], [b * us, y0 * vs], [b * us, y1 * vs], [a * us, y1 * vs]);
  else if (nrm === 'e') gb.quad([f, y0, b], [f, y0, a], [f, y1, a], [f, y1, b], [1, 0, 0], [-b * us, y0 * vs], [-a * us, y0 * vs], [-a * us, y1 * vs], [-b * us, y1 * vs]);
  else gb.quad([f, y0, a], [f, y0, b], [f, y1, b], [f, y1, a], [-1, 0, 0], [a * us, y0 * vs], [b * us, y0 * vs], [b * us, y1 * vs], [a * us, y1 * vs]);
}
const NRM_OFF = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };

const LEVEL = { group: new THREE.Group(), ammo: [], gun: null, panels: null, glows: null, rooms: [], gdoors: [], spots: null };
scene.add(LEVEL.group);
const MAT = {};
// 같은 모양을 여러 군데 (인스턴스). 방 가구는 어느 방 것인지 기억해 둔다 (닫힌 방은 안 그림)
let INST_OWNER = -1;
const ROOM_INST = new Map();   // 방 id → [[inst, k], ...]
function makeInst(geo, mat, n, outline = false) {
  const m = new THREE.InstancedMesh(geo, mat, n); m.count = 0; m.frustumCulled = false; LEVEL.group.add(m);
  let o = null;
  if (outline) { o = new THREE.InstancedMesh(geo, OUT_LIT, n); o.instanceMatrix = m.instanceMatrix; o.count = 0; o.frustumCulled = false; LEVEL.group.add(o); }
  const inst = {
    m, o,
    add(mat4, color) {
      const k = m.count++; m.setMatrixAt(k, mat4); if (color !== undefined) m.setColorAt(k, _col.set(color)); if (o) o.count = m.count;
      if (INST_OWNER >= 0) { if (!ROOM_INST.has(INST_OWNER)) ROOM_INST.set(INST_OWNER, []); ROOM_INST.get(INST_OWNER).push([inst, k]); }
      return k;
    },
  };
  return inst;
}
// 문이 닫힌 방의 가구는 납작하게 접어 둔다 (안 보이니까 그리지 않음)
function roomFurnShow(roomId, on) {
  const list = ROOM_INST.get(roomId); if (!list) return;
  for (const [inst, k] of list) {
    if (!inst.saved) continue;
    if (on) _m4.fromArray(inst.saved, k * 16); else _m4.copy(_zeroM);
    inst.m.setMatrixAt(k, _m4); inst.m.instanceMatrix.needsUpdate = true;
  }
}
const _q2 = new THREE.Quaternion(), _e2 = new THREE.Euler(), _s2 = new THREE.Vector3(), _p2 = new THREE.Vector3();
function trs(x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) { _q2.setFromEuler(_e2.set(rx, ry, rz, 'YXZ')); return _m4.compose(_p2.set(x, y, z), _q2, _s2.set(sx, sy, sz)); }

function buildLevel() {
  const H = CEIL;
  MAT.corWall = envMat({ map: TEX.corWall, kind: 0, ceilY: H, dirt: 0.3 });
  MAT.roomWall = envMat({ map: TEX.roomWall, kind: 0, ceilY: H, dirt: 0.24 });
  MAT.kitWall = envMat({ map: TEX.kitchenWall, kind: 0, ceilY: H, dirt: 0.2 });
  MAT.showerWall = envMat({ map: TEX.showerTile, kind: 0, ceilY: H, dirt: 0.28 });
  MAT.frame = envMat({ color: 0x5f3d24, kind: 3, dirt: 0.1 });
  MAT.base = envMat({ color: 0x4a3122, kind: 3, dirt: 0.08 });
  MAT.floor = envMat({ map: TEX.floor, kind: 1, dirt: 0.26 });
  MAT.tileFloor = envMat({ map: TEX.tile, kind: 1, dirt: 0.16, polygonOffset: true });
  MAT.showerFloor = envMat({ map: TEX.showerTile, kind: 1, dirt: 0.32, polygonOffset: true });
  MAT.ceil = envMat({ map: TEX.ceil, kind: 2, dirt: 0.14 });
  const gbs = { cor: new GB(), room: new GB(), kitchen: new GB(), shower: new GB(), door: new GB() };
  const typeGB = { cor: 'cor', lobby: 'cor', room: 'room', gun: 'room', kitchen: 'kitchen', shower: 'shower', door: 'door' };
  const base = new GB();
  for (const [nrm, f, a, b, type] of GOSI.segs) {
    const key = typeGB[type];
    const [us, vs] = key === 'kitchen' ? [1, 1 / H] : key === 'shower' ? [1 / 1.2, 1 / 1.2] : [1, 1];
    wallFace(gbs[key], nrm, f, a, b, 0, H, us, vs);
    if (key === 'cor' || key === 'room') { const o = NRM_OFF[nrm]; wallFace(base, nrm, f + (o[0] + o[1]) * 0.008, a, b, 0, 0.085, 1, 1); }
    // 충돌 상자는 막힌 쪽으로 얇게, 빛도 막는다
    const th = 0.06;
    if (nrm === 'n') { addWall(a, b, f, f + th); lfBlockH(f, a, b); }
    else if (nrm === 's') { addWall(a, b, f - th, f); lfBlockH(f, a, b); }
    else if (nrm === 'w') { addWall(f, f + th, a, b); lfBlockV(f, a, b); }
    else { addWall(f - th, f, a, b); lfBlockV(f, a, b); }
  }
  LEVEL.group.add(new THREE.Mesh(gbs.cor.geo(), MAT.corWall), new THREE.Mesh(gbs.room.geo(), MAT.roomWall), new THREE.Mesh(gbs.kitchen.geo(), MAT.kitWall), new THREE.Mesh(gbs.shower.geo(), MAT.showerWall), new THREE.Mesh(gbs.door.geo(), MAT.frame), new THREE.Mesh(base.geo(), MAT.base));
  // 집으로 가는 방문이 달린 벽 (로비 남쪽 면)
  {
    const gb = new GB(), z = 30 - T / 2, g0 = DOOR.x - DOOR.w / 2, g1 = DOOR.x + DOOR.w / 2, L = GOSI.regions.find((r) => r.type === 'lobby').rect;
    wallFace(gb, 'n', z, L[0], g0, 0, H); wallFace(gb, 'n', z, g1, L[2], 0, H); wallFace(gb, 'n', z, g0, g1, DOOR.h, H);
    LEVEL.group.add(new THREE.Mesh(gb.geo(), MAT.corWall));
    const bb = new GB(); wallFace(bb, 'n', z - 0.008, L[0], g0, 0, 0.085); wallFace(bb, 'n', z - 0.008, g1, L[2], 0, 0.085); LEVEL.group.add(new THREE.Mesh(bb.geo(), MAT.base));
    addWall(L[0], g0, z, z + T); addWall(g1, L[2], z, z + T); addWall(g0, g1, z, z + T, DOOR.h, H, 'lintel');
    lfBlockH(z, L[0], L[2]);
  }
  // 바닥·천장
  const fl = new GB(); flatUp(fl, 0, GOSI.W, 0, 30, 0, 0.5, 0.5);
  LEVEL.group.add(new THREE.Mesh(fl.geo(), MAT.floor));
  const tf = new GB(), sf = new GB();
  for (const r of GOSI.regions) {
    const [x0, z0, x1, z1] = r.rect;
    if (r.type === 'kitchen' || r.type === 'lobby') flatUp(tf, x0, x1, z0, z1, 0.002, 1 / 0.6, 1 / 0.6);
    else if (r.type === 'shower') flatUp(sf, x0, x1, z0, z1, 0.002, 1 / 1.2, 1 / 1.2);
  }
  LEVEL.group.add(new THREE.Mesh(tf.geo(), MAT.tileFloor), new THREE.Mesh(sf.geo(), MAT.showerFloor));
  const cl = new GB(); flatDown(cl, 0, GOSI.W, 0, 30, H, 1 / 0.6, 1 / 0.6);
  LEVEL.group.add(new THREE.Mesh(cl.geo(), MAT.ceil));

  buildHouse();
  buildTubes();
  buildGosiDoors();
  buildRooms();
  buildSpecialRooms();
  // 집 등
  LEVEL.hallLamp = addFixture({ x: 16.5, z: 32.2, R: 5, gain: 2.6, kind: 'home', mode: 'off', start: 'off', base: 1 });
  LEVEL.entryLamp = addFixture({ x: 16.5, z: 35.4, R: 5.5, gain: 3.4, kind: 'home', mode: 'off', start: 'off', base: 1 });
  // 문이 열리면 고시원 형광등 빛이 집 복도로 쏟아짐
  LEVEL.spill = addFixture({ x: 16.5, z: 30.3, R: 4.2, gain: 1.4, kind: 'spill', mode: 'off', start: 'off', base: 1 });

  buildProps();
  buildNav();
}

// ── 형광등 ──
function buildTubes() {
  const H = CEIL, n = GOSI.lights.length;
  const tubeGeo = new THREE.BoxGeometry(1.22, 0.05, 0.13);
  const panelMat = new THREE.ShaderMaterial({ uniforms: Object.assign({ map: { value: TEX.tube } }, LU), vertexShader: PANEL_VS, fragmentShader: PANEL_FS });
  const panels = new THREE.InstancedMesh(tubeGeo, panelMat, n);
  const glowGeo = new THREE.PlaneGeometry(2.4, 1.3); glowGeo.rotateX(Math.PI / 2);
  const glowMat = new THREE.ShaderMaterial({ uniforms: Object.assign({ map: { value: TEX.glow }, uColor: { value: new THREE.Color(0.86, 1.0, 0.84) }, uStr: { value: 0.3 } }, LU), vertexShader: PANEL_VS, fragmentShader: GLOW_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const glows = new THREE.InstancedMesh(glowGeo, glowMat, n);
  LEVEL.tubeFix = [];
  GOSI.lights.forEach((L, k) => {
    const ry = L.rot ? Math.PI / 2 : 0;
    if (L.kind === 'bulb') { panels.setMatrixAt(k, _zeroM); glows.setMatrixAt(k, _zeroM); }
    else {
      panels.setMatrixAt(k, trs(L.x, H - 0.03, L.z, ry));
      glows.setMatrixAt(k, trs(L.x, H - 0.004, L.z, ry));
    }
    panels.setColorAt(k, _col.setRGB(1, 1, 1)); glows.setColorAt(k, _col.setRGB(1, 1, 1));
    const bulb = L.kind === 'bulb';
    const f = addFixture({ x: L.x, z: L.z, mesh: k, R: bulb ? 3.4 : 6.0, gain: bulb ? 1.55 : 1.0, mode: L.mode, start: L.mode });
    f.kind = 'panel';
    LEVEL.tubeFix.push(f);
  });
  panels.renderOrder = 0; glows.renderOrder = 2; glows.frustumCulled = false; panels.frustumCulled = false;
  LEVEL.group.add(panels, glows);
  LEVEL.panels = panels; LEVEL.glows = glows;
  // 로비 형광등 (집 복도로 새는 빛의 기준)
  LEVEL.lobbyLight = LEVEL.tubeFix.reduce((b, f) => (Math.hypot(f.x - 16.5, f.z - 28.4) < Math.hypot(b.x - 16.5, b.z - 28.4) ? f : b));
}

// ── 고시원 방문 ──
function buildGosiDoors() {
  const H = CEIL;
  const leafGeo = new THREE.BoxGeometry(GD_W - 0.02, GD_H - 0.02, 0.04);
  const leafMat = envMat({ map: TEX.gosiDoor, kind: 3, dirt: 0.12 });
  const doors = [];
  for (const rm of GOSI.rooms) doors.push({ room: rm.id, num: rm.num, ...rm.door, leaf: true });
  for (const sd of GOSI.specialDoors) {
    const typ = GOSI.regions.find((r) => r.id === sd.room).type;
    doors.push({ room: sd.room, num: '', ...sd, leaf: typ === 'gun' });
  }
  const nLeaf = doors.filter((d) => d.leaf).length;
  const leaves = makeInst(leafGeo, leafMat, nLeaf);
  // 호수판: 아틀라스 칸을 인스턴스마다 다르게
  const plateGeo = new THREE.PlaneGeometry(0.2, 0.085);
  const aNum = new THREE.InstancedBufferAttribute(new Float32Array(nLeaf * 2), 2);
  plateGeo.setAttribute('aNum', aNum);
  const plateMat = new THREE.ShaderMaterial({
    uniforms: Object.assign({ map: { value: TEX.nums } }, LU),
    vertexShader: `attribute vec2 aNum; varying vec2 vUv; varying vec3 vWP; void main(){ vUv = uv / vec2(${NUM_COLS}.0, ${NUM_ROWS}.0) + aNum; vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: LIGHT_GLSL + `uniform sampler2D map; varying vec2 vUv; varying vec3 vWP; void main(){ vec3 c = texture2D(map, vUv).rgb; float L = lfAt(vWP.xz) + uAmb + flashAt(vWP); gl_FragColor = vec4(applyFog(c * L * lightTint(vWP), vWP, L), 1.0);
      #include <colorspace_fragment>
      }`,
  });
  const plates = new THREE.InstancedMesh(plateGeo, plateMat, nLeaf); plates.count = nLeaf; plates.frustumCulled = false; LEVEL.group.add(plates);
  // 손잡이 (양쪽)
  const hParts = [];
  for (const sd of [-1, 1]) {
    const rose = new THREE.CylinderGeometry(0.028, 0.028, 0.018, 12); rose.rotateX(Math.PI / 2); rose.translate(0, 0, sd * 0.03); hParts.push(rose);
    const lever = new THREE.BoxGeometry(0.12, 0.02, 0.022); lever.translate(-0.05, 0, sd * 0.05); hParts.push(lever);
  }
  const handles = makeInst(mergeGeos(hParts), toonLit(0xb7b2a6), nLeaf);
  // 문틀(복도 쪽)·상인방
  const frame = new GB(), lint = { cor: new GB(), room: new GB(), kitchen: new GB(), shower: new GB() }, lintBot = new GB();
  let li = 0;
  for (const d of doors) {
    const rtype = GOSI.regions.find((r) => r.id === d.room).type;
    const roomKey = rtype === 'gun' ? 'room' : rtype;
    if (d.axis === 'x') {
      const corZ = d.side === 'n' ? d.z0 : d.z1, roomZ = d.side === 'n' ? d.z1 : d.z0;
      const cn = d.side === 'n' ? 'n' : 's', rn = d.side === 'n' ? 's' : 'n';
      wallFace(lint.cor, cn, corZ, d.x0, d.x1, GD_H, H); wallFace(lint[roomKey], rn, roomZ, d.x0, d.x1, GD_H, H);
      flatDown(lintBot, d.x0, d.x1, d.z0, d.z1, GD_H, 1, 1);
      addWall(d.x0, d.x1, d.z0, d.z1, GD_H, H, 'lintel');
      lfBlockH(corZ, d.x0, d.x1);
      const o = (cn === 'n' ? -1 : 1) * 0.01, w = 0.065;
      wallFace(frame, cn, corZ + o, d.x0 - w, d.x0, 0, GD_H + w); wallFace(frame, cn, corZ + o, d.x1, d.x1 + w, 0, GD_H + w); wallFace(frame, cn, corZ + o, d.x0, d.x1, GD_H, GD_H + w);
    } else {
      const corX = d.side === 'e' ? d.x1 : d.x0, roomX = d.side === 'e' ? d.x0 : d.x1;
      const cn = d.side === 'e' ? 'e' : 'w', rn = d.side === 'e' ? 'w' : 'e';
      wallFace(lint.cor, cn, corX, d.z0, d.z1, GD_H, H); wallFace(lint[roomKey], rn, roomX, d.z0, d.z1, GD_H, H);
      flatDown(lintBot, d.x0, d.x1, d.z0, d.z1, GD_H, 1, 1);
      addWall(d.x0, d.x1, d.z0, d.z1, GD_H, H, 'lintel');
      lfBlockV(corX, d.z0, d.z1);
      const o = (cn === 'w' ? -1 : 1) * 0.01, w = 0.065;
      wallFace(frame, cn, corX + o, d.z0 - w, d.z0, 0, GD_H + w); wallFace(frame, cn, corX + o, d.z1, d.z1 + w, 0, GD_H + w); wallFace(frame, cn, corX + o, d.z0, d.z1, GD_H, GD_H + w);
    }
    if (!d.leaf) continue;
    // 경첩은 방 옆벽 쪽, 문은 방 안으로 열린다
    const g = { ...d, li, a: 0, target: 0, k: 3.2 };
    if (d.axis === 'x') {
      const intoZ = d.side === 'n' ? 1 : -1;
      g.n = [0, intoZ];
      if (d.left !== false) { g.hx = d.x0 + 0.01; g.u = [1, 0]; } else { g.hx = d.x1 - 0.01; g.u = [-1, 0]; }
      g.hz = (d.z0 + d.z1) / 2;
      g.cx = (d.x0 + d.x1) / 2; g.cz = d.side === 'n' ? d.z0 - 0.45 : d.z1 + 0.45;
      g.wall = addWall(d.x0, d.x1, d.z0, d.z1, -0.3, GD_H, 'gdoor');
    } else {
      const intoX = d.side === 'e' ? -1 : 1;
      g.n = [intoX, 0]; g.hx = (d.x0 + d.x1) / 2; g.hz = d.z0 + 0.01; g.u = [0, 1];
      g.cx = d.side === 'e' ? d.x1 + 0.45 : d.x0 - 0.45; g.cz = (d.z0 + d.z1) / 2;
      g.wall = addWall(d.x0, d.x1, d.z0, d.z1, -0.3, GD_H, 'gdoor');
    }
    // 복도 쪽 면이 로컬 +Z인지 -Z인지
    g.side2 = -(g.n[0] * -g.u[1] + g.n[1] * g.u[0]) >= 0 ? 1 : -1;
    leaves.add(_zeroM); handles.add(_zeroM);
    const k = d.num ? clamp(+d.num - 301, 0, NUM_COLS * NUM_ROWS - 1) : 0;
    aNum.setXY(li, (k % NUM_COLS) / NUM_COLS, 1 - (Math.floor(k / NUM_COLS) + 1) / NUM_ROWS);
    if (!d.num) plates.setMatrixAt(li, _zeroM);
    g.hasPlate = !!d.num;
    li++;
    LEVEL.gdoors.push(g);
    if (!d.num) LEVEL.gunDoor = g;
  }
  aNum.needsUpdate = true;
  LEVEL.group.add(new THREE.Mesh(frame.geo(), MAT.frame), new THREE.Mesh(lint.cor.geo(), MAT.corWall), new THREE.Mesh(lint.room.geo(), MAT.roomWall), new THREE.Mesh(lint.kitchen.geo(), MAT.kitWall), new THREE.Mesh(lint.shower.geo(), MAT.showerWall), new THREE.Mesh(lintBot.geo(), MAT.frame));
  LEVEL.leafInst = leaves; LEVEL.plates = plates; LEVEL.handleInst = handles;
  for (const g of LEVEL.gdoors) gdoorWrite(g);
}
const _gm = new THREE.Matrix4(), _gl = new THREE.Matrix4();
function gdoorWrite(g) {
  const c = Math.cos(g.a), s = Math.sin(g.a);
  const vx = g.u[0] * c + g.n[0] * s, vz = g.u[1] * c + g.n[1] * s;
  _gm.set(vx, 0, -vz, g.hx + vx * GD_W / 2, 0, 1, 0, GD_H / 2, vz, 0, vx, g.hz + vz * GD_W / 2, 0, 0, 0, 1);
  LEVEL.leafInst.m.setMatrixAt(g.li, _gm); LEVEL.leafInst.m.instanceMatrix.needsUpdate = true;
  _gl.makeTranslation(GD_W / 2 - 0.1, 1.0 - GD_H / 2, 0); LEVEL.handleInst.m.setMatrixAt(g.li, _gl.premultiply(_gm)); LEVEL.handleInst.m.instanceMatrix.needsUpdate = true;
  if (g.hasPlate) {
    _gl.makeRotationY(g.side2 > 0 ? 0 : Math.PI); _gl.setPosition(0, 0.5, g.side2 * 0.0215);
    LEVEL.plates.setMatrixAt(g.li, _gl.premultiply(_gm)); LEVEL.plates.instanceMatrix.needsUpdate = true;
  }
}
// 문 여닫기: 각도와 함께 충돌·길찾기도 바꾼다
function gdoorSet(g, target, k = 3.2) { g.target = target; g.k = k; }
function gdoorTick(dt) {
  for (const g of LEVEL.gdoors) {
    if (Math.abs(g.a - g.target) < 0.0005) continue;
    g.a = approach(g.a, g.target, g.k, dt);
    if (Math.abs(g.a - g.target) < 0.002) g.a = g.target;
    gdoorWrite(g);
    const shut = g.a < 0.9;
    if (g.wall.off === shut) { g.wall.off = !shut; navDoorShut(g, shut); }
    if (!g.furnOn && g.a > 0.005) { g.furnOn = true; roomFurnShow(g.room, true); }
  }
}
function gdoorReset() {
  for (const g of LEVEL.gdoors) {
    g.a = g.target = g.init || 0; gdoorWrite(g);
    const shut = g.a < 0.9;
    g.wall.off = !shut;
    if (NAV.ready) navDoorShut(g, shut, true);
    g.furnOn = g.a > 0.005; roomFurnShow(g.room, g.furnOn);
  }
}

// 처음부터 사람이 있는 방 (문이 열려 있고 모니터가 켜져 있다)
const LURK_ROOMS = { '345': 'desk', '306': 'desk', '348': 'bed', '359': 'floor', '331': 'floor', '317': 'bed' };
// ── 방 가구 (68칸 모두 같은 살림, 문 쪽에 따라 좌우만 바꿈) ──
function buildRooms() {
  const N = GOSI.rooms.length + 2;
  const R = rng(202);
  const woodDk = toonLit(0x6b4a33), woodLt = toonLit(0xc9a77c), white = toonLit(0xf1eee6), gray = toonLit(0x55565c), dark = toonLit(0x26262b);
  const bedFrame = makeInst(new THREE.BoxGeometry(1, 1, 1), woodLt, N, true);
  const mattress = makeInst(new THREE.BoxGeometry(1, 1, 1), white, N);
  const blanketGeo = (() => { const g = new THREE.BoxGeometry(1, 1, 1, 5, 1, 7); const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y > 0.2) p.setY(i, y + Math.sin(p.getX(i) * 9 + p.getZ(i) * 5) * 0.12 + Math.cos(p.getZ(i) * 13) * 0.1); } g.computeVertexNormals(); return g; })();
  const blankets = makeInst(blanketGeo, toonLit(0xffffff, { map: TEX.blanket }, 'toonlit-map'), N, true);
  const pillows = makeInst(G3.ell(0.5, 0.5, 0.5, 12, 6), white, N, true);
  const deskTop = makeInst(new THREE.BoxGeometry(1, 1, 1), woodLt, N, true);
  const deskSide = makeInst(new THREE.BoxGeometry(1, 1, 1), woodDk, N * 2);
  const chairGeo = mergeGeos([(() => { const g = new THREE.BoxGeometry(0.42, 0.06, 0.42); g.translate(0, 0.45, 0); return g; })(), (() => { const g = new THREE.BoxGeometry(0.42, 0.45, 0.05); g.translate(0, 0.7, -0.19); return g; })(), (() => { const g = new THREE.CylinderGeometry(0.03, 0.03, 0.42, 8); g.translate(0, 0.21, 0); return g; })(), (() => { const g = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 10); g.translate(0, 0.02, 0); return g; })()]);
  const chairs = makeInst(chairGeo, toonLit(0x2f3440), N, true);
  const monGeo = mergeGeos([(() => { const g = new THREE.BoxGeometry(0.56, 0.34, 0.04); g.translate(0, 0.3, 0); return g; })(), (() => { const g = new THREE.BoxGeometry(0.05, 0.12, 0.05); g.translate(0, 0.08, 0.02); return g; })(), (() => { const g = new THREE.BoxGeometry(0.22, 0.02, 0.16); g.translate(0, 0.01, 0.02); return g; })()]);
  const monitors = makeInst(monGeo, dark, N, true);
  const screens = makeInst(new THREE.PlaneGeometry(0.52, 0.3), new THREE.MeshBasicMaterial({ map: TEX.screen }), N);
  const shelves = makeInst(new THREE.BoxGeometry(1, 1, 1), woodDk, N);
  const booksM = makeInst(new THREE.BoxGeometry(1, 1, 1), toonLit(0xffffff), N * 3);
  const bins = makeInst(new THREE.CylinderGeometry(0.13, 0.11, 0.3, 12), gray, N);
  const cups = makeInst(new THREE.CylinderGeometry(0.05, 0.04, 0.09, 10), toonLit(0xffffff), N * 3);
  const clothes = makeInst(G3.ell(1, 1, 1, 8, 5), toonLit(0xffffff), N * 2);
  LEVEL.furn = { bedFrame, mattress, blankets, pillows, deskTop, deskSide, chairs, monitors, screens, shelves, booksM, bins, cups, clothes };
  const BLANKET = ['#d8665e', '#6f8fc9', '#e8c45a', '#7fb07a', '#c78bc6', '#9aa0a8', '#e59a5b', '#5aa7a2'];
  const BOOKS = ['#c0443c', '#3a6aa8', '#e2b23c', '#4f8a4a', '#8a5aa8'];
  const CLOTH = ['#3b4252', '#6e6e72', '#c9a24a', '#2f5d8a', '#d9d4c7', '#556b2f'];
  for (const rm of GOSI.rooms) {
    INST_OWNER = rm.id;
    const [x0, z0, x1, z1] = rm.rect, d = rm.door;
    const inZ = d.side === 'n' ? 1 : -1, zr = d.side === 'n' ? z0 : z1, W = x1 - x0;
    const left = d.left !== false;
    const X = (a) => x0 + a, Z = (dd) => zr + dd * inZ;
    const span = (a0, a1, d0, d1) => ({ x0: Math.min(X(a0), X(a1)), x1: Math.max(X(a0), X(a1)), z0: Math.min(Z(d0), Z(d1)), z1: Math.max(Z(d0), Z(d1)) });
    const box = (inst, b, y0, y1, col) => inst.add(trs((b.x0 + b.x1) / 2, (y0 + y1) / 2, (b.z0 + b.z1) / 2, 0, b.x1 - b.x0, y1 - y0, b.z1 - b.z0), col);
    const info = { id: rm.id, num: rm.num, rect: rm.rect, inZ, zr, left, door: d };
    // 침대: 문 반대편 벽을 따라
    const bA = left ? [W - 0.97, W - 0.03] : [0.03, 0.97];
    const bed = span(bA[0], bA[1], 0.42, 2.44);
    box(bedFrame, bed, 0, 0.3); box(mattress, { x0: bed.x0 + 0.02, x1: bed.x1 - 0.02, z0: bed.z0 + 0.02, z1: bed.z1 - 0.02 }, 0.3, 0.46);
    const bl = span(bA[0] + 0.02, bA[1] - 0.02, 0.5, 1.95);
    blankets.add(trs((bl.x0 + bl.x1) / 2, 0.5, (bl.z0 + bl.z1) / 2, R() < 0.5 ? 0 : Math.PI, bl.x1 - bl.x0 + 0.04, 0.1, bl.z1 - bl.z0), pick(BLANKET));
    pillows.add(trs(X((bA[0] + bA[1]) / 2), 0.52, Z(2.2), 0, 0.5, 0.13, 0.32), '#f4f1e8');
    addWall(bed.x0, bed.x1, bed.z0, bed.z1, -0.3, 0.46, 'prop');
    info.bed = { x: X((bA[0] + bA[1]) / 2), z: Z(1.4), top: 0.47, yaw: inZ > 0 ? 0 : Math.PI, head: { x: X((bA[0] + bA[1]) / 2), z: Z(2.2) } };
    info.bedRect = bed;
    // 책상·의자·모니터: 문 쪽 깊숙한 곳
    const dA = left ? [0.04, 0.98] : [W - 0.98, W - 0.04];
    const desk = span(dA[0], dA[1], 1.98, 2.46);
    box(deskTop, desk, 0.7, 0.735);
    for (const e of [0, 1]) { const ax = dA[e] + (e ? -0.03 : 0); const s = span(ax, ax + 0.03, 1.98, 2.46); box(deskSide, s, 0, 0.7); }
    addWall(desk.x0, desk.x1, desk.z0, desk.z1, -0.3, 0.74, 'prop');
    const dcx = X((dA[0] + dA[1]) / 2);
    chairs.add(trs(dcx, 0, Z(1.62), inZ > 0 ? 0 : Math.PI, 1, 1, 1, 0, 0));
    const myaw = inZ > 0 ? Math.PI : 0;
    monitors.add(trs(dcx, 0.735, Z(2.3), myaw));
    const on = R() < 0.45 || !!LURK_ROOMS[rm.num];
    info.screen = screens.add(trs(dcx, 0.735 + 0.3, Z(2.3) - inZ * 0.022, myaw), on ? '#ffffff' : '#1d2026');
    info.monitorOn = on;
    if (on) info.fix = addFixture({ x: dcx, z: Z(2.0), R: 2.2, gain: 0.85, mode: 'on', start: 'on', kind: 'room' });
    // 책상 위 선반과 책
    box(shelves, span(dA[0], dA[1], 2.3, 2.46), 1.35, 1.38);
    let bx = dA[0] + 0.06;
    for (let b = 0; b < 3; b++) { const w = 0.05 + R() * 0.05; booksM.add(trs(X(bx + w / 2), 1.38 + 0.11, Z(2.38), 0, w, 0.2 + R() * 0.06, 0.15), pick(BOOKS)); bx += w + 0.01; }
    // 휴지통, 컵라면, 옷가지
    bins.add(trs(X(left ? 1.12 : W - 1.12), 0.15, Z(2.3)));
    for (let c = 0; c < 1 + (R() * 3 | 0); c++) cups.add(trs(dcx + (R() - 0.5) * 0.6, 0.735 + 0.045, Z(2.05 + R() * 0.12)), R() < 0.5 ? '#f3efe6' : '#d94a3a');
    if (R() < 0.7) clothes.add(trs(X(left ? 0.55 + R() * 0.3 : W - 0.55 - R() * 0.3), 0.04, Z(1.0 + R() * 0.5), R() * TAU, 0.28, 0.05, 0.2), pick(CLOTH));
    LEVEL.rooms.push(info);
  }
  INST_OWNER = -1;
  for (const inst of Object.values(LEVEL.furn)) { inst.m.instanceMatrix.needsUpdate = true; if (inst.m.instanceColor) inst.m.instanceColor.needsUpdate = true; inst.saved = inst.m.instanceMatrix.array.slice(); }
}

// ── 주방, 샤워실, 끝방, 로비 ──
function buildSpecialRooms() {
  const reg = (t) => GOSI.regions.find((r) => r.type === t).rect;
  const white = toonLit(0xf2efe8), steel = toonLit(0x9ea4a8), gray = toonLit(0x6a6d72), dark = toonLit(0x2a2b30);
  const add = (geo, mat, x, y, z, ry = 0, outline = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.y = ry; LEVEL.group.add(m); if (outline) m.add(new THREE.Mesh(geo, OUT_LIT)); return m; };
  const boxG = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  // 주방
  {
    const [x0, z0, x1, z1] = reg('kitchen');
    add(boxG(0.62, 0.86, 4.0), white, x0 + 0.31, 0.43, 11.6);
    add(boxG(0.66, 0.04, 4.04), steel, x0 + 0.33, 0.88, 11.6, 0, false);
    add(boxG(0.4, 0.02, 0.6), dark, x0 + 0.32, 0.895, 10.9, 0, false);
    add(boxG(0.34, 0.66, 4.0), white, x0 + 0.17, 1.9, 11.6);
    addWall(x0, x0 + 0.66, 9.6, 13.6, -0.3, 0.9, 'prop');
    add(new THREE.CylinderGeometry(0.14, 0.14, 0.22, 16), white, x0 + 0.3, 1.01, 12.7);
    add(boxG(0.36, 0.27, 0.46), toonLit(0xdedad0), x0 + 0.3, 1.035, 13.2);
    add(new THREE.CylinderGeometry(0.07, 0.08, 0.2, 12), steel, x0 + 0.3, 1.0, 10.2);
    add(boxG(0.68, 1.78, 0.66), white, x1 - 0.36, 0.89, z0 + 0.36);
    addWall(x1 - 0.7, x1, z0, z0 + 0.7, -0.3, 1.8, 'prop');
    add(boxG(0.36, 1.2, 0.4), toonLit(0x6f9fd0), x1 - 0.2, 0.6, z0 + 1.35);
    add(boxG(1.4, 0.04, 1.0), toonLit(0xc9a77c), 24.8, 0.72, 11.9);
    add(boxG(1.3, 0.7, 0.9), woodLeg(), 24.8, 0.35, 11.9, 0, false);
    addWall(24.1, 25.5, 11.4, 12.4, -0.3, 0.74, 'prop');
    for (const [sx, sz] of [[24.2, 11.15], [25.4, 11.15], [24.2, 12.65], [25.4, 12.65]]) add(new THREE.CylinderGeometry(0.15, 0.15, 0.44, 12), toonLit(0xd0453c), sx, 0.22, sz);
  }
  // 샤워실
  {
    const [x0, z0, x1, z1] = reg('shower');
    for (const px of [7.15, 8.55]) { add(boxG(0.04, 2.0, 1.1), toonLit(0xdfe6ea), px, 1.0, z0 + 0.55); addWall(px - 0.03, px + 0.03, z0, z0 + 1.1, -0.3, 2.0, 'prop'); }
    const curtain = new THREE.PlaneGeometry(1, 1.75, 12, 1); { const p = curtain.attributes.position; for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 18) * 0.03); curtain.computeVertexNormals(); }
    // 반투명 샤워 커튼 (뒤에 선 사람이 비친다)
    const cm = toonLit(0x8fc6dd, { side: THREE.DoubleSide, transparent: true, opacity: 0.62, depthWrite: false }, 'toonlit-2s-tr');
    [[x0 + 0.7, 1.2], [7.85, 0.55], [9.27, 1.25]].forEach(([cx, w]) => { const m = new THREE.Mesh(curtain, cm); m.scale.x = w; m.position.set(cx, 1.03, z0 + 1.1); LEVEL.group.add(m); });
    for (const cx of [6.45, 7.85, 9.27]) add(new THREE.CylinderGeometry(0.05, 0.03, 0.1, 10), steel, cx, 1.98, z0 + 0.1, 0, false);
    add(boxG(0.62, 0.84, 0.62), white, x0 + 0.34, 0.42, z1 - 0.36);
    add(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 20).rotateX(Math.PI / 2), dark, x0 + 0.34, 0.45, z1 - 0.67, 0, false);
    addWall(x0, x0 + 0.66, z1 - 0.68, z1, -0.3, 0.86, 'prop');
    add(boxG(0.5, 0.2, 0.62), white, x1 - 0.26, 0.78, 20.45);
    add(boxG(0.02, 0.6, 0.5), toonLit(0xa9c4d2), x1 - 0.012, 1.45, 20.45, 0, false);
  }
  // 끝방: 침대 위 산탄총, 책상의 켜진 모니터, 깜빡이는 알전구
  {
    const [x0, z0, x1, z1] = reg('gun');
    const wood = toonLit(0xc9a77c);
    add(boxG(0.95, 0.3, 2.05), wood, x0 + 0.5, 0.15, z0 + 1.1);
    add(boxG(0.91, 0.16, 2.01), white, x0 + 0.5, 0.38, z0 + 1.1, 0, false);
    const bk = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.1, 1.2, 6, 2, 8), toonLit(0xffffff, { map: TEX.blanket }, 'toonlit-map')); bk.material.color.set('#7a8bb0'); bk.position.set(x0 + 0.5, 0.5, z0 + 1.55); bk.rotation.y = 0.12; LEVEL.group.add(bk);
    addWall(x0, x0 + 0.98, z0 + 0.08, z0 + 2.13, -0.3, 0.46, 'prop');
    add(boxG(1.1, 0.035, 0.46), wood, x1 - 0.6, 0.72, z1 - 0.25);
    add(boxG(1.0, 0.7, 0.42), toonLit(0x6b4a33), x1 - 0.6, 0.35, z1 - 0.25, 0, false);
    addWall(x1 - 1.15, x1, z1 - 0.48, z1, -0.3, 0.74, 'prop');
    const mon = add(boxG(0.56, 0.34, 0.04), dark, x1 - 0.6, 1.04, z1 - 0.3);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.3), new THREE.MeshBasicMaterial({ map: TEX.screen })); scr.position.set(x1 - 0.6, 1.04, z1 - 0.322); scr.rotation.y = Math.PI; LEVEL.group.add(scr);
    LEVEL.gunScr = scr;
    LEVEL.gunScreen = addFixture({ x: x1 - 0.6, z: z1 - 0.7, R: 2.2, gain: 0.85, mode: 'on', start: 'on', kind: 'room' });
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.4, 6), dark); cord.position.set(4.85, CEIL - 0.2, 1.9); LEVEL.group.add(cord);
    LEVEL.bulb = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), new THREE.MeshBasicMaterial({ color: 0xfff2c4 })); LEVEL.bulb.position.set(4.85, CEIL - 0.44, 1.9); LEVEL.group.add(LEVEL.bulb);
    LEVEL.bulbFix = LEVEL.tubeFix.find((f) => Math.hypot(f.x - 4.85, f.z - 1.9) < 0.6);
    LEVEL.gunBed = { x: x0 + 0.5, z: z0 + 1.2, top: 0.47 };
  }
  // 로비: 신발장, 게시판, CCTV
  {
    const [x0, z0, x1, z1] = reg('lobby');
    add(boxG(0.38, 1.05, 2.1), toonLit(0xd9cdb6), x0 + 0.2, 0.525, 28.4);
    for (const y of [0.35, 0.7]) add(boxG(0.36, 0.02, 2.06), toonLit(0x8a6a4a), x0 + 0.21, y, 28.4, 0, false);
    addWall(x0, x0 + 0.4, 27.35, 29.45, -0.3, 1.05, 'prop');
    const nb = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.75), envMat({ map: TEX.notice, kind: 3, dirt: 0.05 }));
    nb.rotation.y = -Math.PI / 2; nb.position.set(x1 - 0.012, 1.5, 28.3); LEVEL.group.add(nb);
    const cam = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 8, 0, TAU, 0, Math.PI / 2), dark); cam.rotation.x = Math.PI; cam.position.set(x1 - 0.3, CEIL - 0.002, z0 + 0.3); LEVEL.group.add(cam);
  }
  function woodLeg() { return toonLit(0x6b4a33); }
}

// ── 집 ──
function buildHouse() {
  MAT.homeWall = envMat({ map: TEX.homeWall, kind: 0, ceilY: HOME_CEIL, dirt: 0.06 });
  MAT.entryWall = envMat({ map: TEX.homeWall, kind: 0, floorY: ENTRY_Y, ceilY: HOME_CEIL, dirt: 0.06 });
  MAT.wood = envMat({ map: TEX.wood, kind: 1, dirt: 0.08 });
  MAT.tile = envMat({ map: TEX.tile, kind: 1, dirt: 0.08 });
  MAT.homeCeil = envMat({ color: 0xf4f1ea, kind: 2, dirt: 0.04, gain: 1.25 });
  MAT.trim = envMat({ color: 0xf6f3ec, kind: 0, ceilY: HOME_CEIL, dirt: 0.03 });
  const H = HOME_CEIL;
  const w = new GB(), e = new GB(), f = new GB(), t = new GB(), c = new GB();
  boxSides(w, HALL.x0 - T, HALL.x0, HALL.z0, HALL.z1, 0, H, 'e');
  boxSides(w, HALL.x1, HALL.x1 + T, HALL.z0, HALL.z1, 0, H, 'w');
  addWall(HALL.x0 - T, HALL.x0, HALL.z0 - 0.1, HALL.z1, -0.3, H, 'home');
  addWall(HALL.x1, HALL.x1 + T, HALL.z0 - 0.1, HALL.z1, -0.3, H, 'home');
  lfBlockV(HALL.x0, HALL.z0 - 0.1, HALL.z1); lfBlockV(HALL.x1, HALL.z0 - 0.1, HALL.z1);
  const g0 = DOOR.x - DOOR.w / 2, g1 = DOOR.x + DOOR.w / 2, zf = 30 + T / 2;
  w.quad([HALL.x0, 0, zf], [g0, 0, zf], [g0, H, zf], [HALL.x0, H, zf], [0, 0, 1], [HALL.x0, 0], [g0, 0], [g0, H], [HALL.x0, H]);
  w.quad([g1, 0, zf], [HALL.x1, 0, zf], [HALL.x1, H, zf], [g1, H, zf], [0, 0, 1], [g1, 0], [HALL.x1, 0], [HALL.x1, H], [g1, H]);
  w.quad([g0, DOOR.h, zf], [g1, DOOR.h, zf], [g1, H, zf], [g0, H, zf], [0, 0, 1], [g0, DOOR.h], [g1, DOOR.h], [g1, H], [g0, H]);
  const jamb = new GB();
  jamb.quad([g0, 0, 30 - T / 2], [g0, 0, 30 + T / 2], [g0, DOOR.h, 30 + T / 2], [g0, DOOR.h, 30 - T / 2], [1, 0, 0], [0, 0], [0.14, 0], [0.14, 1], [0, 1]);
  jamb.quad([g1, 0, 30 + T / 2], [g1, 0, 30 - T / 2], [g1, DOOR.h, 30 - T / 2], [g1, DOOR.h, 30 + T / 2], [-1, 0, 0], [0, 0], [0.14, 0], [0.14, 1], [0, 1]);
  jamb.quad([g0, DOOR.h, 30 + T / 2], [g1, DOOR.h, 30 + T / 2], [g1, DOOR.h, 30 - T / 2], [g0, DOOR.h, 30 - T / 2], [0, -1, 0], [0, 0], [1, 0], [1, 0.14], [0, 0.14]);
  for (const side of [-1, 1]) {
    const z = 30 + side * (T / 2 + 0.012), wd = 0.07;
    const quadFace = (x0, x1, y0, y1) => {
      if (side > 0) jamb.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);
      else jamb.quad([x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], [0, 0, -1], [0, 0], [1, 0], [1, 1], [0, 1]);
    };
    quadFace(g0 - wd, g0, 0, DOOR.h + wd); quadFace(g1, g1 + wd, 0, DOOR.h + wd); quadFace(g0, g1, DOOR.h, DOOR.h + wd);
  }
  LEVEL.group.add(new THREE.Mesh(jamb.geo(), MAT.trim));
  boxSides(e, ENTRY.x0 - T, ENTRY.x0, ENTRY.z0, ENTRY.z1, ENTRY_Y, H, 'e');
  boxSides(e, ENTRY.x1, ENTRY.x1 + T, ENTRY.z0, ENTRY.z1, ENTRY_Y, H, 'w');
  addWall(ENTRY.x0 - T, ENTRY.x0, ENTRY.z0, ENTRY.z1 + T, -0.3, H, 'home');
  addWall(ENTRY.x1, ENTRY.x1 + T, ENTRY.z0, ENTRY.z1 + T, -0.3, H, 'home');
  lfBlockV(ENTRY.x0, ENTRY.z0, ENTRY.z1); lfBlockV(ENTRY.x1, ENTRY.z0, ENTRY.z1);
  const fz = ENTRY.z1, f0 = FRONT.x - FRONT.w / 2, f1 = FRONT.x + FRONT.w / 2;
  e.quad([f0, ENTRY_Y, fz], [ENTRY.x0, ENTRY_Y, fz], [ENTRY.x0, H, fz], [f0, H, fz], [0, 0, -1], [-f0, ENTRY_Y], [-ENTRY.x0, ENTRY_Y], [-ENTRY.x0, H], [-f0, H]);
  e.quad([ENTRY.x1, ENTRY_Y, fz], [f1, ENTRY_Y, fz], [f1, H, fz], [ENTRY.x1, H, fz], [0, 0, -1], [-ENTRY.x1, ENTRY_Y], [-f1, ENTRY_Y], [-f1, H], [-ENTRY.x1, H]);
  e.quad([f1, FRONT.h + ENTRY_Y, fz], [f0, FRONT.h + ENTRY_Y, fz], [f0, H, fz], [f1, H, fz], [0, 0, -1], [-f1, FRONT.h], [-f0, FRONT.h], [-f0, H], [-f1, H]);
  addWall(ENTRY.x0, f0, fz, fz + T, -0.3, H, 'home'); addWall(f1, ENTRY.x1, fz, fz + T, -0.3, H, 'home');
  addWall(f0, f1, fz, fz + T, FRONT.h + ENTRY_Y, H, 'lintel');
  lfBlockH(fz, ENTRY.x0, ENTRY.x1);
  const nz = ENTRY.z0;
  e.quad([ENTRY.x0, ENTRY_Y, nz], [HALL.x0, ENTRY_Y, nz], [HALL.x0, H, nz], [ENTRY.x0, H, nz], [0, 0, 1], [ENTRY.x0, ENTRY_Y], [HALL.x0, ENTRY_Y], [HALL.x0, H], [ENTRY.x0, H]);
  e.quad([HALL.x1, ENTRY_Y, nz], [ENTRY.x1, ENTRY_Y, nz], [ENTRY.x1, H, nz], [HALL.x1, H, nz], [0, 0, 1], [HALL.x1, ENTRY_Y], [ENTRY.x1, ENTRY_Y], [ENTRY.x1, H], [HALL.x1, H]);
  addWall(ENTRY.x0, HALL.x0, nz - T, nz, -0.3, H, 'home'); addWall(HALL.x1, ENTRY.x1, nz - T, nz, -0.3, H, 'home');
  lfBlockH(nz, ENTRY.x0, HALL.x0); lfBlockH(nz, HALL.x1, ENTRY.x1);
  flatUp(f, HALL.x0, HALL.x1, HALL.z0 - T / 2 - 0.02, HALL.z1, 0, 0.5, 0.5);
  flatUp(t, ENTRY.x0, ENTRY.x1, ENTRY.z0, ENTRY.z1, ENTRY_Y, 1 / 0.6, 1 / 0.6);
  const riser = new GB();
  riser.quad([HALL.x0, ENTRY_Y, nz], [HALL.x1, ENTRY_Y, nz], [HALL.x1, 0, nz], [HALL.x0, 0, nz], [0, 0, 1], [0, 0], [1, 0], [1, 0.1], [0, 0.1]);
  flatDown(c, HALL.x0, HALL.x1, HALL.z0 - T / 2, HALL.z1, H, 1, 1);
  flatDown(c, ENTRY.x0, ENTRY.x1, ENTRY.z0, ENTRY.z1, H, 1, 1);
  LEVEL.group.add(new THREE.Mesh(w.geo(), MAT.homeWall), new THREE.Mesh(e.geo(), MAT.entryWall), new THREE.Mesh(f.geo(), MAT.wood), new THREE.Mesh(t.geo(), MAT.tile), new THREE.Mesh(c.geo(), MAT.homeCeil), new THREE.Mesh(riser.geo(), MAT.wood));
}

// ── 집 문 ──
function makeDoorLeaf(wd, ht, tex, handleCol, dark) {
  const g = new THREE.Group();
  const leafGeo = new THREE.BoxGeometry(wd, ht, 0.045); leafGeo.translate(wd / 2, ht / 2, 0);
  const mat = envMat({ map: tex, kind: 3, dirt: 0.04 });
  const edge = envMat({ color: dark ? 0x3a2c22 : 0xe4e0d6, kind: 3, dirt: 0.02 });
  const leaf = new THREE.Mesh(leafGeo, [edge, edge, edge, edge, mat, mat]);
  g.add(leaf);
  const hm = envMat({ color: handleCol, kind: 3, dirt: 0 });
  for (const side of [-1, 1]) {
    const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 14), hm); rose.rotation.x = Math.PI / 2; rose.position.set(wd - 0.09, 1.0, side * 0.032); g.add(rose);
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.022, 0.024), hm); lever.position.set(wd - 0.14, 1.0, side * 0.055); g.add(lever);
  }
  return g;
}
const DOORS = {};
function buildDoors() {
  const inner = makeDoorLeaf(DOOR.w, DOOR.h, TEX.doorWhite, 0xb8b2a6, false);
  inner.position.set(DOOR.x - DOOR.w / 2, 0, DOOR.z);
  LEVEL.group.add(inner);
  DOORS.inner = { obj: inner, a: 0, target: 0, wall: addWall(DOOR.x - DOOR.w / 2, DOOR.x + DOOR.w / 2, DOOR.z - 0.03, DOOR.z + 0.03, -0.3, DOOR.h, 'door'), open: false };
  DOORS.innerOpenWall = addWall(DOOR.x - DOOR.w / 2 - 0.02, DOOR.x - DOOR.w / 2 + 0.06, DOOR.z - DOOR.w, DOOR.z, -0.3, DOOR.h, 'door'); DOORS.innerOpenWall.off = true;
  // 문 밑으로 새어 나오는 형광등 빛
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(DOOR.w - 0.06, 0.035), new THREE.MeshBasicMaterial({ color: 0xe9ffd8 }));
  strip.position.set(DOOR.x, 0.014, DOOR.z + 0.035); LEVEL.group.add(strip);
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 0.9), new THREE.MeshBasicMaterial({ map: TEX.glow, color: 0xcfe8c0, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
  pool.rotation.x = -Math.PI / 2; pool.position.set(DOOR.x, 0.006, DOOR.z + 0.4); LEVEL.group.add(pool);
  DOORS.strip = strip; DOORS.pool = pool;
  const front = makeDoorLeaf(FRONT.w, FRONT.h, TEX.doorDark, 0x9ea3a8, true);
  front.children[0].geometry.translate(-FRONT.w, 0, 0);
  for (let i = 1; i < front.children.length; i++) front.children[i].position.x -= FRONT.w;
  front.position.set(FRONT.x + FRONT.w / 2, ENTRY_Y, FRONT.z + 0.03);
  const lock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.24, 0.05), envMat({ color: 0x2b2c30, kind: 3, dirt: 0 }));
  lock.position.set(-FRONT.w + 0.11, 1.12, -0.045); front.add(lock);
  const lockLed = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.012), new THREE.MeshBasicMaterial({ color: 0x5dd1ff }));
  lockLed.rotation.y = Math.PI; lockLed.position.set(-FRONT.w + 0.11, 1.2, -0.071); front.add(lockLed);
  LEVEL.group.add(front);
  DOORS.front = { obj: front, a: 0, target: 0, wall: addWall(FRONT.x - FRONT.w / 2, FRONT.x + FRONT.w / 2, FRONT.z, FRONT.z + 0.07, -0.3, FRONT.h, 'door') };
  const white = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  white.position.set(FRONT.x, 1, FRONT.z + 0.9); white.rotation.y = Math.PI; LEVEL.group.add(white);
  DOORS.white = white;
}
function doorTick(d, dt, k = 3.2) {
  d.a = approach(d.a, d.target, k, dt);
  d.obj.rotation.y = d.a;
}

// ── 소품 ──
function slipperGeo() {
  const parts = [];
  for (const sx of [-1, 1]) {
    const sole = new THREE.BoxGeometry(0.1, 0.022, 0.26); sole.translate(sx * 0.065, 0.011, sx * 0.02); parts.push(sole);
    const band = G3.ell(0.052, 0.024, 0.07, 10, 6); band.translate(sx * 0.065, 0.03, 0.06 + sx * 0.02); parts.push(band);
  }
  return mergeGeos(parts);
}
function shoePair(x, z, yaw, col, sole, kind) {
  const g = new THREE.Group();
  const m = toonLit(col, {}, 'toonlit'), s = toonLit(sole, {}, 'toonlit');
  for (const sx of [-1, 1]) {
    const shoe = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), m);
    if (kind === 'slipper') {
      body.scale.set(0.05, 0.022, 0.12); body.position.set(0, 0.03, 0.03);
      const sl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.022, 0.26), s); sl.position.y = 0.011; shoe.add(sl);
    } else {
      body.scale.set(0.052, 0.05, 0.13); body.position.set(0, 0.05, 0);
      const sl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.024, 0.27), s); sl.position.y = 0.012; shoe.add(sl);
    }
    shoe.add(body);
    shoe.position.set(sx * 0.065, 0, sx * 0.02); shoe.rotation.y = sx * 0.06;
    g.add(shoe);
  }
  g.position.set(x, floorAt(x, z), z); g.rotation.y = yaw;
  LEVEL.group.add(g);
  return g;
}
function buildProps() {
  // 집 현관: 신발장, 신발, 우산, 옆방 문, 액자, 스위치, 천장 등
  const cab = new GB();
  boxSides(cab, 17.3, ENTRY.x1, ENTRY.z0 + 0.04, ENTRY.z1 - 0.04, ENTRY_Y, 2.1, 'w', 1, 1);
  const cabGeo = cab.geo();
  { const uv = cabGeo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - (ENTRY.z0 + 0.04)) / (ENTRY.z1 - ENTRY.z0 - 0.08), (uv.getY(i) - ENTRY_Y) / (2.1 - ENTRY_Y)); }
  LEVEL.group.add(new THREE.Mesh(cabGeo, envMat({ map: TEX.cabinet, kind: 0, floorY: ENTRY_Y, ceilY: HOME_CEIL, dirt: 0.03 })));
  const cabTop = new GB(); boxSides(cabTop, 17.3, ENTRY.x1, ENTRY.z0 + 0.04, ENTRY.z1 - 0.04, ENTRY_Y, 2.1, 'ns');
  flatDown(cabTop, 17.3, ENTRY.x1, ENTRY.z0 + 0.04, ENTRY.z1 - 0.04, 2.1, 1, 1);
  LEVEL.group.add(new THREE.Mesh(cabTop.geo(), MAT.trim));
  addWall(17.3, ENTRY.x1, ENTRY.z0 + 0.04, ENTRY.z1 - 0.04, -0.3, 2.1, 'cab');
  shoePair(15.62, 36.05, 0.15, 0xf2f2f2, 0x9aa0ab, 'sneaker');
  shoePair(16.05, 35.65, -0.4, 0x2a2a2e, 0x111111, 'shoe');
  shoePair(16.95, 36.1, 0.05, 0xc44a3a, 0xeeeeee, 'sneaker');
  shoePair(16.15, 34.0, Math.PI, 0x8a96a8, 0x5d6672, 'slipper');
  shoePair(16.85, 34.02, Math.PI + 0.1, 0x8a96a8, 0x5d6672, 'slipper');
  const umb = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.95, 8), toonLit(0x333333)); shaft.position.y = 0.47; umb.add(shaft);
  const cloth = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.7, 10), toonLit(0x2c4f7c)); cloth.position.y = 0.45; cloth.rotation.x = Math.PI; umb.add(cloth);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.012, 6, 12, Math.PI), toonLit(0x5a3a22)); hook.position.y = 0.95; umb.add(hook);
  umb.position.set(15.42, ENTRY_Y, 36.33); umb.rotation.z = -0.12; umb.rotation.x = 0.1; LEVEL.group.add(umb);
  const side = makeDoorLeaf(0.86, 2.0, TEX.doorWhite, 0xb8b2a6, false);
  side.rotation.y = Math.PI / 2; side.position.set(HALL.x0 + 0.025, 0, 32.9); LEVEL.group.add(side);
  const trimG = new GB(), sx = HALL.x0 + 0.006;
  for (const [z0, z1, y0, y1] of [[32.04 - 0.07, 32.04, 0, 2.07], [32.9, 32.97, 0, 2.07], [32.04 - 0.07, 32.97, 2.0, 2.07]]) trimG.quad([sx, y0, z0], [sx, y0, z1], [sx, y1, z1], [sx, y1, z0], [1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  LEVEL.group.add(new THREE.Mesh(trimG.geo(), MAT.trim));
  const pic = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.39), envMat({ map: TEX.painting, kind: 3, dirt: 0 }));
  pic.rotation.y = -Math.PI / 2; pic.position.set(HALL.x1 - 0.012, 1.5, 32.4); LEVEL.group.add(pic);
  const sw = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.08), MAT.trim); sw.position.set(ENTRY.x0 + 0.01, 1.2, 34.55); LEVEL.group.add(sw);
  LEVEL.lampMeshes = [];
  for (const [z, f] of [[32.2, LEVEL.hallLamp], [35.4, LEVEL.entryLamp]]) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 24), new THREE.MeshBasicMaterial({ color: 0xdddddd }));
    m.position.set(16.5, HOME_CEIL - 0.015, z); LEVEL.group.add(m);
    LEVEL.lampMeshes.push({ m, f });
  }
  buildDoors();
  // 복도: 방문 앞 슬리퍼·택배·쓰레기봉투, 벽의 소화기
  const R = rng(303);
  const slippers = makeInst(slipperGeo(), toonLit(0xffffff), 80);
  const boxes = makeInst(new THREE.BoxGeometry(1, 1, 1), envMat({ map: TEX.box, kind: 3, dirt: 0.1 }), 40);
  const bagGeo = mergeGeos([G3.ell(0.22, 0.26, 0.2, 12, 8), (() => { const g = G3.ell(0.06, 0.08, 0.05, 8, 5); g.translate(0, 0.28, 0); return g; })()]);
  const bags = makeInst(bagGeo, toonLit(0xffffff), 40, true);
  const extGeo = mergeGeos([(() => { const g = new THREE.CylinderGeometry(0.08, 0.08, 0.5, 12); g.translate(0, 0.25, 0); return g; })(), (() => { const g = new THREE.CylinderGeometry(0.03, 0.05, 0.08, 10); g.translate(0, 0.54, 0); return g; })()]);
  const exts = makeInst(extGeo, toonLit(0xd8322e), 12, true);
  const SLIP = ['#8a96a8', '#d65a5a', '#3d6fb5', '#f0f0f0', '#e2b84a', '#5e9a5e', '#2c2c32'];
  for (const g of LEVEL.gdoors) {
    if (!g.num) continue;
    const ax = g.u[0], az = g.u[1], cx = g.cx, cz = g.cz;
    const awayX = -g.n[0], awayZ = -g.n[1];
    // 문 옆 (경첩 반대편 쪽으로 조금 비켜서)
    const sideOff = (g.left !== false ? 1 : -1) * 0.75;
    const px = (g.axis === 'x' ? cx + sideOff : cx) - awayX * 0.2, pz = (g.axis === 'x' ? cz : cz + sideOff) - awayZ * 0.2;
    const v = R();
    const yawIn = Math.atan2(-awayX, -awayZ);
    if (v < 0.42) slippers.add(trs(px + (R() - 0.5) * 0.1, 0, pz + (R() - 0.5) * 0.1, yawIn + (R() - 0.5) * 0.4), pick(SLIP));
    else if (v < 0.6) { const s = 0.28 + R() * 0.2; boxes.add(trs(px, s * 0.32, pz, R() * 0.6 - 0.3, s * 1.2, s * 0.64, s), undefined); }
    else if (v < 0.72) bags.add(trs(px, 0.24, pz, R() * TAU, 1, 0.95 + R() * 0.15, 1), R() < 0.6 ? '#f1ecd2' : '#e9df9a');
  }
  for (const [x, z] of [[3.6, 22.55], [31.7, 15.2], [1.3, 8.3], [26.9, 1.0], [15.95, 19.0], [21.0, 2.6]]) exts.add(trs(x, 0, z));
  for (const inst of [slippers, boxes, bags, exts]) { inst.m.instanceMatrix.needsUpdate = true; if (inst.m.instanceColor) inst.m.instanceColor.needsUpdate = true; }
  // 탄약 상자
  const ammoMat = [envMat({ map: TEX.ammo, kind: 3, dirt: 0 }), envMat({ map: TEX.ammo, kind: 3, dirt: 0 }), envMat({ color: 0x3f6b3c, kind: 3, dirt: 0 }), envMat({ color: 0x2c4a2a, kind: 3, dirt: 0 }), envMat({ map: TEX.ammo, kind: 3, dirt: 0 }), envMat({ map: TEX.ammo, kind: 3, dirt: 0 })];
  const ammoGeo = new THREE.BoxGeometry(0.34, 0.17, 0.22);
  for (const [x, z, n] of [[29.0, 15.1, 18], [24.6, 13.2, 18], [8.4, 8.0, 18], [26.2, 1.2, 18], [2.0, 12.8, 18], [31.3, 21.0, 18], [12.0, 22.5, 18]]) {
    const m = new THREE.Mesh(ammoGeo, ammoMat);
    m.position.set(x, 0.085, z); m.rotation.y = R() * TAU; LEVEL.group.add(m);
    LEVEL.ammo.push({ m, x, z, taken: false, n });
  }
  // 산탄총: 끝방 침대 위
  const gun = makeShotgunModel(true);
  const gb = LEVEL.gunBed;
  gun.position.set(gb.x + 0.05, gb.top + 0.07, gb.z - 0.1);
  gun.rotation.set(0, 0.25, Math.PI / 2);
  LEVEL.group.add(gun);
  const spark = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.glow, color: 0xfff3c4, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  spark.scale.set(0.5, 0.5, 1); spark.position.copy(gun.position).add(_v.set(0, 0.12, 0)); LEVEL.group.add(spark);
  LEVEL.gun = { m: gun, spark, x: gun.position.x, z: gun.position.z, taken: false };
}
// 산탄총 모양 (바닥에 놓인 것과 손에 든 것 모두)
function makeShotgunModel(world, noStock = false) {
  const g = new THREE.Group();
  const mk = world ? (c) => toonLit(c) : (c) => new THREE.MeshToonMaterial({ color: c, gradientMap: GRAD });
  const outM = world ? OUT_LIT : VM_OUT;
  const metal = mk(0x3a3942), metalHi = mk(0x767884), wood = mk(0x8a4f2a), woodDk = mk(0x5e341c);
  const part = (geo, mat, x, y, z, outline = true) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); if (outline) m.add(new THREE.Mesh(geo, outM)); return m; };
  const barrel = new THREE.CylinderGeometry(0.022, 0.022, 0.62, 12); barrel.rotateX(Math.PI / 2);
  part(barrel, metalHi, 0, 0.035, -0.42);
  const tube = new THREE.CylinderGeometry(0.019, 0.019, 0.5, 10); tube.rotateX(Math.PI / 2);
  part(tube, metal, 0, -0.012, -0.37);
  part(new THREE.BoxGeometry(0.052, 0.082, 0.24), metal, 0, 0.012, -0.03);
  const pump = new THREE.CylinderGeometry(0.034, 0.034, 0.2, 12); pump.rotateX(Math.PI / 2);
  const pm = part(pump, wood, 0, -0.008, -0.36);
  const grip = new THREE.BoxGeometry(0.042, 0.11, 0.07); grip.rotateX(-0.4);
  part(grip, woodDk, 0, -0.06, 0.09);
  if (!noStock) { const stock = new THREE.BoxGeometry(0.05, 0.09, 0.3); stock.rotateX(0.12); part(stock, wood, 0, -0.035, 0.27); }
  part(new THREE.BoxGeometry(0.012, 0.016, 0.012), metalHi, 0, 0.066, -0.7, false);
  g.userData.pump = pm;
  return g;
}

// ── 충돌 격자 ──
const HASH = { cs: 1.5, x0: -2, z0: -2, nx: 26, nz: 28, cells: [] };
function hashBuild() {
  HASH.cells = Array.from({ length: HASH.nx * HASH.nz }, () => []);
  WALLS.forEach((w, idx) => {
    const i0 = Math.floor((w.x0 - HASH.x0) / HASH.cs), i1 = Math.floor((w.x1 - HASH.x0) / HASH.cs);
    const j0 = Math.floor((w.z0 - HASH.z0) / HASH.cs), j1 = Math.floor((w.z1 - HASH.z0) / HASH.cs);
    for (let j = Math.max(0, j0); j <= Math.min(HASH.nz - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(HASH.nx - 1, i1); i++) HASH.cells[j * HASH.nx + i].push(idx);
  });
}
const _hseen = new Uint32Array(8192); let _hstamp = 1;
function collideCircle(p, r, yLo = 0.1, yHi = 1.6) {
  _hstamp++;
  const i0 = Math.floor((p.x - r - HASH.x0) / HASH.cs), i1 = Math.floor((p.x + r - HASH.x0) / HASH.cs);
  const j0 = Math.floor((p.z - r - HASH.z0) / HASH.cs), j1 = Math.floor((p.z + r - HASH.z0) / HASH.cs);
  let hit = false;
  for (let j = Math.max(0, j0); j <= Math.min(HASH.nz - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(HASH.nx - 1, i1); i++) {
    for (const idx of HASH.cells[j * HASH.nx + i]) {
      if (_hseen[idx] === _hstamp) continue; _hseen[idx] = _hstamp;
      const w = WALLS[idx];
      if (w.off || w.y1 < yLo || w.y0 > yHi) continue;
      const cx = clamp(p.x, w.x0, w.x1), cz = clamp(p.z, w.z0, w.z1);
      let dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 < 1e-10) {
        const l = p.x - w.x0, rr = w.x1 - p.x, t = p.z - w.z0, b = w.z1 - p.z, m = Math.min(l, rr, t, b);
        if (m === l) p.x = w.x0 - r; else if (m === rr) p.x = w.x1 + r; else if (m === t) p.z = w.z0 - r; else p.z = w.z1 + r;
      } else {
        const d = Math.sqrt(d2), push = r - d;
        p.x += dx / d * push; p.z += dz / d * push;
      }
      hit = true;
    }
  }
  return hit;
}
// 총알·시야: 격자 칸을 따라가며 가까운 상자부터
const RAY = { t: 0, nx: 0, ny: 0, nz: 0, wall: null, hit: false, surf: '' };
function rayWalls(ox, oy, oz, dx, dy, dz, maxT) {
  let best = maxT, axis = -1, bw = null;
  _hstamp++;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  let i = Math.floor((ox - HASH.x0) / HASH.cs), j = Math.floor((oz - HASH.z0) / HASH.cs);
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx), adz = Math.abs(dz);
  const tdx = adx > 1e-9 ? HASH.cs / adx : 1e9, tdz = adz > 1e-9 ? HASH.cs / adz : 1e9;
  let tmx = adx > 1e-9 ? (dx > 0 ? (HASH.x0 + (i + 1) * HASH.cs - ox) : (ox - (HASH.x0 + i * HASH.cs))) / adx : 1e9;
  let tmz = adz > 1e-9 ? (dz > 0 ? (HASH.z0 + (j + 1) * HASH.cs - oz) : (oz - (HASH.z0 + j * HASH.cs))) / adz : 1e9;
  for (let guard = 0; guard < 80; guard++) {
    if (i >= 0 && j >= 0 && i < HASH.nx && j < HASH.nz) {
      for (const idx of HASH.cells[j * HASH.nx + i]) {
        if (_hseen[idx] === _hstamp) continue; _hseen[idx] = _hstamp;
        const w = WALLS[idx];
        if (w.off) continue;
        const lo = [w.x0, w.y0, w.z0], hi = [w.x1, w.y1, w.z1];
        let tmin = 0, tmax = best, ax = -1, miss = false;
        for (let a = 0; a < 3; a++) {
          if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) { miss = true; break; } continue; }
          let t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a];
          if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
          if (t1 > tmin) { tmin = t1; ax = a; }
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) { miss = true; break; }
        }
        if (miss || ax < 0) continue;
        if (tmin > 0.0001 && tmin < best) { best = tmin; axis = ax; bw = w; }
      }
    }
    const tNext = Math.min(tmx, tmz);
    if (best <= tNext || tNext > maxT) break;
    if (tmx < tmz) { i += sx; tmx += tdx; } else { j += sz; tmz += tdz; }
  }
  RAY.surf = bw ? (bw.kind === 'door' || bw.kind === 'gdoor' ? 'door' : 'wall') : '';
  if (dy < -1e-6) {
    let t = -oy / dy;
    if (oz + dz * t >= ENTRY.z0) t = (ENTRY_Y - oy) / dy;
    if (t > 0 && t < best) { best = t; axis = 4; bw = null; RAY.surf = 'floor'; }
  } else if (dy > 1e-6) {
    let t = (CEIL - oy) / dy;
    if (oz + dz * t >= 30) t = (HOME_CEIL - oy) / dy;
    if (t > 0 && t < best) { best = t; axis = 5; bw = null; RAY.surf = 'ceil'; }
  }
  RAY.t = best; RAY.wall = bw; RAY.hit = axis >= 0;
  RAY.nx = axis === 0 ? (dx > 0 ? -1 : 1) : 0;
  RAY.ny = axis === 1 ? (dy > 0 ? -1 : 1) : axis === 4 ? 1 : axis === 5 ? -1 : 0;
  RAY.nz = axis === 2 ? (dz > 0 ? -1 : 1) : 0;
  return RAY;
}
function losClear(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz);
  if (L < 1e-4) return true;
  rayWalls(ax, ay, az, dx / L, dy / L, dz / L, L);
  return RAY.t >= L - 0.02;
}

// ── 길찾기 격자 (0.5m) ──
const NAV = { cs: 0.5, x0: -1.5, z0: -1.5, nx: 72, nz: 79 };
NAV.block = new Uint8Array(NAV.nx * NAV.nz);
NAV.shut = new Uint8Array(NAV.nx * NAV.nz);
NAV.dist = new Int16Array(NAV.nx * NAV.nz);
NAV.q = new Int32Array(NAV.nx * NAV.nz);
NAV.src = -1;
function buildNav() {
  const pad = 0.3;
  const rects = GOSI.regions.map((r) => r.rect);
  for (let j = 0; j < NAV.nz; j++) for (let i = 0; i < NAV.nx; i++) {
    const x = NAV.x0 + (i + 0.5) * NAV.cs, z = NAV.z0 + (j + 0.5) * NAV.cs;
    let inside = (x > HALL.x0 && x < HALL.x1 && z > 29.9 && z < HALL.z1) || (x > ENTRY.x0 && x < ENTRY.x1 && z >= HALL.z1 && z < ENTRY.z1);
    // 구역 경계에 칸 중심이 딱 걸려도 걸을 수 있게 (경계는 포함)
    if (!inside) for (const r of rects) if (x >= r[0] && x <= r[2] && z >= r[1] && z <= r[3]) { inside = true; break; }
    let b = inside ? 0 : 1;
    if (!b) for (const w of WALLS) {
      if (w.kind === 'lintel' || w.kind === 'door' || w.kind === 'gdoor') continue;
      if (w.y0 > 1.0) continue;
      if (x > w.x0 - pad && x < w.x1 + pad && z > w.z0 - pad && z < w.z1 + pad) { b = 1; break; }
    }
    if (Math.abs(x - DOOR.x) < DOOR.w / 2 && Math.abs(z - DOOR.z) < 0.45) b = 0;
    NAV.block[j * NAV.nx + i] = b;
  }
  // 고시원 문틈: 문 한가운데 줄은 막히지 않게 (닫힌 문은 shut으로 막음)
  const allDoors = GOSI.rooms.map((r) => r.door).concat(GOSI.specialDoors);
  for (const d of allDoors) {
    const cells = navDoorLine(d);
    for (const k of cells) NAV.block[k] = 0;
    const g = LEVEL.gdoors.find((q) => q.x0 === d.x0 && q.z0 === d.z0);
    if (g) g.navCells = cells;
  }
  NAV.ready = true;
  for (const g of LEVEL.gdoors) if (g.a < 0.9) navDoorShut(g, true, true);
}
function navDoorLine(d) {
  const out = [];
  if (d.axis === 'x') {
    const cx = (d.x0 + d.x1) / 2;
    for (let z = Math.min(d.z0, d.z1) - 0.55; z <= Math.max(d.z0, d.z1) + 0.55; z += 0.25) { const k = navIdx(cx, z); if (k >= 0 && !out.includes(k)) out.push(k); }
  } else {
    const cz = (d.z0 + d.z1) / 2;
    for (let x = Math.min(d.x0, d.x1) - 0.55; x <= Math.max(d.x0, d.x1) + 0.55; x += 0.25) { const k = navIdx(x, cz); if (k >= 0 && !out.includes(k)) out.push(k); }
  }
  return out;
}
function navDoorShut(g, shut, force = false) {
  if (!g.navCells) return;
  if (g.navShut === shut) return;
  g.navShut = shut;
  // 문틀 가운데 칸(벽 두께 안)만 막는다
  const mid = g.navCells.filter((k) => { const x = NAV.x0 + (k % NAV.nx + 0.5) * NAV.cs, z = NAV.z0 + (((k / NAV.nx) | 0) + 0.5) * NAV.cs; return g.axis === 'x' ? Math.abs(z - (g.z0 + g.z1) / 2) < 0.26 : Math.abs(x - (g.x0 + g.x1) / 2) < 0.26; });
  for (const k of mid) NAV.shut[k] = Math.max(0, NAV.shut[k] + (shut ? 1 : -1));
  NAV.src = -1;
}
function navIdx(x, z) { const i = Math.floor((x - NAV.x0) / NAV.cs), j = Math.floor((z - NAV.z0) / NAV.cs); if (i < 0 || j < 0 || i >= NAV.nx || j >= NAV.nz) return -1; return j * NAV.nx + i; }
function navFree(k) { return k >= 0 && !NAV.block[k] && !NAV.shut[k] && !(NAV.doorBlock && NAV.doorSet.has(k)); }
NAV.doorSet = new Set();
NAV.doorBlock = true;
function navDoorCells() {
  NAV.doorSet.clear();
  for (let x = DOOR.x - 0.6; x <= DOOR.x + 0.6; x += 0.25) for (let z = DOOR.z - 0.3; z <= DOOR.z + 0.3; z += 0.25) { const k = navIdx(x, z); if (k >= 0) NAV.doorSet.add(k); }
}
function navNearestFree(k) {
  if (navFree(k)) return k;
  const i0 = k % NAV.nx, j0 = (k / NAV.nx) | 0;
  for (let r = 1; r < 4; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) { const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= NAV.nx || j >= NAV.nz) continue; const kk = j * NAV.nx + i; if (navFree(kk)) return kk; }
  return k;
}
function navBFS(x, z) {
  let s = navIdx(x, z); if (s < 0) return;
  s = navNearestFree(s);
  if (s === NAV.src) return;
  NAV.src = s;
  const d = NAV.dist, q = NAV.q, nx = NAV.nx;
  d.fill(-1);
  let h = 0, t = 0; q[t++] = s; d[s] = 0;
  while (h < t) {
    const k = q[h++], i = k % nx, j = (k / nx) | 0, dk = d[k] + 2;
    const fl = i > 0 && navFree(k - 1), fr = i < nx - 1 && navFree(k + 1), fu = j > 0 && navFree(k - nx), fd = j < NAV.nz - 1 && navFree(k + nx);
    if (fl && d[k - 1] < 0) { d[k - 1] = dk; q[t++] = k - 1; }
    if (fr && d[k + 1] < 0) { d[k + 1] = dk; q[t++] = k + 1; }
    if (fu && d[k - nx] < 0) { d[k - nx] = dk; q[t++] = k - nx; }
    if (fd && d[k + nx] < 0) { d[k + nx] = dk; q[t++] = k + nx; }
    const dd = d[k] + 3;
    if (fl && fu && navFree(k - nx - 1) && d[k - nx - 1] < 0) { d[k - nx - 1] = dd; q[t++] = k - nx - 1; }
    if (fr && fu && navFree(k - nx + 1) && d[k - nx + 1] < 0) { d[k - nx + 1] = dd; q[t++] = k - nx + 1; }
    if (fl && fd && navFree(k + nx - 1) && d[k + nx - 1] < 0) { d[k + nx - 1] = dd; q[t++] = k + nx - 1; }
    if (fr && fd && navFree(k + nx + 1) && d[k + nx + 1] < 0) { d[k + nx + 1] = dd; q[t++] = k + nx + 1; }
  }
}
const _dir = { x: 0, z: 0, d: -1 };
function navDir(x, z) {
  const k = navIdx(x, z);
  _dir.x = 0; _dir.z = 0; _dir.d = -1;
  if (k < 0) return _dir;
  const nx = NAV.nx, i = k % nx, j = (k / nx) | 0;
  let best = NAV.dist[k] >= 0 ? NAV.dist[k] : 1e9, bk = -1;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (!di && !dj) continue;
    const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= NAV.nz) continue;
    const kk = jj * nx + ii, dv = NAV.dist[kk];
    if (dv < 0) continue;
    if (di && dj && (!navFree(j * nx + ii) || !navFree(jj * nx + i))) continue;
    if (dv < best) { best = dv; bk = kk; }
  }
  _dir.d = NAV.dist[k];
  if (bk < 0) return _dir;
  const tx = NAV.x0 + (bk % nx + 0.5) * NAV.cs, tz = NAV.z0 + (((bk / nx) | 0) + 0.5) * NAV.cs;
  const L = Math.hypot(tx - x, tz - z) || 1;
  _dir.x = (tx - x) / L; _dir.z = (tz - z) / L;
  return _dir;
}


// ───────────────────────── 외로운 사람들 ─────────────────────────
const C = { HIP_Y: 0.52, TORSO_H: 0.39, HEAD_R: 0.3, HEAD_UP: 0.262, SH_X: 0.2, SH_Y: 0.33, UARM: 0.19, FARM: 0.17, HIP_X: 0.095, THIGH: 0.22, SHIN: 0.22 };
const MAXA = 34, MAXD = 70;
const G3 = {
  sphere: (r, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h),
  ell: (sx, sy, sz, w = 16, h = 12) => { const g = new THREE.SphereGeometry(1, w, h); g.scale(sx, sy, sz); return g; },
  cap: (r, len, rs = 12) => new THREE.CapsuleGeometry(r, len, 5, rs),
};
function mergeGeos(geos) {
  let vc = 0, ic = 0;
  for (const g of geos) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i); pos[(vo + i) * 3 + 1] = p.getY(i); pos[(vo + i) * 3 + 2] = p.getZ(i);
      nor[(vo + i) * 3] = n.getX(i); nor[(vo + i) * 3 + 1] = n.getY(i); nor[(vo + i) * 3 + 2] = n.getZ(i);
      if (u) { uv[(vo + i) * 2] = u.getX(i); uv[(vo + i) * 2 + 1] = u.getY(i); }
    }
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo; io += g.index.count; }
    else { for (let i = 0; i < p.count; i++) idx[io + i] = vo + i; io += p.count; }
    vo += p.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  m.setIndex(new THREE.BufferAttribute(idx, 1));
  m.computeBoundingSphere();
  return m;
}
function headGeo(r, ws = 28, hs = 20) {
  const front = new THREE.SphereGeometry(r, ws, hs, 0, Math.PI);
  const back = new THREE.SphereGeometry(r, ws, hs, Math.PI, Math.PI);
  const fp = front.attributes.position, fu = front.attributes.uv;
  for (let i = 0; i < fp.count; i++) fu.setXY(i, 0.5 + fp.getX(i) / (2 * r) * 0.98, 0.5 + fp.getY(i) / (2 * r) * 0.98);
  const bu = back.attributes.uv;
  for (let i = 0; i < bu.count; i++) bu.setXY(i, 0.03, 0.97);
  return mergeGeos([front, back]);
}
function noisify(g, amt, f1, f2) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = 1 + amt * Math.sin(x * f1 + y * 13.1) * Math.cos(z * f2 - y * 7.7);
    p.setXYZ(i, x * n, y * n, z * n);
  }
  g.computeVertexNormals();
  return g;
}
function crowdHairGeo(r) {
  const parts = [];
  const back = new THREE.SphereGeometry(r * 1.06, 20, 12, Math.PI / 2 + 1.0, TAU - 2.0, 0, Math.PI * 0.6);
  const front = new THREE.SphereGeometry(r * 1.07, 10, 6, Math.PI / 2 - 1.02, 2.04, 0, Math.PI * 0.27);
  noisify(back, 0.04, 31, 27); noisify(front, 0.035, 29, 23);
  parts.push(back, front);
  for (const [a, h, tilt] of [[-0.5, 0.55, 0.22], [-0.18, 0.62, 0.0], [0.15, 0.6, -0.15], [0.48, 0.52, 0.3]]) {
    const st = G3.ell(0.055, 0.12, 0.045, 8, 5);
    st.rotateZ(tilt); st.rotateX(-0.35);
    st.translate(Math.sin(a) * r * 0.82, r * h, Math.cos(a) * r * 0.86);
    parts.push(st);
  }
  for (const [x, z, rz] of [[0.04, -0.05, -0.5], [-0.07, 0.02, 0.6], [0.09, 0.05, -0.2]]) {
    const c = new THREE.ConeGeometry(0.045, 0.14, 5); c.rotateZ(rz); c.translate(x, r * 1.05, z); parts.push(c);
  }
  for (const sx of [-1, 1]) { const e = G3.ell(0.06, 0.1, 0.09, 8, 5); e.translate(sx * r * 0.93, r * 0.05, -0.02); parts.push(e); }
  const m = mergeGeos(parts);
  m.translate(0, C.HEAD_UP, 0);
  return m;
}
const CROWD_GEO = (() => {
  const torso = new THREE.CapsuleGeometry(0.17, 0.11, 5, 14); torso.scale(1.18, 1, 0.8); torso.translate(0, 0.195, 0);
  const pelvis = G3.ell(0.182, 0.12, 0.135, 14, 8);
  const head = headGeo(C.HEAD_R, 30, 22); head.translate(0, C.HEAD_UP, 0);
  const hair = crowdHairGeo(C.HEAD_R);
  const cap10 = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 10);
  const uarm = cap10(0.062, 0.12); uarm.translate(0, -0.1, 0);
  const farm = cap10(0.056, 0.1); farm.translate(0, -0.088, 0);
  const hand = G3.sphere(0.066, 12, 8); hand.translate(0, -0.035, 0);
  const thigh = cap10(0.083, 0.08); thigh.translate(0, -0.1, 0);
  const shin = cap10(0.073, 0.1); shin.translate(0, -0.1, 0);
  const shoe = G3.ell(0.078, 0.052, 0.125, 10, 7); shoe.translate(0, -0.03, 0.04);
  return { torso, pelvis, head, hair, uarm, farm, hand, thigh, shin, shoe };
})();
const CROWD_COLORS = {
  shirt: ['#e0474f', '#f08a2c', '#4fae4c', '#25a39d', '#3a7cd6', '#7a58d0', '#d1559c', '#8a8794', '#34456a', '#9c5530', '#2f2d3a', '#c95b2e', '#5b8f3a', '#ffffff'],
  pants: ['#2c3a5c', '#393a42', '#6a6e78', '#7a6a50', '#232630', '#4a5c7c'],
  shoe: ['#f1f1f1', '#2a2a2e', '#c44a3a', '#6b7888', '#e7d9bf'],
  hair: ['#1d181b', '#2b211b', '#3c2a1f', '#55392a', '#141414', '#4a3b33'],
  skin: ['#f6d0b2', '#eec09c', '#e2ac88', '#f8dac4', '#d69f7c', '#f3c9a6'],
};
const PART_DEFS = [
  ['torso', 'torso', 'shirt', 'torso'], ['pelvis', 'pelvis', 'pants', 'hips'],
  ['head', 'head', 'skin', 'neck'], ['hair', 'hair', 'hair', 'neck'],
  ['uarmL', 'uarm', 'shirt', 'shL'], ['uarmR', 'uarm', 'shirt', 'shR'],
  ['farmL', 'farm', 'shirt', 'elL'], ['farmR', 'farm', 'shirt', 'elR'],
  ['handL', 'hand', 'skin', 'wrL'], ['handR', 'hand', 'skin', 'wrR'],
  ['thighL', 'thigh', 'pants', 'hipL'], ['thighR', 'thigh', 'pants', 'hipR'],
  ['shinL', 'shin', 'pants', 'knL'], ['shinR', 'shin', 'pants', 'knR'],
  ['shoeL', 'shoe', 'shoe', 'anL'], ['shoeR', 'shoe', 'shoe', 'anR'],
];
const crowdMat = toonLit(0xffffff, {}, 'crowd-lit');
const crowdHeadMat = patchLit(new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: GRAD, map: TEX.face }), 'crowd-head-lit', false, (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aFace;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv = vMapUv * vec2(1.0 / 3.0, 0.5) + aFace;\n#endif');
});
const _white = new THREE.Color(1, 1, 1);
function makeCrowdSet(max, face) {
  const set = { parts: [], max, count: 0 };
  const hg = CROWD_GEO.head.clone();
  const af = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
  af.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < max; i++) af.setXY(i, FACE_OFF[face][0], FACE_OFF[face][1]);
  hg.setAttribute('aFace', af);
  set.aFace = af;
  for (const [name, geoKey, kind, node] of PART_DEFS) {
    const geo = name === 'head' ? hg : CROWD_GEO[geoKey];
    const m = new THREE.InstancedMesh(geo, name === 'head' ? crowdHeadMat : crowdMat, max);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < max; i++) m.setMatrixAt(i, _zeroM);
    m.setColorAt(0, _white);
    m.count = 0; m.frustumCulled = false;
    const o = new THREE.InstancedMesh(geo, OUT_LIT, max);
    o.instanceMatrix = m.instanceMatrix;
    o.count = 0; o.frustumCulled = false;
    scene.add(m, o);
    set.parts.push({ name, m, o, node, kind });
  }
  return set;
}
const CA = makeCrowdSet(MAXA, 0);
const CD = makeCrowdSet(MAXD, 3);
function setSetCount(set, n) { set.count = n; for (const part of set.parts) { part.m.count = n; part.o.count = n; } }

// 정신건강 책 (넷 중 하나가 들고 있음)
function makeCareBookTex() {
  const c = cnv(1024, 512), g = c.getContext('2d');
  const colors = ['#376da8', '#637d58'];
  for (let k = 0; k < 2; k++) {
    const x = k * 512, color = colors[k];
    g.fillStyle = color; g.fillRect(x, 0, 512, 512);
    g.fillStyle = '#f9f5e8'; g.fillRect(x + 12, 12, 232, 488);
    g.fillStyle = color; g.fillRect(x + 12, 12, 17, 488);
    g.textAlign = 'center'; g.fillStyle = '#1e2a35';
    g.font = '900 51px "Noto Sans KR", "Malgun Gothic", sans-serif';
    (k === 0 ? ['마음', '건강'] : ['건강한', '관계']).forEach((line, j) => g.fillText(line, x + 136, 171 + j * 69));
    g.strokeStyle = color; g.lineWidth = 5; g.beginPath(); g.arc(x + 135, 351, 36, 0, TAU); g.stroke();
    g.beginPath(); g.moveTo(x + 117, 352); g.quadraticCurveTo(x + 135, 375, x + 153, 352); g.stroke();
    g.fillStyle = color; g.fillRect(x + 57, 442, 155, 6);
    g.fillStyle = '#f1eadc'; g.fillRect(x + 256, 256, 256, 256);
    g.strokeStyle = '#c9bcab'; g.lineWidth = 2;
    for (let y = 263; y < 512; y += 12) { g.beginPath(); g.moveTo(x + 256, y); g.lineTo(x + 512, y); g.stroke(); }
  }
  return texOf(c);
}
const bookTex = makeCareBookTex();
const bookGeo = new THREE.BoxGeometry(0.265, 0.355, 0.065);
{
  const uv = bookGeo.attributes.uv;
  for (let face = 0; face < 6; face++) for (let j = 0; j < 4; j++) {
    const i = face * 4 + j, u = uv.getX(i), v = uv.getY(i);
    if (face === 4) uv.setXY(i, 0.02 + u * 0.22, 0.02 + v * 0.96);
    else if (face === 5) uv.setXY(i, 0.26 + u * 0.22, 0.52 + v * 0.46);
    else uv.setXY(i, 0.26 + u * 0.23, 0.02 + v * 0.46);
  }
  bookGeo.setAttribute('aBook', new THREE.InstancedBufferAttribute(new Float32Array(MAXA), 1));
}
const bookMat = patchLit(new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: GRAD, map: bookTex }), 'book-lit', false, (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aBook;')
    .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\n  vMapUv.x += aBook * 0.5;\n#endif');
});
const books = new THREE.InstancedMesh(bookGeo, bookMat, MAXA);
books.instanceMatrix.setUsage(THREE.DynamicDrawUsage); books.frustumCulled = false; books.count = MAXA;
for (let i = 0; i < MAXA; i++) books.setMatrixAt(i, _zeroM);
const booksO = new THREE.InstancedMesh(bookGeo, OUT_LIT, MAXA); booksO.instanceMatrix = books.instanceMatrix; booksO.frustumCulled = false; booksO.count = MAXA;
scene.add(books, booksO);
const _bookLocal = new THREE.Matrix4(), _bookRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.22), _bookPos = new THREE.Vector3(), _bookScale = new THREE.Vector3(1, 1, 1);

// 발밑 그림자
const blobMat = new THREE.ShaderMaterial({
  uniforms: Object.assign({ map: { value: TEX.blob } }, LU), transparent: true, depthWrite: false,
  vertexShader: `varying vec2 vUv; varying vec3 vWP; void main(){ vUv = uv; vec4 wp = modelMatrix * instanceMatrix * vec4(position,1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: LIGHT_GLSL + `uniform sampler2D map; varying vec2 vUv; varying vec3 vWP; void main(){ float L = lfAt(vWP.xz); float a = texture2D(map, vUv).r * 0.62 * clamp(L, 0.0, 1.0); gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const blobGeo = new THREE.PlaneGeometry(0.95, 0.95); blobGeo.rotateX(-Math.PI / 2);
const blobs = new THREE.InstancedMesh(blobGeo, blobMat, MAXA);
blobs.frustumCulled = false; blobs.count = MAXA; for (let i = 0; i < MAXA; i++) blobs.setMatrixAt(i, _zeroM);
scene.add(blobs);

// 리그
function mkNode(parent, x, y, z, order) { const n = new THREE.Object3D(); n.position.set(x, y, z); if (order) n.rotation.order = order; if (parent) parent.add(n); return n; }
function buildRig(D) {
  const R = {};
  R.root = mkNode(null, 0, 0, 0, 'YXZ');
  R.hips = mkNode(R.root, 0, D.HIP_Y, 0);
  R.torso = mkNode(R.hips, 0, 0.03, 0, 'YXZ');
  R.neck = mkNode(R.torso, 0, D.TORSO_H, 0, 'YXZ');
  R.shL = mkNode(R.torso, D.SH_X, D.SH_Y, 0, 'YXZ'); R.shR = mkNode(R.torso, -D.SH_X, D.SH_Y, 0, 'YXZ');
  R.elL = mkNode(R.shL, 0, -D.UARM, 0, 'XYZ'); R.elR = mkNode(R.shR, 0, -D.UARM, 0, 'XYZ');
  R.wrL = mkNode(R.elL, 0, -D.FARM, 0); R.wrR = mkNode(R.elR, 0, -D.FARM, 0);
  R.hipL = mkNode(R.hips, D.HIP_X, 0, 0, 'YXZ'); R.hipR = mkNode(R.hips, -D.HIP_X, 0, 0, 'YXZ');
  R.knL = mkNode(R.hipL, 0, -D.THIGH, 0); R.knR = mkNode(R.hipR, 0, -D.THIGH, 0);
  R.anL = mkNode(R.knL, 0, -D.SHIN, 0); R.anR = mkNode(R.knR, 0, -D.SHIN, 0);
  return R;
}
const CR = buildRig(C);
const P = { RP: 0, RR: 1, HY: 2, SX: 3, SY: 4, SZ: 5, HX: 6, HW: 7, HZ: 8, LSX: 9, LSY: 10, LSZ: 11, LEX: 12, LEZ: 13, RSX: 14, RSY: 15, RSZ: 16, REX: 17, REZ: 18, LHX: 19, LHZ: 20, LKX: 21, RHX: 22, RHZ: 23, RKX: 24, LIFT: 25 };
const NPOSE = 26;
function applyRig(R, pose, x, y, z, yaw) {
  R.root.position.set(x, y + pose[P.LIFT], z);
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

// ── 사람 ──
const persons = [];       // 인스턴스 칸 번호 = 배열 번호
const live = [];
const freeA = [];
let highA = 0, deadNext = 0, deadUsed = 0;
const F_KEYS_F = ['f_F1', 'f_F2', 'f_F3', 'f_F4', 'f_F5'], F_KEYS_M = ['f_M2', 'f_M3', 'f_M4', 'f_M5'];
const G_KEYS = ['g_F1', 'g_F3', 'g_F5', 'g_M2', 'g_M4'];
function allocAlive() {
  if (freeA.length) return freeA.pop();
  if (highA < MAXA) { const i = highA++; setSetCount(CA, highA); return i; }
  return -1;
}
function freeAlive(i) { for (const part of CA.parts) part.m.setMatrixAt(i, _zeroM); books.setMatrixAt(i, _zeroM); blobs.setMatrixAt(i, _zeroM); freeA.push(i); persons[i] = null; }
function setCrowdColors(i, cols) {
  for (const part of CA.parts) { _col.set(cols[part.kind]); part.m.setColorAt(i, _col); part.m.instanceColor.needsUpdate = true; }
}
function setFace(p, f) {
  if (p.faceSet === f) return;
  p.faceSet = f;
  CA.aFace.setXY(p.i, FACE_OFF[f][0], FACE_OFF[f][1]); CA.aFace.needsUpdate = true;
}
// kind 0 걷는 사람, 1 뛰는 사람, 2 누운 사람 (무기력해서 누운 채로 미끄러져 옴)
const LIE_SHIRT = ['#8a8794', '#5b6b7c', '#4f5d4a', '#9c8f7a', '#3f4656', '#b8b2a6', '#6d5a72'], LIE_PANTS = ['#6a6e78', '#393a42', '#4a4f5c', '#55524c'];
function newPerson(x, z, opt = {}) {
  const i = allocAlive();
  if (i < 0) return null;
  const kind = opt.kind || 0, female = Math.random() < 0.5;
  const p = {
    i, x, z, y: floorAt(x, z) + (opt.yOff || 0), yOff: opt.yOff || 0, vx: 0, vz: 0, yaw: opt.yaw === undefined ? rand(0, TAU) : opt.yaw,
    state: opt.state || 'chase', kind, idle: opt.idle || 0,
    speed: kind === 1 ? rand(3.0, 3.6) : kind === 2 ? rand(1.9, 2.3) : rand(1.25, 1.65) * (opt.fast || 1), spd: 0,
    phase: rand(0, TAU), seed: rand(0, 100),
    pose: new Float32Array(NPOSE), tgt: new Float32Array(NPOSE), tmp: new Float32Array(NPOSE),
    reach: 0, rise: opt.state === 'idle' ? 0 : 1, look: 0, hp: kind === 1 ? 70 : kind === 2 ? 140 : 100,
    faceSet: -1, speakCD: rand(0.4, 2.2), vo: null, voiceKey: kind === 1 ? pick(G_KEYS) : pick(female ? F_KEYS_F : F_KEYS_M), vrate: kind === 2 ? rand(0.7, 0.78) : rand(0.93, 1.07),
    slot: -1, clingT: 0, ca: 0, cr: 0.5, dieT: 0, fallT: 0.5, back: true, fallRoll: 0, fly: 0, corpse: null, landed: false, how: '',
    noticeT: -1, losT: rand(0, 0.2), los: false, stagger: 0, kbx: 0, kbz: 0, dirx: 0, dirz: 0,
    tearT: rand(0, 0.5), book: kind !== 2 && Math.random() < 0.25, bookCover: Math.random() < 0.5 ? 0 : 1, dragLv: 0,
    skew: kind === 2 ? (Math.random() < 0.5 ? -1 : 1) * rand(0.6, 0.85) : 0,   // 누운 사람은 비스듬히 누운 채 미끄러진다
    hc: new THREE.Vector3(x, 1.2, z), ta: new THREE.Vector3(), tb: new THREE.Vector3(), la: new THREE.Vector3(), lb: new THREE.Vector3(),
    e1: new THREE.Vector3(), e2: new THREE.Vector3(),
  };
  persons[i] = p;
  if (kind === 2) setCrowdColors(i, { shirt: pick(LIE_SHIRT), pants: pick(LIE_PANTS), shoe: pick(['#d9d4c7', '#6b7888', '#2a2a2e']), hair: pick(CROWD_COLORS.hair), skin: pick(CROWD_COLORS.skin) });
  else setCrowdColors(i, { shirt: pick(CROWD_COLORS.shirt), pants: pick(CROWD_COLORS.pants), shoe: pick(CROWD_COLORS.shoe), hair: pick(CROWD_COLORS.hair), skin: pick(CROWD_COLORS.skin) });
  books.geometry.attributes.aBook.setX(i, p.bookCover); books.geometry.attributes.aBook.needsUpdate = true;
  setFace(p, 0);
  computePose(p, 0, p.pose);
  live.push(p);
  return p;
}
function addCorpse(p) {
  const d = deadNext; deadNext = (deadNext + 1) % MAXD; deadUsed = Math.min(MAXD, deadUsed + 1);
  const hsl = {};
  for (let k = 0; k < CA.parts.length; k++) {
    const a = CA.parts[k].m, b = CD.parts[k].m;
    a.getMatrixAt(p.i, _m4); b.setMatrixAt(d, _m4);
    a.getColorAt(p.i, _col); _col.getHSL(hsl); _col.setHSL(hsl.h, hsl.s * 0.7, hsl.l * 0.85); b.setColorAt(d, _col);
    b.instanceMatrix.needsUpdate = true; b.instanceColor.needsUpdate = true;
  }
  setSetCount(CD, deadUsed);
}
function clearCrowd() {
  for (const p of live) if (p.vo) p.vo.stop(0.05);
  for (const set of [CA, CD]) {
    for (const part of set.parts) { for (let i = 0; i < set.max; i++) part.m.setMatrixAt(i, _zeroM); part.m.instanceMatrix.needsUpdate = true; }
    setSetCount(set, 0);
  }
  for (let i = 0; i < MAXA; i++) { books.setMatrixAt(i, _zeroM); blobs.setMatrixAt(i, _zeroM); }
  books.instanceMatrix.needsUpdate = true; blobs.instanceMatrix.needsUpdate = true;
  live.length = 0; persons.length = 0; freeA.length = 0; highA = 0; deadNext = 0; deadUsed = 0;
}

// ── 자세 (본편과 같은 몸짓) ──
function lookAtMe(p, o, w) {
  const dx = PL.x - p.x, dz = PL.z - p.z, dist = Math.hypot(dx, dz) || 0.001;
  const headY = p.state === 'idle' ? 0.9 : 1.2;
  const rel = wrapAngle(Math.atan2(dx, dz) - p.yaw - o[P.SY]);
  const hw = clamp(rel, -1.15, 1.15);
  const pitch = -Math.atan2(PL.eye - headY - p.y, dist) - 0.06 - o[P.SX];
  o[P.HW] = lerp(o[P.HW], hw, w);
  o[P.HX] = lerp(o[P.HX], clamp(pitch, -1.0, 0.8), w);
}
function poseIdle(p, t, o) {
  o.fill(0); o[P.HY] = C.HIP_Y;
  const hic = Math.pow(Math.max(0, Math.sin(t * 5.1 + p.seed * 3)), 3);
  const side = (p.seed % 2) < 1 ? 1 : -1;
  if (p.idle === 0) {
    o[P.HY] = C.HIP_Y - 0.012;
    o[P.SX] = 0.4 + hic * 0.07; o[P.HX] = 0.6 + hic * 0.1; o[P.HZ] = side * 0.14;
    o[P.LSX] = -0.3; o[P.RSX] = -0.3; o[P.LSZ] = 0.04; o[P.RSZ] = -0.04; o[P.LEX] = -0.15; o[P.REX] = -0.15;
    o[P.LHX] = -0.05; o[P.RHX] = -0.05; o[P.LKX] = 0.1; o[P.RKX] = 0.1;
  } else if (p.idle === 1) {
    o[P.HY] = 0.15; o[P.RP] = -0.1;
    o[P.LHX] = -1.95; o[P.RHX] = -1.95; o[P.LHZ] = 0.1; o[P.RHZ] = -0.1; o[P.LKX] = 2.5; o[P.RKX] = 2.5;
    o[P.SX] = 0.66 + hic * 0.06; o[P.HX] = 0.7; o[P.HZ] = side * 0.18;
    o[P.LSX] = -0.95; o[P.RSX] = -0.95; o[P.LSY] = -0.35; o[P.RSY] = 0.35; o[P.LEX] = -0.5; o[P.REX] = -0.5; o[P.LEZ] = -0.75; o[P.REZ] = 0.75;
  } else if (p.idle === 2) {
    o[P.HY] = 0.24;
    o[P.LHX] = -1.7; o[P.RHX] = -1.7; o[P.LHZ] = 0.28; o[P.RHZ] = -0.28; o[P.LKX] = 2.45; o[P.RKX] = 2.45;
    o[P.SX] = 0.72 + hic * 0.06; o[P.HX] = 0.5;
    o[P.LSX] = -1.3; o[P.RSX] = -1.3; o[P.LSY] = -0.3; o[P.RSY] = 0.3; o[P.LEX] = -1.95; o[P.REX] = -1.95;
  } else {
    // 책상 의자에 앉아 모니터 쪽으로 구부정하게 (발은 바닥에 안 닿음)
    o[P.HY] = 0.6;
    o[P.LHX] = -1.5; o[P.RHX] = -1.5; o[P.LHZ] = 0.08; o[P.RHZ] = -0.08; o[P.LKX] = 1.45; o[P.RKX] = 1.45;
    o[P.SX] = 0.34 + hic * 0.05; o[P.HX] = 0.12 + hic * 0.05; o[P.HZ] = side * 0.08;
    o[P.LSX] = -1.2; o[P.RSX] = -1.2; o[P.LSY] = -0.25; o[P.RSY] = 0.25; o[P.LEX] = -0.75; o[P.REX] = -0.75;
  }
  if (p.look > 0) lookAtMe(p, o, p.look);
}
function poseChase(p, t, o) {
  o.fill(0);
  const run = p.kind === 1;
  const s = Math.sin(p.phase), c = Math.cos(p.phase);
  const g = clamp(p.spd / (run ? 2.8 : 1.3), 0, 1.15);
  const amp = (run ? 0.85 : 0.44) * g;
  const hic = Math.pow(Math.max(0, Math.sin(t * 5 + p.seed * 3)), 4);
  o[P.HY] = C.HIP_Y - Math.abs(c) * (run ? 0.045 : 0.02) * g - (run ? 0.035 : 0.012);
  o[P.RR] = s * (run ? 0.05 : 0.035) * g;
  o[P.SX] = (run ? 0.48 : 0.3) + hic * 0.06;
  o[P.SY] = -s * (run ? 0.16 : 0.07) * g;
  o[P.LHX] = -s * amp; o[P.RHX] = s * amp;
  o[P.LKX] = Math.max(0, c) * amp * 1.25 + 0.06; o[P.RKX] = Math.max(0, -c) * amp * 1.25 + 0.06;
  o[P.LHZ] = 0.03; o[P.RHZ] = -0.03;
  const tr = Math.sin(t * 13 + p.seed) * 0.05;
  if (run) {
    o[P.LSX] = -1.75 + Math.sin(p.phase) * 0.35; o[P.RSX] = -1.75 - Math.sin(p.phase) * 0.35;
    o[P.LSZ] = 0.22; o[P.RSZ] = -0.22; o[P.LEX] = -0.35; o[P.REX] = -0.35;
  } else {
    const r = p.reach, hang = -o[P.SX] + 0.1, sw = s * 0.2 * g;
    o[P.LSX] = lerp(hang + sw, -1.72 + tr, r); o[P.RSX] = lerp(hang - sw, -1.66 - tr, r);
    o[P.LSZ] = lerp(0.05, 0.13, r); o[P.RSZ] = -o[P.LSZ];
    o[P.LSY] = lerp(0, -0.12, r); o[P.RSY] = -o[P.LSY];
    o[P.LEX] = lerp(-0.12, -0.28, r); o[P.REX] = o[P.LEX];
  }
  if (p.stagger > 0) { const k = Math.sin(clamp(p.stagger / 0.3, 0, 1) * Math.PI); o[P.SX] -= 0.55 * k; o[P.HX] -= 0.6 * k; o[P.LSX] += 0.6 * k; o[P.RSX] += 0.5 * k; }
  lookAtMe(p, o, 1);
}
const SLOT_KIND = ['stand', 'kneel', 'side', 'low', 'stand', 'side', 'kneel', 'low'];
function poseCling(p, t, o) {
  o.fill(0);
  const kind = p.kindC || SLOT_KIND[p.slot];
  const br = Math.sin(t * 2.8 + p.seed) * 0.025;
  const side = (p.seed % 2) < 1 ? 1 : -1;
  if (kind === 'low') {
    o[P.HY] = 0.27; o[P.LHX] = -0.55; o[P.RHX] = -0.55; o[P.LKX] = 2.1; o[P.RKX] = 2.1; o[P.LHZ] = 0.14; o[P.RHZ] = -0.14;
    o[P.SX] = 0.95 + br;
    o[P.LSX] = -1.0; o[P.RSX] = -1.0; o[P.LSY] = -0.55; o[P.RSY] = 0.55; o[P.LEZ] = -1.0; o[P.REZ] = 1.0; o[P.LEX] = -0.3; o[P.REX] = -0.3;
    o[P.HX] = -0.45; o[P.HZ] = side * 0.5; o[P.HW] = side * 0.35;
  } else if (kind === 'kneel') {
    o[P.HY] = 0.31; o[P.LHX] = -0.12; o[P.RHX] = -0.12; o[P.LKX] = 1.62; o[P.RKX] = 1.62; o[P.LHZ] = 0.1; o[P.RHZ] = -0.1;
    o[P.SX] = 0.3 + br;
    o[P.LSX] = -1.3; o[P.RSX] = -1.3; o[P.LSY] = -0.6; o[P.RSY] = 0.6; o[P.LEZ] = -1.0; o[P.REZ] = 1.0; o[P.LEX] = -0.2; o[P.REX] = -0.2;
    o[P.HX] = -0.35; o[P.HZ] = side * 0.3; o[P.HW] = side * 0.15;
  } else if (kind === 'side') {
    o[P.HY] = C.HIP_Y - 0.19; o[P.LHX] = -0.85; o[P.RHX] = -0.85; o[P.LKX] = 1.35; o[P.RKX] = 1.35;
    o[P.SX] = 0.62 + br;
    o[P.LSX] = -1.2; o[P.RSX] = -1.2; o[P.LSY] = -0.5; o[P.RSY] = 0.5; o[P.LEZ] = -1.1; o[P.REZ] = 1.1; o[P.LEX] = -0.2; o[P.REX] = -0.2;
    o[P.HX] = -0.25; o[P.HZ] = side * 0.35; o[P.HW] = side * 0.2;
  } else {
    // 앞에서 매달려 올려다봄 (팔은 내 몸을 붙잡으러 뻗음)
    o[P.HY] = C.HIP_Y - 0.05; o[P.SX] = 0.34 + br; o[P.LKX] = 0.2; o[P.RKX] = 0.2; o[P.LHX] = -0.12; o[P.RHX] = -0.12;
    o[P.LSX] = -1.75; o[P.RSX] = -1.7; o[P.LSY] = -0.35; o[P.RSY] = 0.35; o[P.LEZ] = -0.5; o[P.REZ] = 0.5; o[P.LEX] = -0.2; o[P.REX] = -0.2;
    o[P.HX] = -0.62; o[P.HZ] = side * 0.18; o[P.HW] = side * 0.1;
  }
}
function makeCorpse(back) {
  const o = new Float32Array(NPOSE);
  o[P.HY] = C.HIP_Y;
  o[P.LSZ] = rand(0.7, 1.6); o[P.RSZ] = -rand(0.7, 1.6);
  o[P.LSX] = rand(-0.5, 0.3); o[P.RSX] = rand(-0.5, 0.3);
  o[P.LEX] = rand(-0.9, 0); o[P.REX] = rand(-0.9, 0);
  o[P.LHX] = rand(-0.7, 0.05); o[P.RHX] = rand(-0.5, 0.1); o[P.LKX] = rand(0, 1.1); o[P.RKX] = rand(0, 0.7);
  o[P.LHZ] = rand(0, 0.35); o[P.RHZ] = -rand(0, 0.35);
  o[P.HW] = rand(-0.9, 0.9); o[P.HX] = back ? 0.5 : -0.5; o[P.HZ] = rand(-0.3, 0.3);
  o[P.SZ] = rand(-0.2, 0.2);
  return o;
}
function poseDying(p, t, o) {
  o.set(p.corpse);
  const k = clamp(p.dieT / p.fallT, 0, 1);
  let a = easeInQuad(k) * Math.PI / 2;
  if (p.dieT > p.fallT) { const x = p.dieT - p.fallT; a = Math.PI / 2 - 0.09 * Math.exp(-x * 9) * Math.abs(Math.sin(x * 24)); }
  const sgn = p.back ? -1 : 1;
  o[P.RP] = sgn * a;
  o[P.RR] = p.fallRoll * easeOutCubic(k);
  o[P.LIFT] = 0.12 * easeInQuad(k) + (p.fly ? p.fly * Math.sin(k * Math.PI) : 0);
  const fl = Math.sin(k * Math.PI);
  o[P.LSX] += -1.3 * fl; o[P.RSX] += -1.1 * fl;
  o[P.HX] += (p.back ? -0.6 : 0.5) * fl;
  if (p.how === 'head') o[P.HX] += (p.back ? -0.9 : 0.6) * Math.min(1, p.dieT * 6);
  if (p.how === 'stab') o[P.HY] = lerp(C.HIP_Y, C.HIP_Y - 0.15, fl);
}
// ── 누운 사람 ──
// 등을 대고 반듯이 누움: 몸통이 머리 쪽으로 살짝 들려 큰 머리가 바닥에 닿는다. 팔다리는 움직이지 않는다.
// 발끝부터 미끄러져 오고, 고개만 들어 나를 쳐다본다.
function lieLook(p, o, w = 1) {
  const hx = p.hc.x, hz = p.hc.z, dx = PL.x - hx, dz = PL.z - hz;
  const b = dx * Math.cos(p.yaw) - dz * Math.sin(p.yaw);                // 몸의 옆쪽(로컬 +x)
  const a = dx * -Math.sin(p.yaw) + dz * -Math.cos(p.yaw);               // 머리 쪽(+) / 발 쪽(-)
  const v = Math.max(0.3, PL.eye - p.hc.y);
  const L = Math.hypot(a, b, v) || 1;
  o[P.HX] = lerp(o[P.HX], clamp(-Math.asin(clamp(a / L, -1, 1)) - 0.24, 0, 0.8), w);    // 턱을 당겨 고개를 듦
  o[P.HW] = lerp(o[P.HW], clamp(Math.atan2(b, v), -1.3, 1.3), w);                   // 옆으로 돌림
}
function poseLie(p, t, o) {
  o.fill(0);
  o[P.HY] = C.HIP_Y; o[P.RP] = -Math.PI / 2 + 0.24; o[P.LIFT] = 0.02;
  o[P.SX] = Math.sin(t * 1.5 + p.seed) * 0.012;
  o[P.LSX] = 0.34; o[P.RSX] = 0.34; o[P.LSZ] = 0.2; o[P.RSZ] = -0.2; o[P.LEX] = -0.12; o[P.REX] = -0.12;
  o[P.LHX] = 0.04; o[P.RHX] = 0.04; o[P.LHZ] = 0.07; o[P.RHZ] = -0.07;
  if (p.state !== 'idle' || p.look > 0) lieLook(p, o, p.state === 'idle' ? p.look : 1);
  else { o[P.HW] = Math.sin(p.seed) * 0.6; }
  // 맞으면 한 번 움찔
  const fl = p.flinch || 0;
  if (fl > 0) { o[P.LSZ] += fl * 0.35; o[P.RSZ] -= fl * 0.35; o[P.HX] = Math.max(0, o[P.HX] - fl * 0.4); o[P.LKX] = fl * 0.25; o[P.RKX] = fl * 0.2; }
}
// 내 발밑으로 미끄러져 들어와 두 팔로 다리를 붙잡고 올려다본다
function poseLieCling(p, t, o) {
  o.fill(0);
  o[P.HY] = C.HIP_Y; o[P.RP] = -Math.PI / 2 + 0.24; o[P.LIFT] = 0.02;
  const tug = Math.sin(t * 5.5 + p.seed) * 0.08;
  o[P.LSX] = -1.38 + tug; o[P.RSX] = -1.38 - tug; o[P.LSZ] = 0.16; o[P.RSZ] = -0.16; o[P.LEX] = -0.42; o[P.REX] = -0.42;
  o[P.LHX] = 0.04; o[P.RHX] = 0.04; o[P.LHZ] = 0.07; o[P.RHZ] = -0.07;
  lieLook(p, o, 1);
}
function poseLieDead(p, t, o) {
  poseLie(p, t, o);
  const k = clamp(p.dieT / 0.25, 0, 1);
  o[P.HW] = (p.seed % 2 < 1 ? 1 : -1) * 1.1 * easeOutCubic(k);
  o[P.HX] = 0.2;
  o[P.LSZ] = 0.6; o[P.RSZ] = -0.6; o[P.LSX] = 0.2; o[P.RSX] = 0.2;
  o[P.LIFT] = 0.02 + 0.05 * Math.sin(k * Math.PI);
}
function computePose(p, t, o) {
  if (p.kind === 2) {
    if (p.state === 'cling') poseLieCling(p, t, o);
    else if (p.state === 'dying') poseLieDead(p, t, o);
    else poseLie(p, t, o);
    if (p.state !== 'dying') o[P.HW] += Math.sin(t * (p.state === 'cling' ? 19 : 13) + p.seed * 2.7) * (p.state === 'cling' ? 0.24 : 0.045);
    return;
  }
  switch (p.state) {
    case 'idle': poseIdle(p, t, o); break;
    case 'rise': {
      poseIdle(p, t, p.tmp); poseChase(p, t, o);
      const k = easeInOutSine(p.rise);
      for (let i = 0; i < NPOSE; i++) o[i] = lerp(p.tmp[i], o[i], k);
      break;
    }
    case 'cling': {
      poseCling(p, t, o);
      if (p.clingT < 0.25) { poseChase(p, t, p.tmp); const k = easeOutCubic(p.clingT / 0.25); for (let i = 0; i < NPOSE; i++) o[i] = lerp(p.tmp[i], o[i], k); }
      break;
    }
    case 'dying': poseDying(p, t, o); break;
    default: poseChase(p, t, o);
  }
  if (p.state !== 'dying') o[P.HW] += Math.sin(t * (p.state === 'cling' ? 19 : 13) + p.seed * 2.7) * (p.state === 'cling' ? 0.24 : 0.045);
}
const DIRECT = [P.RP, P.RR, P.LIFT];
function writeCrowdInstance(p) {
  // 누운 사람은 p.x/z가 몸 한가운데: 리그 뿌리(발)는 머리 반대쪽으로 0.7m
  if (p.kind === 2) applyRig(CR, p.pose, p.x + Math.sin(p.yaw) * 0.7, p.y, p.z + Math.cos(p.yaw) * 0.7, p.yaw);
  else applyRig(CR, p.pose, p.x, p.y, p.z, p.yaw);
  for (const part of CA.parts) part.m.setMatrixAt(p.i, CR[part.node].matrixWorld);
  // 맞는 자리 (머리 구, 몸통·다리 캡슐)
  p.hc.set(0, C.HEAD_UP, 0).applyMatrix4(CR.neck.matrixWorld);
  p.ta.set(0, 0.06, 0).applyMatrix4(CR.torso.matrixWorld);
  p.tb.set(0, C.TORSO_H - 0.02, 0).applyMatrix4(CR.torso.matrixWorld);
  p.la.set(0, 0, 0).applyMatrix4(CR.hips.matrixWorld);
  _v.set(0, 0, 0).applyMatrix4(CR.anL.matrixWorld); _v2.set(0, 0, 0).applyMatrix4(CR.anR.matrixWorld);
  p.lb.copy(_v).add(_v2).multiplyScalar(0.5);
  p.e1.set(-0.15, C.HEAD_UP - 0.05, C.HEAD_R * 0.72).applyMatrix4(CR.neck.matrixWorld);
  p.e2.set(0.15, C.HEAD_UP - 0.05, C.HEAD_R * 0.72).applyMatrix4(CR.neck.matrixWorld);
  if (p.book && p.state !== 'dying') {
    const left = Math.floor(p.seed * 7) % 2 === 0;
    _bookPos.set(left ? 0.12 : -0.12, -0.115, 0.036);
    _bookLocal.compose(_bookPos, _bookRot, _bookScale);
    _m4.multiplyMatrices((left ? CR.wrL : CR.wrR).matrixWorld, _bookLocal);
    books.setMatrixAt(p.i, _m4);
  } else books.setMatrixAt(p.i, _zeroM);
  if (p.state !== 'dying') {
    if (p.kind === 2) { _m4.compose(_v.set(p.x, floorAt(p.x, p.z) + 0.012, p.z), _q.setFromAxisAngle(_v2.set(0, 1, 0), p.yaw), _v3.set(0.75, 1, 1.5)); }
    else _m4.makeTranslation(p.x, p.y + 0.012, p.z);
    blobs.setMatrixAt(p.i, _m4);
  } else blobs.setMatrixAt(p.i, _zeroM);
}
function animatePerson(p, dt) {
  computePose(p, G.t, p.tgt);
  const rate = p.state === 'dying' ? 16 : 18;
  for (let i = 0; i < NPOSE; i++) p.pose[i] = approach(p.pose[i], p.tgt[i], rate, dt);
  for (const i of DIRECT) p.pose[i] = p.tgt[i];
  writeCrowdInstance(p);
}
function flushCrowd() {
  for (const part of CA.parts) part.m.instanceMatrix.needsUpdate = true;
  books.instanceMatrix.needsUpdate = true; blobs.instanceMatrix.needsUpdate = true;
}


// ───────────────────────── 나 ─────────────────────────
const EYE = 1.36;
const PL = { x: 16.5, z: 35.7, y: ENTRY_Y, eye: ENTRY_Y + EYE, yaw: 0, pitch: 0, vx: 0, vz: 0, r: 0.27, stepAcc: 0, bob: 0, bobAmt: 0, kick: 0, kickYaw: 0, shake: 0, clingers: [], pressure: 0, lastYaw: 0, lastPitch: 0, inHouse: true, run: 0, running: false, runBlock: 0 };
const INPUT = { mx: 0, mz: 0, keys: { x: 0, z: 0 }, stick: { x: 0, z: 0 }, fire: false, trigger: false, run: false, stickRun: false };
function playerReset() {
  Object.assign(PL, { x: 16.5, z: 35.75, y: ENTRY_Y, yaw: 0, pitch: -0.04, vx: 0, vz: 0, stepAcc: 0, bob: 0, bobAmt: 0, kick: 0, kickYaw: 0, shake: 0, pressure: 0, inHouse: true, run: 0, running: false, runBlock: 0 });
  PL.clingers.length = 0;
  PL.eye = PL.y + EYE;
}
function playerMove(dt, canMove) {
  let ix = INPUT.keys.x + INPUT.stick.x, iz = INPUT.keys.z + INPUT.stick.z;
  const m = Math.hypot(ix, iz); if (m > 1) { ix /= m; iz /= m; }
  if (!canMove) { ix = 0; iz = 0; }
  const fx = -Math.sin(PL.yaw), fz = -Math.cos(PL.yaw), rx = Math.cos(PL.yaw), rz = -Math.sin(PL.yaw);
  // 앞으로는 조금 더 빠르게
  const fwd = -iz;
  let spd = fwd > 0 ? lerp(3.0, 3.6, fwd) : 3.0;
  const nCling = PL.clingers.length;
  // 달리기: PC는 Shift, 휴대폰은 스틱을 앞으로 끝까지. 쏘거나 붙잡히면 멈춤
  PL.runBlock -= dt;
  const run = canMove && (INPUT.run || INPUT.stickRun) && fwd > 0.55 && !nCling && PL.runBlock <= 0 && WEP.stabT <= 0;
  PL.running = run;
  PL.run = approach(PL.run, run ? 1 : 0, run ? 7 : 13, dt);
  if (run) { spd = lerp(4.3, 5.0, fwd); ix *= 0.6; }
  // 발목을 잡혔으면 훨씬 무겁다
  if (nCling) { let w = 0; for (const q of PL.clingers) w += q.kind === 2 ? 1.9 : 1; spd *= Math.max(0.16, 1 - 0.24 * w); }
  const tx = (fx * fwd + rx * ix) * spd, tz = (fz * fwd + rz * ix) * spd;
  const k = (tx || tz) ? 11 : 14;
  PL.vx = approach(PL.vx, tx, k, dt); PL.vz = approach(PL.vz, tz, k, dt);
  const ox = PL.x, oz = PL.z;
  PL.x += PL.vx * dt; PL.z += PL.vz * dt;
  if (!GUN_MOD.noclip) for (let i = 0; i < 2; i++) collideCircle(PL, PL.r, PL.y + 0.15, PL.y + 1.6);
  const moved = Math.hypot(PL.x - ox, PL.z - oz);
  PL.vx = (PL.x - ox) / Math.max(dt, 1e-4); PL.vz = (PL.z - oz) / Math.max(dt, 1e-4);
  // 현관 턱
  PL.y = approach(PL.y, floorAt(PL.x, PL.z), 14, dt);
  PL.eye = PL.y + EYE;
  const sp = Math.hypot(PL.vx, PL.vz);
  PL.bobAmt = approach(PL.bobAmt, clamp(sp / 3.4, 0, 1.45), 8, dt);
  PL.bob += moved * (PL.running ? 2.2 : 2.55);
  PL.stepAcc += moved;
  if (PL.stepAcc > (PL.running ? 0.84 : 0.66)) {
    PL.stepAcc = 0;
    const reg = regionAt(PL.x, PL.z), loud = PL.running ? 1.3 : 1;
    const fl = reg === 'back' ? floorKindAt(PL.x, PL.z) : reg === 'hall' ? 'wood' : 'tile';
    sfxStep(fl, (fl === 'vinyl' ? 0.8 : 0.6) * loud);
  }
  PL.inHouse = PL.z > 30.05;
}
function applyCamera(dt) {
  PL.kick = approach(PL.kick, 0, 9, dt);
  PL.kickYaw = approach(PL.kickYaw, 0, 10, dt);
  PL.shake = approach(PL.shake, 0, 7, dt);
  const sh = PL.shake;
  camera.position.set(PL.x + (sh ? rand(-1, 1) * sh * 0.02 : 0), PL.eye + (sh ? rand(-1, 1) * sh * 0.02 : 0), PL.z);
  camera.rotation.set(PL.pitch + PL.kick, PL.yaw + PL.kickYaw, 0);
  camera.updateMatrixWorld();
  // 사람 비추는 빛: 내 머리 위 뒤쪽에서 얼굴 쪽으로
  const fx = -Math.sin(PL.yaw), fz = -Math.cos(PL.yaw);
  keyLight.position.set(PL.x - fx * 1.5, PL.eye + 2.2, PL.z - fz * 1.5);
  keyLight.target.position.set(PL.x + fx * 4, PL.eye - 0.4, PL.z + fz * 4);
}

// ───────────────────────── 손과 총 (따로 그림) ─────────────────────────
const VM_OUT = (() => {
  const m = new THREE.MeshBasicMaterial({ color: 0x1f1a24, side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uPx = OUTLINE.px; sh.uniforms.uRes = OUTLINE.res;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uPx;\nuniform vec2 uRes;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec3 oV = normalize(normalMatrix * normal);
        vec2 oD = oV.xy; float oL = length(oD); oD = oL > 0.0001 ? oD / oL : vec2(0.0);
        gl_Position.xy += oD * uPx * 1.6 / uRes * gl_Position.w;`);
  };
  m.customProgramCacheKey = () => 'vm-outline';
  return m;
})();
const vmToon = (c, extra = {}) => new THREE.MeshToonMaterial({ color: c, gradientMap: GRAD, ...extra });
const VMM = { skin: vmToon('#ffcfb0'), sleeve: vmToon('#4fb0ee'), cuff: vmToon('#ffffff'), gun: vmToon('#26252c'), gunHi: vmToon('#848793'), blade: vmToon('#e6eaef'), handle: vmToon('#1b1a1f'), brass: vmToon('#d8a840'), mag: vmToon('#3a3940') };
const vmHemi = new THREE.HemisphereLight(0xffffff, 0x8f7a46, 1.4);
const vmKey = new THREE.DirectionalLight(0xffffff, 1.5); vmKey.position.set(-0.6, 1.2, 0.6);
vmScene.add(vmHemi, vmKey, vmCamera);
function vmPart(geo, mat, parent, outline = true) {
  const m = new THREE.Mesh(geo, mat); parent.add(m);
  if (outline) m.add(new THREE.Mesh(geo, VM_OUT));
  return m;
}
const VGS = 1.15;              // 손에 든 권총 크기 (본편 3인칭은 1.6배)
const _down = new THREE.Vector3(0, -1, 0);
function pistolGeo() {
  const slide = new THREE.BoxGeometry(0.046, 0.054, 0.2); slide.translate(0, 0.03, 0.06);
  const muzzle = new THREE.CylinderGeometry(0.013, 0.013, 0.014, 10); muzzle.rotateX(Math.PI / 2); muzzle.translate(0, 0.035, 0.162);
  const sight = new THREE.BoxGeometry(0.012, 0.014, 0.012); sight.translate(0, 0.062, 0.14);
  const rsight = new THREE.BoxGeometry(0.03, 0.012, 0.012); rsight.translate(0, 0.062, -0.03);
  const grip = new THREE.BoxGeometry(0.04, 0.12, 0.058); grip.rotateX(-0.28); grip.translate(0, -0.04, -0.02);
  const guard = new THREE.TorusGeometry(0.026, 0.008, 6, 12, Math.PI); guard.rotateY(Math.PI / 2); guard.rotateX(Math.PI); guard.translate(0, -0.002, 0.03);
  const frame = new THREE.BoxGeometry(0.042, 0.03, 0.15); frame.translate(0, -0.006, 0.05);
  const top = mergeGeos([slide, muzzle, sight, rsight]), low = mergeGeos([grip, guard, frame]);
  for (const g of [top, low]) { g.scale(VGS, VGS, VGS); g.rotateY(Math.PI); }
  return { top, low };
}
function gripHandGeo() {
  // 본편의 손잡이 쥔 손 (본편 총 1.6배 기준 → 지금 크기로 줄이고 총구가 -Z를 보게 돌림)
  const palm = G3.ell(0.050, 0.050, 0.047, 16, 12); palm.translate(0.026, -0.065, -0.070);
  const parts = [palm];
  for (let f = 0; f < 4; f++) { const finger = G3.ell(0.051, 0.018, 0.045, 14, 10); finger.translate(0.025, -0.027 - f * 0.022, -0.038); parts.push(finger); }
  const thumb = G3.ell(0.027, 0.018, 0.042, 14, 10); thumb.rotateX(-0.25); thumb.translate(0.066, -0.028, -0.055); parts.push(thumb);
  const g = mergeGeos(parts); g.rotateY(Math.PI);
  const k = 0.82; g.scale(k, k, k);
  return g;
}
function knifeGeo() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(0.034, 0); shape.quadraticCurveTo(0.03, 0.17, 0.0, 0.24); shape.lineTo(-0.004, 0.06); shape.lineTo(0, 0);
  const blade = new THREE.ExtrudeGeometry(shape, { depth: 0.008, bevelEnabled: false }); blade.translate(-0.015, 0.0, -0.004);
  return blade;
}
const GUN_G = pistolGeo(), HAND_G = gripHandGeo(), KNIFE_G = knifeGeo();
const VM = { root: new THREE.Group(), arms: [], shot: null, knife: null, mags: [] };
vmCamera.add(VM.root);
// 손목에서 화면 밖(아래 뒤쪽)으로 빠지는 소매
function forearm(parent, x, y, z, dir, len = 0.55, r = 0.05) {
  const fa = new THREE.Group(); fa.position.set(x, y, z); parent.add(fa);
  fa.quaternion.setFromUnitVectors(_down, dir.clone().normalize());
  const wristG = G3.cap(r * 0.66, 0.03, 10); wristG.translate(0, -0.012, 0); vmPart(wristG, VMM.skin, fa);
  const cuffG = new THREE.CylinderGeometry(r * 1.08, r * 1.08, 0.034, 16); cuffG.translate(0, -0.046, 0); vmPart(cuffG, VMM.cuff, fa);
  const sleeveG = G3.cap(r, len, 14); sleeveG.translate(0, -0.06 - len / 2, 0); vmPart(sleeveG, VMM.sleeve, fa);
  return fa;
}
function makeArm(side) {
  // side: 1 오른손, -1 왼손 (거울)
  const g = new THREE.Group();
  const inner = new THREE.Group(); g.add(inner);
  inner.scale.x = side;
  const gun = new THREE.Group(); inner.add(gun);
  const slide = vmPart(GUN_G.top, VMM.gunHi, gun);
  vmPart(GUN_G.low, VMM.gun, gun);
  const hand = vmPart(HAND_G, VMM.skin, gun);
  forearm(inner, 0.004, -0.112, 0.05, new THREE.Vector3(0.3, -0.62, 0.72));
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.flash, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  flash.position.set(0, 0.043, -0.22); flash.scale.set(0.1, 0.1, 1); flash.visible = false; gun.add(flash);
  // 칼 (붙잡혔을 때 오른손)
  const knife = new THREE.Group(); knife.visible = false; inner.add(knife);
  const kb = vmPart(KNIFE_G, VMM.blade, knife); kb.rotation.x = -Math.PI / 2; kb.position.set(0, 0.0, -0.05); kb.scale.setScalar(0.85);
  const kh = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.03, 0.095), VMM.handle); kh.position.set(0, 0.0, 0.0); knife.add(kh); kh.add(new THREE.Mesh(kh.geometry, VM_OUT));
  const kf = vmPart(G3.ell(0.036, 0.04, 0.05, 12, 10), VMM.skin, knife); kf.position.set(0, -0.012, 0.01);
  VM.root.add(g);
  return { g, inner, gun, slide, hand, flash, knife, side, rec: 0, flashT: 0, slideT: 0 };
}
VM.arms = [makeArm(1), makeArm(-1)];
VM.knife = VM.arms[0].knife;
// 산탄총 들기: 오른손은 손잡이, 왼손은 펌프
(() => {
  const g = new THREE.Group();
  const gun = makeShotgunModel(false, true); g.add(gun);
  const hR = vmPart(G3.ell(0.042, 0.05, 0.055, 14, 10), VMM.skin, g); hR.position.set(0.012, -0.075, 0.085);
  forearm(g, 0.02, -0.1, 0.11, new THREE.Vector3(0.32, -0.55, 0.77));
  const hL = vmPart(G3.ell(0.044, 0.04, 0.065, 14, 10), VMM.skin, gun.userData.pump); hL.position.set(-0.01, -0.035, 0);
  forearm(gun.userData.pump, -0.02, -0.055, 0.03, new THREE.Vector3(-0.42, -0.55, 0.72), 0.75);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.flash, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  flash.position.set(0, 0.035, -0.78); flash.scale.set(0.34, 0.34, 1); flash.visible = false; gun.add(flash);
  const shell = vmPart(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 10), vmToon('#b3262c'), g); shell.rotation.x = Math.PI / 2; shell.visible = false;
  g.visible = false;
  VM.root.add(g);
  VM.shot = { g, gun, pump: gun.userData.pump, flash, shell, rec: 0, flashT: 0, pumpT: 0 };
})();
// 떨어지는 탄창
for (let i = 0; i < 2; i++) {
  const m = vmPart(new THREE.BoxGeometry(0.036, 0.09, 0.05), VMM.mag, VM.root); m.visible = false;
  VM.mags.push({ m, t: 0, vx: 0, vy: 0 });
}
let VM_LAYOUT = { x: 0.19, y: -0.128, z: -0.48, sx: 0.16, sy: -0.2, sz: -0.52 };
function vmLayout() {
  // 좁은 세로 화면에서는 총을 가운데 아래로 모은다
  const a = VW / VH;
  const k = clamp((a - 0.55) / 1.1, 0, 1);
  const wide = clamp((a - 1.8) / 0.5, 0, 1);   // 가로로 아주 긴 휴대폰: 조금 멀리
  VM_LAYOUT = { x: lerp(0.088, 0.19, k) + wide * 0.03, y: lerp(-0.2, -0.128, k) - wide * 0.012, z: lerp(-0.64, -0.48, k) - wide * 0.1, sx: lerp(0.075, 0.16, k) + wide * 0.02, sy: lerp(-0.26, -0.2, k) - wide * 0.01, sz: lerp(-0.7, -0.52, k) - wide * 0.08 };
}

// ── 무기 상태 ──
const GUN_MOD = { damage: 1, rate: 1, infiniteAmmo: false, noRecoil: false, auto: false, noclip: false };
let crowdRepelT = 0;
const WEP = {
  cur: 'pistol', hasShotgun: false,
  pistol: { mag: [9, 9], size: 9, res: 27, hand: 0, cd: 0, reloadT: 0, dur: 1.55 },
  shotgun: { mag: 6, size: 6, res: 12, cd: 0, reloadT: 0, shellT: 0, pumpQ: 0 },
  switchT: 0, switchTo: '', stabT: 0, stabCD: 0, bloom: 0, holdT: 0, magSpawned: false, magIn: false, slid: false, fireQ: 0,
};
function weaponsReset() {
  Object.assign(WEP, { cur: 'pistol', hasShotgun: false, switchT: 0, switchTo: '', stabT: 0, stabCD: 0, bloom: 0, holdT: 0, fireQ: 0 });
  Object.assign(WEP.pistol, { mag: [9, 9], res: 27, hand: 0, cd: 0, reloadT: 0 });
  Object.assign(WEP.shotgun, { mag: 6, res: 12, cd: 0, reloadT: 0, shellT: 0, pumpQ: 0 });
  VM.shot.g.visible = false; for (const a of VM.arms) a.g.visible = true;
  hudAmmo(true);
}
function pistolLoaded() { return WEP.pistol.mag[0] + WEP.pistol.mag[1]; }
function canReload() {
  if (WEP.cur === 'pistol') return WEP.pistol.reloadT <= 0 && WEP.pistol.res > 0 && pistolLoaded() < WEP.pistol.size * 2;
  return WEP.shotgun.reloadT <= 0 && WEP.shotgun.res > 0 && WEP.shotgun.mag < WEP.shotgun.size;
}
function startReload() {
  if (WEP.switchT > 0 || !canReload()) return;
  if (WEP.cur === 'pistol') { WEP.pistol.reloadT = WEP.pistol.dur; WEP.magSpawned = false; WEP.magIn = false; WEP.slid = false; }
  else { WEP.shotgun.reloadT = 0.35; WEP.shotgun.shellT = 0.35; }
}
function switchWeapon(to) {
  if (!to) to = WEP.cur === 'pistol' ? 'shotgun' : 'pistol';
  if (to === WEP.cur || (to === 'shotgun' && !WEP.hasShotgun) || WEP.switchT > 0) return;
  WEP.pistol.reloadT = 0; WEP.shotgun.reloadT = 0;
  WEP.switchT = 0.42; WEP.switchTo = to;
  sfxSwitch();
}
function weaponTick(dt) {
  const ps = WEP.pistol, sg = WEP.shotgun;
  ps.cd -= dt; sg.cd -= dt; WEP.stabCD -= dt;
  WEP.bloom = approach(WEP.bloom, 0, 5, dt);
  if (WEP.switchT > 0) {
    const was = WEP.switchT; WEP.switchT -= dt;
    if (was > 0.21 && WEP.switchT <= 0.21) {
      WEP.cur = WEP.switchTo;
      VM.shot.g.visible = WEP.cur === 'shotgun';
      for (const a of VM.arms) a.g.visible = WEP.cur === 'pistol';
      hudAmmo(true);
    }
  }
  // 권총 재장전: 탄창 빼고, 넣고, 슬라이드
  if (ps.reloadT > 0) {
    ps.reloadT -= dt;
    const k = 1 - ps.reloadT / ps.dur;
    if (!WEP.magSpawned && k > 0.16) { WEP.magSpawned = true; sfxMagOut(); dropMags(); }
    if (!WEP.magIn && k > 0.55) { WEP.magIn = true; sfxMagIn(); }
    if (!WEP.slid && k > 0.78) { WEP.slid = true; sfxSlide(); }
    if (ps.reloadT <= 0) {
      for (let h = 0; h < 2; h++) { const need = ps.size - ps.mag[h], n = Math.min(need, ps.res); ps.mag[h] += n; ps.res -= n; }
      ps.hand = 0; hudAmmo(true);
    }
  }
  // 산탄총: 한 발씩 넣기
  if (sg.reloadT > 0) {
    sg.shellT -= dt;
    if (sg.shellT <= 0) {
      if (sg.mag < sg.size && sg.res > 0) { sg.mag++; sg.res--; sfxShellIn(); hudAmmo(true); sg.shellT = 0.42; VM.shot.rec = Math.max(VM.shot.rec, 0.25); }
      if (sg.mag >= sg.size || sg.res <= 0) { sg.reloadT = 0; sfxPump(0.05); VM.shot.pumpT = 0.4; }
    }
  }
  if (sg.pumpQ > 0) { sg.pumpQ -= dt; if (sg.pumpQ <= 0) { sfxPump(); VM.shot.pumpT = 0.42; } }
  if (WEP.stabT > 0) WEP.stabT -= dt;
  // 쏘기 (달리다 누른 한 발은 총을 들자마자 나간다)
  WEP.fireQ -= dt;
  const want = INPUT.trigger || (GUN_MOD.auto && INPUT.fire) || WEP.fireQ > 0;
  if (INPUT.fire) WEP.holdT += dt; else WEP.holdT = 0;
  if (want && G.state === 'play') tryFire();
  INPUT.trigger = false;
}
function tryFire() {
  if (WEP.switchT > 0) return;
  if (PL.clingers.length) { if (WEP.stabCD <= 0) stab(); return; }
  PL.runBlock = 0.5;
  if (PL.run > 0.35) { if (INPUT.trigger) WEP.fireQ = 0.3; return; }
  const ps = WEP.pistol, sg = WEP.shotgun;
  if (WEP.cur === 'pistol') {
    if (ps.reloadT > 0 || ps.cd > 0) return;
    let h = ps.hand;
    if (ps.mag[h] <= 0) h = 1 - h;
    if (ps.mag[h] <= 0) {
      if (ps.res > 0) { startReload(); return; }
      if (WEP.hasShotgun && (sg.mag + sg.res) > 0) { switchWeapon('shotgun'); return; }
      melee(); return;
    }
    if (!GUN_MOD.infiniteAmmo) ps.mag[h]--; ps.hand = 1 - h; WEP.fireQ = 0;
    ps.cd = (INPUT.trigger ? 0.13 : 0.2) / GUN_MOD.rate;
    shootPistol(h);
    hudAmmo(true);
    if (pistolLoaded() === 0 && ps.res > 0) later(0.26, () => { if (WEP.cur === 'pistol' && pistolLoaded() === 0) startReload(); });
  } else {
    if (sg.cd > 0) return;
    if (sg.reloadT > 0) { if (sg.mag > 0) sg.reloadT = 0; else return; }
    if (sg.mag <= 0) {
      if (sg.res > 0) { startReload(); return; }
      switchWeapon('pistol'); return;
    }
    if (!GUN_MOD.infiniteAmmo) sg.mag--; sg.cd = 0.86 / GUN_MOD.rate; sg.pumpQ = 0.24; WEP.fireQ = 0;
    shootShotgun();
    hudAmmo(true);
  }
}

// ── 총알 ──
const _ro = new THREE.Vector3(), _rd = new THREE.Vector3(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _upv = new THREE.Vector3();
function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z, cc = ox * ox + oy * oy + oz * oz - r * r, h = b * b - cc;
  if (h < 0) return -1;
  const t = -b - Math.sqrt(h);
  return t > 0 ? t : -1;
}
function rayCapsule(ro, rd, pa, pb, r) {
  const bax = pb.x - pa.x, bay = pb.y - pa.y, baz = pb.z - pa.z;
  const oax = ro.x - pa.x, oay = ro.y - pa.y, oaz = ro.z - pa.z;
  const baba = bax * bax + bay * bay + baz * baz, bard = bax * rd.x + bay * rd.y + baz * rd.z, baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = rd.x * oax + rd.y * oay + rd.z * oaz, oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba - bard * bard, b = baba * rdoa - baoa * bard, c = baba * oaoa - baoa * baoa - r * r * baba;
  const h = b * b - a * c;
  if (h >= 0 && Math.abs(a) > 1e-9) {
    const t = (-b - Math.sqrt(h)) / a, y = baoa + t * bard;
    if (y > 0 && y < baba) return t > 0 ? t : -1;
    const ocx = y <= 0 ? oax : ro.x - pb.x, ocy = y <= 0 ? oay : ro.y - pb.y, ocz = y <= 0 ? oaz : ro.z - pb.z;
    const b2 = rd.x * ocx + rd.y * ocy + rd.z * ocz, c2 = ocx * ocx + ocy * ocy + ocz * ocz - r * r, h2 = b2 * b2 - c2;
    if (h2 > 0) { const t2 = -b2 - Math.sqrt(h2); return t2 > 0 ? t2 : -1; }
  }
  return -1;
}
const HIT = { p: null, t: 0, part: '' };
function rayPeople(o, d, maxT) {
  HIT.p = null; HIT.t = maxT; HIT.part = '';
  for (const p of live) {
    if (p.state === 'dying') continue;
    const dx = p.x - o.x, dz = p.z - o.z;
    if (dx * d.x + dz * d.z < -1) continue;
    let t = raySphere(o, d, p.hc, C.HEAD_R * 0.98);
    if (t > 0 && t < HIT.t) { HIT.t = t; HIT.p = p; HIT.part = 'head'; }
    t = rayCapsule(o, d, p.ta, p.tb, 0.22);
    if (t > 0 && t < HIT.t) { HIT.t = t; HIT.p = p; HIT.part = 'body'; }
    t = rayCapsule(o, d, p.la, p.lb, 0.15);
    if (t > 0 && t < HIT.t) { HIT.t = t; HIT.p = p; HIT.part = 'legs'; }
  }
  return HIT;
}
function aimRay(spread) {
  camera.getWorldDirection(_fw);
  _rt.set(1, 0, 0).applyQuaternion(camera.quaternion); _upv.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const a = rand(0, TAU), r = Math.sqrt(Math.random()) * spread;
  _rd.copy(_fw).addScaledVector(_rt, Math.cos(a) * r).addScaledVector(_upv, Math.sin(a) * r).normalize();
  _ro.copy(camera.position);
}
function bulletHit(dmgHead, dmgBody, dmgLegs, power, weapon, falloff = 0) {
  rayWalls(_ro.x, _ro.y, _ro.z, _rd.x, _rd.y, _rd.z, 60);
  const wallT = RAY.t, wn = { x: RAY.nx, y: RAY.ny, z: RAY.nz }, surf = RAY.surf;
  rayPeople(_ro, _rd, wallT);
  if (HIT.p) {
    const p = HIT.p, t = HIT.t;
    const hx = _ro.x + _rd.x * t, hy = _ro.y + _rd.y * t, hz = _ro.z + _rd.z * t;
    let dmg = HIT.part === 'head' ? dmgHead : HIT.part === 'body' ? dmgBody : dmgLegs;
    if (weapon === 'pistol' || weapon === 'shotgun') dmg *= GUN_MOD.damage;
    if (falloff) dmg *= clamp(1.35 - t / falloff, 0.3, 1);
    hurtPerson(p, dmg, HIT.part, _rd.x, _rd.z, hx, hy, hz, power, weapon);
    return { kind: 'person', p, part: HIT.part };
  }
  if (RAY.hit && wallT < 60) {
    const hx = _ro.x + _rd.x * wallT, hy = _ro.y + _rd.y * wallT, hz = _ro.z + _rd.z * wallT;
    addDecal(hx, hy, hz, wn.x, wn.y, wn.z, rand(0.07, 0.1), 4);
    dust(hx, hy, hz, wn.x, wn.y, wn.z, surf === 'floor' ? 0xa07c2c : surf === 'ceil' ? 0xe0cf93 : 0xd6ac36);
    if (Math.random() < 0.6) sfxWallHit(clamp(1.2 - wallT * 0.05, 0.3, 1), panOf(hx, hz));
  }
  return null;
}
function shootPistol(h) {
  const arm = VM.arms[h];
  arm.rec = GUN_MOD.noRecoil ? 0 : 1; arm.flashT = 0.055; arm.slideT = 0.09;
  arm.flash.material.rotation = rand(0, TAU); const fs = rand(0.085, 0.12); arm.flash.scale.set(fs, fs, 1);
  sfxPistol(h ? -0.25 : 0.25);
  if (!GUN_MOD.noRecoil) { PL.kick += 0.026; PL.kickYaw += rand(-0.006, 0.006); }
  const moving = Math.hypot(PL.vx, PL.vz) > 0.6;
  aimRay(GUN_MOD.noRecoil ? 0 : 0.006 + WEP.bloom + (moving ? 0.012 : 0));
  if (!GUN_MOD.noRecoil) WEP.bloom = Math.min(0.05, WEP.bloom + 0.014);
  bulletHit(100, 38, 26, 1.1, 'pistol');
  muzzleLight(1.3);
  ejectShell(h ? -1 : 1);
  noiseAlert(16);
}
function shootShotgun() {
  const s = VM.shot;
  s.rec = GUN_MOD.noRecoil ? 0 : 1; s.flashT = 0.07;
  s.flash.material.rotation = rand(0, TAU);
  sfxShotgun();
  if (!GUN_MOD.noRecoil) { PL.kick += 0.06; PL.kickYaw += rand(-0.01, 0.01); PL.shake = Math.max(PL.shake, 0.5); }
  const hits = new Map();
  for (let i = 0; i < 9; i++) {
    aimRay(0.055);
    const r = bulletHit(48, 24, 17, 3.2, 'shotgun', 7.5);
    if (r) hits.set(r.p, (hits.get(r.p) || 0) + 1);
  }
  muzzleLight(2.4);
  noiseAlert(22);
}
// 칼: 붙잡혔을 때 보고 있는 쪽에 붙은 사람부터
function stab() {
  WEP.stabT = 0.3; WEP.stabCD = 0.3;
  VM.knife.visible = true; VM.arms[0].gun.visible = false;
  sfxSwing(0.8);
  camera.getWorldDirection(_fw);
  let best = null, bd = 9;
  for (const p of PL.clingers) {
    const dx = p.x - PL.x, dz = p.z - PL.z, L = Math.hypot(dx, dz) || 1;
    const dot = (dx * _fw.x + dz * _fw.z) / L;
    const score = 1 - dot;
    if (score < bd) { bd = score; best = p; }
  }
  if (best) later(0.07, () => {
    if (best.state !== 'cling') return;
    sfxStab(panOf(best.x, best.z), 1);
    const dx = best.x - PL.x, dz = best.z - PL.z, L = Math.hypot(dx, dz) || 1;
    killPerson(best, 'stab', dx / L, dz / L, 0.6);
    bloodBurst(best.hc.x, Math.max(0.12, best.hc.y - 0.35), best.hc.z, dx / L, dz / L, 14, 1);
    hitMarker(true);
  });
}
function melee() {
  if (WEP.stabCD > 0) return;
  WEP.stabT = 0.3; WEP.stabCD = 0.45;
  VM.knife.visible = true; VM.arms[0].gun.visible = false;
  sfxSwing(1);
  camera.getWorldDirection(_fw);
  let best = null, bd = 1.9;
  for (const p of live) {
    if (p.state === 'dying') continue;
    const dx = p.x - PL.x, dz = p.z - PL.z, L = Math.hypot(dx, dz);
    if (L > bd) continue;
    if ((dx * _fw.x + dz * _fw.z) / (L || 1) < 0.7) continue;
    best = p; bd = L;
  }
  if (best) later(0.09, () => {
    if (best.state === 'dying') return;
    const dx = best.x - PL.x, dz = best.z - PL.z, L = Math.hypot(dx, dz) || 1;
    sfxStab(panOf(best.x, best.z), 1);
    hurtPerson(best, 55, 'body', dx / L, dz / L, best.ta.x, best.ta.y + 0.1, best.ta.z, 0.8, 'knife');
  });
}

// ───────────────────────── 피·자국·불빛 ─────────────────────────
const DEC_MAX = 520;
const decalGeo = new THREE.PlaneGeometry(1, 1);
const aCell = new THREE.InstancedBufferAttribute(new Float32Array(DEC_MAX * 2), 2);
decalGeo.setAttribute('aCell', aCell);
const decalMat = new THREE.ShaderMaterial({
  uniforms: Object.assign({ map: { value: TEX.decal } }, LU), transparent: true, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  vertexShader: `attribute vec2 aCell; varying vec2 vUv; varying vec3 vWP; varying vec3 vN;
    void main(){ vUv = uv * vec2(0.25, 0.5) + aCell; vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0); vWP = wp.xyz; vN = normalize(mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0)); gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: LIGHT_GLSL + `uniform sampler2D map; varying vec2 vUv; varying vec3 vWP; varying vec3 vN;
    void main(){ vec4 c = texture2D(map, vUv); if (c.a < 0.02) discard; float L = lfAt(vWP.xz + vN.xz * 0.3) + uAmb + flashAt(vWP); vec3 col = applyFog(c.rgb * L, vWP, L); gl_FragColor = vec4(col, c.a);
    #include <colorspace_fragment>
    }`,
});
const decals = new THREE.InstancedMesh(decalGeo, decalMat, DEC_MAX);
decals.frustumCulled = false; decals.count = 0; decals.renderOrder = 1;
scene.add(decals);
let decNext = 0, decUsed = 0;
const growing = [];
const _dn = new THREE.Vector3(), _z1 = new THREE.Vector3(0, 0, 1), _qr = new THREE.Quaternion();
function addDecal(x, y, z, nx, ny, nz, size, cell, grow = 0) {
  const i = decNext; decNext = (decNext + 1) % DEC_MAX; decUsed = Math.min(DEC_MAX, decUsed + 1);
  decals.count = decUsed;
  aCell.setXY(i, DEC_OFF[cell][0], DEC_OFF[cell][1]); aCell.needsUpdate = true;
  _dn.set(nx, ny, nz).normalize();
  _q.setFromUnitVectors(_z1, _dn); _qr.setFromAxisAngle(_z1, rand(0, TAU)); _q.multiply(_qr);
  const off = 0.004 + (i % 40) * 0.0002;
  const d = { i, x: x + nx * off, y: y + ny * off, z: z + nz * off, q: _q.clone(), size, s: grow ? size * 0.2 : size, t: 0, dur: grow };
  setDecal(d);
  if (grow) growing.push(d);
  return d;
}
function setDecal(d) {
  _s.set(d.s, d.s, d.s);
  _m4.compose(_v.set(d.x, d.y, d.z), d.q, _s);
  decals.setMatrixAt(d.i, _m4); decals.instanceMatrix.needsUpdate = true;
}
function growDecals(dt) {
  for (let k = growing.length - 1; k >= 0; k--) {
    const d = growing[k]; d.t += dt;
    d.s = lerp(d.size * 0.2, d.size, easeOutCubic(d.t / d.dur)); setDecal(d);
    if (d.t >= d.dur) growing.splice(k, 1);
  }
}
function clearDecals() { decNext = 0; decUsed = 0; decals.count = 0; growing.length = 0; }

// 피 방울·먼지·눈물·탄피 (한 묶음)
const PT_MAX = 600;
const ptMat = new THREE.ShaderMaterial({
  uniforms: Object.assign({}, LU),
  vertexShader: `varying vec3 vWP; varying vec3 vC; void main(){ vC = instanceColor; vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0); vWP = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
  fragmentShader: LIGHT_GLSL + `varying vec3 vWP; varying vec3 vC; void main(){ float L = lfAt(vWP.xz) + uAmb + flashAt(vWP); gl_FragColor = vec4(applyFog(vC * L, vWP, L), 1.0);
    #include <colorspace_fragment>
    }`,
});
const pts = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 5), ptMat, PT_MAX);
pts.frustumCulled = false; pts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
for (let i = 0; i < PT_MAX; i++) { pts.setMatrixAt(i, _zeroM); pts.setColorAt(i, _white); }
scene.add(pts);
const PTS = [];
for (let i = 0; i < PT_MAX; i++) PTS.push({ on: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0.03, kind: 0, life: 0, sx: 1, sy: 1.25, sz: 1 });
let ptNext = 0;
function ptSpawn(kind, x, y, z, vx, vy, vz, r, color, life = 3) {
  const d = PTS[ptNext]; const i = ptNext; ptNext = (ptNext + 1) % PT_MAX;
  Object.assign(d, { on: true, x, y, z, vx, vy, vz, r, kind, life, bounced: 0 });
  d.sx = 1; d.sy = 1.25; d.sz = 1;
  if (kind === 3) { d.sx = 0.6; d.sy = 0.6; d.sz = 1.6; }
  _col.set(color); pts.setColorAt(i, _col); pts.instanceColor.needsUpdate = true;
  return d;
}
function bloodBurst(x, y, z, dx, dz, n, power = 1) {
  for (let k = 0; k < n; k++) {
    const sp = rand(1.0, 4.2) * power;
    ptSpawn(0, x + rand(-0.04, 0.04), y + rand(-0.06, 0.06), z + rand(-0.04, 0.04), dx * sp + rand(-1.2, 1.2), rand(0.4, 3.2) * power, dz * sp + rand(-1.2, 1.2), rand(0.016, 0.045), 0xc8001d);
  }
}
function dust(x, y, z, nx, ny, nz, color) {
  for (let k = 0; k < 6; k++) ptSpawn(1, x, y, z, nx * rand(0.6, 2) + rand(-0.6, 0.6), ny * rand(0.6, 2) + rand(-0.3, 1.2), nz * rand(0.6, 2) + rand(-0.6, 0.6), rand(0.008, 0.02), color, 0.7);
}
function tear(x, y, z) { ptSpawn(2, x, y, z, rand(-0.1, 0.1), rand(-0.2, 0.1), rand(-0.1, 0.1), rand(0.016, 0.026), 0x6cc8ff, 1.5); }
function ejectShell(side) {
  _rt.set(1, 0, 0).applyQuaternion(camera.quaternion);
  camera.getWorldDirection(_fw);
  const x = camera.position.x + _rt.x * 0.32 * side + _fw.x * 0.5, y = camera.position.y - 0.2, z = camera.position.z + _rt.z * 0.32 * side + _fw.z * 0.5;
  ptSpawn(3, x, y, z, _rt.x * side * rand(1.2, 2) + rand(-0.3, 0.3), rand(1.2, 2.2), _rt.z * side * rand(1.2, 2) + rand(-0.3, 0.3), 0.012, 0xd8a840, 2.2);
}
function ptTick(dt) {
  tinkBudget = Math.max(0, tinkBudget - dt * 6);
  for (let i = 0; i < PT_MAX; i++) {
    const d = PTS[i];
    if (!d.on) continue;
    d.life -= dt;
    const grav = d.kind === 1 ? 3 : d.kind === 2 ? 5 : 14;
    d.vy -= grav * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    if (d.kind === 1) { d.vx *= 1 - 3 * dt; d.vz *= 1 - 3 * dt; d.vy *= 1 - 2 * dt; }
    const fy = floorAt(d.x, d.z);
    if (d.y < fy + 0.01 || d.life <= 0) {
      if (d.kind === 3 && d.y < fy + 0.01 && d.bounced < 1 && d.life > 0) {
        d.bounced++; d.y = fy + 0.01; d.vy = Math.abs(d.vy) * 0.35; d.vx *= 0.5; d.vz *= 0.5;
        sfxTink(0.9, panOf(d.x, d.z));
      } else {
        d.on = false; pts.setMatrixAt(i, _zeroM);
        if (d.kind === 0 && d.y < fy + 0.02 && Math.random() < 0.5) addDecal(d.x, fy, d.z, 0, 1, 0, d.r * rand(4, 8), Math.random() < 0.5 ? 0 : 1);
        continue;
      }
    }
    if (d.kind === 3) { _q.setFromEuler(_e.set(d.life * 13, d.life * 9, 0)); _s.set(d.r * d.sx, d.r * d.sy, d.r * d.sz); _m4.compose(_v.set(d.x, d.y, d.z), _q, _s); }
    else { _m4.makeScale(d.r * d.sx, d.r * d.sy, d.r * d.sz); _m4.setPosition(d.x, d.y, d.z); }
    pts.setMatrixAt(i, _m4);
  }
  pts.instanceMatrix.needsUpdate = true;
}
function clearPts() { for (let i = 0; i < PT_MAX; i++) { PTS[i].on = false; pts.setMatrixAt(i, _zeroM); } pts.instanceMatrix.needsUpdate = true; }
// 총구 불빛이 주변을 잠깐 밝힘
const FLASH = { I: 0 };
function muzzleLight(I) {
  camera.getWorldDirection(_fw);
  FLASH.I = Math.max(FLASH.I, I);
  LU.uFlash.value.set(camera.position.x + _fw.x * 0.6, camera.position.y - 0.1, camera.position.z + _fw.z * 0.6, FLASH.I);
}
function flashTick(dt) {
  FLASH.I = approach(FLASH.I, 0, 30, dt);
  LU.uFlash.value.w = FLASH.I < 0.01 ? 0 : FLASH.I;
}
// 소리 좌우: 내 오른쪽 방향 (cos yaw, -sin yaw) 으로 얼마나 치우쳤나
function panOf(x, z) {
  const dx = x - PL.x, dz = z - PL.z, L = Math.hypot(dx, dz) || 1;
  return clamp((dx * Math.cos(PL.yaw) - dz * Math.sin(PL.yaw)) / L, -1, 1) * 0.85;
}

// ── 손 움직임 ──
const VMS = { swayX: 0, swayY: 0, t: 0, lower: 0, sgRel: 0 };
function vmUpdate(dt) {
  VMS.t += dt;
  const dyaw = wrapAngle(PL.yaw - PL.lastYaw), dpitch = PL.pitch - PL.lastPitch;
  PL.lastYaw = PL.yaw; PL.lastPitch = PL.pitch;
  VMS.swayX = approach(VMS.swayX, clamp(dyaw * 2.2, -0.05, 0.05), 10, dt);
  VMS.swayY = approach(VMS.swayY, clamp(-dpitch * 2.2, -0.05, 0.05), 10, dt);
  const bob = PL.bobAmt;
  const bx = Math.sin(PL.bob) * 0.011 * bob, by = -Math.abs(Math.cos(PL.bob)) * 0.012 * bob + Math.sin(VMS.t * 1.7) * 0.0025;
  // 무기 바꿀 때 내렸다 올림
  let lower = 0;
  if (WEP.switchT > 0) lower = Math.sin((1 - WEP.switchT / 0.42) * Math.PI);
  VMS.lower = approach(VMS.lower, lower, 18, dt);
  const L = VM_LAYOUT;
  VM.root.position.set(bx + VMS.swayX, by + VMS.swayY - VMS.lower * 0.32, 0);
  VM.root.rotation.set(VMS.swayY * 1.5, VMS.swayX * 2.0, 0);
  if (WEP.cur === 'pistol' || (WEP.switchT > 0.21 && WEP.cur === 'pistol')) {
    const ps = WEP.pistol;
    const rk = ps.reloadT > 0 ? 1 - ps.reloadT / ps.dur : -1;
    for (const arm of VM.arms) {
      arm.rec = approach(arm.rec, 0, 11, dt);
      arm.flashT -= dt; arm.flash.visible = arm.flashT > 0;
      arm.slideT -= dt;
      arm.slide.position.z = arm.slideT > 0 ? 0.035 : approach(arm.slide.position.z, 0, 30, dt);
      const s = arm.side;
      let x = L.x * s, y = L.y, z = L.z, rx = 0.02, ry = 0.07 * s, rz = 0.1 * s;
      x -= Math.sin(PL.bob + (s > 0 ? 0 : 1.2)) * 0.004 * bob;
      z += arm.rec * 0.05; rx += arm.rec * 0.3; y += arm.rec * 0.01;
      // 달리기: 총구를 내리고 몸 쪽으로 모아 팔을 흔든다
      const R = PL.run;
      if (R > 0.001) {
        x -= s * 0.03 * R; y -= 0.07 * R + Math.sin(PL.bob + (s > 0 ? 0 : Math.PI)) * 0.014 * R; z += 0.05 * R;
        rx -= 0.62 * R; ry += s * 0.14 * R; rz += s * 0.3 * R;
      }
      if (rk >= 0) {
        // 재장전: 총구를 들고 안쪽으로 눕혀 빈 탄창을 떨구고, 아래로 탁 쳐서 새 탄창을 끼우고, 슬라이드
        const up = rk < 0.16 ? easeOutCubic(rk / 0.16) : rk < 0.8 ? 1 : 1 - easeInOutSine((rk - 0.8) / 0.2);
        const slam = rk > 0.48 && rk < 0.64 ? Math.sin((rk - 0.48) / 0.16 * Math.PI) : 0;
        x -= s * 0.035 * up; y += 0.012 * up - 0.035 * slam; z += 0.03 * up;
        rx += 0.5 * up - 0.3 * slam; rz += s * 0.6 * up; ry += s * 0.1 * up;
        if (rk > 0.76 && rk < 0.86) z += 0.05 * Math.sin((rk - 0.76) / 0.1 * Math.PI);
      }
      if (s > 0 && WEP.stabT > 0) {
        // 칼: 앞으로 아래로 찌름
        const k = 1 - WEP.stabT / 0.3, th = k < 0.35 ? easeOutCubic(k / 0.35) : 1 - easeInOutSine((k - 0.35) / 0.65);
        z -= 0.25 * th; y -= 0.03 + 0.06 * th; x -= 0.07 * th; rx -= 0.5 * th; ry += 0.25 * th;
      }
      if (s > 0 && WEP.stabT <= 0 && VM.knife.visible) { VM.knife.visible = false; arm.gun.visible = true; }
      arm.g.position.set(x, y, z);
      arm.g.rotation.set(rx, ry, rz);
    }
  }
  if (WEP.cur === 'shotgun') {
    const s = VM.shot, sg = WEP.shotgun;
    s.rec = approach(s.rec, 0, 7, dt);
    s.flashT -= dt; s.flash.visible = s.flashT > 0;
    s.pumpT -= dt;
    let pz = 0;
    if (s.pumpT > 0) { const k = 1 - s.pumpT / 0.42; pz = Math.sin(k * Math.PI) * 0.11; }
    s.pump.position.z = -0.36 + pz;
    let x = L.sx, y = L.sy, z = L.sz, rx = 0.035, ry = 0.06, rz = 0;
    z += s.rec * 0.1; rx += s.rec * 0.24; y += s.rec * 0.015;
    const R = PL.run;
    if (R > 0.001) { x -= 0.06 * R; y -= 0.05 * R + Math.abs(Math.sin(PL.bob)) * 0.012 * R; z += 0.03 * R; rx -= 0.28 * R; ry += 0.5 * R; rz += 0.42 * R; }
    // 한 발씩 넣는 동안 총을 눕혀 든다 (부드럽게 넘어가게)
    VMS.sgRel = approach(VMS.sgRel, sg.reloadT > 0 ? 1 : 0, 12, dt);
    const sr = VMS.sgRel;
    if (sr > 0.001) { rz += 0.45 * sr; x -= 0.04 * sr; y -= 0.03 * sr; rx += 0.12 * sr; }
    if (sg.reloadT > 0) { s.shell.visible = sg.shellT > 0.2; s.shell.position.set(-0.02, -0.05, -0.05 + (0.42 - sg.shellT) * 0.12); }
    else s.shell.visible = false;
    if (WEP.stabT > 0) { const k = 1 - WEP.stabT / 0.3, th = Math.sin(k * Math.PI); z -= 0.12 * th; rx -= 0.3 * th; x -= 0.06 * th; }
    s.g.position.set(x, y, z); s.g.rotation.set(rx, ry, rz);
  }
  // 떨어지는 탄창
  for (const mg of VM.mags) {
    if (!mg.m.visible) continue;
    mg.t += dt; mg.vy -= 3.2 * dt;
    mg.m.position.x += mg.vx * dt; mg.m.position.y += mg.vy * dt; mg.m.rotation.z += mg.vx * dt * 4;
    if (mg.t > 0.7) mg.m.visible = false;
  }
}
function dropMags() {
  for (let h = 0; h < 2; h++) {
    const mg = VM.mags[h], s = h ? -1 : 1;
    mg.m.visible = true; mg.t = 0; mg.vx = s * 0.05; mg.vy = -0.2;
    mg.m.position.set((VM_LAYOUT.x - 0.02) * s, VM_LAYOUT.y - 0.1, VM_LAYOUT.z + 0.04); mg.m.rotation.set(0.3, 0, 0);
  }
}


// ───────────────────────── 게임 상태 ─────────────────────────
const G = { state: 'title', t: 0, playT: 0, kills: 0, event: false, eventT: 0, spawnAcc: 0, overT: 0, exitT: 0, sensorT: -1, obj: '', heartT: 0, chorusT: 0, navT: 0 };
const MAX_EVENT = 15;
// 게임 시간 기준 예약 (멈춤 동안에는 안 흐름)
const LATER = [];
function later(sec, fn) { LATER.push({ t: G.t + sec, fn }); }
function laterTick() {
  if (!LATER.length) return;
  const due = [];
  for (let i = 0; i < LATER.length; i++) if (G.t >= LATER[i].t) due.push(LATER[i]);
  if (!due.length) return;
  for (const d of due) LATER.splice(LATER.indexOf(d), 1);
  for (const d of due) d.fn();
}

// ── 사람 움직임 ──
function notice(p, delay) {
  if (p.state !== 'idle' || p.noticeT >= 0) return;
  p.noticeT = delay;
  p.speakCD = Math.min(p.speakCD, delay + 0.2);
}
function rise(p) {
  p.state = 'rise'; p.rise = 0; p.riseDur = p.idle === 0 ? 0.45 : p.idle === 3 ? 0.8 : 1.0;
  if (p.idle === 3) sfxChair(panOf(p.x, p.z), clamp(1.2 - Math.hypot(p.x - PL.x, p.z - PL.z) * 0.08, 0.25, 1));
}
function noiseAlert(radius) {
  for (const p of live) {
    if (p.state !== 'idle') continue;
    const k = navIdx(p.x, p.z), d = k >= 0 ? NAV.dist[k] : -1;
    const m = d >= 0 ? d * 0.25 : Math.hypot(p.x - PL.x, p.z - PL.z) * 1.6;
    if (m < radius) notice(p, rand(0.15, 0.5));
  }
}
function tryCling(p) {
  const a = Math.atan2(p.x - PL.x, p.z - PL.z);
  let k0 = Math.round(a / (TAU / 8)); k0 = ((k0 % 8) + 8) % 8;
  const used = new Set(PL.clingers.map((q) => q.slot));
  for (const off of [0, 1, -1, 2, -2, 3, -3, 4]) {
    const k = (((k0 + off) % 8) + 8) % 8;
    if (used.has(k)) continue;
    p.state = 'cling'; p.slot = k; p.clingT = 0;
    p.ca = k * TAU / 8;
    if (p.kind === 2) {
      // 몸이 내 발밑으로 미끄러져 들어와 가슴께가 내 자리에 온다 (머리는 내가 온 쪽)
      p.kindC = 'ankle'; p.ca = p.yaw; p.cr = 0.12;
      PL.clingers.push(p);
      sfxGrab(panOf(p.x, p.z), 1.1); sfxDragStop(p);
      PL.shake = Math.max(PL.shake, 0.6);
      p.speakCD = rand(0.6, 1.6);
      if (p.vo) { p.vo.stop(0.05); p.vo = null; }
      return true;
    }
    // 내가 보는 쪽에 붙은 사람은 무릎 꿇고 올려다보고, 옆은 허리, 뒤는 등을 끌어안는다 (앞 시야를 다 가리지 않게)
    const rel = Math.abs(wrapAngle(Math.atan2(Math.sin(p.ca), Math.cos(p.ca)) - Math.atan2(-Math.sin(PL.yaw), -Math.cos(PL.yaw))));
    const kind = rel < 0.95 ? (Math.random() < 0.7 ? 'kneel' : 'low') : rel < 2.2 ? 'side' : 'stand';
    p.kindC = kind;
    p.cr = kind === 'stand' ? 0.6 : kind === 'kneel' ? 0.72 : kind === 'side' ? 0.58 : 0.7;
    PL.clingers.push(p);
    sfxGrab(panOf(p.x, p.z), 1);
    PL.shake = Math.max(PL.shake, 0.5);
    p.speakCD = rand(0.3, 1.2);
    if (p.vo) { p.vo.stop(0.05); p.vo = null; }
    return true;
  }
  return false;
}
function hurtPerson(p, dmg, part, dx, dz, hx, hy, hz, power, weapon) {
  if (p.state === 'dying') return;
  p.hp -= dmg;
  const head = part === 'head';
  bloodBurst(hx, hy, hz, dx, dz, head ? 18 : 8, head ? 1.25 : 0.9);
  // 뒤쪽 벽·바닥에 튄 피
  rayWalls(hx, hy, hz, dx, -0.08, dz, 2.8);
  if (RAY.hit && RAY.t < 2.8) {
    const wx = hx + dx * RAY.t, wy = hy - 0.08 * RAY.t, wz = hz + dz * RAY.t;
    addDecal(wx, wy, wz, RAY.nx, RAY.ny, RAY.nz, rand(0.35, 0.6) * (head ? 1.3 : 1), RAY.ny > 0.5 ? (Math.random() < 0.5 ? 0 : 1) : 5);
  }
  const pan = panOf(p.x, p.z), dist = Math.hypot(p.x - PL.x, p.z - PL.z), v = clamp(1.3 - dist * 0.07, 0.3, 1);
  sfxFlesh(v, pan);
  if (head) sfxHead(pan);
  if (p.state === 'idle' || p.state === 'rise') { p.state = 'chase'; p.rise = 1; p.look = 1; }
  if (p.hp <= 0) {
    killPerson(p, head ? 'head' : weapon, dx, dz, power);
    hitMarker(true);
  } else if (p.kind === 2) {
    p.stagger = head ? 0.5 : 0.32; p.spd = 0;
    p.flinch = 1;
    hitMarker(false);
  } else {
    p.stagger = head ? 0.36 : 0.24;
    p.kbx += dx * power * 0.9; p.kbz += dz * power * 0.9;
    hitMarker(false);
  }
}
function killPerson(p, how, dx, dz, power) {
  if (p.state === 'dying') return;
  if (p.state === 'cling') { const i = PL.clingers.indexOf(p); if (i >= 0) PL.clingers.splice(i, 1); }
  const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
  p.back = fx * dx + fz * dz < 0;
  p.state = 'dying'; p.dieT = 0; p.how = how; p.landed = false; p.pooled = false;
  p.corpse = makeCorpse(p.back); p.fallRoll = rand(-0.4, 0.4);
  p.fallT = how === 'shotgun' ? 0.4 : how === 'stab' ? 0.6 : 0.52;
  p.fly = how === 'shotgun' ? 0.22 : 0;
  p.kbx = dx * power * 1.5; p.kbz = dz * power * 1.5;
  if (p.kind === 2) { p.fallT = 0.22; p.fly = 0; p.kbx *= 0.15; p.kbz *= 0.15; sfxDragStop(p); }
  if (p.vo) { p.vo.stop(0.03); p.vo = null; }
  setFace(p, 3);
  G.kills++;
}
// 화면 안에 보이는지 (누운 사람은 쳐다보면 느려진다)
const VIEW = { fx: 0, fz: -1, cosHalf: 0.6 };
function viewUpdate() {
  VIEW.fx = -Math.sin(PL.yaw); VIEW.fz = -Math.cos(PL.yaw);
  const half = Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
  VIEW.cosHalf = Math.cos(half * 0.92);
}
function inView(x, z) { const dx = x - PL.x, dz = z - PL.z, L = Math.hypot(dx, dz) || 1; return (dx * VIEW.fx + dz * VIEW.fz) / L > VIEW.cosHalf; }
const _hd = { x: 0, z: 0 };
// 문틈 가까이에서는 비스듬히 누운 몸을 곧게 펴서 지나간다
let DOOR_PTS = null;
function nearDoor(x, z, r) {
  if (!DOOR_PTS) DOOR_PTS = GOSI.rooms.map((q) => q.door).concat(GOSI.specialDoors).map((q) => ({ x: (q.x0 + q.x1) / 2, z: (q.z0 + q.z1) / 2 }));
  for (const q of DOOR_PTS) if (Math.abs(q.x - x) < r && Math.abs(q.z - z) < r) return true;
  return false;
}
function lieTick(p, dt, d, dx, dz) {
  if (p.state === 'idle') {
    p.losT -= dt;
    if (p.losT <= 0 && p.noticeT < 0) {
      p.losT = 0.2;
      if ((d < 2.6 || (d < 8.5 && losClear(p.hc.x, p.hc.y + 0.1, p.hc.z, PL.x, PL.eye, PL.z))) && PL.z < 30.6) notice(p, rand(0.5, 1.0));
    }
    if (p.noticeT >= 0) {
      p.look = approach(p.look, 1, 2.5, dt);
      p.noticeT -= dt;
      if (p.noticeT < 0) { p.noticeT = 9; p.state = 'chase'; p.spd = 0; }
    }
    return;
  }
  // 누운 채로 미끄러져 온다: 쳐다보고 있으면 아주 느리게, 안 보면 빨라진다. 팔다리는 그대로.
  p.losT -= dt;
  if (p.losT <= 0) { p.losT = rand(0.12, 0.2); p.los = d < 16 && losClear(p.hc.x, p.hc.y + 0.12, p.hc.z, PL.x, PL.eye - 0.2, PL.z); }
  p.seen = p.los && inView(p.hc.x, p.hc.z);
  p.stagger -= dt;
  const target = p.stagger > 0 ? 0 : p.seen ? 0.22 : p.speed;
  p.spd = approach(p.spd, target, p.seen || p.stagger > 0 ? 7 : 1.8, dt);
  let tx = dx / d, tz = dz / d;
  if (!p.los && d > 1.4) { const nd = navDir(p.x, p.z); if (nd.d >= 0 && (nd.x || nd.z)) { tx = nd.x; tz = nd.z; } }
  p.dirx = approach(p.dirx, tx, 4, dt); p.dirz = approach(p.dirz, tz, 4, dt);
  const L = Math.hypot(p.dirx, p.dirz) || 1;
  p.x += (p.dirx / L) * p.spd * dt; p.z += (p.dirz / L) * p.spd * dt;
  p.skewMul = approach(p.skewMul === undefined ? 1 : p.skewMul, nearDoor(p.x, p.z, 1.35) ? 0 : 1, 3, dt);
  p.yaw = angleTo(p.yaw, Math.atan2(p.dirx, p.dirz) + p.skew * p.skewMul, p.skewMul < 0.9 ? 6 : 3.2, dt);
  if (p.yOff > 0) {
    const b = p.bed, m = 0.04;
    const onBed = b && p.x > b.x0 - m && p.x < b.x1 + m && p.z > b.z0 - m && p.z < b.z1 + m;
    if (!onBed) {
      p.yOff = Math.max(0, p.yOff - dt * 3.5);
      if (p.yOff === 0) sfxFall(clamp(1.1 - d * 0.08, 0.2, 0.9), panOf(p.x, p.z), p.los ? 0 : 800);
    }
  }
  // 몸통, 머리, 발 모두 벽에 걸리게
  collideCircle(p, 0.26, p.y + 0.05, p.y + 0.6);
  for (const [k, r] of [[-0.5, 0.25], [0.5, 0.17]]) {
    _hd.x = p.x + Math.sin(p.yaw) * k; _hd.z = p.z + Math.cos(p.yaw) * k;
    const bx = _hd.x, bz = _hd.z;
    collideCircle(_hd, r, p.y + 0.05, p.y + 0.6);
    p.x += _hd.x - bx; p.z += _hd.z - bz;
  }
  p.dragLv = p.spd;
  if (p.flinch > 0) p.flinch = Math.max(0, p.flinch - dt * 4);
  // 발끝이 내 발밑을 지나 몸이 반쯤 들어오면 다리를 붙잡는다
  if (Math.hypot(PL.x - p.x, PL.z - p.z) < 0.55 && p.stagger <= 0 && G.state === 'play') tryCling(p);
}
function crowdTick(dt) {
  crowdRepelT = Math.max(0, crowdRepelT - dt);
  G.navT -= dt;
  if (G.navT <= 0) { G.navT = 0.1; navBFS(PL.x, PL.z); }
  viewUpdate();
  for (let a = live.length - 1; a >= 0; a--) {
    const p = live[a];
    const dx = PL.x - p.x, dz = PL.z - p.z, d = Math.hypot(dx, dz) || 0.001;
    if (p.kind === 2 && (p.state === 'idle' || p.state === 'chase')) lieTick(p, dt, d, dx, dz);
    else if (p.state === 'idle') {
      p.losT -= dt;
      if (p.losT <= 0 && p.noticeT < 0) {
        p.losT = 0.15;
        if (d < 2.3 && PL.z < 30.6) notice(p, 0.12);
        else if (d < 13 && PL.z < 30.6 && losClear(p.hc.x, p.hc.y, p.hc.z, PL.x, PL.eye, PL.z)) {
          const facing = (Math.sin(p.yaw) * dx + Math.cos(p.yaw) * dz) / d;
          if (d < 6 || facing > -0.25) notice(p, rand(0.3, 0.75));
        }
      }
      if (p.noticeT >= 0) {
        p.look = approach(p.look, 1, 3.5, dt);
        p.noticeT -= dt;
        if (p.noticeT < 0) { p.noticeT = 9; rise(p); }
      }
    } else if (p.state === 'rise') {
      p.rise += dt / p.riseDur;
      p.yaw = angleTo(p.yaw, Math.atan2(dx, dz), 5, dt);
      if (p.rise >= 1) { p.rise = 1; p.state = 'chase'; }
    } else if (p.state === 'chase') {
      p.losT -= dt;
      if (p.losT <= 0) { p.losT = rand(0.16, 0.26); p.los = d < 15 && losClear(p.hc.x, p.hc.y - 0.15, p.hc.z, PL.x, PL.eye - 0.2, PL.z); }
      let tx = dx / d, tz = dz / d;
      if (!p.los && d > 1.4) { const nd = navDir(p.x, p.z); if (nd.d >= 0 && (nd.x || nd.z)) { tx = nd.x; tz = nd.z; } }
      if (crowdRepelT > 0) { tx = -dx / d; tz = -dz / d; }
      p.dirx = approach(p.dirx, tx, 7, dt); p.dirz = approach(p.dirz, tz, 7, dt);
      const L = Math.hypot(p.dirx, p.dirz) || 1;
      p.stagger -= dt;
      p.spd = approach(p.spd, p.stagger > 0 ? 0.2 : p.speed, p.stagger > 0 ? 12 : 3, dt);
      p.x += (p.dirx / L) * p.spd * dt + p.kbx * dt; p.z += (p.dirz / L) * p.spd * dt + p.kbz * dt;
      p.kbx *= Math.exp(-7 * dt); p.kbz *= Math.exp(-7 * dt);
      // 발소리: 뒤에서 다가와도 들리게
      p.stepAcc = (p.stepAcc || 0) + p.spd * dt;
      if (p.stepAcc > (p.kind ? 0.85 : 0.62)) {
        p.stepAcc = 0;
        if (d < 8 && G.state === 'play') sfxCrowdStep(clamp(0.95 - d * 0.1, 0.14, 0.8), panOf(p.x, p.z), p.kind === 1);
      }
      collideCircle(p, 0.25, p.y + 0.2, p.y + 1.4);
      const face = d < 3 ? Math.atan2(dx, dz) : Math.atan2(p.dirx, p.dirz);
      p.yaw = angleTo(p.yaw, face, p.kind ? 9 : 6, dt);
      p.phase += p.spd * dt * (p.kind ? 3.0 : 4.4);
      p.reach = approach(p.reach, d < 3.4 ? 1 : 0, 4, dt);
      if (d < 0.98 && p.stagger <= 0 && G.state === 'play') tryCling(p);
    } else if (p.state === 'cling') {
      p.clingT += dt;
      const tx = PL.x + Math.sin(p.ca) * p.cr, tz = PL.z + Math.cos(p.ca) * p.cr;
      p.x = approach(p.x, tx, 14, dt); p.z = approach(p.z, tz, 14, dt);
      if (p.kind === 2) { p.ca = p.yaw; p.yOff = 0; if (Math.hypot(PL.vx, PL.vz) > 0.3) p.yaw = angleTo(p.yaw, Math.atan2(-PL.vx, -PL.vz), 2.2, dt); }
      else p.yaw = angleTo(p.yaw, Math.atan2(PL.x - p.x, PL.z - p.z), 12, dt);
    } else if (p.state === 'dying') {
      p.dieT += dt;
      p.x += p.kbx * dt; p.z += p.kbz * dt;
      p.kbx *= Math.exp(-5 * dt); p.kbz *= Math.exp(-5 * dt);
      collideCircle(p, 0.3, p.y + 0.05, p.y + 1.0);
      if (!p.landed && p.dieT > p.fallT) {
        p.landed = true;
        const occl = !losClear(p.x, 0.5, p.z, PL.x, PL.eye, PL.z);
        sfxFall(clamp(1.2 - d * 0.08, 0.2, 1), panOf(p.x, p.z), occl ? 700 : 0);
        if (Math.random() < 0.7) sfxSplat(0.6, panOf(p.x, p.z));
      }
      if (!p.pooled && p.dieT > p.fallT + 0.25) {
        p.pooled = true;
        _v.set(0, 0.15, 0).applyMatrix4(CR.torso.matrixWorld);
        addDecal(lerp(p.x, p.ta.x, 0.5), p.y, lerp(p.z, p.ta.z, 0.5), 0, 1, 0, rand(0.9, 1.3), 3, 2.4);
      }
      if (p.dieT > p.fallT + 0.7) {
        animatePerson(p, dt);
        addCorpse(p);
        freeAlive(p.i);
        live.splice(a, 1);
        continue;
      }
    }
    p.y = approach(p.y, floorAt(p.x, p.z) + (p.yOff || 0), 12, dt);
    speechTick(p, dt, d);
    tearTick(p, dt, d);
    animatePerson(p, dt);
  }
  // 서로 겹치지 않게
  for (let a = 0; a < live.length; a++) {
    const p = live[a];
    if (p.state !== 'chase') continue;
    for (let b = a + 1; b < live.length; b++) {
      const q = live[b];
      if (q.state !== 'chase' && q.state !== 'cling' && q.state !== 'idle') continue;
      const dx = q.x - p.x, dz = q.z - p.z, d2 = dx * dx + dz * dz;
      if (d2 > 0.5 || d2 < 1e-6) continue;
      const d = Math.sqrt(d2), push = (0.7 - d) * 0.5;
      if (push <= 0) continue;
      const ux = dx / d, uz = dz / d;
      p.x -= ux * push; p.z -= uz * push;
      if (q.state === 'chase') { q.x += ux * push; q.z += uz * push; }
    }
  }
  flushCrowd();
  dragTick(dt);
}
// 누운 사람이 끌려오는 소리: 가까운 셋까지 (발목을 잡고 내게 끌려올 때도)
function dragTick(dt) {
  if (!ac || OFFLINE) return;
  const list = [];
  if (G.state === 'play') for (const p of live) {
    if (p.kind !== 2) continue;
    const sp = p.state === 'chase' ? p.spd : p.state === 'cling' ? Math.hypot(PL.vx, PL.vz) * 0.9 : 0;
    if (sp < 0.05) continue;
    const d = Math.hypot(p.x - PL.x, p.z - PL.z); if (d < 15) list.push([d, p, sp]);
  }
  list.sort((a, b) => a[0] - b[0]);
  dragAssign(list.slice(0, 3).map(([d, p, sp]) => ({ p, lv: clamp(0.18 + sp / 2.4, 0, 1) * Math.pow(1 - d / 15, 1.5), pan: panOf(p.x, p.z), occl: p.state === 'chase' && !p.los })), dt);
}
function angleTo(cur, target, k, dt) { return cur + wrapAngle(target - cur) * (1 - Math.exp(-k * dt)); }
function speechTick(p, dt, d) {
  if (p.state === 'dying') return;
  const talking = p.vo && !p.vo.stopped;
  if (p.state === 'cling') setFace(p, talking && Math.sin(G.t * 17 + p.seed) > 0 ? 1 : 2);
  else if (p.state === 'idle' && p.noticeT < 0) setFace(p, p.kind === 2 && talking && Math.sin(G.t * 19 + p.seed) > -0.2 ? 1 : 0);
  else setFace(p, talking && Math.sin(G.t * 19 + p.seed) > -0.2 ? 1 : 0);
  const lie = p.kind === 2;
  const lieIdle = lie && p.state === 'idle' && p.noticeT < 0;
  if (p.state === 'idle' && p.noticeT < 0 && !lie) return;
  p.speakCD -= dt;
  if (p.speakCD > 0) return;
  if (lieIdle) {
    // 혼자 누워서 훌쩍이며 중얼거림 (작게, 띄엄띄엄)
    p.speakCD = rand(4.5, 8.5);
    if (d > 11 || voicesPlaying() >= 5 || G.state !== 'play' || (p.vo && !p.vo.stopped)) return;
    const occ = !losClear(p.hc.x, p.hc.y + 0.1, p.hc.z, PL.x, PL.eye, PL.z);
    const h = playVoice(p.voiceKey, { rate: p.vrate * 0.97, gain: clamp(0.75 - d * 0.05, 0.12, 0.6) * (occ ? 0.7 : 1), pan: panOf(p.x, p.z), sob: 0.022, lp: occ ? 650 : 1500, verb: 0.42 });
    if (h) p.vo = h;
    return;
  }
  const cling = p.state === 'cling';
  p.speakCD = cling ? rand(2.0, 4.0) : rand(2.2, 4.8) * (d > 9 ? 1.4 : 1);
  if (talking || d > 19 || voicesPlaying() >= 6 || G.state !== 'play') return;
  const occl = !cling && !(p.state === 'chase' ? p.los : losClear(p.hc.x, p.hc.y, p.hc.z, PL.x, PL.eye, PL.z));
  const vol = (cling ? 0.62 : clamp(1.25 - d * 0.075, 0.2, 1)) * (occl ? 0.75 : 1);
  const key = cling ? p.voiceKey.replace(/^g_/, 'f_') : p.voiceKey;
  const h = playVoice(VO[key] ? key : p.voiceKey, { rate: p.vrate * (cling ? 0.96 : 1), gain: vol * (lie ? 0.85 : 1), pan: panOf(p.x, p.z), sob: lie ? 0.018 : cling ? 0.014 : 0.028, lp: occl ? 720 : lie ? 1900 : d > 9 ? 2600 : 0, verb: occl ? 0.5 : lie ? 0.38 : 0.32 });
  if (h && lie) p.speakCD += rand(1.0, 2.5);
  if (h) p.vo = h;
}
function tearTick(p, dt, d) {
  if (d > 9 || p.state === 'dying') return;
  p.tearT -= dt;
  if (p.tearT > 0) return;
  p.tearT = rand(0.28, 0.6);
  const e = Math.random() < 0.5 ? p.e1 : p.e2;
  tear(e.x, e.y - 0.06, e.z);
}

// ── 처음 배치 ──
const roomBy = (num) => LEVEL.rooms.find((r) => r.num === num);
// 문 상태: 사람이 있는 방은 열려 있고, 몇 개는 열려 있거나 살짝 열려 있다. 끝방은 살짝.
function initDoors() {
  const R = rng(77);
  for (const g of LEVEL.gdoors) {
    if (!g.num) { g.init = 0.42; continue; }
    const v = R(), w = R();
    if (LURK_ROOMS[g.num]) g.init = 1.32 + w * 0.1;
    else g.init = v < 0.12 ? 1.2 + w * 0.3 : v < 0.22 ? 0.16 + w * 0.3 : 0;
  }
  gdoorReset();
}
function spawnLurkers() {
  const put = (x, z, opt) => { const p = newPerson(x, z, opt); if (p) { computePose(p, 0, p.pose); writeCrowdInstance(p); } return p; };
  // 누운 사람: 머리를 내가 올 쪽으로 두고 (머리 방향 = (-sin yaw, -cos yaw))
  const lie = (x, z, hx, hz, yOff = 0, bed = null) => { const p = put(x, z, { state: 'idle', kind: 2, yaw: Math.atan2(-hx, -hz), yOff }); if (p) { p.bed = bed; if (!bed) { p.yaw += p.skew * 0.8; computePose(p, 0, p.pose); writeCrowdInstance(p); } } return p; };
  lie(16.5, 19.4, 0, -1);           // 현관 복도 바닥: 발을 로비 쪽으로
  lie(12.0, 1.5, -1, 0);            // 끝방 가는 복도 바닥: 발을 오는 쪽으로
  // 벽을 보고 선 사람
  for (const [x, z, yaw] of [[21.6, 21.85, Math.PI], [14.0, 8.65, 0], [20.2, 4.6, -Math.PI / 2], [6.0, 14.95, Math.PI], [31.55, 18.6, Math.PI / 2], [7.85, 19.3, Math.PI]]) put(x, z, { state: 'idle', idle: 0, yaw: yaw + rand(-0.15, 0.15) });
  // 주방 구석에 쭈그려 앉은 사람
  put(26.35, 10.95, { state: 'idle', idle: 2, yaw: Math.PI / 2 });
  // 방 안: 책상 앞, 바닥, 침대 위
  for (const [num, how] of Object.entries(LURK_ROOMS)) {
    const r = roomBy(num); if (!r) continue;
    const W = r.rect[2] - r.rect[0], X = (a) => r.rect[0] + a, Z = (d) => r.zr + d * r.inZ;
    if (how === 'desk') put(r.left ? X(0.51) : X(W - 0.51), Z(1.58), { state: 'idle', idle: 3, yaw: r.inZ > 0 ? 0 : Math.PI });
    else if (how === 'floor') put(r.left ? X(0.62) : X(W - 0.62), Z(1.05), { state: 'idle', idle: 1, yaw: r.inZ > 0 ? Math.PI : 0 });
    else lie(r.bed.x, Z(1.42), 0, r.inZ, 0.56, r.bedRect);    // 침대에 누워 발은 문 쪽으로
  }
  flushCrowd();
}
// 어두운 곳, 안 보이는 곳에서 나타남
let SPAWN_RECTS = null;
function lyingAlive() { let n = 0; for (const p of live) if (p.kind === 2 && p.state !== 'dying') n++; return n; }
function spawnHidden(lieOnly = false) {
  if (!lieOnly && Math.random() < 0.5 && burstRoom()) return true;
  if (!SPAWN_RECTS) SPAWN_RECTS = GOSI.regions.filter((r) => r.type === 'cor' || r.type === 'kitchen' || r.type === 'shower').map((r) => r.rect);
  for (let tries = 0; tries < 30; tries++) {
    const r = pick(SPAWN_RECTS);
    const x = rand(r[0] + 0.45, r[2] - 0.45), z = rand(r[1] + 0.45, r[3] - 0.45);
    const k = navIdx(x, z); if (k < 0 || !navFree(k) || NAV.dist[k] < 0) continue;
    const dm = NAV.dist[k] * 0.25;
    if (dm < 10.5 || dm > 26) continue;
    if (losClear(PL.x, PL.eye, PL.z, x, 1.2, z)) continue;
    const lie = lieOnly || (lyingAlive() < 3 && Math.random() < 0.12);
    const runner = !lie && Math.random() < (G.eventT > 12 ? 0.38 : 0.26);
    const p = lie ? newPerson(x, z, { state: 'chase', kind: 2, yaw: Math.atan2(PL.x - x, PL.z - z) + rand(-0.8, 0.8) })
      : newPerson(x, z, { state: 'chase', kind: runner ? 1 : 0, yaw: Math.atan2(PL.x - x, PL.z - z), fast: 1.25 });
    if (p) { p.speakCD = rand(0.3, 2.5); return true; }
  }
  return false;
}
// 닫힌 방문이 벌컥 열리고 사람이 나온다. 누운 사람은 문이 스르륵 열리고 미끄러져 나온다.
function burstRoom(o = {}) {
  const lo = o.min || 5, hi = o.max || 18;
  const cand = [];
  for (const g of LEVEL.gdoors) {
    if (!g.num || g.target > 0.85 || g.a > 0.85) continue;
    const k = navIdx(g.cx, g.cz); if (k < 0 || NAV.dist[k] < 0) continue;
    const dm = NAV.dist[k] * 0.25;
    if (dm < lo || dm > hi) continue;
    cand.push(g);
  }
  if (!cand.length) return o.lie ? spawnHidden(true) : null;
  const g = pick(cand);
  const ix = g.n[0], iz = g.n[1];
  const mx = (g.x0 + g.x1) / 2, mz = (g.z0 + g.z1) / 2;
  const lie = o.lie !== undefined ? o.lie : lyingAlive() < 3 && Math.random() < 0.24;
  const dist = Math.hypot(mx - PL.x, mz - PL.z), pan = panOf(mx, mz);
  const occl = !losClear(PL.x, PL.eye, PL.z, g.cx, 1.0, g.cz);
  let p;
  if (lie) {
    p = newPerson(mx + ix * 0.95, mz + iz * 0.95, { state: 'chase', kind: 2, yaw: Math.atan2(-ix, -iz) });
    if (!p) return null;
    gdoorSet(g, rand(1.3, 1.5), 1.7);
    if (ac) sfxCreak(ac.currentTime, 1.7, clamp(1.15 - dist * 0.06, 0.25, 0.9), rand(150, 185));
    p.spd = 0.4;
  } else {
    const runner = Math.random() < (G.eventT > 12 ? 0.4 : 0.28);
    p = newPerson(mx + ix * 0.6, mz + iz * 0.6, { state: 'chase', kind: runner ? 1 : 0, yaw: Math.atan2(-ix, -iz), fast: 1.2 });
    if (!p) return null;
    gdoorSet(g, rand(1.4, 1.55), 15);
    sfxDoorBang(pan, clamp(1.3 - dist * 0.06, 0.3, 1.1), occl ? 900 : 0);
    if (dist < 9) PL.shake = Math.max(PL.shake, 0.18);
  }
  p.los = false; p.losT = 0.05; p.speakCD = rand(0.2, 1.4);
  return p;
}

// ── 불 ──
let panelDirty = false;
const _scrOff = new THREE.Color('#1d2026'), _scrOn = new THREE.Color('#ffffff');
function lightsTick(dt) {
  for (const f of FIX) {
    if (f.pendingDie > 0) { f.pendingDie -= dt; if (f.pendingDie <= 0) { f.mode = 'dying'; f.dieT = rand(0.25, 0.9); } }
    if (f.kind === 'panel') { f.near = Math.hypot(f.x - PL.x, f.z - PL.z); f.pan = f.near < 9 ? panOf(f.x, f.z) : 0; }
    const before = f.I;
    if (f.kind === 'spill') {
      const target = DOORS.inner.open ? clamp(LEVEL.lobbyLight.I, 0, 1) * clamp(DOORS.inner.a / 1.2, 0, 1) : 0;
      f.I = target; fixApply(f, target);
    } else fixTick(f, dt);
    if (f.mesh >= 0 && Math.abs(before - f.I) > 0.001) {
      LEVEL.panels.setColorAt(f.mesh, _col.setRGB(f.I, 0, 0)); LEVEL.glows.setColorAt(f.mesh, _col.setRGB(f.I, 0, 0));
      panelDirty = true;
    }
  }
  if (panelDirty) { LEVEL.panels.instanceColor.needsUpdate = true; LEVEL.glows.instanceColor.needsUpdate = true; panelDirty = false; }
  for (const { m, f } of LEVEL.lampMeshes) m.material.color.setScalar(lerp(0.55, 1.0, clamp(f.I, 0, 1)));
  // 끝방 알전구, 방마다 모니터
  if (LEVEL.bulbFix) { const k = clamp(LEVEL.bulbFix.I, 0, 1); LEVEL.bulb.material.color.setRGB(lerp(0.22, 1, k), lerp(0.2, 0.95, k), lerp(0.16, 0.77, k)); }
  if (LEVEL.gunScr) LEVEL.gunScr.material.color.copy(_scrOff).lerp(_scrOn, clamp(LEVEL.gunScreen.I, 0, 1));
  let scrDirty = false;
  for (const r of LEVEL.rooms) {
    if (!r.fix) continue;
    const I = clamp(r.fix.I, 0, 1);
    if (r.scrI !== undefined && Math.abs(r.scrI - I) < 0.04) continue;
    r.scrI = I; LEVEL.furn.screens.m.setColorAt(r.screen, _col.copy(_scrOff).lerp(_scrOn, I)); scrDirty = true;
  }
  if (scrDirty) LEVEL.furn.screens.m.instanceColor.needsUpdate = true;
  lfFlush();
  // 형광등 웅: 고시원 안에서는 밝은 만큼, 집 안에서는 문 너머로 먹먹하게
  if (ac && HUM.on) {
    const l = PL.inHouse ? (DOORS.inner.open ? 0.55 : 0.4) : clamp(lfAtCPU(PL.x, PL.z) * 0.95, 0, 1);
    humSet(l, !PL.inHouse || DOORS.inner.a > 0.4);
  }
}
function resetLights() {
  for (const f of FIX) { f.mode = f.start; f.pendingDie = 0; f.burst = 0; f.after = ''; f.ft = rand(0, 3); f.base = 1; f.I = f.mode === 'on' ? 1 : 0; fixApply(f, f.I); if (f.mesh >= 0) { LEVEL.panels.setColorAt(f.mesh, _col.setRGB(f.I, 0, 0)); LEVEL.glows.setColorAt(f.mesh, _col.setRGB(f.I, 0, 0)); } }
  LEVEL.panels.instanceColor.needsUpdate = true; LEVEL.glows.instanceColor.needsUpdate = true;
  for (const r of LEVEL.rooms) r.scrI = undefined;
  lfFlush();
}
// 길찾기 격자 위의 가장 짧은 길 (a → b)
function navPath(ax, az, bx, bz) {
  const nx = NAV.nx, n = nx * NAV.nz, d = new Int32Array(n).fill(-1), q = new Int32Array(n);
  const s = navNearestFree(navIdx(bx, bz)), e = navNearestFree(navIdx(ax, az));
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  let h = 0, t = 0; q[t++] = s; d[s] = 0;
  while (h < t) {
    const k = q[h++]; if (k === e) break;
    const i = k % nx, j = (k / nx) | 0;
    for (const [di, dj] of N4) {
      const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= NAV.nz) continue;
      const kk = jj * nx + ii; if (d[kk] >= 0 || !navFree(kk)) continue;
      d[kk] = d[k] + 1; q[t++] = kk;
    }
  }
  const out = [];
  if (d[e] < 0) return out;
  let k = e;
  for (let guard = 0; guard < n && k !== s; guard++) {
    out.push(k);
    const i = k % nx, j = (k / nx) | 0; let nk = -1;
    for (const [di, dj] of N4) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= nx || jj >= NAV.nz) continue; const kk = jj * nx + ii; if (d[kk] === d[k] - 1) { nk = kk; break; } }
    if (nk < 0) break; k = nk;
  }
  out.push(s);
  return out.map((c) => ({ x: NAV.x0 + (c % nx + 0.5) * NAV.cs, z: NAV.z0 + (((c / nx) | 0) + 0.5) * NAV.cs }));
}

// ── 무기 줍기 → 불이 나감 ──
function pickupTick() {
  for (const a of LEVEL.ammo) {
    if (a.taken) continue;
    if (Math.hypot(a.x - PL.x, a.z - PL.z) < 0.85) {
      a.taken = true; a.m.visible = false;
      WEP.pistol.res += a.n;
      sfxAmmo(); showNotice(`권총 탄약 +${a.n}`); hudAmmo(true);
    }
  }
  const gun = LEVEL.gun;
  if (!gun.taken) {
    gun.spark.material.opacity = 0.55 + 0.45 * Math.sin(G.t * 4.5);
    const s = 0.4 + 0.12 * Math.sin(G.t * 4.5); gun.spark.scale.set(s, s, 1);
    if (Math.hypot(gun.x - PL.x, gun.z - PL.z) < 1.3) {   // 침대 위에 있어서 손을 뻗는 거리
      gun.taken = true; gun.m.visible = false; gun.spark.visible = false;
      WEP.hasShotgun = true;
      sfxGetGun(); showNotice('산탄총');
      switchWeapon('shotgun');
      $('swap').hidden = false; setSwapIcon();
      startEvent();
    }
  }
}
function startEvent() {
  G.event = true; G.eventT = 0; G.spawnAcc = -2.2;
  // 끝방에서 로비까지 가는 길의 형광등만 희미하게 남고 나머지는 꺼진다. 방 모니터도 다 꺼진다.
  const path = navPath(LEVEL.gun.x, LEVEL.gun.z, 16.5, 29.2);
  const gx = LEVEL.gun.x, gz = LEVEL.gun.z;
  for (const f of FIX) {
    if (f.kind === 'room') { f.pendingDie = rand(0.4, 1.6); continue; }
    if (f.kind !== 'panel') continue;
    let near = 1e9; for (const c of path) near = Math.min(near, Math.hypot(c.x - f.x, c.z - f.z));
    const dgun = Math.hypot(f.x - gx, f.z - gz);
    if (near < 1.7) { f.pendingDie = 0; f.mode = 'flicker'; f.burst = 0.6 + dgun * 0.012; f.after = 'path'; }
    else f.pendingDie = 0.5 + dgun * 0.035 + rand(0, 0.25);
  }
  later(0.45, () => { if (!G.event) return; sfxBreaker(); PL.shake = Math.max(PL.shake, 0.5); });
  later(1.25, () => { if (!G.event) return; humKill(); for (const f of FIX) if (f.after === 'path') { f.mode = 'path'; f.base = 0.72; f.after = ''; } });
  // 사방에서 들려오는 목소리
  later(2.3, () => {
    if (!G.event || G.state !== 'play') return;
    const keys = [...F_KEYS_F, ...F_KEYS_M];
    for (let i = 0; i < 7; i++) playVoice(pick(keys), { rate: rand(0.9, 1.08), gain: rand(0.28, 0.5), pan: rand(-0.9, 0.9), sob: 0.03, lp: rand(500, 900), verb: 0.7, delay: i * rand(0.12, 0.3) });
  });
  // 근처 방에서 누운 사람들이 스르륵 미끄러져 나온다
  later(3.0, () => { if (G.event && G.state === 'play') burstRoom({ lie: true, min: 2.5, max: 11 }); });
  later(5.2, () => { if (G.event && G.state === 'play') burstRoom({ lie: true, min: 4, max: 14 }); });
  for (const p of live) if (p.state === 'idle') notice(p, rand(0.6, 2.2));
}
function eventTick(dt) {
  if (!G.event) return;
  G.eventT += dt;
  if (G.state !== 'play') return;
  let alive = 0; for (const p of live) if (p.state !== 'dying') alive++;
  G.spawnAcc += dt;
  const every = G.eventT < 10 ? 1.2 : 0.95;
  if (G.spawnAcc > every && alive < MAX_EVENT && G.eventT > 2.4) { G.spawnAcc = 0; spawnHidden(); }
  G.chorusT -= dt;
  if (G.chorusT <= 0 && G.eventT > 3) {
    G.chorusT = rand(0.8, 1.8);
    if (voicesPlaying() < 5) playVoice(pick([...F_KEYS_F, ...F_KEYS_M]), { rate: rand(0.9, 1.08), gain: rand(0.15, 0.3), pan: rand(-0.9, 0.9), sob: 0.03, lp: rand(450, 800), verb: 0.75 });
  }
}

// ── 문 ──
function doorsTick(dt) {
  const d = DOORS.inner;
  if (!d.open && Math.abs(PL.x - DOOR.x) < 0.9 && PL.z < DOOR.z + 1.25 && PL.z > DOOR.z - 1.2 && G.state === 'play') {
    d.open = true; d.target = 1.75;
    d.wall.off = true; DOORS.innerOpenWall.off = false;
    DOORS.strip.visible = false; DOORS.pool.visible = false;
    NAV.doorBlock = false; NAV.src = -1;
    if (ac) { sfxLatch(ac.currentTime, 0.8); sfxCreak(ac.currentTime + 0.05, 1.1, 0.8, 175); }
  }
  doorTick(d, dt, 3.0);
  doorTick(DOORS.front, dt, 2.6);
  // 고시원 방문
  gdoorTick(dt);
  // 끝방 문: 가까이 가면 저절로 스르륵 열린다
  const gd = LEVEL.gunDoor;
  if (gd && gd.target < 1.0 && G.state === 'play' && Math.hypot(PL.x - gd.cx, PL.z - gd.cz) < 2.3) {
    gdoorSet(gd, 1.45, 1.5);
    if (ac) sfxCreak(ac.currentTime, 2.0, 0.8, 160);
  }
}

// ── 붙잡힘 ──
function pressureTick(dt) {
  const n = PL.clingers.length;
  if (n) PL.pressure += dt * (0.1 + 0.12 * (n - 1));
  else PL.pressure = Math.max(0, PL.pressure - dt * 0.35);
  if (PL.pressure > 0.25) {
    G.heartT -= dt;
    if (G.heartT <= 0) { G.heartT = 0.8 - PL.pressure * 0.38; sfxHeart(0.5 + PL.pressure * 0.6); }
  }
  if (PL.pressure >= 1 && G.state === 'play') gameOver();
}
// 다 쓸어버리고 "싫어."
function gameOver() {
  G.state = 'over'; G.overT = 0;
  INPUT.fire = false;
  // 주변(보이는 곳, 바로 옆)만
  const near = (p) => { const d = Math.hypot(p.x - PL.x, p.z - PL.z); return d < 3.2 || (d < 9 && losClear(PL.x, PL.eye, PL.z, p.hc.x, p.hc.y, p.hc.z)); };
  const targets = live.filter((p) => p.state !== 'dying' && near(p)).sort((a, b) => Math.hypot(a.x - PL.x, a.z - PL.z) - Math.hypot(b.x - PL.x, b.z - PL.z)).slice(0, 24);
  G.sweep = targets.map((p, i) => ({ p, t: 0.15 + i * 0.075 }));
  G.sweepEnd = 0.15 + targets.length * 0.075 + 0.55;
  G.said = false;
}
function overTick(dt) {
  G.overT += dt;
  for (const s of G.sweep) {
    if (s.done || G.overT < s.t) continue;
    s.done = true;
    const p = s.p; if (p.state === 'dying') continue;
    const h = WEP.cur === 'pistol' ? (s.t * 13 | 0) % 2 : 0;
    if (WEP.cur === 'pistol') { const arm = VM.arms[h]; arm.rec = 1; arm.flashT = 0.05; arm.slideT = 0.08; sfxPistol(h ? -0.25 : 0.25); }
    else { VM.shot.rec = 1; VM.shot.flashT = 0.06; sfxShotgun(); }
    muzzleLight(1.4);
    const dx = p.x - PL.x, dz = p.z - PL.z, L = Math.hypot(dx, dz) || 1;
    bloodBurst(p.hc.x, p.hc.y, p.hc.z, dx / L, dz / L, 14, 1.2);
    killPerson(p, 'head', dx / L, dz / L, 1.2);
    sfxHead(panOf(p.x, p.z));
  }
  PL.clingers.length = 0;
  PL.pressure = Math.max(0, PL.pressure - dt * 1.5);
  if (!G.said && G.overT > G.sweepEnd) {
    G.said = true;
    const say = $('say'); say.hidden = false; say.classList.remove('go'); void say.offsetWidth; say.classList.add('go');
    playVoice('p_no', { gain: 1.0, verb: 0.2 });
  }
  if (G.overT > G.sweepEnd + 1.7 && !G.ending) { G.ending = true; fadeTo('#ffffff', 0.8, showResult); }
}
// 현관문을 열고 나감
function exitTick(dt) {
  if (G.state === 'play' && PL.z > FRONT.z - 0.75 && Math.abs(PL.x - FRONT.x) < 0.75) {
    if (G.event) {
      G.state = 'exit'; G.exitT = 0;
      DOORS.front.target = 1.6; DOORS.front.wall.off = true;
      sfxOut();
      INPUT.fire = false;
    } else if (G.t > G.rattleT) {
      // 총을 찾기 전에는 현관문이 안 열린다
      G.rattleT = G.t + 1.3;
      sfxRattle();
      DOORS.front.a = 0.03;
    }
  }
  if (G.state === 'exit') {
    G.exitT += dt;
    if (G.exitT > 0.35 && !G.ending) { G.ending = true; fadeTo('#ffffff', 0.9, LINK ? goOutside : showResult); }
  }
}
// 밖으로: 하얗게 된 채로 원래 게임으로 돌아가 그 자리에서 이어진다
function goOutside() {
  G.state = 'leaving';
  const shells = WEP.hasShotgun ? WEP.shotgun.mag + WEP.shotgun.res : 0;
  const hash = linkWrite({ dir: 'out', kills: LINK_KILLS + G.kills, shells, main: LINK.main || {} });
  stopAllVoices(); humStop(); sfxDragAllStop();
  if (document.pointerLockElement) document.exitPointerLock();
  location.replace('./' + location.search + hash);
}

// ── 화면 위 글자 ──
const els = { hudN: $('hudN'), xhair: $('xhair'), hitm: $('hitm'), obj: $('obj'), objArrow: $('objArrow'), ammo: $('ammo'), ammoName: $('ammoName'), ammoMag: $('ammoMag'), ammoRes: $('ammoRes'), prompt: $('prompt'), notice: $('notice'), vig: $('vig'), fire: $('fire'), fade: $('fade') };
let lastAmmo = '';
function hudAmmo(pop) {
  const pistol = WEP.cur === 'pistol';
  const mag = pistol ? pistolLoaded() : WEP.shotgun.mag, res = pistol ? WEP.pistol.res : WEP.shotgun.res;
  const infinite = GUN_MOD.infiniteAmmo;
  const s = WEP.cur + '|' + mag + '|' + res + '|' + infinite;
  if (s === lastAmmo) return;
  lastAmmo = s;
  els.ammoName.textContent = pistol ? '권총' : '산탄총';
  els.ammoMag.textContent = infinite ? '∞' : mag; els.ammoRes.textContent = '/ ' + (infinite ? '∞' : res);
  els.ammo.classList.toggle('low', !infinite && (pistol ? mag <= 3 : mag <= 1));
  if (pop) { els.ammoMag.classList.remove('pop'); void els.ammoMag.offsetWidth; els.ammoMag.classList.add('pop'); }
  setSwapIcon();
}
let hitT = 0;
function hitMarker(kill) {
  els.hitm.classList.toggle('kill', kill);
  els.hitm.classList.remove('go'); void els.hitm.offsetWidth; els.hitm.classList.add('go');
  sfxHitTick(kill);
}
let noticeTok = 0;
function showNotice(txt) {
  els.notice.textContent = txt; els.notice.hidden = false;
  els.notice.classList.remove('go'); void els.notice.offsetWidth; els.notice.classList.add('go');
  const tok = ++noticeTok;
  later(1.85, () => { if (tok === noticeTok) els.notice.hidden = true; });
}
const SWAP_SVG = {
  pistol: '<path d="M9 22h40l3-3h5v9h-4v4H32l-2 3h-6l-3 13a3 3 0 0 1-3 2.4h-6a2 2 0 0 1-2-2.5l4-14.4L9 30z" fill="#1f1a24"/>',
  shotgun: '<path d="M4 25h40l2-2h12v6H40l-4 2h-9l-2 2H15l-6 9H3l4-11z" fill="#1f1a24"/><rect x="27" y="29" width="13" height="5" rx="1.5" fill="#8a4f2a"/>',
};
function setSwapIcon() { $('swapIcon').innerHTML = SWAP_SVG[WEP.cur === 'pistol' ? 'shotgun' : 'pistol']; }
// ── 화면 밖에서 다가오는 사람 방향 표시 (FPS의 위협 방향 표시) ──
const THR = { box: $('threat'), els: [], tw: 0 };
for (let i = 0; i < 6; i++) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '-100 -100 200 200');
  s.innerHTML = '<path d="M-36 -84.6A92 92 0 0 1 36 -84.6" fill="none" stroke="#1f1a24" stroke-opacity=".55" stroke-width="15" stroke-linecap="round"/><path d="M-36 -84.6A92 92 0 0 1 36 -84.6" fill="none" stroke="#ff2b40" stroke-width="8.5" stroke-linecap="round"/>';
  THR.box.appendChild(s);
  THR.els.push({ el: s, p: null, tgt: null, a: 0, o: 0, wa: 999, wo: -1 });
}
function threatReset() { for (const T of THR.els) { T.p = null; T.tgt = null; T.o = 0; T.wo = 0; T.el.style.opacity = 0; } }
function threatTick(dt) {
  const tw = Math.round(Math.min(VW, VH) * 0.8);
  if (tw !== THR.tw) { THR.tw = tw; THR.box.style.setProperty('--tw', tw + 'px'); }
  const want = [];
  if (G.state === 'play') {
    const cy = Math.cos(PL.yaw), sy = Math.sin(PL.yaw);
    const half = Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect) * 0.85;
    for (const p of live) {
      const cl = p.state === 'cling';
      if (!cl && p.state !== 'chase') continue;
      const dx = p.x - PL.x, dz = p.z - PL.z, d = Math.hypot(dx, dz);
      if (d > 10) continue;
      const a = Math.atan2(dx * cy - dz * sy, -dx * sy - dz * cy);   // 0 앞, + 오른쪽, ±π 뒤
      if (Math.abs(a) < half && (cl || p.los)) continue;             // 화면에 보이는 사람은 표시 안 함
      if (!cl && !p.los) { const k = navIdx(p.x, p.z); if (k < 0 || NAV.dist[k] < 0 || NAV.dist[k] * 0.25 > 9) continue; }
      want.push({ p, a, d, cl, taken: false });
    }
    want.sort((u, v) => u.d - v.d);
    if (want.length > THR.els.length) want.length = THR.els.length;
  }
  // 이미 맡은 사람은 계속 따라가고, 빈 표시에 새 사람을 붙인다
  for (const T of THR.els) {
    const w = T.p ? want.find((x) => x.p === T.p) : null;
    if (w) { w.taken = true; T.tgt = w; } else T.tgt = null;
  }
  for (const w of want) {
    if (w.taken) continue;
    const T = THR.els.find((t) => !t.tgt && t.o < 0.05);
    if (!T) continue;
    T.p = w.p; T.tgt = w; T.a = w.a; w.taken = true;
  }
  for (const T of THR.els) {
    const w = T.tgt;
    if (w) {
      T.a += wrapAngle(w.a - T.a) * (1 - Math.exp(-16 * dt));
      const base = w.cl ? 1 : clamp(1.2 - w.d / 9, 0.3, 1);
      const pulse = w.d < 3.5 ? 0.72 + 0.28 * Math.sin(G.t * 12) : 1;
      T.o = approach(T.o, base * pulse, 12, dt);
    } else {
      T.o = approach(T.o, 0, 6, dt);
      if (T.o < 0.02) T.p = null;
    }
    const deg = Math.round(T.a * 360 / Math.PI) / 2, op = Math.round(T.o * 50) / 50;
    if (deg !== T.wa) { T.wa = deg; T.el.style.transform = `rotate(${deg}deg)`; }
    if (op !== T.wo) { T.wo = op; T.el.style.opacity = op; }
  }
}
let lastSpread = -1, lastPrompt = '', objShown = '', lastVig = -1, lastKnife = null, lastRun = false, lastStickRun = false, lastKills = -1;
const stickBox = $('stick');
let lastLockHint = false;
function hudTick(dt = 1 / 60) {
  threatTick(dt);
  // 친구 요청 거절: 밖에서 센 것까지 합쳐서
  const kn = LINK_KILLS + G.kills;
  if (kn !== lastKills) {
    const pop = lastKills >= 0 && kn > lastKills; lastKills = kn; els.hudN.textContent = kn;
    if (pop) { els.hudN.classList.remove('pop'); void els.hudN.offsetWidth; els.hudN.classList.add('pop'); }
  }
  // PC: 마우스가 아직 안 잡혔으면 클릭하라고 알려 준다 (안 그러면 마우스를 움직여도 시점이 안 돌아서 헷갈림)
  const lh = G.state === 'play' && !IS_TOUCH && !LOCKED && !FALLBACK && !PAUSED;
  if (lh !== lastLockHint) { lastLockHint = lh; $('lockHint').hidden = !lh; }
  const sp = Math.round(7 + WEP.bloom * 260 + Math.min(1, Math.hypot(PL.vx, PL.vz) / 3.5) * 5);
  if (sp !== lastSpread) { els.xhair.style.setProperty('--s', sp + 'px'); lastSpread = sp; }
  const knife = PL.clingers.length > 0;
  if (knife !== lastKnife) { lastKnife = knife; els.xhair.classList.toggle('knife', knife); els.fire.classList.toggle('knife', knife); els.fire.classList.toggle('pulse', knife); }
  const runV = PL.run > 0.5 && !knife;
  if (runV !== lastRun) { lastRun = runV; els.xhair.classList.toggle('run', runV); }
  // 스틱 손잡이는 실제로 달리고 있을 때만 노랗게 (붙잡혀서 못 달릴 땐 흰색)
  const sr = PL.running && INPUT.stickRun;
  if (sr !== lastStickRun) { lastStickRun = sr; stickBox.classList.toggle('run', sr); }
  // 안내 문구
  let pr = '';
  const ps = WEP.pistol;
  if (G.state === 'play') {
    if (WEP.cur === 'pistol' && ps.reloadT <= 0 && pistolLoaded() === 0) pr = ps.res > 0 ? (IS_TOUCH ? '재장전' : 'R 재장전') : (WEP.hasShotgun && WEP.shotgun.mag + WEP.shotgun.res > 0 ? '' : '탄약 없음');
    if (WEP.cur === 'shotgun' && WEP.shotgun.mag === 0 && WEP.shotgun.reloadT <= 0) pr = WEP.shotgun.res > 0 ? (IS_TOUCH ? '재장전' : 'R 재장전') : '';
  }
  if (pr !== lastPrompt) { lastPrompt = pr; els.prompt.textContent = pr; els.prompt.hidden = !pr; }
  const v = Math.round(clamp(PL.pressure, 0, 1) * (0.75 + 0.25 * Math.sin(G.t * 9)) * 100) / 100;
  if (v !== lastVig) { lastVig = v; els.vig.style.opacity = v; els.vig.style.visibility = v > 0 ? 'visible' : 'hidden'; }
  // 목표 화살표
  let tx = null, tz = null, key = '';
  if (G.state === 'play') {
    if (!G.event) { tx = LEVEL.gun.x; tz = LEVEL.gun.z; key = 'gun'; }
    else if (PL.z < DOOR.z + 0.4) { tx = DOOR.x; tz = DOOR.z + 0.6; key = 'door'; }
    else { tx = FRONT.x; tz = FRONT.z; key = 'front'; }
  }
  const show = key && Math.hypot(tx - PL.x, tz - PL.z) > 2.2;
  if (!show) { if (!els.obj.hidden) els.obj.hidden = true; objShown = ''; }
  else {
    if (els.obj.hidden || objShown !== key) { els.obj.hidden = false; els.obj.classList.remove('in'); void els.obj.offsetWidth; els.obj.classList.add('in'); objShown = key; }
    const at = Math.atan2(-(tx - PL.x), -(tz - PL.z));
    const rel = wrapAngle(at - PL.yaw);
    els.objArrow.setAttribute('transform', `rotate(${(-rel * 180 / Math.PI).toFixed(1)} 24 24)`);
  }
}

// ── 화면 전환 ──
let fadeAnim = null;
function fadeTo(color, dur, done) {
  const el = els.fade;
  el.style.background = color;
  const from = parseFloat(el.style.opacity || '0');
  const t0 = performance.now();
  if (fadeAnim) cancelAnimationFrame(fadeAnim);
  const step = () => {
    const k = clamp((performance.now() - t0) / (dur * 1000), 0, 1);
    el.style.opacity = lerp(from, 1, k); el.style.visibility = 'visible';
    if (k < 1) fadeAnim = requestAnimationFrame(step); else { fadeAnim = null; if (done) done(); }
  };
  step();
}
function fadeFrom(dur) {
  const el = els.fade, t0 = performance.now(), from = parseFloat(el.style.opacity || '1');
  if (fadeAnim) cancelAnimationFrame(fadeAnim);
  const step = () => { const k = clamp((performance.now() - t0) / (dur * 1000), 0, 1); el.style.opacity = lerp(from, 0, k); el.style.visibility = k < 1 ? 'visible' : 'hidden'; if (k < 1) fadeAnim = requestAnimationFrame(step); else fadeAnim = null; };
  step();
}
function showResult() {
  G.state = 'result';
  if (document.pointerLockElement) document.exitPointerLock();
  stopAllVoices(); humStop();
  $('say').hidden = true;
  for (const id of ['xhair', 'obj', 'ammo', 'prompt', 'touchUI', 'pauseBtn', 'hudK']) $(id).hidden = true;
  $('endN').textContent = LINK_KILLS + G.kills;
  $('result').hidden = false;
  els.fade.style.opacity = 0; els.fade.style.visibility = 'hidden';
  const again = $('again'); again.classList.remove('show');
  setTimeout(() => again.classList.add('show'), 800);
}

// ───────────────────────── 문 열리는 장면 ─────────────────────────
const DS = { t: 0, dur: 4.7, door: null, lever: null, built: false, skip: false };
function buildDoorScene() {
  doorScene.background = new THREE.Color(0x000000);
  const amb = new THREE.AmbientLight(0xffffff, 0.035); doorScene.add(amb);
  const front = new THREE.PointLight(0xcfd8ff, 0.8, 5, 1.8); front.position.set(0.2, 1.3, 3.2); doorScene.add(front);
  const spot = new THREE.SpotLight(0xdfe8ff, 55, 11, 0.42, 0.8, 1.4);
  spot.position.set(-0.7, 2.9, 2.9); spot.target.position.set(0.05, 1.05, 0); doorScene.add(spot, spot.target);
  const fill = new THREE.PointLight(0xffc98a, 0.7, 3.5, 2); fill.position.set(0.9, 0.3, 1.2); doorScene.add(fill);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x6a6358, roughness: 0.95, map: TEX.homeWall });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), wallMat); wall.position.set(0, 1.5, 0); doorScene.add(wall);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshStandardMaterial({ color: 0x8f8a82, roughness: 0.8, map: TEX.tile }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(0, -0.5 + 0.5, 1.6); doorScene.add(floor);
  // 문 구멍을 뚫기 위해 벽은 네 조각으로
  wall.visible = false;
  const W2 = 0.5, H2 = 2.12;
  for (const [x, w] of [[-W2 - 1.5, 3], [W2 + 1.5, 3]]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 4), wallMat); m.position.set(x, 1.5, 0); doorScene.add(m); }
  const top = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 4 - H2 + 0.5), wallMat); top.position.set(0, H2 + (4 - H2 - 0.5) / 2 + 0.0, 0); doorScene.add(top);
  // 문틀
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3b3d42, roughness: 0.5, metalness: 0.5 });
  for (const [x, y, w, h] of [[-W2 - 0.04, H2 / 2, 0.08, H2 + 0.08], [W2 + 0.04, H2 / 2, 0.08, H2 + 0.08], [0, H2 + 0.04, 1.08, 0.08]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.12), frameMat); m.position.set(x, y, 0.0); doorScene.add(m);
  }
  // 문짝: 오른쪽 경첩, 안쪽(멀어지는 쪽)으로 열림
  const pivot = new THREE.Group(); pivot.position.set(W2, 0, -0.03); doorScene.add(pivot);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: TEX.doorDark, roughness: 0.42, metalness: 0.35 });
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(1.0, H2, 0.05), leafMat); leaf.position.set(-0.5, H2 / 2, 0); pivot.add(leaf);
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.25, metalness: 0.9 });
  const lever = new THREE.Group(); lever.position.set(-0.88, 1.0, 0.045); pivot.add(lever);
  const rose = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 16), steel); rose.rotation.x = Math.PI / 2; lever.add(rose);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.024, 0.026), steel); bar.position.set(0.075, 0, 0.02); lever.add(bar);
  // 도어락 번호판
  const lockBody = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.27, 0.035), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.15, metalness: 0.6 }));
  lockBody.position.set(-0.89, 1.25, 0.04); pivot.add(lockBody);
  const keyC = cnv(64, 192), kg = keyC.getContext('2d');
  kg.fillStyle = '#0c0d10'; kg.fillRect(0, 0, 64, 192);
  kg.fillStyle = '#58c8ff'; kg.font = '700 22px sans-serif'; kg.textAlign = 'center'; kg.textBaseline = 'middle';
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].forEach((s, i) => kg.fillText(s, 16 + (i % 3) * 16, 40 + Math.floor(i / 3) * 34));
  const keyTex = texOf(keyC);
  const pad = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.18), new THREE.MeshBasicMaterial({ map: keyTex, transparent: true }));
  pad.position.set(-0.89, 1.25, 0.059); pivot.add(pad);
  DS.pad = pad;
  const peep = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 12), steel); peep.rotation.x = Math.PI / 2; peep.position.set(-0.5, 1.58, 0.035); pivot.add(peep);
  DS.door = pivot; DS.lever = lever; DS.built = true;
}
function doorStart(fromGate) {
  if (!DS.built) buildDoorScene();
  // 문 앞에서 눌러 연 경우: 이미 문이 보이고 있으니 어둡게 시작하지 않고, 누르자마자 번호를 누르는 소리
  G.state = 'door'; DS.t = fromGate ? 0.3 : 0; DS.skip = false;
  DS.door.rotation.y = 0; DS.lever.rotation.z = 0;
  DS.pad.material.opacity = 1;
  if (!fromGate) { els.fade.style.background = '#000'; els.fade.style.opacity = 1; fadeFrom(0.5); }
  if (ac) {
    const t = ac.currentTime - DS.t;
    sfxLock(t + 0.55);
    sfxLatch(t + 1.45, 1);
    sfxCreak(t + 1.65, 2.5, 1, 140);
  }
}
// ── 밖에서 들어왔을 때: 현관 앞에서 한 번 누르면 도어락을 열고 들어간다 (휴대폰 소리·PC 마우스 잠금을 여기서 켬) ──
function gateShow() {
  $('title').hidden = true;
  resetWorld();
  if (!DS.built) buildDoorScene();
  G.state = 'gate'; DS.t = 0; DS.skip = false; DS.fading = false;
  DS.door.rotation.y = 0; DS.lever.rotation.z = 0; DS.pad.material.opacity = 1;
  doorCamera.position.set(0.26, 1.4, 3.0); doorCamera.lookAt(0.05, 1.08, 0);
  $('gate').hidden = false; $('gate').classList.add('ready');
  $('gateTap').textContent = IS_TOUCH ? '화면을 누르면 문을 엽니다' : '클릭하면 문을 엽니다';
  els.fade.style.background = '#000'; els.fade.style.opacity = 1; els.fade.style.visibility = 'visible';
  fadeFrom(0.7);
}
function gateTick() {
  // 도어락 번호판 불빛만 천천히 숨 쉬듯
  DS.pad.material.opacity = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(G.t * 3.2));
  doorCamera.position.set(0.26 + Math.sin(G.t * 0.5) * 0.015, 1.4 + Math.cos(G.t * 0.37) * 0.01, 3.0);
  doorCamera.lookAt(0.05, 1.08, 0);
}
function gateOpen() {
  if (G.state !== 'gate') return;
  audioInit(); requestLock();
  $('gate').hidden = true;
  doorStart(true);
}
function doorSceneTick(dt) {
  DS.t += dt;
  const t = DS.t;
  DS.lever.rotation.z = t > 1.35 && t < 1.9 ? -0.55 * Math.sin(clamp((t - 1.35) / 0.55, 0, 1) * Math.PI) : 0;
  DS.pad.material.opacity = t > 0.5 && t < 1.3 ? (Math.sin(t * 40) > 0 ? 1 : 0.5) : 1;
  DS.door.rotation.y = -easeInOutSine((t - 1.6) / 2.6) * 1.55;
  const k = easeInOutSine(t / 4.4);
  doorCamera.position.set(lerp(0.26, 0.06, k), lerp(1.4, 1.36, k), lerp(3.0, 0.7, k));
  doorCamera.lookAt(lerp(0.05, -0.05, k), lerp(1.08, 1.15, k), lerp(0, -1.4, k));
  if (t > 4.15 && !DS.fading) { DS.fading = true; fadeTo('#000000', 0.45, () => { DS.fading = false; enterHouse(); }); }
}
function enterHouse() {
  G.state = 'play'; G.playT = 0; G.sensorT = 0.55;
  els.fade.style.background = '#000'; els.fade.style.opacity = 1;
  fadeFrom(0.35);
  for (const id of ['xhair', 'ammo', 'pauseBtn', 'hudK']) $(id).hidden = false;
  if (IS_TOUCH) $('touchUI').hidden = false;
  hudAmmo(false);
  humStart();
}

// ── 시작 / 다시 ──
function resetWorld() {
  stopAllVoices(); threatReset();
  LATER.length = 0; noticeTok++; els.notice.hidden = true;
  clearCrowd(); clearDecals(); clearPts();
  for (const a of LEVEL.ammo) { a.taken = false; a.m.visible = true; }
  LEVEL.gun.taken = false; LEVEL.gun.m.visible = true; LEVEL.gun.spark.visible = true;
  DOORS.inner.open = false; DOORS.inner.a = 0; DOORS.inner.target = 0; DOORS.inner.obj.rotation.y = 0;
  DOORS.inner.wall.off = false; DOORS.innerOpenWall.off = true; DOORS.strip.visible = true; DOORS.pool.visible = true;
  DOORS.front.a = 0; DOORS.front.target = 0; DOORS.front.obj.rotation.y = 0; DOORS.front.wall.off = false;
  NAV.doorBlock = true; NAV.src = -1;
  initDoors();
  sfxDragAllStop();
  resetLights();
  playerReset(); weaponsReset();
  Object.assign(G, { t: 0, playT: 0, kills: 0, event: false, eventT: 0, spawnAcc: 0, overT: 0, exitT: 0, sensorT: -1, heartT: 0, chorusT: 0, navT: 0, ending: false, sweep: [], said: false, rattleT: 0 });
  lastKills = -1;
  $('swap').hidden = true;
  $('say').hidden = true; $('result').hidden = true;
  spawnLurkers();
  navBFS(PL.x, PL.z);
  applyCamera(0);
}
function startGame() {
  audioInit();
  $('title').hidden = true;
  resetWorld();
  doorStart();
}


// ───────────────────────── 입력 ─────────────────────────
const MOUSE_SENS = 0.0022, TOUCH_SENS = 0.0066;
let SENS = clamp(+store.get('fh_room_sens', 1) || 1, 0.4, 2.2);
// 마우스 잠금이 아예 안 되는 곳(일부 앱 안 브라우저 등)에서만 잠금 없이 둘러보기
let LOCKED = false, FALLBACK = typeof canvas.requestPointerLock !== 'function', PAUSED = false;
let lockFails = 0, lastFailT = -1e9, wantResume = false;
function setTouch(on) {
  if (IS_TOUCH === on) return;
  IS_TOUCH = on;
  document.body.classList.toggle('touch', on);
  if (G.state === 'play') $('touchUI').hidden = !on;
  if (PAUSED) pauseHint();
}
function look(dx, dy, k) {
  PL.yaw -= dx * k * SENS;
  PL.pitch = clamp(PL.pitch - dy * k * SENS, -1.32, 1.32);
}
function lockFailed() {
  const now = performance.now();
  if (now - lastFailT < 80) return;   // 같은 실패가 두 번 알려지는 경우
  lastFailT = now; wantResume = false;
  // Esc 직후 바로 다시 잠그면 브라우저가 거절한다 → 멈춤 화면에서 한 번 더 누르게. 계속 안 되면 잠금 없이
  if (++lockFails >= 4) { FALLBACK = true; if (PAUSED) setPaused(false); return; }
  if (G.state === 'play' && !IS_TOUCH) { if (!PAUSED) setPaused(true); $('pauseHint').textContent = '잠시 뒤에 한 번 더 눌러 주세요'; }
}
function requestLock() {
  if (IS_TOUCH || FALLBACK || document.pointerLockElement === canvas) return;
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(lockFailed);
  } catch (e) { lockFailed(); }
}
function pauseHint() { $('pauseHint').textContent = IS_TOUCH || FALLBACK ? '' : 'Esc를 누르면 이 화면이 나옵니다'; }
function releaseInputs() {
  INPUT.fire = false; INPUT.keys.x = INPUT.keys.z = 0; KEYS.clear(); INPUT.run = false; INPUT.stickRun = false;
  INPUT.stick.x = INPUT.stick.z = 0; TT.stick = TT.look = TT.fire = null; stickEl.hidden = true; fireEl.classList.remove('down');
}
function setPaused(on) {
  PAUSED = on;
  $('pause').hidden = !on;
  releaseInputs();
  pauseHint();
  if (on && document.pointerLockElement) document.exitPointerLock();
  if (!on) wantResume = false;
  if (ac) { if (on) ac.suspend(); else ac.resume(); }
}
// 계속하기: PC는 마우스가 잠긴 뒤에 풀어 준다 (잠기기 전에 풀리면 시점이 안 돌아서 헷갈림)
function resumePlay() {
  if (IS_TOUCH || FALLBACK || document.pointerLockElement === canvas) { setPaused(false); return; }
  wantResume = true;
  requestLock();
}
document.addEventListener('pointerlockchange', () => {
  LOCKED = document.pointerLockElement === canvas;
  if (LOCKED) { lockFails = 0; if (PAUSED && wantResume) setPaused(false); wantResume = false; }
  else if (G.state === 'play' && !IS_TOUCH && !FALLBACK && !PAUSED) setPaused(true);
});
document.addEventListener('pointerlockerror', lockFailed);
document.addEventListener('visibilitychange', () => { if (document.hidden && G.state === 'play' && !PAUSED) setPaused(true); });
$('resume').addEventListener('click', resumePlay);
$('pauseBtn').addEventListener('click', () => { if (G.state === 'play') setPaused(true); });
$('restart').addEventListener('click', () => { if (LINK) { goMainTitle(); return; } setPaused(false); requestLock(); startGame(); });
const sensEl = $('sens'), sensVal = $('sensVal');
sensEl.value = SENS; sensVal.textContent = SENS.toFixed(2);
sensEl.addEventListener('input', () => { SENS = +sensEl.value; sensVal.textContent = SENS.toFixed(2); store.set('fh_room_sens', SENS); });
$('pause').addEventListener('pointerdown', (e) => { if (e.target === $('pause')) resumePlay(); });

document.addEventListener('mousemove', (e) => {
  if (IS_TOUCH || PAUSED || G.state !== 'play') return;
  if (!LOCKED && !FALLBACK) return;
  look(e.movementX || 0, e.movementY || 0, MOUSE_SENS);
});
let lastTouchT = -1e9;
window.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') lastTouchT = performance.now(); }, true);
canvas.addEventListener('mousedown', (e) => {
  // 손가락으로 누른 뒤 따라오는 가짜 마우스 이벤트는 무시
  if (performance.now() - lastTouchT < 900) return;
  if (G.state !== 'play' || PAUSED) return;
  setTouch(false);
  if (!LOCKED && !FALLBACK) { requestLock(); return; }
  if (e.button === 0) { INPUT.fire = true; INPUT.trigger = true; }
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) INPUT.fire = false; });
window.addEventListener('wheel', (e) => { if (G.state === 'play' && !PAUSED && Math.abs(e.deltaY) > 4) switchWeapon(); }, { passive: true });
window.addEventListener('contextmenu', (e) => e.preventDefault());

const KEYS = new Set();
const MOVE_KEYS = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
const TURN_KEYS = { ArrowLeft: 1, ArrowRight: -1 };
let keyTurnT = 0;
function keysToVec() {
  let x = 0, z = 0;
  for (const k of KEYS) { const v = MOVE_KEYS[k]; if (v) { x += v[0]; z += v[1]; } }
  const l = Math.hypot(x, z); INPUT.keys.x = l ? x / l : 0; INPUT.keys.z = l ? z / l : 0;
}
const modMenu = $('modMenu');
const modClose = $('modClose');
const damageRange = $('modDamage');
const rateRange = $('modRate');
const damageValue = $('modDamageValue');
const rateValue = $('modRateValue');
const modInfinite = $('modInfinite');
const modRecoil = $('modRecoil');
const modAuto = $('modAuto');
const modNoclip = $('modNoclip');
function setModMenu(open) {
  modMenu.hidden = !open;
  if (open) damageRange.focus({ preventScroll: true });
}
function syncModValues() {
  GUN_MOD.damage = Number(damageRange.value);
  GUN_MOD.rate = Number(rateRange.value);
  GUN_MOD.infiniteAmmo = modInfinite.checked;
  GUN_MOD.noRecoil = modRecoil.checked;
  GUN_MOD.auto = modAuto.checked;
  GUN_MOD.noclip = modNoclip.checked;
  if (GUN_MOD.infiniteAmmo) {
    WEP.pistol.mag = [WEP.pistol.size, WEP.pistol.size]; WEP.pistol.reloadT = 0;
    WEP.shotgun.mag = WEP.shotgun.size; WEP.shotgun.reloadT = 0;
    hudAmmo(true);
  }
  damageValue.textContent = GUN_MOD.damage.toFixed(1) + '×';
  rateValue.textContent = GUN_MOD.rate.toFixed(2) + '×';
}
damageRange.addEventListener('input', syncModValues);
rateRange.addEventListener('input', syncModValues);
for (const control of [modInfinite, modRecoil, modAuto, modNoclip]) control.addEventListener('change', syncModValues);
modClose.addEventListener('click', () => setModMenu(false));
$('modRepel').addEventListener('click', () => { crowdRepelT = 5; });
syncModValues();

window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote') { e.preventDefault(); setModMenu(modMenu.hidden); return; }
  if (modMenu.contains(e.target) && e.target.matches('input')) return;
  if (G.state === 'gate') {
    if (!e.repeat && !/^(KeyM|Tab|Shift|Control|Alt|Meta|Escape|F\d)/.test(e.code)) { e.preventDefault(); gateOpen(); }
    else if (e.code === 'KeyM' && !e.repeat) setMuted(!MUTED);
    return;
  }
  if (MOVE_KEYS[e.code]) { KEYS.add(e.code); keysToVec(); e.preventDefault(); if (IS_TOUCH && !e.repeat) setTouch(false); return; }
  if (TURN_KEYS[e.code]) { KEYS.add(e.code); e.preventDefault(); if (IS_TOUCH && !e.repeat) setTouch(false); return; }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { INPUT.run = true; return; }
  if (e.repeat) return;
  if (e.code === 'KeyM') { setMuted(!MUTED); return; }
  if (G.state === 'play' && !PAUSED) {
    if (e.code === 'KeyR') startReload();
    else if (e.code === 'KeyQ') switchWeapon();
    else if (e.code === 'Digit1') switchWeapon('pistol');
    else if (e.code === 'Digit2') switchWeapon('shotgun');
  }
  if ((e.code === 'Enter' || e.code === 'Space') && G.state === 'door') { e.preventDefault(); skipDoor(); }
});
window.addEventListener('keyup', (e) => {
  if (MOVE_KEYS[e.code]) { KEYS.delete(e.code); keysToVec(); }
  if (TURN_KEYS[e.code]) KEYS.delete(e.code);
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') INPUT.run = false;
});
window.addEventListener('blur', () => { KEYS.clear(); keysToVec(); INPUT.fire = false; INPUT.run = false; });

// 터치: 왼쪽은 손가락 닿은 자리에 생기는 스틱, 오른쪽은 끌어서 둘러보기
const TT = { stick: null, sx: 0, sy: 0, look: null, lx: 0, ly: 0, fire: null, fx: 0, fy: 0 };
const stickEl = $('stick'), knobEl = stickEl.querySelector('.knob');
const STICK_R = 56;
function touchLook(dx, dy) {
  const f = (d) => d * TOUCH_SENS * SENS * (0.5 + 0.7 * Math.min(1, Math.abs(d) / 16));
  const wide = clamp(640 / VW, 1, 1.6);   // 폭이 좁은 세로 화면일수록 좌우로 더 돈다
  PL.yaw -= f(dx) * wide;
  PL.pitch = clamp(PL.pitch - f(dy) * (1 + (wide - 1) * 0.4), -1.32, 1.32);
}
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  setTouch(true);
  if (G.state === 'door') { skipDoor(); return; }
  if (G.state !== 'play' || PAUSED) return;
  const stickZone = e.clientX < VW * 0.45 && (VW >= VH || e.clientY > VH * 0.42);
  if (stickZone && TT.stick === null) {
    TT.stick = e.pointerId; TT.sx = e.clientX; TT.sy = e.clientY;
    stickEl.hidden = false; stickEl.style.transform = `translate3d(${TT.sx}px, ${TT.sy}px, 0)`; knobEl.style.transform = 'translate(0px, 0px)';
  } else if (TT.look === null) {
    TT.look = e.pointerId; TT.lx = e.clientX; TT.ly = e.clientY;
  } else return;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerId === TT.stick) {
    let dx = e.clientX - TT.sx, dy = e.clientY - TT.sy;
    const l = Math.hypot(dx, dy);
    if (l > STICK_R) { const over = l - STICK_R; TT.sx += dx / l * over; TT.sy += dy / l * over; dx = e.clientX - TT.sx; dy = e.clientY - TT.sy; stickEl.style.transform = `translate3d(${TT.sx}px, ${TT.sy}px, 0)`; }
    knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
    // 가운데 근처는 무시하고 부드럽게
    const len = Math.hypot(dx, dy), m = len / STICK_R, dead = 0.12;
    const k = m < dead ? 0 : clamp((m - dead) / (1 - dead), 0, 1);
    INPUT.stick.x = len ? dx / len * k : 0;
    INPUT.stick.z = len ? dy / len * k : 0;
    // 앞으로 끝까지 밀면 달리기
    INPUT.stickRun = k > 0.96 && dy < 0 && Math.abs(dx) < -dy * 0.6;
  } else if (e.pointerId === TT.look) {
    touchLook(e.clientX - TT.lx, e.clientY - TT.ly); TT.lx = e.clientX; TT.ly = e.clientY;
  }
});
function touchEnd(e) {
  if (e.pointerId === TT.stick) { TT.stick = null; INPUT.stick.x = INPUT.stick.z = 0; INPUT.stickRun = false; stickEl.hidden = true; }
  if (e.pointerId === TT.look) TT.look = null;
}
canvas.addEventListener('pointerup', touchEnd);
canvas.addEventListener('pointercancel', touchEnd);
canvas.addEventListener('lostpointercapture', touchEnd);
const fireEl = $('fire');
fireEl.addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation();
  if (G.state !== 'play' || PAUSED) return;
  TT.fire = e.pointerId; TT.fx = e.clientX; TT.fy = e.clientY;
  try { fireEl.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
  fireEl.classList.add('down');
  INPUT.fire = true; INPUT.trigger = true;
});
fireEl.addEventListener('pointermove', (e) => {
  if (e.pointerId !== TT.fire) return;
  // 쏘면서 끌면 조준도 따라간다
  touchLook(e.clientX - TT.fx, e.clientY - TT.fy); TT.fx = e.clientX; TT.fy = e.clientY;
});
function fireUp(e) { if (e.pointerId !== TT.fire) return; TT.fire = null; fireEl.classList.remove('down'); INPUT.fire = false; }
fireEl.addEventListener('pointerup', fireUp); fireEl.addEventListener('pointercancel', fireUp); fireEl.addEventListener('lostpointercapture', fireUp);
// 뒤돌기 (바이오하자드 퀵턴): 0.24초 동안 180도
const QT = { t: 0, from: 0 };
function quickTurn() { if (G.state !== 'play' || QT.t > 0) return; QT.t = 0.24; QT.from = PL.yaw; }
for (const [id, fn] of [['reload', () => startReload()], ['swap', () => switchWeapon()], ['turn', () => quickTurn()]]) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('down'); if (G.state === 'play' && !PAUSED) fn(); });
  const up = () => el.classList.remove('down');
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('pointerleave', up);
}
$('mute').addEventListener('click', () => setMuted(!MUTED));
$('mute').classList.toggle('muted', MUTED);
$('start').addEventListener('click', () => { requestLock(); startGame(); });
$('again').addEventListener('click', () => { if (LINK) { goMainTitle(); return; } requestLock(); startGame(); });
// 현관 앞: 아무 데나 누르면 (손가락은 뗄 때 눌린 걸로 쳐야 휴대폰 소리가 켜진다)
$('gate').addEventListener('click', (e) => { e.preventDefault(); gateOpen(); });
// 화면을 돌리면 잡고 있던 손가락은 놓은 걸로 (스틱이 엉뚱한 자리에 남지 않게)
let lastPortrait = VH > VW;
window.addEventListener('resize', () => { const p = VH > VW; if (p !== lastPortrait) { lastPortrait = p; releaseInputs(); } });
function skipDoor() {
  if (G.state !== 'door' || DS.t > 4.0) return;
  DS.t = 4.1;
  if (ac) stopAllVoices();
}
canvas.addEventListener('click', () => { if (G.state === 'door' && performance.now() - lastTouchT > 900) skipDoor(); });

// ───────────────────────── 매 프레임 ─────────────────────────
function tick(dt) {
  G.t += dt;
  if (G.state === 'gate') { gateTick(); return; }
  if (G.state === 'door') { doorSceneTick(dt); return; }
  if (G.state !== 'play' && G.state !== 'over' && G.state !== 'exit') return;
  G.playT += dt;
  laterTick();
  if (G.sensorT > 0) { G.sensorT -= dt; if (G.sensorT <= 0) { LEVEL.entryLamp.mode = 'on'; if (ac) sfxSensor(ac.currentTime); } }
  if (G.state === 'play') {
    const turn = (KEYS.has('ArrowLeft') ? 1 : 0) - (KEYS.has('ArrowRight') ? 1 : 0);
    keyTurnT = turn ? keyTurnT + dt : 0;
    if (turn) PL.yaw += turn * 2.6 * SENS * Math.min(1, 0.35 + keyTurnT * 2.6) * dt;
    if (QT.t > 0) { QT.t = Math.max(0, QT.t - dt); PL.yaw = QT.from + Math.PI * easeInOutSine(1 - QT.t / 0.24); }
  } else QT.t = 0;
  playerMove(dt, G.state === 'play');
  weaponTick(dt);
  doorsTick(dt);
  crowdTick(dt);
  if (G.state === 'play') { pickupTick(); pressureTick(dt); }
  eventTick(dt);
  if (G.state === 'over') overTick(dt);
  exitTick(dt);
  lightsTick(dt);
  ptTick(dt); growDecals(dt); flashTick(dt);
  applyCamera(dt);
  vmUpdate(dt);
  const Lp = clamp(lfAtCPU(PL.x, PL.z) * 0.95 + 0.06 + FLASH.I * 0.45, 0.07, 1.3);
  vmHemi.intensity = 1.5 * Lp; vmKey.intensity = 1.65 * Lp;
  hudTick(dt);
}
function render() {
  renderer.clear();
  if (G.state === 'door' || G.state === 'gate') { renderer.render(doorScene, doorCamera); return; }
  if (G.state === 'title' || G.state === 'result') return;
  renderer.render(scene, camera);
  renderer.clearDepth();
  renderer.render(vmScene, vmCamera);
}
let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const raw = Math.min(0.1, Math.max(0, (now - lastT) / 1000)); lastT = now;
  if (PAUSED || window.__fhManual) return;
  if (G.state === 'play') perfTick(raw);
  tick(Math.min(0.05, raw));
  render();
}

// ───────────────────────── 시작 준비 ─────────────────────────
onResize();
buildLevel();
hashBuild();
navDoorCells();
resetWorld();
buildDoorScene();
// 셰이더를 미리 만들어 둔다 (처음 쏠 때 멈칫하지 않게)
try {
  renderer.compile(scene, camera); renderer.compile(vmScene, vmCamera); renderer.compile(doorScene, doorCamera);
  VM.shot.g.visible = true; renderer.compile(vmScene, vmCamera); VM.shot.g.visible = false;
} catch (e) { /* 무시 */ }
$('start').disabled = false;
$('loading').hidden = true;
if (LINK) gateShow();
requestAnimationFrame(frame);

// 시험용 손잡이
window.__fh = {
  G, PL, WEP, live, FIX, LF, LEVEL, DOORS, renderer, camera, NAV, navIdx, navFree, losClear, startReload, switchWeapon, DOOR, FRONT, INPUT,
  start: startGame, gate: gateShow, gateOpen, LINK, LINK_KILLS, skip: () => { if (G.state === 'door') { DS.t = 4.1; DS.fading = false; enterHouse(); } },
  tp(x, z, yaw, pitch) { PL.x = x; PL.z = z; if (yaw !== undefined) PL.yaw = yaw; if (pitch !== undefined) PL.pitch = pitch; PL.y = floorAt(x, z); PL.eye = PL.y + EYE; applyCamera(0); },
  look(yaw, pitch) { PL.yaw = yaw; PL.pitch = pitch || 0; },
  move(x, z) { INPUT.keys.x = x; INPUT.keys.z = z; },
  fire(on) { INPUT.fire = !!on; if (on) INPUT.trigger = true; },
  event: () => { LEVEL.gun.taken = true; LEVEL.gun.m.visible = false; LEVEL.gun.spark.visible = false; WEP.hasShotgun = true; switchWeapon('shotgun'); startEvent(); },
  sim(sec, step = 1 / 60) { const n = Math.round(sec / step); for (let i = 0; i < n; i++) tick(step); render(); },
  render, tick,
  prof() { const gl = renderer.getContext(); const t0 = performance.now(); renderer.clear(); renderer.render(scene, camera); gl.finish(); const t1 = performance.now(); renderer.clearDepth(); renderer.render(vmScene, vmCamera); gl.finish(); const t2 = performance.now(); return { world: t1 - t0, vm: t2 - t1, calls: renderer.info.render.calls }; },
  info() { return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, live: live.length, state: G.state, kills: G.kills, pressure: PL.pressure, clingers: PL.clingers.length, x: PL.x, z: PL.z, L: lfAtCPU(PL.x, PL.z), ammo: [WEP.pistol.mag.join('+'), WEP.pistol.res, WEP.shotgun.mag, WEP.shotgun.res], cur: WEP.cur }; },
  // 효과음을 소리 없이 렌더해서 파형을 돌려줌 (시험용)
  async renderSfx(name, dur = 1.5) {
    const saveAc = ac, saveA = Object.assign({}, A), saveHum = Object.assign({}, HUM);
    const off = new OfflineAudioContext(2, Math.ceil(44100 * dur), 44100);
    ac = off; OFFLINE = true; sfxEnds.length = 0; sfxWinT = -1; sfxWinN = 0; tinkBudget = 0;
    A.master = off.createGain(); A.master.gain.value = 0.95;
    A.comp = off.createDynamicsCompressor(); A.comp.threshold.value = -12; A.comp.knee.value = 8; A.comp.ratio.value = 4.5; A.comp.attack.value = 0.002; A.comp.release.value = 0.16;
    A.comp.connect(A.master); A.master.connect(off.destination);
    A.sfx = off.createGain(); A.sfx.gain.value = 0.95; A.sfx.connect(A.comp);
    A.voice = off.createGain(); A.voice.connect(A.comp);
    A.verb = off.createConvolver(); A.verb.buffer = makeIR(1.5, 3.1); A.verbOut = off.createGain(); A.verbOut.gain.value = 0.5; A.verb.connect(A.verbOut); A.verbOut.connect(A.comp);
    A.noise = makeNoise(2.5); A.shaper = makeCurve(2.4); A.shaperHard = makeCurve(4.5);
    const fns = { pistol: () => sfxPistol(0.2), shotgun: () => sfxShotgun(), pump: () => sfxPump(), mag: () => { sfxMagOut(); sfxMagIn(0.4); sfxSlide(0.75); }, flesh: () => sfxFlesh(1), head: () => sfxHead(), stab: () => sfxStab(), grab: () => sfxGrab(), step: () => { sfxStep('carpet'); }, vstep: () => { sfxStep('vinyl'); }, drag: () => sfxDragDemo(1.4), bang: () => sfxDoorBang(0, 1), chair: () => sfxChair(0, 1), lock: () => sfxLock(0.05), creak: () => sfxCreak(0.05, 2.4, 1, 140), sensor: () => sfxSensor(0.05), rattle: () => sfxRattle(), flick: () => sfxFlick(1), breaker: () => sfxBreaker(), getgun: () => sfxGetGun(), ammo: () => sfxAmmo(), wall: () => sfxWallHit(1), heart: () => sfxHeart(1), out: () => sfxOut(), hum: () => { HUM.on = false; humStart(); humSet(1, true); } };
    try { fns[name](); } catch (e) { ac = saveAc; OFFLINE = false; Object.assign(A, saveA); return { err: e.message }; }
    const buf = await off.startRendering();
    ac = saveAc; OFFLINE = false; Object.assign(A, saveA); Object.assign(HUM, saveHum);
    const d = buf.getChannelData(0), d2 = buf.getChannelData(1);
    let peak = 0, sum = 0, nan = 0, last = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.max(Math.abs(d[i]), Math.abs(d2[i])); if (!Number.isFinite(v)) nan++; else { peak = Math.max(peak, v); sum += v * v; if (v > 0.01) last = i; } }
    const step = 32, env = [];
    for (let i = 0; i < d.length; i += step) env.push(Math.round(Math.abs(d[i]) * 1000) / 1000);
    return { peak, rms: Math.sqrt(sum / d.length), nan, tail: last / 44100, env: Array.from(d.filter((_, i) => i % 4 === 0)) };
  },
  clear() { clearCrowd(); PL.clingers.length = 0; PL.pressure = 0; },
  panOf, quickTurn,
  spawn(x, z, kind = 0, state = 'chase') { return newPerson(x, z, { kind, state, yaw: Math.atan2(PL.x - x, PL.z - z) }); },
};