import { Vector2 } from 'three';

export const CROWD_COLORS = {
  shirt: ['#e0474f', '#f08a2c', '#efbd24', '#4fae4c', '#25a39d', '#3a7cd6', '#7a58d0', '#d1559c', '#8a8794', '#34456a', '#9c5530', '#2f2d3a', '#c95b2e', '#5b8f3a'],
  pants: ['#2c3a5c', '#393a42', '#6a6e78', '#7a6a50', '#232630', '#4a5c7c'],
  shoe: ['#f1f1f1', '#2a2a2e', '#c44a3a', '#6b7888', '#e7d9bf'],
  hair: ['#1d181b', '#2b211b', '#3c2a1f', '#55392a', '#141414', '#4a3b33'],
  skin: ['#f6d0b2', '#eec09c', '#e2ac88', '#f8dac4', '#d69f7c', '#f3c9a6'],
};

export const introText = [
  '인간들의 정신건강이 악화되어',
  '정신건강한 사람이 희귀해진 근미래',
  '국가는 이들을 특별관리 보호대상으로 지정하고 등급을 매기기 시작했다.',
];

export const OUTLINE = {
  px: { value: 2.6 },
  res: { value: new Vector2(1, 1) }
};

export const ITEM_DEFS = [{
  key: 'pierce',
  name: '관통탄',
  short: '관통',
  color: '#168d9b'
}, {
  key: 'impact',
  name: '충격탄',
  short: '파괴',
  color: '#d56b24'
}, {
  key: 'spread',
  name: '산탄',
  short: '산탄',
  color: '#8660be'
}];

export const WAVES = [{
  t0: 0,
  t1: 14,
  every: 1.3,
  run: 0.12,
  north: 0.68
}, {
  t0: 14,
  t1: 40,
  every: 0.95,
  run: 0.48,
  north: 0.58
}, {
  t0: 40,
  t1: 85,
  every: 0.78,
  run: 0.65,
  north: 0.48
}, {
  t0: 85,
  t1: 130,
  every: 0.66,
  run: 0.76,
  north: 0.40
}];

export const SLOTS = [{
  x: 0.0,
  z: -0.37,
  kind: 'stand'
}, {
  x: 0.31,
  z: 0.13,
  kind: 'kneel'
}, {
  x: -0.31,
  z: 0.13,
  kind: 'kneel'
}, {
  x: 0.56,
  z: -0.08,
  kind: 'side'
}, {
  x: -0.56,
  z: -0.08,
  kind: 'side'
}, {
  x: 0.34,
  z: -0.34,
  kind: 'stand'
}, {
  x: -0.34,
  z: -0.34,
  kind: 'stand'
}, {
  x: 0.0,
  z: 0.5,
  kind: 'low'
}];

export const ALLY_DEFS = [{
  shirt: '#8fdcbf', // 2급
  hair: '#3b2a20',
  bob: false
}, {
  shirt: '#c6b6f2', // 3급
  hair: '#2a2024',
  bob: true
}, {
  shirt: '#f7bccf', // 2급
  hair: '#5a3a28',
  bob: true
}, {
  shirt: '#f1da86', // 3급 (안경)
  hair: '#1d1a1c',
  bob: false
}];

export const ALLY_LOOK = [{
  grade: 2,
  eyeW: 42,
  eyeH: 48,
  hl: 2,
  brow: '#3a2a20',
  fem: false,
  glasses: false,
  smile: 15,
  bags: false
}, {
  grade: 3,
  eyeW: 37,
  eyeH: 42,
  hl: 1,
  brow: '#2a2024',
  fem: true,
  glasses: false,
  smile: 9,
  bags: true
}, {
  grade: 2,
  eyeW: 41,
  eyeH: 47,
  hl: 2,
  brow: '#5a3a28',
  fem: true,
  glasses: false,
  smile: 14,
  bags: false
}, {
  grade: 3,
  eyeW: 36,
  eyeH: 41,
  hl: 1,
  brow: '#1d1a1c',
  fem: false,
  glasses: true,
  smile: 8,
  bags: true
}];