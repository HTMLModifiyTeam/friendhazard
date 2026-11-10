
function resolveStorage() {
  try {
    // Merely accessing window.localStorage can throw (blocked cookies, sandboxed iframes)
    const s = window.localStorage;
    const probe = "__store_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export default class Store {
  /**
   * @param {string} [namespace] prefix for all keys, e.g. "myapp"
   * @param {Storage} [backend]  inject for tests; defaults to localStorage
   */
  constructor(namespace = "", backend = resolveStorage()) {
    this.prefix = namespace ? `${namespace}:` : "";
    this.backend = backend;
    this.memory = new Map(); // fallback when storage is unavailable or full
  }

  #key(k) {
    return this.prefix + k;
  }

  get(k, fallback) {
    const key = this.#key(k);
    if (this.memory.has(key)) return this.memory.get(key);
    if (!this.backend) return fallback;
    try {
      const raw = this.backend.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch {
      this.remove(k); // drop corrupt entries instead of failing forever
      return fallback;
    }
  }

  /** @returns {boolean} true if persisted, false if only held in memory */
  set(k, v) {
    const key = this.#key(k);
    if (v === undefined) return this.remove(k);
    this.memory.set(key, v); // always readable this session
    if (!this.backend) return false;
    try {
      this.backend.setItem(key, JSON.stringify(v));
      this.memory.delete(key); // persisted, so no need for the fallback copy
      return true;
    } catch { return false; } // quota exceeded, circular JSON, etc.
  }

  has(k) {
    const sentinel = Symbol();
    return this.get(k, sentinel) !== sentinel;
  }

  remove(k) {
    const key = this.#key(k);
    this.memory.delete(key);
    try { this.backend?.removeItem(key); } catch { }
    return true;
  }

  /** Clears only this namespace's keys, not the whole origin's storage */
  clear() {
    this.memory.clear();
    if (!this.backend) return;
    try {
      const doomed = [];
      for (let i = 0; i < this.backend.length; i++) {
        const key = this.backend.key(i);
        if (key?.startsWith(this.prefix)) doomed.push(key);
      }
      doomed.forEach((key) => this.backend.removeItem(key));
    } catch { }
  }

  /** Listen for changes made in other tabs. Returns an unsubscribe function. */
  subscribe(k, callback) {
    const key = this.#key(k);
    const handler = (e) => {
      if (e.storageArea !== this.backend || e.key !== key) return;
      let value;
      try { value = e.newValue === null ? undefined : JSON.parse(e.newValue); } catch { return; }
      callback(value);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }
}