import { SCREEN_H, TILE } from "./constants";
import type { Theme } from "./data";
import { drawText } from "./font";

/* Procedural NES-style tiles and parallax backdrops, generated once per theme. */

export type Tileset = {
  top: HTMLCanvasElement;
  fill: HTMLCanvasElement;
  block: HTMLCanvasElement;
  ladder: HTMLCanvasElement;
  spike: HTMLCanvasElement;
  door: HTMLCanvasElement;
  far: HTMLCanvasElement;
  mid: HTMLCanvasElement;
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx] as const;
}

function px(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w = 1, h = 1) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function speckle(ctx: CanvasRenderingContext2D, color: string, count: number, seed: number, y0 = 0) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) px(ctx, color, Math.floor(r() * TILE), y0 + Math.floor(r() * (TILE - y0)));
}

function fillTile(theme: Theme) {
  const [c, ctx] = canvas(TILE, TILE);
  px(ctx, theme.fill, 0, 0, TILE, TILE);
  switch (theme.ground) {
    case "asphalt":
      speckle(ctx, theme.fillDark, 22, 3);
      px(ctx, theme.fillDark, 3, 9, 4, 1);
      px(ctx, theme.fillDark, 7, 10, 2, 1);
      break;
    case "snow":
    case "steel":
      px(ctx, theme.fillDark, 0, 7, TILE, 1);
      px(ctx, theme.fillDark, 0, 15, TILE, 1);
      px(ctx, theme.fillDark, 7, 0, 1, 7);
      px(ctx, theme.fillDark, 15, 8, 1, 7);
      if (theme.ground === "steel") {
        px(ctx, theme.topLight, 2, 2);
        px(ctx, theme.topLight, 12, 2);
        px(ctx, theme.topLight, 4, 11);
      } else speckle(ctx, "#fcfcfc", 4, 9);
      break;
    case "grass":
      speckle(ctx, theme.fillDark, 16, 5);
      px(ctx, "#7c7c7c", 4, 6, 3, 2);
      px(ctx, "#bcbcbc", 4, 6, 1, 1);
      px(ctx, "#7c7c7c", 11, 12, 2, 2);
      break;
    case "tile":
      px(ctx, theme.fillDark, 0, 0, 8, 8);
      px(ctx, theme.fillDark, 8, 8, 8, 8);
      break;
    case "carpet":
      for (let y = 0; y < TILE; y += 4) px(ctx, theme.fillDark, 0, y, TILE, 1);
      speckle(ctx, theme.top, 6, 8);
      break;
    case "circuit":
      px(ctx, theme.fillDark, 0, 0, TILE, 1);
      px(ctx, theme.top, 3, 4, 8, 1);
      px(ctx, theme.top, 10, 4, 1, 8);
      px(ctx, theme.top, 10, 11, 5, 1);
      px(ctx, theme.topLight, 2, 3, 3, 3);
      px(ctx, theme.topLight, 14, 10, 2, 3);
      break;
    case "boards":
      for (let y = 0; y < TILE; y += 5) px(ctx, theme.fillDark, 0, y, TILE, 1);
      break;
  }
  return c;
}

function topTile(theme: Theme, fill: HTMLCanvasElement) {
  const [c, ctx] = canvas(TILE, TILE);
  ctx.drawImage(fill, 0, 0);
  switch (theme.ground) {
    case "asphalt":
      px(ctx, theme.top, 0, 0, TILE, 4);
      px(ctx, theme.topLight, 2, 1, 6, 1);
      px(ctx, "#000000", 0, 4, TILE, 1);
      px(ctx, "#bcbcbc", 0, 5, TILE, 1);
      break;
    case "snow": {
      px(ctx, theme.top, 0, 0, TILE, 4);
      const bumps = [5, 6, 5, 4, 5, 6, 6, 5, 4, 4, 5, 6, 5, 5, 4, 5];
      bumps.forEach((h, x) => {
        px(ctx, theme.top, x, 0, 1, h);
        px(ctx, "#a4e4fc", x, h, 1, 1);
      });
      px(ctx, "#a4e4fc", 3, 2, 2, 1);
      break;
    }
    case "grass": {
      px(ctx, theme.top, 0, 0, TILE, 4);
      const r = rng(11);
      for (let x = 0; x < TILE; x++) px(ctx, theme.top, x, 4, 1, Math.floor(r() * 3));
      px(ctx, theme.topLight, 1, 0, 3, 1);
      px(ctx, theme.topLight, 9, 1, 2, 1);
      px(ctx, "#004000", 0, 3, TILE, 1);
      break;
    }
    case "tile":
      px(ctx, theme.top, 0, 0, TILE, 3);
      px(ctx, theme.topLight, 0, 0, TILE, 1);
      px(ctx, "#000000", 0, 3, TILE, 1);
      break;
    case "carpet":
      px(ctx, theme.top, 0, 0, TILE, 5);
      for (let x = 0; x < TILE; x += 2) px(ctx, theme.topLight, x, 1, 1, 1);
      px(ctx, "#000000", 0, 5, TILE, 1);
      break;
    case "circuit":
      px(ctx, theme.top, 0, 0, TILE, 2);
      px(ctx, theme.topLight, 0, 0, TILE, 1);
      px(ctx, "#000000", 0, 2, TILE, 1);
      break;
    case "steel":
      px(ctx, theme.top, 0, 0, TILE, 3);
      for (let x = 0; x < TILE; x += 4) px(ctx, "#000000", x, 0, 2, 3);
      px(ctx, "#000000", 0, 3, TILE, 1);
      break;
    case "boards":
      px(ctx, theme.top, 0, 0, TILE, 3);
      px(ctx, "#000000", 0, 3, TILE, 1);
      break;
  }
  return c;
}

