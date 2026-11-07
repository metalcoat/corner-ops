import { HEAD_ICON } from "./art/player";
import { MAX_HP } from "./constants";
import { drawText } from "./font";
import { draw, sprite } from "./sprites";

/** Classic vertical segmented energy bar: 28 one-pixel ticks, filled from the bottom. */
export function drawBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  value: number,
  main: string,
  light: string,
  max = MAX_HP,
) {
  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, 8, max * 2 + 2);
  const filled = Math.max(0, Math.min(max, Math.ceil(value)));
  for (let i = 0; i < filled; i++) {
    const ty = y + 1 + (max - 1 - i) * 2;
    ctx.fillStyle = main;
    ctx.fillRect(x + 1, ty, 6, 1);
    ctx.fillStyle = light;
    ctx.fillRect(x + 3, ty, 2, 1);
  }
}

/** Horizontal bar used by the pause menu. */
export function drawHBar(ctx: CanvasRenderingContext2D, x: number, y: number, value: number, main: string, max = MAX_HP) {
  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, max * 2 + 2, 7);
  const filled = Math.max(0, Math.min(max, Math.ceil(value)));
  for (let i = 0; i < filled; i++) {
    ctx.fillStyle = main;
    ctx.fillRect(x + 1 + i * 2, y + 1, 1, 5);
    ctx.fillStyle = "#fcfcfc";
    ctx.fillRect(x + 1 + i * 2, y + 3, 1, 1);
  }
}

export function drawLives(ctx: CanvasRenderingContext2D, x: number, y: number, lives: number) {
  const head = sprite("headIcon", HEAD_ICON);
  draw(ctx, head, x, y);
  drawText(ctx, `X${Math.max(0, lives)}`, x + 19, y + 4, "#fcfcfc", { shadow: "#000000" });
}
