export default class Linker {
  constructor(key = 'fh_link') {
    this.LINK_KEY = key;
  }

  read() {
    let v = null;
    try {
      v = JSON.parse(sessionStorage.getItem(this.LINK_KEY) || 'null');
    } catch { v = null; }
    if (!v) {
      const m = location.hash.match(/[#&]s=([^&]+)/);
      if (m) {
        try {
          v = JSON.parse(decodeURIComponent(m[1]));
        } catch { v = null; }
      }
    }
    return v && v.v === 1 && Date.now() - (v.at || 0) < 6 * 3600e3 ? v : null;
  }

  write(o) {
    const v = Object.assign({
      v: 1,
      at: Date.now()
    }, o);
    try {
      sessionStorage.setItem(this.LINK_KEY, JSON.stringify(v));
      return '';
    } catch { return '#s=' + encodeURIComponent(JSON.stringify(v)); }
  }

  clear() {
    try {
      sessionStorage.removeItem(this.LINK_KEY);
    } catch { }
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }
}