function blockTile(theme: Theme) {
  const [c, ctx] = canvas(TILE, TILE);
  px(ctx, "#000000", 0, 0, TILE, TILE);
  px(ctx, theme.block, 1, 1, 14, 14);
  px(ctx, theme.blockLight, 1, 1, 14, 2);
  px(ctx, theme.blockLight, 1, 1, 2, 14);
  px(ctx, theme.blockDark, 3, 13, 12, 2);
  px(ctx, theme.blockDark, 13, 3, 2, 12);
  px(ctx, theme.blockLight, 6, 6, 4, 4);
  px(ctx, theme.blockDark, 7, 7, 3, 3);
  return c;
}

function ladderTile(theme: Theme) {
  const [c, ctx] = canvas(TILE, TILE);
  px(ctx, "#000000", 2, 0, 3, TILE);
  px(ctx, "#000000", 11, 0, 3, TILE);
  px(ctx, theme.ladder, 3, 0, 1, TILE);
  px(ctx, theme.ladder, 12, 0, 1, TILE);
  for (const y of [2, 7, 12]) {
    px(ctx, "#000000", 4, y - 1, 8, 3);
    px(ctx, theme.ladder, 3, y, 10, 1);
  }
  return c;
}

function spikeTile() {
  const [c, ctx] = canvas(TILE, TILE);
  px(ctx, "#4c4c4c", 0, 12, TILE, 4);
  px(ctx, "#000000", 0, 11, TILE, 1);
  for (let s = 0; s < 4; s++) {
    const x0 = s * 4;
    for (let y = 0; y < 11; y++) {
      const half = Math.floor(((y + 1) / 11) * 2);
      px(ctx, "#000000", x0 + 1 - half, y + 1, half * 2 + 2, 1);
      px(ctx, y < 4 ? "#fcfcfc" : "#bcbcbc", x0 + 2 - half, y + 1, Math.max(1, half * 2), 1);
    }
  }
  return c;
}

function doorTile() {
  const [c, ctx] = canvas(TILE, TILE);
  px(ctx, "#000000", 0, 0, TILE, TILE);
  for (let y = 0; y < TILE; y += 4) {
    px(ctx, "#bcbcbc", 1, y, 14, 3);
    px(ctx, "#fcfcfc", 1, y, 14, 1);
    px(ctx, "#7c7c7c", 1, y + 2, 14, 1);
  }
  px(ctx, "#d82800", 6, 6, 4, 4);
  return c;
}

/* ---------- Backdrops ---------- */

const FAR_W = 512;

function skyBands(ctx: CanvasRenderingContext2D, theme: Theme) {
  px(ctx, theme.sky, 0, 0, FAR_W, SCREEN_H);
  const bands = [96, 120, 136, 146];
  bands.forEach((y, i) => {
    px(ctx, theme.sky2, 0, y, FAR_W, 2 + i * 2);
  });
  px(ctx, theme.sky2, 0, 152, FAR_W, SCREEN_H - 152);
}

function stars(ctx: CanvasRenderingContext2D, seed: number, count: number, maxY: number) {
  const r = rng(seed);
  for (let i = 0; i < count; i++)
    px(ctx, i % 5 === 0 ? "#f8b800" : "#fcfcfc", Math.floor(r() * FAR_W), Math.floor(r() * maxY));
}

