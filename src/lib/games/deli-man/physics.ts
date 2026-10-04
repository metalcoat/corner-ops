import { TILE } from "./constants";
import { isSolid, Tile, tileAt, type Level } from "./levels";

export type Box = { x: number; y: number; w: number; h: number };

export type Body = Box & { vx: number; vy: number; grounded: boolean };

export type MoveResult = {
  wall: boolean;
  landed: boolean;
  ceiling: boolean;
  door: boolean;
  spike: boolean;
};

export function overlap(a: Box, b: Box) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function isLadderTop(level: Level, col: number, row: number) {
  return tileAt(level, col, row) === Tile.Ladder && tileAt(level, col, row - 1) !== Tile.Ladder;
}

/**
 * Axis-separated tile collision. Ladder tops act as one-way platforms
 * unless `throughLadders` is set (climbing down).
 */
export function moveBody(
  level: Level,
  body: Body,
  options: { ladderTops?: boolean; walls?: boolean } = {},
): MoveResult {
  const result: MoveResult = { wall: false, landed: false, ceiling: false, door: false, spike: false };
  const ladderTops = options.ladderTops ?? true;

  if (body.vx !== 0) {
    body.x += body.vx;
    const col = body.vx > 0 ? Math.floor((body.x + body.w - 0.01) / TILE) : Math.floor(body.x / TILE);
    const top = Math.floor(body.y / TILE);
    const bottom = Math.floor((body.y + body.h - 0.01) / TILE);
    for (let row = top; row <= bottom; row++) {
      const tile = tileAt(level, col, row);
      if (!isSolid(tile)) continue;
      if (tile === Tile.Door) result.door = true;
      if (tile === Tile.Spike) result.spike = true;
      body.x = body.vx > 0 ? col * TILE - body.w : (col + 1) * TILE;
      result.wall = true;
      break;
    }
  }

  const prevBottom = body.y + body.h;
  body.grounded = false;
  body.y += body.vy;
  const left = Math.floor(body.x / TILE);
  const right = Math.floor((body.x + body.w - 0.01) / TILE);
  if (body.vy > 0) {
    const row = Math.floor((body.y + body.h - 0.01) / TILE);
    for (let col = left; col <= right; col++) {
      const tile = tileAt(level, col, row);
      const ladderTop = ladderTops && isLadderTop(level, col, row) && prevBottom <= row * TILE + 0.01;
      if (!isSolid(tile) && !ladderTop) continue;
      if (tile === Tile.Spike) result.spike = true;
      body.y = row * TILE - body.h;
      body.vy = 0;
      body.grounded = true;
      result.landed = true;
    }
  } else if (body.vy < 0) {
    const row = Math.floor(body.y / TILE);
    for (let col = left; col <= right; col++) {
      if (!isSolid(tileAt(level, col, row))) continue;
      body.y = (row + 1) * TILE;
      body.vy = 0;
      result.ceiling = true;
      break;
    }
  }
  return result;
}

/** Is there floor directly below the given x at the body's feet? */
export function groundBelow(level: Level, x: number, feetY: number) {
  const tile = tileAt(level, Math.floor(x / TILE), Math.floor((feetY + 1) / TILE));
  return isSolid(tile) || tile === Tile.Ladder;
}

export function solidAtPoint(level: Level, x: number, y: number) {
  return isSolid(tileAt(level, Math.floor(x / TILE), Math.floor(y / TILE)));
}

export function ladderAt(level: Level, x: number, y: number) {
  return tileAt(level, Math.floor(x / TILE), Math.floor(y / TILE)) === Tile.Ladder;
}
