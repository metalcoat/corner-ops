// Procedural Ogdensburg lots: every address gets its own house (or business)
// and yard, generated from a seed so the same street looks the same each run.
import type { House, LotKind } from "./street-model";

type G = CanvasRenderingContext2D;
export const LOT_W = 150;
export const LOT_H = 176;
/** Ground line (the porch) inside a lot canvas. */
export const LOT_GROUND = 156;

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
export function shade(hex: string, f: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
const R = (g: G, x: number, y: number, w: number, h: number, c: string) => {
  g.fillStyle = c;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};
const pickOf = <T,>(r: () => number, items: readonly T[]) => items[Math.floor(r() * items.length)];

const SIDINGS = ["#e9e4d6", "#e8d9a6", "#a9b99a", "#9fb2c4", "#9c4a3c", "#c8d6d0", "#d9c3a5", "#7d8b96"];
const TRIMS = ["#f6f3ea", "#ffffff", "#3c4a3a", "#2d3540"];
const ROOFS = ["#4a4d55", "#3d5a44", "#5b4636", "#7a2f2a", "#33373f", "#55606b"];
const DOORS = ["#7a2f2a", "#2f4a6b", "#2f5a3a", "#3a2a1e", "#c8a040", "#f6f3ea"];

/** Which lot stands at an address. Fixed per day and number. */
export function lotKindFor(stage: number, number: number): LotKind {
  const r = rng(stage * 7919 + number * 104729)();
  // Downtown blocks get brick buildings and businesses; the rest is houses.
  if (r < 0.2) return "victorian";
  if (r < 0.37) return "foursquare";
  if (r < 0.5) return "ranch";
  if (r < 0.62) return "duplex";
  if (r < 0.71) return "trailer";
  if (r < 0.8) return "brick";
  if (r < 0.88) return "vacant";
  if (r < 0.93) return "minimart";
  if (r < 0.97) return "dollar";
  return "church";
}

function siding(g: G, x: number, y: number, w: number, h: number, base: string) {
  R(g, x, y, w, h, base);
  for (let yy = y + 3; yy < y + h; yy += 4) R(g, x, yy, w, 1, shade(base, 0.84));
  R(g, x, y, w, 2, shade(base, 0.7));
  R(g, x + w - 2, y, 2, h, shade(base, 0.78));
}
function brick(g: G, x: number, y: number, w: number, h: number, base: string) {
  R(g, x, y, w, h, base);
  for (let yy = y, row = 0; yy < y + h; yy += 4, row++) {
    R(g, x, yy, w, 1, shade(base, 1.3));
    for (let xx = x + (row % 2 ? 4 : 0); xx < x + w; xx += 8) R(g, xx, yy, 1, 4, shade(base, 1.25));
  }
  R(g, x + w - 2, y, 2, h, shade(base, 0.75));
}
function gable(g: G, x: number, y: number, w: number, h: number, color: string, trim: string) {
  for (let i = 0; i < h; i++) {
    const half = (w / 2) * ((i + 1) / h);
    R(g, x + w / 2 - half, y + i, half * 2, 1, i % 4 === 3 ? shade(color, 0.72) : color);
    R(g, x + w / 2 - half - 1, y + i, 2, 1, trim);
    R(g, x + w / 2 + half - 1, y + i, 2, 1, trim);
  }
}
function sideRoof(g: G, x: number, y: number, w: number, h: number, color: string, inset: number) {
  for (let i = 0; i < h; i++) {
    const pad = inset * (1 - (i + 1) / h);
    R(g, x + pad, y + i, w - pad * 2, 1, i % 4 === 3 ? shade(color, 0.72) : color);
  }
  R(g, x - 2, y + h - 2, w + 4, 3, shade(color, 0.55));
}
function windowAt(
  g: G,
  x: number,
  y: number,
  w: number,
  h: number,
  o: { lit?: boolean; boarded?: boolean; shutter?: string; trim: string; arch?: boolean },
) {
  if (o.shutter) {
    R(g, x - 5, y, 4, h, o.shutter);
    R(g, x + w + 1, y, 4, h, o.shutter);
  }
  R(g, x - 2, y - 2, w + 4, h + 4, o.trim);
  if (o.boarded) {
    R(g, x, y, w, h, "#b08a55");
    for (let yy = y + 3; yy < y + h; yy += 5) R(g, x, yy, w, 1, "#8a6a3d");
    R(g, x, y + h / 2 - 1, w, 2, "#7a5a32");
    return;
  }
  R(g, x, y, w, h, o.lit ? "#f7d774" : "#38506e");
  if (o.lit) R(g, x, y, w, Math.ceil(h / 3), "#fbe9a6");
  else {
    R(g, x + 2, y + 2, 2, h - 4, "#6f8fb0");
    R(g, x + w - 5, y + 2, 1, 3, "#8fb0cf");
  }
  R(g, x + w / 2 - 1, y, 2, h, o.trim);
  R(g, x, y + h / 2 - 1, w, 2, o.trim);
  R(g, x - 3, y + h + 2, w + 6, 2, shade(o.trim.length === 7 ? o.trim : "#ffffff", 0.8));
}
function doorAt(g: G, x: number, y: number, w: number, h: number, color: string, trim: string) {
  R(g, x - 2, y - 2, w + 4, h + 2, trim);
  R(g, x, y, w, h, color);
  R(g, x + 2, y + 3, w - 4, 6, shade(color, 1.35));
  R(g, x + 2, y + 12, w - 4, h - 15, shade(color, 0.82));
  R(g, x + w - 4, y + h / 2, 2, 2, "#e8c95a");
}
function porch(
  g: G,
  x: number,
  w: number,
  ground: number,
  h: number,
  o: { trim: string; floor: string; columns: number; rail: boolean; roof: string },
) {
  R(g, x - 3, ground - h - 4, w + 6, 5, o.roof);
  R(g, x - 3, ground - h + 1, w + 6, 2, o.trim);
  for (let i = 0; i < o.columns; i++) {
    const cx = x + (i * (w - 4)) / Math.max(1, o.columns - 1);
    R(g, cx, ground - h + 2, 4, h - 6, o.trim);
  }
  if (o.rail)
    for (let xx = x + 2; xx < x + w - 2; xx += 4) {
      if (Math.abs(xx - (x + w / 2)) < 12) continue;
      R(g, xx, ground - 14, 1, 10, o.trim);
    }
  if (o.rail) R(g, x, ground - 15, w, 2, o.trim);
  R(g, x - 2, ground - 5, w + 4, 5, o.floor);
  R(g, x - 2, ground - 5, w + 4, 1, shade(o.floor, 1.2));
}
function steps(g: G, cx: number, ground: number, color: string) {
  for (let i = 0; i < 3; i++) R(g, cx - 10 - i * 2, ground + i * 3, 20 + i * 4, 3, shade(color, 1 - i * 0.08));
}
function sign(g: G, x: number, y: number, w: number, h: number, bg: string, fg: string, text: string, scale = 1) {
  R(g, x, y, w, h, bg);
  R(g, x, y + h - 1, w, 1, shade(bg, 0.6));
  g.fillStyle = fg;
  g.font = `bold ${7 * scale}px "Courier New", monospace`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, x + w / 2, y + h / 2 + 1);
}