function pine(ctx: CanvasRenderingContext2D, x: number, base: number, h: number, color: string, snow?: string) {
  for (let y = 0; y < h; y++) {
    const half = Math.floor(((y % 10) + 2 + y / 3) / 1.5);
    px(ctx, color, x - half, base - h + y, half * 2 + 1, 1);
    if (snow && y % 10 === 0) px(ctx, snow, x - half, base - h + y, half * 2 + 1, 1);
  }
  px(ctx, "#503000", x - 1, base, 3, 4);
}

function sign(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string, fg: string) {
  const w = text.length * 6 + 5;
  px(ctx, "#000000", x - 1, y - 1, w + 2, 12);
  px(ctx, bg, x, y, w, 10);
  drawText(ctx, text, x + 3, y + 2, fg);
  px(ctx, "#000000", x + Math.floor(w / 2) - 1, y + 11, 2, 20);
}

function buildFar(theme: Theme) {
  const [c, ctx] = canvas(FAR_W, SCREEN_H);
  skyBands(ctx, theme);
  const r = rng(theme.sky.length * 97 + theme.far.charCodeAt(1));
  switch (theme.backdrop) {
    case "city":
    case "hq": {
      if (theme.backdrop === "hq") stars(ctx, 4, 50, 90);
      let x = 0;
      while (x < FAR_W) {
        const w = 24 + Math.floor(r() * 40);
        const h = 40 + Math.floor(r() * (theme.backdrop === "hq" ? 110 : 70));
        px(ctx, theme.farDark, x, 170 - h, w, h + 70);
        px(ctx, theme.far, x + 2, 172 - h, w - 4, h + 70);
        for (let wy = 178 - h; wy < 160; wy += 10)
          for (let wx = x + 5; wx < x + w - 6; wx += 8)
            px(ctx, r() > 0.4 ? (theme.backdrop === "hq" ? "#d82800" : "#fce0a8") : theme.farDark, wx, wy, 3, 5);
        x += w + Math.floor(r() * 6);
      }
      if (theme.backdrop === "city") {
        // church steeple + water tower: the Ogdensburg skyline, roughly
        px(ctx, theme.farDark, 300, 60, 12, 110);
        for (let i = 0; i < 20; i++) px(ctx, theme.farDark, 306 - Math.floor(i / 3), 40 + i, Math.floor(i / 3) * 2 + 1, 1);
        px(ctx, theme.farDark, 120, 70, 30, 18);
        px(ctx, theme.farDark, 124, 88, 3, 60);
        px(ctx, theme.farDark, 143, 88, 3, 60);
        drawText(ctx, "OGD", 126, 76, theme.far);
      }
      break;
    }
    case "winter":
      for (let x = 0; x < FAR_W; x++) {
        const h = 40 + Math.sin(x / 50) * 18 + Math.sin(x / 13) * 4;
        px(ctx, theme.farDark, x, 170 - h, 1, h + 70);
        px(ctx, theme.far, x, 172 - h, 1, h + 70);
      }
      for (let i = 0; i < 70; i++) px(ctx, "#fcfcfc", Math.floor(r() * FAR_W), Math.floor(r() * 120));
      break;
    case "forest":
      stars(ctx, 7, 90, 120);
      // crescent moon
      for (let y = 0; y < 18; y++) {
        const half = Math.round(Math.sqrt(81 - (y - 8.5) ** 2));
        px(ctx, "#fce0a8", 409 - half, 22 + y, half * 2, 1);
        const cut = Math.round(Math.sqrt(Math.max(0, 64 - (y - 7) ** 2)));
        if (cut > 0) px(ctx, theme.sky, 413 - cut, 22 + y, cut * 2, 1);
      }
      for (let x = 0; x < FAR_W; x += 14) pine(ctx, x + Math.floor(r() * 6), 150, 50 + Math.floor(r() * 40), theme.farDark);
      px(ctx, theme.farDark, 0, 150, FAR_W, 90);
      break;
    case "river": {
      px(ctx, "#fce0a8", 60, 30, 26, 26);
      px(ctx, "#f8b800", 64, 34, 18, 18);
      // far Canadian shore + the bridge
      px(ctx, "#005800", 0, 110, FAR_W, 12);
      px(ctx, theme.farDark, 0, 122, FAR_W, 120);
      px(ctx, theme.far, 0, 124, FAR_W, 120);
      for (let y = 128; y < 170; y += 6) for (let x = (y * 7) % 23; x < FAR_W; x += 23) px(ctx, "#a4e4fc", x, y, 6, 1);
      const towerA = 180;
      const towerB = 330;
      for (const tx of [towerA, towerB]) {
        px(ctx, "#4c4c4c", tx, 50, 6, 75);
        px(ctx, "#4c4c4c", tx + 14, 50, 6, 75);
        px(ctx, "#4c4c4c", tx, 60, 20, 3);
        px(ctx, "#4c4c4c", tx, 80, 20, 3);
      }
      px(ctx, "#4c4c4c", 90, 100, 340, 4);
      for (let x = 90; x < 430; x++) {
        const t = x < towerA ? (towerA - x) / 90 : x > towerB + 20 ? (x - towerB - 20) / 100 : 0;
        const mid = (towerA + towerB + 20) / 2;
        const sag = x >= towerA && x <= towerB + 20 ? 50 + 40 * (1 - ((x - mid) / ((towerB + 20 - towerA) / 2)) ** 2) : 50 + 50 * t;
        px(ctx, "#000000", x, Math.floor(sag), 1, 1);
        if (x % 8 === 0) px(ctx, "#4c4c4c", x, Math.floor(sag), 1, 100 - Math.floor(sag));
      }
      sign(ctx, "CANADA ->", 440, 84, "#007800", "#fcfcfc");
      break;
    }
    case "store":
    case "warehouse":
      px(ctx, theme.farDark, 0, 0, FAR_W, 18);
      for (let x = 0; x < FAR_W; x += 64) {
        px(ctx, "#fce0a8", x + 20, 18, 24, 3);
        px(ctx, "#fcfcfc", x + 22, 19, 20, 1);
      }
      for (let x = 0; x < FAR_W; x += 96) {
        px(ctx, theme.farDark, x, 40, 90, 140);
        px(ctx, theme.far, x + 2, 42, 86, 140);
        for (let sy = 70; sy < 180; sy += 28) {
          px(ctx, "#000000", x + 2, sy, 86, 3);
          for (let bx = x + 4; bx < x + 84; bx += 9) {
            const colors = ["#d82800", "#f8b800", "#58d854", "#3cbcfc", "#fcfcfc", "#d800cc"];
            const col = colors[Math.floor(r() * colors.length)];
            const bh = 10 + Math.floor(r() * 12);
            px(ctx, "#000000", bx, sy - bh, 8, bh);
            px(ctx, col, bx + 1, sy - bh + 1, 6, bh - 1);
          }
        }
      }
      break;
    case "office":
      for (let x = 0; x < FAR_W; x += 128) {
        px(ctx, "#000000", x + 16, 40, 60, 50);
        px(ctx, "#3cbcfc", x + 18, 42, 56, 46);
        px(ctx, "#a4e4fc", x + 18, 42, 56, 12);
        px(ctx, "#000000", x + 45, 42, 2, 46);
        px(ctx, theme.farDark, x + 90, 120, 30, 60);
        px(ctx, theme.far, x + 92, 122, 26, 6);
      }
      break;
    case "cyber":
      for (let x = 0; x < FAR_W; x += 16) px(ctx, theme.far, x, 0, 1, SCREEN_H);
      for (let y = 0; y < SCREEN_H; y += 16) px(ctx, theme.far, 0, y, FAR_W, 1);
      for (let i = 0; i < 9; i++) {
        const bx = Math.floor(r() * (FAR_W - 50));
        const by = 20 + Math.floor(r() * 110);
        px(ctx, "#000000", bx - 1, by - 1, 42, 18);
        px(ctx, "#fcfcfc", bx, by, 40, 16);
        px(ctx, "#fcfcfc", bx + 4, by + 16, 4, 4);
        drawText(ctx, ["LOL", "WHY?", "+1", "SAME", "BUMP", "??"][i % 6], bx + 4, by + 5, "#0028a8");
      }
      break;
  }
  return c;
}

