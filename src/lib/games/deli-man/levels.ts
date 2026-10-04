import { ROWS, SCREEN_COLS, TILE } from "./constants";
import type { BossDef } from "./data";

/*
 * Stages are stitched together from 16x15 "screens", the same way NES
 * levels were authored. Only the bottom rows are written; rows above are
 * padded with air.
 *
 *  #  ground          =  block / platform     H  ladder     ^  spikes
 *  D  boss shutter    S  player start         K  checkpoint X  boss spawn
 *  M  hard-hat inspector  F  goose  T  oven turret  P  pothole popper
 *  C  runaway cart    R  charging deer
 *  e/E small/big pickle (health)   w/W small/big mustard (weapon)   U  1-UP
 */
const SCREENS: Record<string, string[]> = {
  start: [
    "..S.............",
    "################",
    "################",
    "################",
  ],
  flat_mets: [
    "................",
    "........F.......",
    "................",
    "................",
    ".....M.......M..",
    "################",
    "################",
    "################",
  ],
  steps: [
    "................",
    "...........F....",
    "..........====..",
    "......===.......",
    "..===.........e.",
    "################",
    "################",
    "################",
  ],
  pit1: [
    "................",
    "........F.......",
    "................",
    ".....==..==.....",
    "..............P.",
    "####........####",
    "####........####",
    "####........####",
  ],
  ladder_spikes: [
    "................",
    "......M....F....",
    "...H==========..",
    "...H............",
    "...H............",
    "...H............",
    "...H............",
    "...H............",
    "...H............",
    "#####^^^^^^^^###",
    "################",
    "################",
  ],
  turret_wall: [
    "................",
    "................",
    "...........T....",
    "..........######",
    "......==..######",
    "..........######",
    "################",
    "################",
    "################",
  ],
  hop_pit: [
    "................",
    "................",
    "...P......P.....",
    "#######..#######",
    "#######..#######",
    "#######..#######",
  ],
  cart_run: [
    "................",
    "................",
    ".....w........C.",
    "################",
    "################",
    "################",
  ],
  pillars: [
    "................",
    "......F.........",
    "..##......##....",
    "..##...e..##....",
    "####..######..##",
    "####..######..##",
    "####..######..##",
  ],
  checkpoint: [
    "................",
    "................",
    ".......K....E...",
    "################",
    "################",
    "################",
  ],
  ladder_wall: [
    "........M.......",
    ".......H######..",
    ".......H######..",
    ".......H######..",
    ".......H######..",
    ".......H######..",
    ".......H######..",
    ".......H######..",
    "################",
    "################",
    "################",
  ],
  spike_jumps: [
    "................",
    "......F.........",
    "................",
    "....==..==..==..",
    "................",
    "##^^^^^^^^^^^^##",
    "################",
    "################",
  ],
  met_stairs: [
    "................",
    "............M...",
    "..........######",
    "......M...######",
    ".....###########",
    "################",
    "################",
    "################",
  ],
  fliers: [
    "..........F.....",
    "................",
    "....F...........",
    "................",
    "...........F....",
    "......==........",
    "..............U.",
    "################",
    "################",
    "################",
  ],
  corridor: [
    "................",
    "................",
    "..e..K......W...",
    "################",
    "################",
    "################",
  ],
  boss: [
    "#..............#",
    "#..............#",
    "#..............#",
    "#..............#",
    "#..............#",
    "#..............#",
    "#..............#",
    "#..............#",
    "#..............#",
    "D..............#",
    "D..........X...#",
    "D..............#",
    "################",
    "################",
    "################",
  ],
};

export const Tile = {
  Air: 0,
  Ground: 1,
  Block: 2,
  Ladder: 3,
  Spike: 4,
  Door: 5,
} as const;
export type Tile = (typeof Tile)[keyof typeof Tile];

export type Spawn = {
  id: number;
  kind: string;
  x: number;
  y: number;
};

export type Level = {
  cols: number;
  tiles: Uint8Array;
  spawns: Spawn[];
  items: Spawn[];
  checkpoints: { x: number; y: number }[];
  start: { x: number; y: number };
  doorCol: number;
  bossSpawn: { x: number; y: number };
};

const ENEMY_KINDS = "MFTPCR";
const ITEM_KINDS = "eEwWU";

export function buildLevel(boss: BossDef): Level {
  const screens = boss.screens.map((name) => {
    const rows = SCREENS[name];
    if (!rows) throw new Error(`Unknown screen ${name}`);
    return [...Array(ROWS - rows.length).fill("".padEnd(SCREEN_COLS, ".")), ...rows];
  });
  const cols = screens.length * SCREEN_COLS;
  const tiles = new Uint8Array(cols * ROWS);
  const spawns: Spawn[] = [];
  const items: Spawn[] = [];
  const checkpoints: { x: number; y: number }[] = [];
  let start = { x: 32, y: 160 };
  let doorCol = cols - SCREEN_COLS;
  let bossSpawn = { x: (cols - 4) * TILE, y: 0 };
  let id = 0;
  screens.forEach((rows, screenIndex) => {
    rows.forEach((row, y) => {
      for (let cx = 0; cx < SCREEN_COLS; cx++) {
        const ch = row[cx] ?? ".";
        const x = screenIndex * SCREEN_COLS + cx;
        const index = y * cols + x;
        const px = x * TILE;
        const py = y * TILE;
        if (ch === "#") tiles[index] = Tile.Ground;
        else if (ch === "=") tiles[index] = Tile.Block;
        else if (ch === "H") tiles[index] = Tile.Ladder;
        else if (ch === "^") tiles[index] = Tile.Spike;
        else if (ch === "D") {
          tiles[index] = Tile.Door;
          doorCol = x;
        } else if (ch === "S") start = { x: px + 1, y: py + TILE - 22 };
        else if (ch === "K") checkpoints.push({ x: px + 1, y: py + TILE - 22 });
        else if (ch === "X") bossSpawn = { x: px, y: py };
        else if (ENEMY_KINDS.includes(ch)) {
          const kind = boss.theme.swap?.[ch] ?? ch;
          spawns.push({ id: id++, kind, x: px, y: py });
        } else if (ITEM_KINDS.includes(ch)) items.push({ id: id++, kind: ch, x: px, y: py });
      }
    });
  });
  return { cols, tiles, spawns, items, checkpoints, start, doorCol, bossSpawn };
}

export function tileAt(level: Level, col: number, row: number): Tile {
  if (col < 0 || col >= level.cols) return Tile.Ground;
  if (row < 0) return Tile.Air;
  if (row >= ROWS) return Tile.Air;
  return level.tiles[row * level.cols + col] as Tile;
}

export function setTile(level: Level, col: number, row: number, tile: Tile) {
  if (col < 0 || col >= level.cols || row < 0 || row >= ROWS) return;
  level.tiles[row * level.cols + col] = tile;
}

export function isSolid(tile: Tile) {
  return tile === Tile.Ground || tile === Tile.Block || tile === Tile.Door || tile === Tile.Spike;
}

export const SCREEN_NAMES = Object.keys(SCREENS);
