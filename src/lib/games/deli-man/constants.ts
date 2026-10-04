/** Native NES-style resolution. Everything is simulated and drawn at this size. */
export const SCREEN_W = 256;
export const SCREEN_H = 240;
export const TILE = 16;
export const ROWS = SCREEN_H / TILE; // 15
export const SCREEN_COLS = SCREEN_W / TILE; // 16
export const STEP_MS = 1000 / 60;

/** Physics tuned per 60 Hz frame, in pixels (close to the NES originals). */
export const PHYS = {
  walk: 1.375,
  tiptoe: 0.5,
  tiptoeFrames: 6,
  jump: -4.9,
  gravity: 0.25,
  maxFall: 7,
  climb: 1.3,
  hurtFrames: 22,
  hurtPush: 0.6,
  invulnFrames: 80,
  deathFrames: 200,
} as const;

export const MAX_HP = 28;
export const MAX_ENERGY = 28;
export const START_LIVES = 3;

/** Restricted NES-like palette shared by sprites, tiles and UI. */
export const PAL: Record<string, string> = {
  K: "#000000",
  W: "#fcfcfc",
  w: "#bcbcbc",
  g: "#7c7c7c",
  d: "#4c4c4c",
  R: "#d82800",
  r: "#881400",
  O: "#f87858",
  o: "#e45c10",
  Y: "#f8b800",
  y: "#fce0a8",
  S: "#fcb890",
  s: "#c86c40",
  B: "#0078f8",
  b: "#0028a8",
  C: "#3cbcfc",
  L: "#a4e4fc",
  G: "#58d854",
  h: "#007800",
  N: "#ac7c00",
  n: "#503000",
  T: "#fca044",
  t: "#c84c0c",
  P: "#d800cc",
  p: "#6844fc",
  M: "#f878f8",
};

export const UI = {
  bg: "#000000",
  text: "#fcfcfc",
  gold: "#f8b800",
  cream: "#fce0a8",
  red: "#d82800",
  sky: "#3cbcfc",
  dim: "#7c7c7c",
  green: "#58d854",
};