function buildMid(theme: Theme) {
  const [c, ctx] = canvas(FAR_W, SCREEN_H);
  const r = rng(theme.mid.charCodeAt(2) * 31 + theme.top.charCodeAt(3));
  const base = 192;
  switch (theme.backdrop) {
    case "city":
      for (let x = 10; x < FAR_W; x += 128) {
        px(ctx, theme.midDark, x, base - 70, 70, 70);
        px(ctx, theme.mid, x + 2, base - 68, 66, 68);
        px(ctx, "#000000", x + 8, base - 50, 16, 24);
        px(ctx, "#3cbcfc", x + 10, base - 48, 12, 20);
        px(ctx, "#000000", x + 40, base - 40, 14, 40);
        px(ctx, "#881400", x + 42, base - 38, 10, 38);
      }
      for (let x = 70; x < FAR_W; x += 256) {
        px(ctx, "#f87858", x, base - 14, 8, 14);
        px(ctx, "#fcfcfc", x, base - 10, 8, 3);
      }
      sign(ctx, theme.signs[0], 90, 100, "#007800", "#fcfcfc");
      sign(ctx, theme.signs[3], 300, 90, "#f8b800", "#000000");
      break;
    case "winter":
      for (let x = 0; x < FAR_W; x += 22) pine(ctx, x + Math.floor(r() * 8), base - 4, 34 + Math.floor(r() * 30), theme.mid, "#fcfcfc");
      for (let x = 0; x < FAR_W; x++) px(ctx, "#fcfcfc", x, base - 10 - Math.floor(Math.abs(Math.sin(x / 19)) * 10), 1, 30);
      sign(ctx, theme.signs[0], 140, 110, "#d82800", "#fcfcfc");
      sign(ctx, theme.signs[3], 380, 120, "#f8b800", "#000000");
      break;
    case "forest":
      for (let x = 0; x < FAR_W; x += 26) pine(ctx, x + Math.floor(r() * 10), base, 60 + Math.floor(r() * 50), theme.mid);
      sign(ctx, theme.signs[0], 120, 120, "#f8b800", "#000000");
      sign(ctx, theme.signs[1], 360, 116, "#007800", "#fcfcfc");
      break;
    case "river":
      for (let x = 0; x < FAR_W; x += 64) {
        px(ctx, "#503000", x + 30, base - 40, 4, 40);
        for (let i = 0; i < 24; i++) px(ctx, i % 6 === 5 ? theme.midDark : theme.mid, x + 32 - Math.floor(i * 0.75) - 1, base - 64 + i, Math.floor(i * 0.75) * 2 + 2, 1);
      }
      for (let x = 0; x < FAR_W; x += 48) {
        px(ctx, "#000000", x + 10, base - 18, 2, 18);
        px(ctx, "#000000", x + 6, base - 18, 10, 2);
      }
      sign(ctx, theme.signs[1], 200, 120, "#fcfcfc", "#007800");
      break;
    case "store":
    case "warehouse":
      sign(ctx, theme.signs[0], 60, 40, "#d82800", "#fcfcfc");
      sign(ctx, theme.signs[1], 230, 36, "#f8b800", "#000000");
      sign(ctx, theme.signs[2], 400, 44, "#fcfcfc", "#d82800");
      break;
    case "office":
      for (let x = 0; x < FAR_W; x += 160) {
        px(ctx, "#000000", x + 20, base - 40, 90, 40);
        px(ctx, theme.mid, x + 21, base - 39, 88, 39);
        px(ctx, theme.midDark, x + 21, base - 39, 88, 4);
        px(ctx, "#007800", x + 130, base - 26, 12, 26);
        px(ctx, "#58d854", x + 128, base - 34, 16, 10);
      }
      sign(ctx, theme.signs[0], 40, 80, "#fcfcfc", "#000000");
      sign(ctx, theme.signs[1], 300, 70, "#000000", "#58d854");
      break;
    case "cyber":
      sign(ctx, theme.signs[0], 30, 60, "#fcfcfc", "#0028a8");
      sign(ctx, theme.signs[2], 300, 90, "#fcfcfc", "#0028a8");
      break;
    case "hq":
      sign(ctx, theme.signs[0], 50, 70, "#881400", "#f8b800");
      sign(ctx, theme.signs[1], 260, 60, "#000000", "#d82800");
      break;
  }
  return c;
}

const sets = new Map<Theme, Tileset>();

export function tileset(theme: Theme): Tileset {
  const hit = sets.get(theme);
  if (hit) return hit;
  const fill = fillTile(theme);
  const made: Tileset = {
    fill,
    top: topTile(theme, fill),
    block: blockTile(theme),
    ladder: ladderTile(theme),
    spike: spikeTile(),
    door: doorTile(),
    far: buildFar(theme),
    mid: buildMid(theme),
  };
  sets.set(theme, made);
  return made;
}

export const BACKDROP_W = FAR_W;
