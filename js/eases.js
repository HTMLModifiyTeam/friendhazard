import { MathUtils } from 'three'

export const easeOutCubic = (t) => 1 - Math.pow(1 - MathUtils.clamp(t, 0, 1), 3);
export const easeInOutCubic = (t) => {
  t = MathUtils.clamp(t, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
export const easeInQuad = (t) => {
  t = MathUtils.clamp(t, 0, 1);
  return t * t;
};
export const easeInOutSine = (t) => {
  t = MathUtils.clamp(t, 0, 1);
  return -(Math.cos(Math.PI * t) - 1) / 2;
};