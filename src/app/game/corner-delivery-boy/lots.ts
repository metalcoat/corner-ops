// Procedural Ogdensburg lots seen from above (3/4 view), facing the road:
// roofs from above, the south wall showing, and the front porch, steps and
// walkway pointing at the street. Lots are painted for the left side of the
// road (street to the right) and mirrored for the right side. Every address
// gets its own house from a seed, so a street looks the same every run.
import type { House, LotKind } from "./street-model";
import { PAINTS, drawCarTop } from "./topdown-art";

type G = CanvasRenderingContext2D;
export const LOT_W = 116;
export const LOT_H = 180;
/** The front door / porch centre inside a lot canvas (house.y lines up here). */
export const LOT_GROUND = 100;
const FRONT = 86; // x where the house front wall stands (the road is to the right)

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
function circle(g: G, x: number, y: number, rad: number, c: string) {
  g.fillStyle = c;
  g.beginPath();
  g.arc(x, y, rad, 0, Math.PI * 2);
  g.fill();
}

const SIDINGS = ["#e9e4d6", "#e8d9a6", "#a9b99a", "#9fb2c4", "#9c4a3c", "#c8d6d0", "#d9c3a5", "#7d8b96"];
const ROOFS = ["#4a4d55", "#3d5a44", "#5b4636", "#7a2f2a", "#33373f", "#55606b", "#6a3a2a"];

/** Which lot stands at an address. Fixed per day and number. */
export function lotKindFor(stage: number, number: number): LotKind {
  const r = rng(stage * 7919 + number * 104729)();
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

// ---- roofs (seen from above) ----
function roofEW(g: G, x0: number, x1: number, y0: number, y1: number, c: string) {
  // Ridge runs away from the street, so the gable end faces the road.
  const mid = Math.round((y0 + y1) / 2);
  R(g, x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4, shade(c, 0.5));
  R(g, x0, y0, x1 - x0, mid - y0, shade(c, 1.1));
  R(g, x0, mid, x1 - x0, y1 - mid, shade(c, 0.78));
  for (let y = y0 + 2; y < y1; y += 3) {
    R(g, x0, y, x1 - x0, 1, shade(c, y < mid ? 0.9 : 0.66));
    for (let x = x0 + ((y / 3) % 2 ? 2 : 5); x < x1; x += 6) R(g, x, y - 2, 1, 2, shade(c, y < mid ? 0.95 : 0.7));
  }
  R(g, x0, mid - 1, x1 - x0, 2, shade(c, 1.3));
  R(g, x1 - 2, y0, 2, y1 - y0, shade(c, 0.55));
}
function roofNS(g: G, x0: number, x1: number, y0: number, y1: number, c: string) {
  // Ridge parallel to the street: the road-facing slope is lit.
  const mid = Math.round((x0 + x1) / 2);
  R(g, x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4, shade(c, 0.5));
  R(g, x0, y0, mid - x0, y1 - y0, shade(c, 0.78));
  R(g, mid, y0, x1 - mid, y1 - y0, shade(c, 1.08));
  for (let x = x0 + 2; x < x1; x += 3) R(g, x, y0, 1, y1 - y0, shade(c, x < mid ? 0.66 : 0.9));
  R(g, mid - 1, y0, 2, y1 - y0, shade(c, 1.3));
}
function roofHip(g: G, x0: number, x1: number, y0: number, y1: number, c: string) {
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2,
    inset = Math.min(x1 - x0, y1 - y0) / 2;
  R(g, x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4, shade(c, 0.5));
  const poly = (pts: number[][], col: string) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
    g.closePath();
    g.fill();
  };
  const a = [cx - (x1 - x0) / 2 + inset, cy],
    b = [cx + (x1 - x0) / 2 - inset, cy];
  poly([[x0, y0], [x1, y0], b, a], shade(c, 1.1));
  poly([[x0, y1], [x1, y1], b, a], shade(c, 0.72));
  poly([[x0, y0], [x0, y1], a], shade(c, 0.85));
  poly([[x1, y0], [x1, y1], b], shade(c, 1.0));
  for (let y = y0 + 3; y < y1; y += 3) R(g, x0, y, x1 - x0, 1, "rgba(0,0,0,0.12)");
}
function roofFlat(g: G, x0: number, x1: number, y0: number, y1: number, r: () => number) {
  R(g, x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4, "#9a968c");
  R(g, x0, y0, x1 - x0, y1 - y0, "#5a5a5c");
  for (let i = 0; i < 90; i++) R(g, x0 + r() * (x1 - x0), y0 + r() * (y1 - y0), 1, 1, r() > 0.5 ? "#6a6a6c" : "#4a4a4c");
  // HVAC box and a vent.
  R(g, x0 + 8, y0 + 8, 14, 10, "#b8bcc0");
  R(g, x0 + 10, y0 + 10, 10, 6, "#8a8e92");
  circle(g, x0 + (x1 - x0) * 0.6, y0 + (y1 - y0) * 0.4, 3, "#8a8e92");
}
function chimney(g: G, x: number, y: number) {
  R(g, x + 3, y + 3, 8, 8, "rgba(0,0,0,0.3)");
  R(g, x, y, 8, 8, "#8a3a2a");
  R(g, x + 1, y + 1, 6, 2, "#a65a3a");
  R(g, x + 2, y + 3, 4, 3, "#2a1a14");
}
function dish(g: G, x: number, y: number) {
  circle(g, x + 2, y + 2, 5, "rgba(0,0,0,0.3)");
  circle(g, x, y, 5, "#e0e0e0");
  circle(g, x - 1, y - 1, 2, "#a8a8a8");
}

