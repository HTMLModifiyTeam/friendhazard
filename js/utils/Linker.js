const LINK_KEY = 'fh_link';
const HASH_PARAM = 's';
const VERSION = 1;
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Persists a small "link" payload across page loads.
 * Primary store: sessionStorage. Fallback: a `#s=<json>` URL hash fragment,
 * for contexts where storage is blocked (private mode, sandboxed iframes, etc.).
 */
export default class Linker {
  static KEY = LINK_KEY;

  /** Returns the stored payload, or null if missing, malformed or expired. */
  read() {
    const value = this.#fromStorage() ?? this.#fromHash();
    if (!this.#isValid(value)) {
      if (value) this.#removeStored(); // drop stale/invalid data
      return null;
    }
    return value;
  }

  /**
   * Stores the payload.
   * @returns {string} '' if saved to sessionStorage; otherwise a hash string
   *   (e.g. '#s=...') the caller should append to the URL to carry the state.
   */
  write(payload = {}) {
    // Spread order matters: v and at can't be overridden by the caller.
    const json = JSON.stringify({ ...payload, v: VERSION, at: Date.now() });
    try {
      sessionStorage.setItem(LINK_KEY, json);
      return '';
    } catch { return `#${HASH_PARAM}=${encodeURIComponent(json)}`; }
  }

  /** Removes stored data and the `s` hash param, leaving other hash params intact. */
  clear() {
    this.#removeStored();

    const params = new URLSearchParams(location.hash.slice(1));
    if (!params.has(HASH_PARAM)) return;
    params.delete(HASH_PARAM);
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  }

  // --- internals ---------------------------------------------------------

  #fromStorage() {
    try {
      const raw = sessionStorage.getItem(LINK_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  #fromHash() {
    try {
      const raw = new URLSearchParams(location.hash.slice(1)).get(HASH_PARAM);
      return raw ? JSON.parse(raw) : null; // URLSearchParams already decodes
    } catch { return null; }
  }

  #removeStored() {
    try {
      sessionStorage.removeItem(LINK_KEY);
    } catch { /* storage unavailable */ }
  }

  #isValid(v) {
    if (!v || typeof v !== 'object' || v.v !== VERSION) return false;
    const age = Date.now() - Number(v.at);
    // Rejects missing/NaN timestamps, expired entries, and future-dated ones.
    return Number.isFinite(age) && age >= 0 && age < TTL_MS;
  }
}