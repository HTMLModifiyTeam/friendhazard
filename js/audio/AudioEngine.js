/**
 * AudioEngine
 * 마스터 버스 / 컴프레서 / 리버브 / SFX·VOICE·MUSIC 버스, 노드 헬퍼, 보이스 로딩,
 * 그리고 컨텍스트 정지·NaN 오염 감시/복구를 한 클래스에 묶었다.
 *
 * 그래프:
 *   sfx ─┐
 *   voice ─┼─► comp ─► master ─► destination
 *   music ─┤                 └─► tap(analyser, 감시용)
 *   verbIn ─► verb(convolver) ─► verbOut ─┘
 *
 * verbIn 은 재구성(rebuild) 후에도 유지되므로, 리버브 센드를 이미 연결한
 * 소스들이 rebuild 이후에도 계속 리버브로 들어간다.
 */

const DEFAULTS = {
  latencyHint: 'interactive',
  masterGain: 0.92,
  sfxGain: 0.95,
  voiceGain: 1.05,
  musicGain: 0.4,
  reverb: { duration: 2.3, decay: 2.6, wet: 0.42 },
  compressor: { threshold: -13, knee: 8, ratio: 4.5, attack: 0.002, release: 0.16 },
  noiseSeconds: 2.5,
  shaperAmount: 2.4,
  watchInterval: 1.2,    // 감시 주기(초)
  rebuildCooldown: 2.0,  // 연속 재구성 방지(초)
  muteRamp: 0.015,       // 뮤트 시 클릭 노이즈 방지용 램프(초)
  voiceDir: 'voices/',   // 보이스 파일 경로 접두사
  panThreshold: 0.06,    // 이보다 작은 pan 은 패너 생략
  verbSendMin: 0.2,      // 이보다 작은 리버브 센드는 생략
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default class AudioEngine {
  /**
   * @param {object}   [options]
   * @param {boolean}  [options.muted=false]
   * @param {object|Function} [options.voiceData]  { 이름: { b: '파일명' } } 또는 이를 반환하는 함수
   * @param {Function} [options.onInit]     최초 초기화 직후
   * @param {Function} [options.onReady]    초기화 400ms 뒤 (ex: 음악 버퍼 렌더링)
   * @param {Function} [options.onRebuild]  버스 재구성 직후 (ex: 음악 재시작)
   * @param {object}   [options.config]     DEFAULTS 덮어쓰기
   */
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...(options.config || {}) };
    this.voiceData = options.voiceData;
    this.hooks = {
      onInit: options.onInit,
      onReady: options.onReady,
      onRebuild: options.onRebuild,
    };

    this.ctx = null;
    this.muted = !!options.muted;

    /** 노드 모음 (기존 전역 A 대체) */
    this.nodes = {};
    /** 이름 → AudioBuffer (기존 VO 대체) */
    this.voices = new Map();
    /** 재생 중인 보이스 핸들 (playVoice 반환값) */
    this.activeVoices = new Set();
    /** loadVoices() 진행 상태 */
    this.voicesReady = Promise.resolve();

    this.rebuildCount = 0;
    this._watchTimer = 0;
    this._lastRebuild = -Infinity;
    this._readyTimeout = null;
    this._visibilityBound = () => { if (!document.hidden) this.resume(); };
    this._onStateChange = () => {
      const s = this.ctx?.state;
      if (s === 'suspended' || s === 'interrupted') this.resume();
    };
  }

  /* ───────────── 접근자 ───────────── */

  get ready() { return !!this.ctx; }
  get running() { return this.ctx?.state === 'running'; }
  get time() { return this.ctx ? this.ctx.currentTime : 0; }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 44100; }
  get sfx() { return this.nodes.sfx; }
  get voice() { return this.nodes.voice; }
  get music() { return this.nodes.music; }
  /** 리버브 센드의 입력단. 센드 게인을 여기에 연결한다. */
  get reverb() { return this.nodes.verbIn; }
  get noise() { return this.nodes.noise; }
  get shaper() { return this.nodes.shaper; }

  /* ───────────── 라이프사이클 ───────────── */

  /** 사용자 제스처 안에서 호출. 여러 번 호출해도 안전. */
  init() {
    if (this.ctx) { this.resume(); return true; }

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;

    this.ctx = new AC({ latencyHint: this.cfg.latencyHint });
    const n = this.nodes;
    const { reverb, noiseSeconds, shaperAmount } = this.cfg;

    // 재구성 시에도 유지되는 자원
    n.sfx = this.gain(this.cfg.sfxGain);
    n.voice = this.gain(this.cfg.voiceGain);
    n.music = this.gain(this.cfg.musicGain);
    n.verbIn = this.gain(1);
    n.ir = this.makeIR(reverb.duration, reverb.decay);
    n.noise = this.makeNoise(noiseSeconds);
    n.shaper = AudioEngine.makeCurve(shaperAmount);

    this._buildOutputChain();

    this.ctx.addEventListener('statechange', this._onStateChange);
    document.addEventListener('visibilitychange', this._visibilityBound);

    this.hooks.onInit?.(this);
    this.voicesReady = this.loadVoices();
    this.resume();
    this._readyTimeout = setTimeout(() => this.hooks.onReady?.(this), 400);
    return true;
  }

  /** 정지된 컨텍스트 재개. 실패해도 예외를 던지지 않는다. */
  resume() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return Promise.resolve();
    try {
      return Promise.resolve(ctx.resume()).catch(() => { });
    } catch {
      return Promise.resolve();
    }
  }

  /** 기존 audioPoke: 제스처 이벤트마다 가볍게 호출 */
  poke() { this.resume(); }

  /** 첫 사용자 입력에서 init/resume. 해제 함수를 반환한다. */
  autoUnlock(target = window, events = ['pointerdown', 'keydown', 'touchend']) {
    const handler = () => this.init();
    for (const e of events) target.addEventListener(e, handler, { passive: true });
    return () => events.forEach(e => target.removeEventListener(e, handler));
  }

  dispose() {
    clearTimeout(this._readyTimeout);
    document.removeEventListener('visibilitychange', this._visibilityBound);
    this.ctx?.removeEventListener('statechange', this._onStateChange);
    this.stopAllVoices();
    Object.values(this.nodes).forEach(n => this._disconnect(n));
    this.ctx?.close?.().catch(() => { });
    this.ctx = null;
    this.nodes = {};
  }

  /* ───────────── 볼륨 / 뮤트 ───────────── */

  setMuted(value) {
    this.muted = !!value;
    const g = this.nodes.master?.gain;
    if (g) g.setTargetAtTime(this._masterTarget(), this.ctx.currentTime, this.cfg.muteRamp);
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /* ───────────── 보이스 ───────────── */

  /**
   * voiceData 의 모든 파일을 병렬로 불러와 디코딩한다.
   * 이미 로드된 항목은 건너뛰고, 실패한 항목은 경고만 남긴다.
   * @returns {Promise<void>}
   */
  async loadVoices() {
    const raw = typeof this.voiceData === 'function' ? this.voiceData() : this.voiceData;
    const data = raw || {};
    const ctx = this.ctx;
    if (!ctx) return;

    await Promise.all(Object.keys(data).map(async (key) => {
      if (this.voices.has(key)) return;
      const file = data[key].b;
      try {
        const res = await fetch(this.cfg.voiceDir + file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        this.voices.set(key, buf);
      } catch (e) {
        console.warn('Failed to load voice:', key, file, e);
      }
    }));
  }

  /**
   * 로드된 보이스를 voice 버스로 재생.
   * @param {string} key
   * @param {object} [o]
   * @param {number} [o.rate=1]    재생 속도(피치 포함)
   * @param {number} [o.gain=1]    볼륨
   * @param {number} [o.pan=0]     -1 ~ 1
   * @param {number} [o.verb=0.22] 리버브 센드 (0 이면 연결 생략)
   * @param {number} [o.lp]        로우패스 컷오프(Hz)
   * @param {number} [o.sob]       울먹임 강도: 음높이 떨림 + 숨 떨림
   * @param {number} [o.delay=0]   시작 지연(초)
   * @returns {VoiceHandle|null}
   */
  playVoice(key, o = {}) {
    const ctx = this.ctx;
    const buf = this.voices.get(key);
    if (!ctx || !buf) return null;

    const rate = o.rate || 1;
    const nodes = [];                 // 종료 시 한꺼번에 disconnect
    const lfos = [];                  // 종료 시 한꺼번에 stop
    const track = (n) => { nodes.push(n); return n; };

    const src = track(ctx.createBufferSource());
    src.buffer = buf;
    src.playbackRate.value = rate;

    const g = track(this.gain(o.gain === undefined ? 1 : o.gain));
    let node = src;

    if (o.sob) {
      // 음높이 떨림: LFO → playbackRate
      const pitchLfo = track(this.osc('sine', AudioEngine.rand(5.6, 7.4)));
      const pitchDepth = track(this.gain(o.sob * rate));
      pitchLfo.connect(pitchDepth);
      pitchDepth.connect(src.playbackRate);

      // 숨 떨림: 0.78 ± 0.22 트레몰로
      const trem = track(this.gain(0.78));
      const tremLfo = track(this.osc('sine', AudioEngine.rand(4.5, 6)));
      const tremDepth = track(this.gain(0.22));
      tremLfo.connect(tremDepth);
      tremDepth.connect(trem.gain);
      node.connect(trem);
      node = trem;

      lfos.push(pitchLfo, tremLfo);
    }

    if (o.lp) {
      const f = track(this.filter('lowpass', o.lp, 0.7));
      node.connect(f);
      node = f;
    }

    node.connect(g);
    let tail = g;
    if (ctx.createStereoPanner) {
      const p = track(ctx.createStereoPanner());
      p.pan.value = clamp(o.pan || 0, -1, 1);
      g.connect(p);
      tail = p;
    }
    tail.connect(this.nodes.voice);

    const verb = o.verb === undefined ? 0.22 : o.verb;
    if (verb > 0) {
      const vs = track(this.gain(verb));
      g.connect(vs);
      vs.connect(this.nodes.verbIn);
    }

    const t0 = ctx.currentTime + (o.delay || 0);
    const dur = buf.duration / rate;
    const engine = this;

    /** @typedef {{key:string, src:AudioBufferSourceNode, g:GainNode, t0:number, rate:number, dur:number, stopped:boolean, progress():number, stop(fast?:number):void}} VoiceHandle */
    const h = {
      key, src, g, t0, rate, dur,
      stopped: false,

      /** 0 ~ 1 재생 진행도 */
      progress() {
        return clamp((engine.ctx.currentTime - h.t0) / h.dur, 0, 1);
      },

      /** fast 초 동안 페이드아웃 후 정지 (클릭 방지) */
      stop(fast = 0.012) {
        if (h.stopped) return;
        h.stopped = true;
        const t = engine.ctx.currentTime;
        try {
          g.gain.cancelScheduledValues(t);
          g.gain.setValueAtTime(g.gain.value, t);
          g.gain.linearRampToValueAtTime(0, t + fast);
          src.stop(t + fast + 0.01);
        } catch { }
        for (const l of lfos) {
          try { l.stop(t + fast + 0.02); } catch { }
        }
      },
    };

    src.onended = () => {
      h.stopped = true;
      this.activeVoices.delete(h);
      for (const l of lfos) {
        try { l.stop(); } catch { }
      }
      for (const n of nodes) this._disconnect(n);
    };

    src.start(t0);
    for (const l of lfos) l.start(t0);
    this.activeVoices.add(h);
    return h;
  }

  /** 특정 키의 재생 중인 보이스를 모두 정지 */
  stopVoice(key, fast) {
    for (const h of [...this.activeVoices]) {
      if (h.key === key) h.stop(fast);
    }
  }

  /** 모든 보이스 정지 */
  stopAllVoices(fast) {
    for (const h of [...this.activeVoices]) h.stop(fast);
  }

  /** key 가 재생 중인지 */
  isVoicePlaying(key) {
    for (const h of this.activeVoices) {
      if (h.key === key && !h.stopped) return true;
    }
    return false;
  }

  /* ───────────── 감시 / 복구 ───────────── */

  /** 매 프레임 호출 (dt: 초). 내부에서 주기 제한. */
  update(dt) {
    if (!this.ctx) return;
    this._watchTimer -= dt;
    if (this._watchTimer > 0) return;
    this._watchTimer = this.cfg.watchInterval;

    if (document.hidden) return;

    if (this.ctx.state !== 'running') {
      if (this.ctx.state !== 'closed') this.resume();
      return;
    }
    if (this._outputIsCorrupted()) this.rebuild();
  }

  /** 출력 버스를 새로 짠다 (NaN 오염된 컴프레서/리버브 상태 초기화). */
  rebuild() {
    if (!this.ctx) return false;
    const now = this.ctx.currentTime;
    if (now - this._lastRebuild < this.cfg.rebuildCooldown) return false;
    this._lastRebuild = now;
    this.rebuildCount++;

    const n = this.nodes;
    for (const key of ['comp', 'master', 'verb', 'verbOut', 'verbIn', 'tap', 'sfx', 'voice', 'music']) {
      this._disconnect(n[key]);
    }
    this._buildOutputChain();
    this.hooks.onRebuild?.(this);
    return true;
  }

  /* ───────────── 노드 헬퍼 (기존 gainN / filt / oscN / noiseN / outChain) ───────────── */

  gain(value) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return g;
  }

  filter(type, freq, q) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = freq;
    if (q !== undefined) b.Q.value = q;
    return b;
  }

  osc(type, freq) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  /** 루프하는 노이즈 소스. rate 로 음색(피치)을 조절. */
  noiseSource(rate) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.nodes.noise;
    s.loop = true;
    if (rate) s.playbackRate.value = rate;
    return s;
  }

  /**
   * SFX 출력 체인: gain → (panner) → sfx 버스, 옵션으로 리버브 센드.
   * @returns {GainNode} 소스를 연결할 입력 게인
   */
  outChain(vol, pan = 0, verb = 0) {
    const g = this.gain(vol);
    let tail = g;
    if (pan && Math.abs(pan) > this.cfg.panThreshold && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      tail = p;
    }
    tail.connect(this.nodes.sfx);
    if (verb > this.cfg.verbSendMin) {
      const s = this.gain(verb);
      g.connect(s);
      s.connect(this.nodes.verbIn);
    }
    return g;
  }

  /** [a, b) 범위 난수 */
  static rand(a, b) { return a + Math.random() * (b - a); }

  /** 0.0001 → peak → 0.0001 지수 어택/디케이 엔벨로프 */
  static envAD(param, t, attack, peak, decay) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(0.0001, t);
    param.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    param.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  /* ───────────── 버퍼 생성 ───────────── */

  /** 모노 화이트 노이즈 */
  makeNoise(sec) {
    const { ctx } = this;
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** 감쇠하는 스테레오 노이즈 IR (처음 90샘플은 페이드인으로 클릭 방지) */
  makeIR(sec, decay) {
    const { ctx } = this;
    const len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    const FADE_IN = 90;
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const fade = i < FADE_IN ? i / FADE_IN : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * fade;
      }
    }
    return buf;
  }

  /** WaveShaper 용 tanh 소프트 클리핑 커브 (컨텍스트 불필요) */
  static makeCurve(k, size = 1024) {
    const curve = new Float32Array(size);
    const norm = Math.tanh(k);
    for (let i = 0; i < size; i++) {
      const x = (i / (size - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * k) / norm;
    }
    return curve;
  }

  /* ───────────── 내부 구현 ───────────── */

  /** 컴프 → 마스터 → 출력 + 리버브 + 버스 연결. init/rebuild 공용. */
  _buildOutputChain() {
    const { ctx, cfg, nodes: n } = this;
    const c = cfg.compressor;

    n.master = this.gain(this._masterTarget());

    n.comp = ctx.createDynamicsCompressor();
    n.comp.threshold.value = c.threshold;
    n.comp.knee.value = c.knee;
    n.comp.ratio.value = c.ratio;
    n.comp.attack.value = c.attack;
    n.comp.release.value = c.release;
    n.comp.connect(n.master);
    n.master.connect(ctx.destination);

    n.tap = ctx.createAnalyser();
    n.tap.fftSize = 256;
    n.master.connect(n.tap);
    this._tapBuf = new Float32Array(n.tap.fftSize);

    n.sfx.connect(n.comp);
    n.voice.connect(n.comp);
    n.music.connect(n.comp);

    n.verb = ctx.createConvolver();
    n.verb.buffer = n.ir;
    n.verbOut = this.gain(cfg.reverb.wet);
    n.verbIn.connect(n.verb);
    n.verb.connect(n.verbOut);
    n.verbOut.connect(n.comp);
  }

  _outputIsCorrupted() {
    const { tap } = this.nodes;
    if (!tap) return false;
    tap.getFloatTimeDomainData(this._tapBuf);
    for (let i = 0; i < this._tapBuf.length; i++) {
      if (!Number.isFinite(this._tapBuf[i])) return true;
    }
    return false;
  }

  _masterTarget() { return this.muted ? 0 : this.cfg.masterGain; }

  _disconnect(node) {
    try { node?.disconnect?.(); } catch { }
  }
}