// ---- the south wall that shows under each roof ----
function southWall(
  g: G,
  x0: number,
  x1: number,
  y: number,
  h: number,
  siding: string,
  o: { windows: number; lit: () => boolean; trim: string; boarded?: boolean; brick?: boolean },
) {
  R(g, x0, y, x1 - x0, h, siding);
  if (o.brick)
    for (let yy = y + 2; yy < y + h; yy += 3) {
      R(g, x0, yy, x1 - x0, 1, shade(siding, 1.25));
      for (let xx = x0 + (yy % 2 ? 0 : 3); xx < x1; xx += 6) R(g, xx, yy - 2, 1, 2, shade(siding, 1.2));
    }
  else for (let yy = y + 2; yy < y + h; yy += 3) R(g, x0, yy, x1 - x0, 1, shade(siding, 0.86));
  const gap = (x1 - x0) / (o.windows + 1);
  for (let i = 1; i <= o.windows; i++) {
    const wx = x0 + gap * i - 4;
    R(g, wx - 1, y + 3, 10, h - 7, o.trim);
    R(g, wx, y + 4, 8, h - 9, o.boarded ? "#b08a55" : o.lit() ? "#f7d774" : "#38506e");
    if (!o.boarded) R(g, wx + 3, y + 4, 2, h - 9, o.trim);
  }
  R(g, x0, y + h - 2, x1 - x0, 2, "#6a6660");
  R(g, x0, y + h, x1 - x0, 3, "rgba(0,0,0,0.25)");
}

// ---- front porch, steps and walk, facing the street ----
function porch(g: G, yC: number, o: { roof: string; trim: string; door: string; floor?: string; wide?: number }) {
  const half = o.wide ?? 13;
  R(g, FRONT, yC - half, 12, half * 2, o.floor ?? "#9a7a52");
  for (let yy = yC - half; yy < yC + half; yy += 3) R(g, FRONT, yy, 12, 1, "#7a5a3a");
  // Porch roof and its posts along the south edge.
  R(g, FRONT - 1, yC - half - 2, 14, half * 2 - 4, shade(o.roof, 0.95));
  R(g, FRONT - 1, yC - half - 2, 14, 2, shade(o.roof, 1.2));
  for (const py of [yC - half, yC + half - 4]) R(g, FRONT + 10, py, 3, 4, o.trim);
  R(g, FRONT - 1, yC + half - 6, 14, 3, o.trim);
  // Front door peeking out under the porch roof.
  R(g, FRONT - 3, yC - 5, 3, 10, o.door);
  // Steps and the walk to the sidewalk.
  for (let i = 0; i < 3; i++) R(g, FRONT + 12 + i * 2, yC - 6 + i, 2, 12 - i * 2, i % 2 ? "#9a968c" : "#b8b4a8");
  R(g, FRONT + 18, yC - 4, LOT_W - FRONT - 18, 8, "#c8c4b8");
}