// ---- yard props ----
function tarpCar(g: G, x: number, ground: number, r: () => number) {
  const tarp = pickOf(r, ["#2f6fc4", "#2a5ea8", "#5b7a3a", "#8a8f96"]);
  R(g, x + 4, ground - 4, 10, 6, "#1d1d22");
  R(g, x + 40, ground - 4, 10, 6, "#1d1d22");
  for (let i = 0; i < 18; i++) {
    const inset = Math.max(0, 12 - i) * 1.2;
    R(g, x + inset, ground - 22 + i, 54 - inset * 2, 1, i % 3 ? tarp : shade(tarp, 0.8));
  }
  R(g, x + 6, ground - 14, 42, 1, "#d8302c");
  R(g, x + 26, ground - 22, 1, 18, "#d8302c");
  R(g, x + 12, ground - 10, 6, 2, shade(tarp, 1.35));
}
function carOnBlocks(g: G, x: number, ground: number) {
  R(g, x + 2, ground - 3, 8, 3, "#8c8c84");
  R(g, x + 40, ground - 3, 8, 3, "#8c8c84");
  R(g, x, ground - 18, 50, 12, "#8a4b2c");
  R(g, x + 10, ground - 26, 28, 9, "#7a3f24");
  R(g, x + 13, ground - 24, 10, 6, "#3a4a5a");
  R(g, x + 25, ground - 24, 10, 6, "#3a4a5a");
  R(g, x + 4, ground - 14, 6, 3, "#c26a3a");
}
function boat(g: G, x: number, ground: number) {
  R(g, x + 4, ground - 4, 6, 4, "#1d1d22");
  R(g, x, ground - 6, 56, 2, "#5a5a60");
  for (let i = 0; i < 12; i++) R(g, x + 4 + i, ground - 18 + i, 48 - i * 2, 1, i < 6 ? "#2f6fc4" : "#e8e4d8");
}
function couch(g: G, x: number, ground: number) {
  const c = "#7d5c8c";
  R(g, x, ground - 16, 28, 6, shade(c, 0.85));
  R(g, x, ground - 10, 28, 6, c);
  R(g, x - 2, ground - 14, 4, 10, shade(c, 0.7));
  R(g, x + 26, ground - 14, 4, 10, shade(c, 0.7));
}
function pumpkins(g: G, x: number, ground: number) {
  for (let i = 0; i < 3; i++) {
    R(g, x + i * 9, ground - 7 + (i % 2) * 2, 8, 7, "#e2751f");
    R(g, x + i * 9 + 3, ground - 9 + (i % 2) * 2, 2, 2, "#3d6a2a");
  }
}
function flag(g: G, x: number, y: number, kind: "us" | "bills") {
  R(g, x, y, 1, 22, "#bdbdbd");
  if (kind === "us") {
    for (let i = 0; i < 6; i++) R(g, x + 1, y + 2 + i * 2, 18, 2, i % 2 ? "#f4f4f4" : "#c7312c");
    R(g, x + 1, y + 2, 8, 6, "#2c3f7a");
  } else {
    R(g, x + 1, y + 2, 18, 12, "#00338d");
    R(g, x + 5, y + 6, 10, 3, "#c60c30");
    R(g, x + 11, y + 4, 2, 2, "#ffffff");
  }
}
function ghost(g: G, x: number, ground: number) {
  R(g, x + 2, ground - 28, 14, 24, "#f4f4ef");
  R(g, x, ground - 22, 18, 16, "#f4f4ef");
  R(g, x + 5, ground - 22, 2, 3, "#222");
  R(g, x + 11, ground - 22, 2, 3, "#222");
  R(g, x + 7, ground - 16, 4, 3, "#222");
}
function flamingo(g: G, x: number, ground: number) {
  R(g, x + 3, ground - 10, 1, 10, "#333");
  R(g, x, ground - 18, 9, 7, "#f07ab0");
  R(g, x + 7, ground - 24, 2, 8, "#f07ab0");
  R(g, x + 8, ground - 26, 4, 3, "#f07ab0");
}
function gnome(g: G, x: number, ground: number) {
  R(g, x, ground - 7, 8, 7, "#3a6ab0");
  R(g, x + 1, ground - 10, 6, 4, "#f2c9a0");
  R(g, x + 1, ground - 9, 6, 4, "#f0f0f0");
  for (let i = 0; i < 6; i++) R(g, x + i / 2, ground - 16 + i, 8 - i, 1, "#c7312c");
}
function lights(g: G, x: number, y: number, w: number, r: () => number) {
  const colors = ["#ff5050", "#50d050", "#5090ff", "#ffd040"];
  for (let xx = x; xx < x + w; xx += 5) R(g, xx, y + (Math.floor(xx / 5) % 2), 2, 2, pickOf(r, colors));
}
function dish(g: G, x: number, y: number) {
  R(g, x, y, 10, 10, "#d8d8d8");
  R(g, x + 2, y + 2, 6, 6, "#bdbdbd");
  R(g, x + 4, y + 8, 2, 5, "#888");
}
function firewood(g: G, x: number, ground: number) {
  for (let row = 0; row < 3; row++)
    for (let i = 0; i < 5 - row; i++) {
      R(g, x + row * 3 + i * 6, ground - 6 - row * 5, 6, 5, "#8a5a32");
      R(g, x + row * 3 + i * 6 + 2, ground - 4 - row * 5, 2, 2, "#c89a62");
    }
}
function pool(g: G, x: number, ground: number) {
  R(g, x, ground - 6, 30, 6, "#4aa0e0");
  R(g, x, ground - 7, 30, 2, "#3070c0");
  R(g, x + 4, ground - 5, 8, 1, "#9ad0ff");
}
function noTrespassing(g: G, x: number, ground: number) {
  R(g, x + 9, ground - 18, 2, 18, "#6b4a2a");
  sign(g, x - 8, ground - 28, 36, 12, "#f2d22e", "#111", "KEEP OUT", 1);
}
function forSale(g: G, x: number, ground: number) {
  R(g, x + 2, ground - 24, 2, 24, "#5b4a3a");
  R(g, x + 22, ground - 24, 2, 24, "#5b4a3a");
  sign(g, x, ground - 34, 26, 14, "#c7312c", "#fff", "SALE", 1);
}
function tallGrass(g: G, x: number, w: number, ground: number, r: () => number) {
  for (let i = 0; i < w; i += 2) R(g, x + i, ground - 4 - r() * 10, 1, 14, r() > 0.5 ? "#7a9a3a" : "#5c7a2a");
}
function hedge(g: G, x: number, w: number, ground: number) {
  R(g, x, ground - 12, w, 12, "#2f6a2a");
  for (let i = 0; i < w; i += 6) R(g, x + i, ground - 14, 6, 4, "#3a7a32");
  R(g, x, ground - 12, w, 2, "#4f8f3f");
}

