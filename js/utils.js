export const $ = (id) => document.getElementById(id);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const TAU = Math.PI * 2;
export const rngChoice = (a) => a[Math.floor(Math.random() * a.length)];
export const approach = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const angleApproach = (cur, target, k, dt) => cur + wrapAngle(target - cur) * (1 - Math.exp(-k * dt));

export class Store {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch { return d; }
  }
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }
}