// ---- yard props from above ----
function tree(g: G, x: number, y: number, rad: number, r: () => number) {
  circle(g, x + 5, y + 6, rad, "rgba(0,0,0,0.28)");
  const fall = r() < 0.45;
  const base = fall ? pickOf(r, ["#c0622a", "#d08a2a", "#a8402a"]) : "#3a7a32";
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    circle(g, x + Math.cos(a) * rad * 0.45, y + Math.sin(a) * rad * 0.45, rad * 0.62, shade(base, 0.82));
  }
  circle(g, x, y, rad * 0.7, base);
  circle(g, x - rad * 0.25, y - rad * 0.25, rad * 0.35, shade(base, 1.25));
}
function bush(g: G, x: number, y: number) {
  circle(g, x + 2, y + 3, 6, "rgba(0,0,0,0.25)");
  circle(g, x, y, 6, "#2f6a2a");
  circle(g, x - 2, y - 2, 3, "#4f8f3f");
}
function couch(g: G, x: number, y: number) {
  R(g, x, y, 7, 16, "#7d5c8c");
  R(g, x, y, 2, 16, "#5d3c6c");
}
function pumpkins(g: G, x: number, y: number) {
  for (let i = 0; i < 3; i++) circle(g, x + (i % 2) * 4, y + i * 5, 2.5, "#e2751f");
}
function flag(g: G, x: number, y: number, bills: boolean) {
  R(g, x, y, 2, 2, "#bdbdbd");
  if (bills) {
    R(g, x + 2, y - 1, 12, 8, "#00338d");
    R(g, x + 5, y + 2, 7, 2, "#c60c30");
  } else {
    for (let i = 0; i < 4; i++) R(g, x + 2, y - 1 + i * 2, 12, 2, i % 2 ? "#f4f4f4" : "#c7312c");
    R(g, x + 2, y - 1, 5, 4, "#2c3f7a");
  }
}
function pool(g: G, x: number, y: number) {
  circle(g, x, y, 11, "#d8d8d8");
  circle(g, x, y, 9, "#4aa0e0");
  R(g, x - 4, y - 3, 6, 1, "#9ad0ff");
}
function trampoline(g: G, x: number, y: number) {
  circle(g, x, y, 13, "#3a6ac0");
  circle(g, x, y, 10, "#1c1c22");
}
function firewood(g: G, x: number, y: number) {
  R(g, x, y, 22, 8, "#6a4220");
  for (let i = 0; i < 5; i++) circle(g, x + 2 + i * 4.4, y + 4, 2, "#c89a62");
}
function ghost(g: G, x: number, y: number) {
  circle(g, x + 2, y + 3, 7, "rgba(0,0,0,0.25)");
  circle(g, x, y, 7, "#f4f4ef");
  R(g, x - 3, y - 2, 2, 2, "#222");
  R(g, x + 1, y - 2, 2, 2, "#222");
}
function flamingo(g: G, x: number, y: number) {
  circle(g, x, y, 3, "#f07ab0");
  R(g, x + 2, y - 5, 2, 5, "#f07ab0");
}
function gnome(g: G, x: number, y: number) {
  circle(g, x, y, 3, "#3a6ab0");
  circle(g, x, y - 2, 2, "#c7312c");
}
function lights(g: G, x0: number, x1: number, y: number, r: () => number) {
  for (let x = x0; x < x1; x += 4) R(g, x, y, 2, 2, pickOf(r, ["#ff5050", "#50d050", "#5090ff", "#ffd040"]));
}
function keepOut(g: G, x: number, y: number) {
  R(g, x, y, 2, 6, "#6b4a2a");
  R(g, x - 4, y - 5, 10, 6, "#f2d22e");
  R(g, x - 3, y - 3, 8, 1, "#111");
}
function forSale(g: G, x: number, y: number) {
  R(g, x, y, 2, 8, "#5b4a3a");
  R(g, x - 6, y - 7, 14, 8, "#c7312c");
  R(g, x - 4, y - 5, 10, 1, "#fff");
  R(g, x - 4, y - 2, 8, 1, "#fff");
}
function tallGrass(g: G, x: number, y: number, w: number, h: number, r: () => number) {
  for (let i = 0; i < (w * h) / 6; i++) R(g, x + r() * w, y + r() * h, 1, 3, r() > 0.5 ? "#7a9a3a" : "#5c7a2a");
}
function driveway(g: G, y: number, h: number) {
  R(g, 20, y, LOT_W - 20, h, "#8c8a84");
  for (let i = 0; i < 30; i++) R(g, 22 + ((i * 37) % (LOT_W - 24)), y + ((i * 13) % h), 2, 1, "#7a7872");
}

