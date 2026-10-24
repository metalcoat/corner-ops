import { PAL } from "./constants";

export type Sprite = { right: HTMLCanvasElement; left: HTMLCanvasElement; w: number; h: number };

const cache = new Map<string, Sprite>();

function paint(rows: string[], palette: Record<string, string>, flip: boolean) {
  const h = rows.length;
  const w = Math.max(...rows.map((row) => row.length));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const color = palette[row[x]] ?? PAL[row[x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(flip ? w - 1 - x : x, y, 1, 1);
    }
  });
  return canvas;
}

/**
 * Compile ASCII pixel art into canvases (both facings), cached by key.
 * `overrides` remaps palette letters (weapon colours, boss colours, flashes).
 */
export function sprite(key: string, rows: string[], overrides: Record<string, string> = {}): Sprite {
  const hit = cache.get(key);
  if (hit) return hit;
  const right = paint(rows, overrides, false);
  const left = paint(rows, overrides, true);
  const made = { right, left, w: right.width, h: right.height };
  cache.set(key, made);
  return made;
}

/** Solid-silhouette version (used for hit flashes and charge glow). */
export function silhouette(key: string, rows: string[], color: string) {
  const all: Record<string, string> = {};
  for (const letter of Object.keys(PAL)) all[letter] = letter === "K" ? PAL.K : color;
  for (const letter of "AaZ") all[letter] = color;
  return sprite(`sil:${color}:${key}`, rows, all);
}

export function draw(
  ctx: CanvasRenderingContext2D,
  s: Sprite,
  x: number,
  y: number,
  facingLeft = false,
) {
  ctx.drawImage(facingLeft ? s.left : s.right, Math.round(x), Math.round(y));
}
