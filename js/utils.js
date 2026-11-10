export const $ = (id) => document.getElementById(id);

// MATH
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const TAU = Math.PI * 2;
export const approach = (cur, target, k, dt) => cur + (target - cur) * (1 - Math.exp(-k * dt));
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const angleApproach = (cur, target, k, dt) => cur + wrapAngle(target - cur) * (1 - Math.exp(-k * dt));
export function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}