export type LotSign = { text: string; x: number; y: number; w: number; bg: string; fg: string };
type Painted = { door: number; sign?: LotSign };

function paintLot(g: G, house: House, night: boolean): Painted {
  const r = rng(house.seed),
    Y = LOT_GROUND,
    siding = pickOf(r, SIDINGS),
    trim = pickOf(r, ["#f6f3ea", "#ffffff", "#e8e4d8"]),
    roof = pickOf(r, ROOFS),
    doorColor = pickOf(r, ["#7a2f2a", "#2f4a6b", "#2f5a3a", "#3a2a1e", "#c8a040"]),
    litChance = night ? 0.5 : 0.12,
    lit = () => house.customer || r() < litChance;
  // Lot edge: a hedge, a picket fence or nothing.
  const edge = r();
  if (edge < 0.3) for (let x = 6; x < FRONT + 20; x += 8) bush(g, x, 8);
  else if (edge < 0.55) for (let x = 4; x < FRONT + 24; x += 4) R(g, x, 6, 2, 4, "#f0eee6");
  let sign: LotSign | undefined;
  const residential = !["minimart", "dollar", "church"].includes(house.kind);
  let driveY: number | null = null;
  switch (house.kind) {
    case "victorian":
    case "vacant": {
      const vacant = house.kind === "vacant",
        top = Y - 50,
        bottom = Y + 36,
        x0 = 8;
      if (vacant) tallGrass(g, 2, top - 14, FRONT + 26, bottom - top + 34, r);
      roofEW(g, x0, FRONT, top, bottom - 16, vacant ? "#5a5650" : roof);
      if (!vacant) {
        // Corner turret with a cone roof.
        circle(g, FRONT - 6, bottom - 22, 10, shade(roof, 0.6));
        for (let i = 0; i < 8; i++) {
          g.fillStyle = shade(roof, i % 2 ? 0.9 : 1.15);
          g.beginPath();
          g.moveTo(FRONT - 6, bottom - 22);
          g.arc(FRONT - 6, bottom - 22, 9, (i / 8) * Math.PI * 2, ((i + 1) / 8) * Math.PI * 2);
          g.fill();
        }
        circle(g, FRONT - 6, bottom - 22, 1.5, "#c8a040");
        chimney(g, x0 + 12, top + 4);
      } else {
        // A blue tarp on the roof, naturally.
        R(g, x0 + 20, top + 6, 22, 14, "#2f6fc4");
        R(g, x0 + 20, top + 12, 22, 1, "#e0302c");
      }
      southWall(g, x0, FRONT, bottom - 16, 16, vacant ? "#9a9a92" : siding, { windows: 3, lit, trim, boarded: vacant });
      porch(g, Y, { roof: vacant ? "#5a5650" : roof, trim, door: vacant ? "#6a5a4a" : doorColor, wide: 16 });
      if (vacant) forSale(g, FRONT + 24, bottom + 4);
      break;
    }
    case "foursquare": {
      const top = Y - 46,
        bottom = Y + 40,
        x0 = 10;
      roofHip(g, x0, FRONT, top, bottom - 16, roof);
      R(g, FRONT - 14, Y - 8, 12, 12, siding);
      R(g, FRONT - 12, Y - 6, 8, 6, lit() ? "#f7d774" : "#38506e");
      chimney(g, x0 + 8, top + 6);
      southWall(g, x0, FRONT, bottom - 16, 16, siding, { windows: 3, lit, trim });
      porch(g, Y, { roof, trim, door: doorColor, wide: 18 });
      break;
    }
    case "ranch": {
      const top = Y - 28,
        bottom = Y + 34,
        x0 = 30;
      roofNS(g, x0, FRONT, top, bottom - 12, roof);
      southWall(g, x0, FRONT, bottom - 12, 12, siding, { windows: 2, lit, trim });
      porch(g, Y, { roof, trim, door: doorColor, wide: 10, floor: "#a8a49a" });
      driveY = bottom + 4;
      break;
    }
    case "duplex": {
      const top = Y - 50,
        bottom = Y + 40,
        x0 = 8;
      roofEW(g, x0, FRONT, top, bottom - 16, roof);
      dish(g, x0 + 18, top + 8);
      dish(g, x0 + 18, bottom - 26);
      southWall(g, x0, FRONT, bottom - 16, 16, siding, { windows: 3, lit, trim });
      porch(g, Y, { roof, trim, door: doorColor, wide: 10 });
      porch(g, Y - 28, { roof, trim, door: pickOf(r, ["#7a2f2a", "#2f4a6b", "#3a2a1e"]), wide: 9 });
      break;
    }
    case "trailer": {
      const top = Y - 18,
        bottom = Y + 16,
        x0 = 6;
      R(g, x0 - 2, top - 2, FRONT - x0 + 4, bottom - top + 2, "#8a8a84");
      R(g, x0, top, FRONT - x0, bottom - top - 10, "#d8d6ce");
      for (let x = x0 + 2; x < FRONT; x += 4) R(g, x, top, 1, bottom - top - 10, "#bcbab2");
      R(g, FRONT - 20, top + 6, 10, 8, "#b8bcc0");
      southWall(g, x0, FRONT, bottom - 10, 10, "#eeeae0", { windows: 4, lit, trim: "#cfcfcf" });
      R(g, x0, bottom - 6, FRONT - x0, 2, pickOf(r, ["#8a5a32", "#3a5a8a", "#2f6a3a"]));
      R(g, FRONT, Y - 8, 14, 16, "#8a6a4a");
      for (let yy = Y - 8; yy < Y + 8; yy += 3) R(g, FRONT, yy, 14, 1, "#6a4a2a");
      R(g, FRONT - 3, Y - 5, 3, 10, "#f4f4f0");
      R(g, FRONT + 14, Y - 4, LOT_W - FRONT - 14, 8, "#c8c4b8");
      dish(g, x0 + 20, top + 8);
      driveY = bottom + 6;
      break;
    }
    case "brick": {
      const top = Y - 56,
        bottom = Y + 44,
        x0 = 2,
        base = pickOf(r, ["#8a3b2a", "#9a4a32", "#7a3324", "#a65a3a"]);
      roofFlat(g, x0, FRONT + 6, top, bottom - 20, r);
      southWall(g, x0, FRONT + 6, bottom - 20, 20, base, { windows: 4, lit, trim: "#d8cfc0", brick: true });
      // Storefront awning toward the street, and the door to the apartments.
      for (let i = 0; i < 6; i++)
        R(g, FRONT + 6, top + 8 + i * 6, 14, 6, i % 2 ? "#f4f0e6" : pickOf(r, ["#2f6a3a", "#c7312c", "#2a4a8a"]));
      R(g, FRONT + 4, Y - 4, 4, 10, "#3a2a1e");
      R(g, FRONT + 8, Y - 4, LOT_W - FRONT - 8, 8, "#c8c4b8");
      sign = {
        text: pickOf(r, ["PIZZA", "VAPE", "PAWN", "TAX", "TATTOO", "CLOSED", "SUBS?", "BAIT"]),
        x: FRONT - 20,
        y: top - 12,
        w: 46,
        bg: "#1d1d22",
        fg: "#f2d22e",
      };
      break;
    }
    case "minimart": {
      const top = Y - 34,
        bottom = Y + 20;
      roofFlat(g, 6, 58, top, bottom - 12, r);
      southWall(g, 6, 58, bottom - 12, 12, "#f2eee4", { windows: 2, lit: () => true, trim: "#c7312c" });
      // Gas canopy over two pumps between the store and the street.
      R(g, 64, Y - 26, 42, 52, "rgba(0,0,0,0.25)");
      R(g, 62, Y - 30, 42, 50, "#e8e4d8");
      R(g, 62, Y - 30, 42, 5, "#c7312c");
      R(g, 74, Y - 14, 6, 10, "#2a2a30");
      R(g, 88, Y - 14, 6, 10, "#2a2a30");
      R(g, 58, Y - 4, 4, 10, "#3a2a1e");
      sign = { text: "STU'S", x: 60, y: top - 12, w: 40, bg: "#c7312c", fg: "#ffffff" };
      break;
    }
    case "dollar": {
      const top = Y - 48,
        bottom = Y + 16;
      roofFlat(g, 4, 70, top, bottom - 12, r);
      southWall(g, 4, 70, bottom - 12, 12, "#d8cdb4", { windows: 2, lit: () => night, trim: "#f6d23a" });
      R(g, 70, top, 4, bottom - top - 12, "#f6d23a");
      // Parking lot between the store and the street.
      R(g, 74, Y - 40, LOT_W - 74, 64, "#4a4e54");
      for (let yy = Y - 36; yy < Y + 20; yy += 14) R(g, 74, yy, 20, 1, "#e8e4d8");
      sign = { text: "DOLLAR GENERALLY", x: 6, y: top - 12, w: 100, bg: "#f6d23a", fg: "#111111" };
      break;
    }
    case "church": {
      const top = Y - 30,
        bottom = Y + 24;
      roofEW(g, 14, FRONT - 14, top, bottom - 18, "#55606b");
      roofNS(g, 34, 54, top - 18, bottom, "#55606b");
      southWall(g, 14, FRONT - 14, bottom - 18, 18, "#f4f2ea", { windows: 3, lit: () => night, trim: "#ffffff" });
      // Square steeple at the street end with a pyramid spire and a cross.
      const sx = FRONT - 16,
        sy = Y - 10;
      R(g, sx + 4, sy + 4, 20, 20, "rgba(0,0,0,0.3)");
      R(g, sx, sy, 20, 20, "#f4f2ea");
      g.fillStyle = "#3a4048";
      g.beginPath();
      g.moveTo(sx + 2, sy + 2);
      g.lineTo(sx + 18, sy + 2);
      g.lineTo(sx + 10, sy + 10);
      g.fill();
      g.fillStyle = "#5a6068";
      g.beginPath();
      g.moveTo(sx + 2, sy + 18);
      g.lineTo(sx + 18, sy + 18);
      g.lineTo(sx + 10, sy + 10);
      g.fill();
      R(g, sx + 9, sy + 6, 2, 8, "#c8a040");
      R(g, sx + 6, sy + 9, 8, 2, "#c8a040");
      R(g, FRONT + 4, Y - 4, LOT_W - FRONT - 4, 8, "#c8c4b8");
      sign = { text: "BINGO THU", x: 30, y: bottom + 8, w: 56, bg: "#2a3a2a", fg: "#ffffff" };
      break;
    }
  }
  if (driveY !== null) {
    driveway(g, driveY, 26);
    const roll = r();
    if (roll < 0.35) drawCarTop(g, 62, driveY + 13, { paint: "#2f6fc4", angle: Math.PI / 2, tarp: true });
    else if (roll < 0.55) drawCarTop(g, 62, driveY + 13, { paint: pickOf(r, PAINTS), angle: Math.PI / 2, rusty: true });
    else if (roll < 0.7) {
      // A boat on a trailer under its own tarp.
      R(g, 34, driveY + 6, 54, 14, "#e8e4d8");
      R(g, 34, driveY + 6, 54, 6, "#2f6fc4");
    } else
      drawCarTop(g, 62, driveY + 13, { paint: pickOf(r, PAINTS), angle: Math.PI / 2, kind: r() < 0.4 ? "pickup" : "car" });
  }
  if (residential) {
    // Yard life, from above. Ogdensburg gets the porch couch.
    const props = [
      () => couch(g, FRONT + 2, Y - 14),
      () => pumpkins(g, FRONT + 14, Y + 6),
      () => flag(g, FRONT + 10, Y - 18, r() < 0.5),
      () => ghost(g, FRONT + 18, Y + 24),
      () => flamingo(g, FRONT + 20, Y + 20),
      () => gnome(g, FRONT + 22, Y - 20),
      () => firewood(g, 4, Y + 44),
      () => pool(g, 26, Y + 46),
      () => trampoline(g, 30, Y - 58),
      () => keepOut(g, LOT_W - 6, Y + 18),
    ];
    const count = 1 + Math.floor(r() * 2.4);
    for (let i = 0; i < count; i++) pickOf(r, props)();
    if (r() < 0.22) lights(g, 12, FRONT, Y - 40, r);
    if (r() < 0.7) tree(g, 12 + r() * 20, Y - 62, 12 + r() * 8, r);
    if (r() < 0.4) bush(g, FRONT + 22, Y - 14);
  }
  return { door: FRONT + 6, sign };
}

const cache = new Map<string, { canvas: HTMLCanvasElement; door: number; sign?: LotSign }>();
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
    const painted = paintLot(g, house, night);
    hit = { canvas, door: painted.door, sign: painted.sign };
    cache.set(key, hit);
  }
  return hit;
}