type BuildingDraw = { door: number; litWindows: boolean; night: boolean; customer: boolean };

/** Draws one lot (building + yard) into a LOT_W×LOT_H canvas. Returns the door x. */
function paintLot(g: G, house: House, night: boolean) {
  const r = rng(house.seed),
    G0 = LOT_GROUND,
    siding0 = pickOf(r, SIDINGS),
    trim = pickOf(r, TRIMS.slice(0, 2)),
    roof = pickOf(r, ROOFS),
    doorColor = pickOf(r, DOORS),
    shutter = r() < 0.5 ? pickOf(r, ["#2f4a35", "#1f2a3a", "#5a2a2a"]) : undefined,
    litChance = night ? 0.5 : 0.15;
  const lit = () => house.customer || r() < litChance;
  let door = LOT_W / 2;
  const cx = LOT_W / 2;
  const residential = house.kind !== "minimart" && house.kind !== "dollar" && house.kind !== "church";
  switch (house.kind) {
    case "victorian":
    case "vacant": {
      const vacant = house.kind === "vacant",
        w = 108,
        x = cx - w / 2,
        body = vacant ? "#9a9a92" : siding0,
        top = G0 - 74;
      if (!vacant) R(g, x + w - 26, top - 46, 10, 22, "#7a3a2a");
      gable(g, x - 6, top - 44, w + 12, 46, roof, trim);
      // scalloped shingles in the gable
      if (!vacant)
        for (let row = 0; row < 3; row++)
          for (let i = 0; i < 6 - row * 2; i++)
            R(g, cx - 24 + row * 8 + i * 8, top - 18 + row * 6, 6, 3, shade(body, 0.9));
      windowAt(g, cx - 5, top - 28, 10, 10, { trim, lit: !vacant && lit(), boarded: vacant });
      siding(g, x, top, w, 74, body);
      windowAt(g, x + 14, top + 10, 16, 22, { trim, lit: !vacant && lit(), boarded: vacant, shutter });
      windowAt(g, x + w - 30, top + 10, 16, 22, { trim, lit: !vacant && lit(), boarded: vacant, shutter });
      porch(g, x + 4, w - 8, G0, 34, { trim, floor: "#8a6a4a", columns: 4, rail: true, roof });
      windowAt(g, x + 16, G0 - 26, 14, 16, { trim, lit: !vacant && lit(), boarded: vacant });
      door = cx + 14;
      doorAt(g, door - 8, G0 - 30, 16, 26, vacant ? "#6a5a4a" : doorColor, trim);
      steps(g, door, G0, "#9a8a7a");
      if (vacant) {
        tallGrass(g, 4, LOT_W - 8, G0 + 14, r);
        forSale(g, 8, G0 + 14);
      }
      break;
    }
    case "foursquare": {
      const w = 116,
        x = cx - w / 2,
        top = G0 - 78;
      R(g, x + 16, top - 40, 10, 20, "#7a3a2a");
      sideRoof(g, x - 6, top - 28, w + 12, 30, roof, 34);
      R(g, cx - 12, top - 26, 24, 16, siding0);
      windowAt(g, cx - 7, top - 22, 14, 9, { trim, lit: lit() });
      siding(g, x, top, w, 78, siding0);
      windowAt(g, x + 16, top + 10, 18, 22, { trim, lit: lit(), shutter });
      windowAt(g, x + w - 34, top + 10, 18, 22, { trim, lit: lit(), shutter });
      porch(g, x, w, G0, 34, { trim, floor: "#7a6a5a", columns: 3, rail: r() < 0.6, roof });
      windowAt(g, x + w - 34, G0 - 26, 18, 16, { trim, lit: lit() });
      door = x + 34;
      doorAt(g, door - 8, G0 - 30, 16, 26, doorColor, trim);
      steps(g, door, G0, "#9a8a7a");
      break;
    }
    case "ranch": {
      const w = 140,
        x = cx - w / 2,
        top = G0 - 40;
      sideRoof(g, x - 4, top - 20, w + 8, 22, roof, 20);
      siding(g, x, top, w, 40, siding0);
      R(g, x + w - 44, top + 8, 40, 32, "#e8e4da");
      for (let yy = top + 12; yy < G0; yy += 6) R(g, x + w - 44, yy, 40, 1, "#bdb8ac");
      windowAt(g, x + 8, top + 10, 30, 16, { trim, lit: lit(), shutter });
      door = x + 54;
      doorAt(g, door - 8, G0 - 30, 16, 28, doorColor, trim);
      R(g, door - 12, G0 - 2, 24, 4, "#9a9a92");
      break;
    }
    case "duplex": {
      const w = 128,
        x = cx - w / 2,
        top = G0 - 74;
      sideRoof(g, x - 6, top - 22, w + 12, 24, roof, 26);
      siding(g, x, top, w, 74, siding0);
      R(g, cx - 1, top, 2, 74, shade(siding0, 0.7));
      for (const side of [0, 1]) {
        const left = x + side * (w / 2);
        windowAt(g, left + 10, top + 10, 14, 18, { trim, lit: lit() });
        windowAt(g, left + 38, top + 10, 14, 18, { trim, lit: lit() });
        windowAt(g, left + 38, G0 - 28, 14, 16, { trim, lit: lit() });
      }
      dish(g, x + 6, top - 12);
      dish(g, x + w - 18, top - 12);
      door = x + 20;
      doorAt(g, door - 7, G0 - 30, 14, 26, doorColor, trim);
      doorAt(g, x + w / 2 + 13, G0 - 30, 14, 26, pickOf(r, DOORS), trim);
      R(g, door - 12, G0 - 2, 24, 4, "#9a9a92");
      R(g, x + w / 2 + 8, G0 - 2, 24, 4, "#9a9a92");
      break;
    }
    case "trailer": {
      const w = 140,
        x = cx - w / 2,
        top = G0 - 44;
      R(g, x, top, w, 34, "#eeeae0");
      for (let yy = top + 3; yy < top + 34; yy += 3) R(g, x, yy, w, 1, "#d8d4ca");
      R(g, x, top + 18, w, 4, pickOf(r, ["#8a5a32", "#3a5a8a", "#2f6a3a"]));
      R(g, x, top - 3, w, 3, "#bcb8ae");
      for (let xx = x; xx < x + w; xx += 6) R(g, xx, top + 34, 3, 10, "#cfcabb");
      R(g, x, top + 34, w, 1, "#a8a496");
      windowAt(g, x + 10, top + 6, 22, 10, { trim: "#cfcfcf", lit: lit() });
      windowAt(g, x + w - 34, top + 6, 22, 10, { trim: "#cfcfcf", lit: lit() });
      R(g, x + w - 30, top + 17, 14, 9, "#bdbdbd");
      door = x + 64;
      doorAt(g, door - 7, top + 4, 14, 28, "#f4f4f0", "#bdbdbd");
      for (let i = 0; i < 3; i++) R(g, door - 9, top + 32 + i * 4, 18, 4, "#8a6a4a");
      dish(g, x + 40, top - 13);
      break;
    }
    case "brick": {
      const w = 128,
        x = cx - w / 2,
        top = G0 - 118,
        base = pickOf(r, ["#8a3b2a", "#9a4a32", "#7a3324", "#a65a3a"]);
      brick(g, x, top, w, 118, base);
      R(g, x - 3, top - 6, w + 6, 8, shade(base, 0.6));
      R(g, x - 3, top - 8, w + 6, 2, "#d8cfc0");
      for (let floor = 0; floor < 2; floor++)
        for (let i = 0; i < 4; i++)
          windowAt(g, x + 10 + i * 30, top + 10 + floor * 30, 14, 20, { trim: "#d8cfc0", lit: lit() });
      const shop = pickOf(r, ["PIZZA", "VAPE", "PAWN", "TAX", "TATTOO", "CLOSED", "SUBS?", "BAIT"]);
      R(g, x + 6, G0 - 48, 86, 44, "#2a2f3a");
      R(g, x + 8, G0 - 44, 82, 34, night ? "#4a4a40" : "#5a7a9a");
      for (let i = 0; i < 6; i++) R(g, x + 4 + i * 15, G0 - 56, 15, 8, i % 2 ? "#f4f0e6" : pickOf(r, ["#2f6a3a", "#c7312c", "#2a4a8a"]));
      sign(g, x + 18, G0 - 68, 60, 11, "#1d1d22", "#f2d22e", shop);
      door = x + w - 18;
      doorAt(g, door - 8, G0 - 32, 16, 30, "#3a2a1e", "#d8cfc0");
      break;
    }
    case "minimart": {
      const w = 140,
        x = cx - w / 2,
        top = G0 - 50;
      R(g, x, top, w, 50, "#f2eee4");
      R(g, x, top, w, 12, "#c7312c");
      sign(g, x + 30, top + 1, 80, 10, "#c7312c", "#ffffff", "STU'S SHOPS");
      R(g, x + 8, top + 16, 90, 30, night ? "#e8d88a" : "#7aa0c0");
      for (let i = 0; i < 4; i++) R(g, x + 8 + i * 22, top + 16, 2, 30, "#d8d4ca");
      R(g, x + 104, top + 22, 30, 24, "#dde8f0");
      sign(g, x + 104, top + 16, 30, 7, "#3a7ac0", "#fff", "ICE");
      door = x + 64;
      break;
    }
    case "dollar": {
      const w = 140,
        x = cx - w / 2,
        top = G0 - 56;
      R(g, x, top, w, 56, "#d8cdb4");
      for (let xx = x; xx < x + w; xx += 5) R(g, xx, top, 1, 56, "#c2b79c");
      sign(g, x + 6, top + 4, w - 12, 14, "#f6d23a", "#111", "DOLLAR GENERALLY", 1);
      R(g, x + 44, top + 26, 52, 30, night ? "#e8d88a" : "#6a8aa8");
      R(g, x + 69, top + 26, 2, 30, "#bbb");
      door = x + 70;
      break;
    }
    case "church": {
      const w = 96,
        x = cx - w / 2,
        top = G0 - 70;
      R(g, cx - 8, top - 70, 16, 70, "#f4f2ea");
      R(g, cx - 3, top - 60, 6, 10, "#2a3a5a");
      for (let i = 0; i < 20; i++) R(g, cx - 8 + i * 0.4, top - 90 + i, 16 - i * 0.8, 1, roof);
      R(g, cx - 1, top - 98, 2, 10, "#c8a040");
      R(g, cx - 4, top - 94, 8, 2, "#c8a040");
      gable(g, x - 4, top - 30, w + 8, 32, roof, "#ffffff");
      siding(g, x, top, w, 70, "#f4f2ea");
      windowAt(g, x + 12, top + 10, 12, 30, { trim: "#ffffff", lit: night });
      windowAt(g, x + w - 24, top + 10, 12, 30, { trim: "#ffffff", lit: night });
      door = cx;
      doorAt(g, cx - 12, G0 - 34, 24, 32, "#7a2f2a", "#ffffff");
      sign(g, 4, G0 + 4, 40, 12, "#2a3a2a", "#ffffff", "BINGO THU");
      break;
    }
  }
  if (residential) {
    // Yard life. Every house gets a couple of things; Ogdensburg gets the couch.
    const props = [
      () => couch(g, door + 16 < LOT_W - 34 ? door + 14 : door - 46, G0 - 4),
      () => pumpkins(g, door - 14, G0 + 6),
      () => flag(g, 8, G0 - 50, r() < 0.5 ? "us" : "bills"),
      () => ghost(g, 6, G0 + 16),
      () => flamingo(g, 10, G0 + 16),
      () => gnome(g, LOT_W - 22, G0 + 16),
      () => firewood(g, 4, G0 + 16),
      () => pool(g, 6, G0 + 16),
      () => noTrespassing(g, LOT_W - 34, G0 + 16),
      () => tarpCar(g, 4, G0 + 18, r),
      () => boat(g, 2, G0 + 18),
      () => carOnBlocks(g, 4, G0 + 18),
      () => hedge(g, 0, 22, G0 + 18),
    ];
    const count = 1 + Math.floor(r() * 2.2);
    for (let i = 0; i < count; i++) pickOf(r, props)();
    if (r() < 0.22) lights(g, 10, G0 - 40, LOT_W - 20, r);
  }
  return door;
}

const cache = new Map<string, { canvas: HTMLCanvasElement; door: number }>();
/** The painted lot canvas for a house (cached per look/state). */
export function lotCanvas(house: House, night: boolean) {
  const key = `${house.seed}|${house.kind}|${house.customer ? 1 : 0}|${night ? 1 : 0}`;
  let hit = cache.get(key);
  if (!hit) {
    if (cache.size > 160) cache.clear();
    const canvas = document.createElement("canvas");
    canvas.width = LOT_W;
    canvas.height = LOT_H;
    const g = canvas.getContext("2d")!;
    const door = paintLot(g, house, night);
    hit = { canvas, door };
    cache.set(key, hit);
  }
  return hit;
}
export type { BuildingDraw };
