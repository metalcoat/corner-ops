// Draws one frame of the Delivery Boy street at 512×448 (SNES hi-res).
import type { Assets } from "./art-assets";
import { LOT_GROUND, LOT_W, lotCanvas, shade } from "./lots";
import { drawText, sprites, wrapText } from "./pixel-art";
import {
  DEADLY,
  HUD_H,
  inThrowWindow,
  LOT_SPAN,
  laneX,
  PLAY_H,
  PLAY_Y,
  PLAYER_Y,
  pctY,
  PORCH_WINDOW,
  ROAD_LEFT,
  ROAD_RIGHT,
  SCREEN_H,
  SCREEN_W,
  SIDEWALK,
  type Fx,
  type House,
  type Scenery,
  type Side,
  type Thing,
} from "./street-model";

export type StreetFrame = {
  stage: number;
  day: string;
  dayName: string;
  street: string;
  lane: number;
  things: Thing[];
  houses: House[];
  scenery: Scenery[];
  distance: number;
  time: number;
  totalTime: number;
  health: number;
  ammo: number;
  routeDelivered: number;
  deliveries: number;
  quota: number;
  score: number;
  combo: number;
  boost: number;
  slow: number;
  damaged: number;
  invulnerable: number;
};
export type Overlay = {
  countdown: number | null;
  wrecked: "fired" | "crash" | null;
  reducedEffects: boolean;
};

const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const R = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) => {
  ctx.fillStyle = c;
  ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
};
const TILE = 512;

let groundTile: HTMLCanvasElement | null = null;
/** A 512px strip of autumn lawn, cracked sidewalk, curb and patched asphalt. */
function ground() {
  if (groundTile) return groundTile;
  const tile = document.createElement("canvas");
  tile.width = SCREEN_W;
  tile.height = TILE;
  const g = tile.getContext("2d")!;
  R(g, 0, 0, SCREEN_W, TILE, "#5a9a3a");
  for (let i = 0; i < 2600; i++) {
    const x = Math.floor(hash(i + 0.3) * SCREEN_W),
      y = Math.floor(hash(i + 0.7) * TILE),
      roll = hash(i);
    R(g, x, y, 1, 2, roll > 0.66 ? "#4c8a32" : roll > 0.33 ? "#6aaa44" : "#5a9a3a");
  }
  // Fallen leaves: it is October in the North Country.
  for (let i = 0; i < 420; i++)
    R(g, Math.floor(hash(i + 7.1) * SCREEN_W), Math.floor(hash(i + 3.3) * TILE), 2, 2,
      ["#d0782a", "#c0462a", "#e0a83a", "#8a4a2a"][i % 4]);
  for (const side of ["left", "right"] as const) {
    const [a, b] = SIDEWALK[side];
    R(g, a, 0, b - a, TILE, "#c4c0b4");
    for (let y = 0; y < TILE; y += 22) R(g, a, y, b - a, 1, "#9c988c");
    for (let i = 0; i < 18; i++) {
      const y = Math.floor(hash(i + side.length) * TILE);
      R(g, a + 4 + Math.floor(hash(i + 2) * 12), y, 1, 6, "#8c887c");
      R(g, a + 5 + Math.floor(hash(i + 2) * 12), y + 5, 3, 1, "#8c887c");
    }
    for (let y = 0; y < TILE; y += 44) R(g, side === "left" ? a - 2 : b, y + 8, 2, 30, "#7aa04a");
    R(g, side === "left" ? b : ROAD_RIGHT, 0, 4, TILE, "#8e8a82");
    R(g, side === "left" ? b + 3 : ROAD_RIGHT + 3, 0, 1, TILE, "#5e5a54");
  }
  R(g, ROAD_LEFT, 0, ROAD_RIGHT - ROAD_LEFT, TILE, "#474c53");
  for (let i = 0; i < 1800; i++)
    R(g, ROAD_LEFT + Math.floor(hash(i + 4.1) * (ROAD_RIGHT - ROAD_LEFT)), Math.floor(hash(i + 2.9) * TILE), 1, 1,
      hash(i + 9) > 0.5 ? "#3d4248" : "#555a61");
  // Patches and cracks: the city fixes potholes one rectangle at a time.
  for (let i = 0; i < 9; i++) {
    const x = ROAD_LEFT + 10 + Math.floor(hash(i + 31) * (ROAD_RIGHT - ROAD_LEFT - 60)),
      y = Math.floor(hash(i + 17) * (TILE - 60)),
      w = 18 + Math.floor(hash(i + 5) * 30),
      h = 14 + Math.floor(hash(i + 8) * 30);
    R(g, x, y, w, h, "#3a3e44");
    R(g, x, y, w, 1, "#2e3238");
  }
  for (let i = 0; i < 14; i++) {
    let x = ROAD_LEFT + 6 + Math.floor(hash(i + 51) * (ROAD_RIGHT - ROAD_LEFT - 12)),
      y = Math.floor(hash(i + 61) * TILE);
    for (let s = 0; s < 14; s++) {
      R(g, x, y, 1, 2, "#2a2e33");
      x += hash(i * 20 + s) > 0.5 ? 1 : -1;
      y += 2;
    }
  }
  R(g, ROAD_LEFT + 4, 0, 2, TILE, "#d8d6cc");
  R(g, ROAD_RIGHT - 6, 0, 2, TILE, "#d8d6cc");
  // Faded double yellow.
  for (let y = 0; y < TILE; y++)
    if (hash(y * 0.37) > 0.12) {
      R(g, 253, y, 2, 1, "#d8b434");
      R(g, 257, y, 2, 1, "#d8b434");
    }
  groundTile = tile;
  return tile;
}

function blit(ctx: CanvasRenderingContext2D, image: CanvasImageSource & { width: number; height: number }, cx: number, bottom: number, flip = false) {
  const x = Math.round(cx - image.width / 2),
    y = Math.round(bottom - image.height);
  if (!flip) {
    ctx.drawImage(image, x, y);
    return;
  }
  ctx.save();
  ctx.translate(x + image.width, y);
  ctx.scale(-1, 1);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  R(ctx, x - 2, y - 2, w + 4, h + 4, "#14141c");
  R(ctx, x, y, w, h, "#f4f4ec");
  R(ctx, x + 2, y + 2, w - 4, h - 4, "#1c2c64");
}

// Houses are drawn smaller and sheared so their fronts turn toward the
// street: the edge nearest the road sits lower (closer to the viewer).
const HOUSE_SX = 0.62,
  HOUSE_SY = 0.8,
  HOUSE_SKEW = 0.22;
function lotPlacement(side: Side, base: number, door: number) {
  const k = side === "left" ? HOUSE_SKEW : -HOUSE_SKEW,
    originX =
      side === "left" ? LOT_SPAN - LOT_W * HOUSE_SX - 2 : SIDEWALK.right[1] + 2,
    originY = base - LOT_GROUND * HOUSE_SY - door * k;
  return { k, originX, originY, doorX: originX + door * HOUSE_SX };
}

/** Where a sub is tossed to for a house: its front door. */
export function porchPoint(side: Side, y: number, house?: House) {
  const door = house ? lotCanvas(house, false).door : LOT_W / 2;
  return { x: lotPlacement(side, pctY(y), door).doorX, y: pctY(y) - 8 };
}

function drawLot(ctx: CanvasRenderingContext2D, house: House, now: number, night: boolean) {
  const base = pctY(house.y),
    { canvas, door } = lotCanvas(house, night),
    place = lotPlacement(house.side, base, door);
  ctx.save();
  ctx.transform(HOUSE_SX, place.k, 0, HOUSE_SY, Math.round(place.originX), Math.round(place.originY));
  ctx.drawImage(canvas, 0, 0);
  ctx.restore();
  const pending = house.customer && house.state === "pending";
  // Mailbox at the curb with the house number; the flag is up for an order.
  const mx = house.side === "left" ? SIDEWALK.left[1] - 3 : SIDEWALK.right[0] + 3;
  R(ctx, mx - 1, base - 10, 3, 18, "#5a3a22");
  R(ctx, mx - 7, base - 20, 14, 10, "#3a4a5a");
  R(ctx, mx - 7, base - 20, 14, 2, "#5a6a7a");
  if (pending) {
    R(ctx, mx + 6, base - 30, 2, 12, "#d8302c");
    R(ctx, mx + 6, base - 30, 7, 5, "#d8302c");
  }
  drawText(ctx, String(house.number), mx, base + 10, pending ? "#f8d848" : "#f4f4ec", {
    align: "center",
    shadow: "#14141c",
  });
  const dx = place.doorX,
    s = sprites();
  if (house.state === "delivered" || house.state === "sampled") {
    ctx.save();
    ctx.translate(dx - 6, base - 14);
    ctx.scale(2, 2);
    ctx.drawImage(s.bag, 0, 0);
    ctx.restore();
  }
  if (house.state === "delivered")
    drawText(ctx, "✓", dx, base - 44, "#9cdc64", { align: "center", shadow: "#14141c", scale: 2 });
  else if (house.state === "missed")
    drawText(ctx, "×", dx, base - 44, "#ff6050", { align: "center", shadow: "#14141c", scale: 2 });
  else if (pending) {
    const bob = Math.floor(now / 200) % 2;
    box(ctx, dx - 32, base - 70 + bob, 64, 22);
    drawText(ctx, "ORDER", dx, base - 66 + bob, "#f8d848", { align: "center" });
    drawText(ctx, house.item.split(" ")[0], dx, base - 57 + bob, "#f4f4ec", { align: "center" });
    if (inThrowWindow(house.y) && Math.floor(now / 120) % 2) {
      const porch = house.y >= PORCH_WINDOW.start && house.y <= PORCH_WINDOW.end;
      drawText(ctx, house.side === "right" ? "▶" : "◀", house.side === "right" ? ROAD_RIGHT - 18 : ROAD_LEFT + 6,
        base - 20, porch ? "#9cdc64" : "#f8d848", { shadow: "#14141c", scale: 2 });
    }
  }
}

function drawCar(ctx: CanvasRenderingContext2D, cx: number, bottom: number, variant: number, van: boolean, night: boolean, rear = false) {
  // Seen from the front (oncoming, or parked facing us) or from the back.
  const paint = ["#2a5ea8", "#8a2a2a", "#d8d4c8", "#2f2f34", "#6a7a3a", "#b08a3a"][variant % 6],
    // Same scale as the Equinox (about 1.85 m wide ≈ 62 px).
    w = van ? 66 : 62,
    h = van ? 62 : 48,
    x = cx - w / 2,
    y = bottom - h;
  R(ctx, x + 3, bottom - 6, 9, 7, "#141418");
  R(ctx, x + w - 12, bottom - 6, 9, 7, "#141418");
  R(ctx, x, y + h * 0.42, w, h * 0.5, paint);
  R(ctx, x + 4, y, w - 8, h * 0.46, shade(paint, 0.85));
  R(ctx, x + 8, y + 4, w - 16, h * 0.34, "#3a5068");
  R(ctx, x + 10, y + 6, 6, 3, "#8fb0cf");
  const lamp = rear ? (night ? "#ff4030" : "#b82020") : night ? "#fff6c0" : "#e8e4c8";
  R(ctx, x + 6, y + h * 0.6, 10, 6, lamp);
  R(ctx, x + w - 16, y + h * 0.6, 10, 6, lamp);
  if (rear) R(ctx, x + w / 2 - 8, y + h * 0.62, 16, 6, "#e8e4d8");
  else R(ctx, x + w / 2 - 9, y + h * 0.62, 18, 6, "#1c1c20");
  R(ctx, x - 2, bottom - 10, w + 4, 4, "#9a9a98");
  R(ctx, x - 4, y + h * 0.36, 5, 4, paint);
  R(ctx, x + w - 1, y + h * 0.36, 5, 4, paint);
}

function drawTarpCar(ctx: CanvasRenderingContext2D, cx: number, bottom: number) {
  ctx.save();
  ctx.translate(cx, bottom);
  ctx.scale(1.1, 1.2);
  ctx.translate(-cx, -bottom);
  const x = cx - 28;
  R(ctx, x + 2, bottom - 6, 9, 7, "#141418");
  R(ctx, x + 45, bottom - 6, 9, 7, "#141418");
  for (let i = 0; i < 30; i++) {
    const inset = Math.max(0, 14 - i) * 1.1;
    R(ctx, x + inset, bottom - 34 + i, 56 - inset * 2, 1, i % 4 ? "#2f6fc4" : "#2558a0");
  }
  R(ctx, x + 4, bottom - 20, 48, 1, "#e0302c");
  R(ctx, x + 27, bottom - 34, 1, 28, "#e0302c");
  R(ctx, x + 10, bottom - 28, 8, 2, "#5a90e0");
  R(ctx, x + 40, bottom - 14, 6, 6, "#1d1d22");
  ctx.restore();
}

function drawEbike(ctx: CanvasRenderingContext2D, cx: number, bottom: number, variant: number, now: number) {
  // A kid on an e-bike, riding the wrong way, hood up, no helmet.
  const hoodie = ["#c7312c", "#2a5ea8", "#3a7a32", "#5a2a7a", "#222"][variant % 5];
  R(ctx, cx - 3, bottom - 12, 6, 12, "#141418");
  R(ctx, cx - 2, bottom - 9, 4, 6, "#3a3a40");
  R(ctx, cx - 12, bottom - 30, 24, 3, "#9a9aa0");
  R(ctx, cx - 9, bottom - 34, 18, 16, hoodie);
  R(ctx, cx - 6, bottom - 44, 12, 11, hoodie);
  R(ctx, cx - 4, bottom - 41, 8, 7, "#e8b890");
  R(ctx, cx - 3, bottom - 38, 2, 2, "#222");
  R(ctx, cx + 1, bottom - 38, 2, 2, "#222");
  R(ctx, cx - 14, bottom - 28, 5, 4, "#e8b890");
  R(ctx, cx + 9, bottom - 28, 5, 4, "#e8b890");
  if (Math.floor(now / 150) % 2) R(ctx, cx - 2, bottom - 16, 4, 3, "#9cf0ff");
}

function drawPothole(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const w = Math.round(30 * size),
    h = Math.round(14 * size);
  for (let i = 0; i < h; i++) {
    const t = 1 - Math.abs((i - h / 2) / (h / 2));
    const half = Math.round((w / 2) * Math.sqrt(Math.max(0, t)));
    R(ctx, cx - half - 1, cy - h / 2 + i, half * 2 + 2, 1, "#2e3136");
    R(ctx, cx - half + 1, cy - h / 2 + i, Math.max(0, half * 2 - 2), 1, i < h / 2 ? "#141519" : "#1f2126");
  }
  R(ctx, cx - w / 2 + 2, cy + h / 2 - 1, w - 4, 1, "#6a6e74");
  if (size > 1.1) R(ctx, cx - 3, cy, 6, 2, "#3a5070");
}

function drawThing(ctx: CanvasRenderingContext2D, thing: Thing, assets: Assets, now: number, night: boolean) {
  const x = laneX(thing.lane),
    y = pctY(thing.y),
    s = sprites(),
    flip = (thing.vx ?? 0) < 0;
  switch (thing.type) {
    case "pothole":
      drawPothole(ctx, x, y, thing.size ?? 1);
      return;
    case "car":
    case "van":
      drawCar(ctx, x, y + 20, thing.variant ?? 0, thing.type === "van", night);
      return;
    case "tarpcar":
      drawTarpCar(ctx, x, y + 18);
      return;
    case "parked":
      drawCar(ctx, x, y + 20, thing.variant ?? 0, false, false, thing.size === 1);
      return;
    case "ebike":
      drawEbike(ctx, x, y + 22, thing.variant ?? 0, now);
      return;
    case "mower":
      blit(ctx, assets.person, x + 8, y + 20);
      R(ctx, x - 22, y + 6, 22, 12, "#c7312c");
      R(ctx, x - 22, y + 6, 22, 3, "#e05a4a");
      R(ctx, x - 24, y + 16, 6, 5, "#141418");
      R(ctx, x - 6, y + 16, 6, 5, "#141418");
      R(ctx, x - 4, y - 6, 2, 14, "#2a2a2e");
      return;
    case "boost":
    case "slow":
    case "restock": {
      const sprite = s[thing.type];
      ctx.save();
      ctx.translate(Math.round(x - sprite.width), Math.round(y - sprite.height));
      ctx.scale(2, 2);
      ctx.drawImage(sprite, 0, 0);
      ctx.restore();
      return;
    }
    default: {
      const art = assets[thing.type];
      if (art) blit(ctx, art, x, y + art.height / 2, flip);
    }
  }
}

function drawScenery(ctx: CanvasRenderingContext2D, item: Scenery, assets: Assets) {
  const left = item.side === "left",
    x = left ? (SIDEWALK.left[0] + SIDEWALK.left[1]) / 2 : (SIDEWALK.right[0] + SIDEWALK.right[1]) / 2,
    y = pctY(item.y) + 14,
    s = sprites();
  switch (item.kind) {
    case "abandoned":
      blit(ctx, assets.junkcar, x + (left ? -6 : 6), y, !left);
      return;
    case "tent":
      blit(ctx, assets.tent, x, y, !left);
      return;
    case "dumpster":
      blit(ctx, assets.dumpster, x, y);
      return;
    case "pole":
      blit(ctx, assets.pole, left ? x - 14 : x + 14, y, !left);
      return;
    case "sign":
      R(ctx, x - 1, y - 40, 3, 40, "#6a6e74");
      R(ctx, x - 24, y - 46, 48, 11, "#1f6a3a");
      R(ctx, x - 23, y - 45, 46, 9, "#2a8a4a");
      return;
    case "trash":
      // Two city cans, one lid missing, one bag that didn't make it in.
      for (const [dx, lid] of [[-7, true], [7, false]] as const) {
        R(ctx, x + dx - 6, y - 22, 12, 20, "#5a6068");
        for (let yy = y - 20; yy < y - 2; yy += 4) R(ctx, x + dx - 6, yy, 12, 1, "#4a5058");
        R(ctx, x + dx - 6, y - 22, 2, 20, "#7a8088");
        if (lid) R(ctx, x + dx - 8, y - 25, 16, 3, "#3a4048");
        else R(ctx, x + dx - 5, y - 26, 10, 5, "#202024");
      }
      R(ctx, x - 16, y - 8, 9, 8, "#202024");
      R(ctx, x - 13, y - 10, 3, 2, "#202024");
      return;
    case "cart":
      R(ctx, x - 12, y - 22, 24, 2, "#b8bcc4");
      R(ctx, x - 12, y - 22, 2, 14, "#b8bcc4");
      R(ctx, x + 10, y - 22, 2, 14, "#b8bcc4");
      for (let xx = x - 10; xx < x + 10; xx += 4) R(ctx, xx, y - 20, 1, 12, "#9aa0a8");
      R(ctx, x - 12, y - 10, 24, 2, "#b8bcc4");
      R(ctx, x + 12, y - 26, 2, 6, "#b8bcc4");
      R(ctx, x + 8, y - 28, 10, 3, "#c7312c");
      R(ctx, x - 10, y - 4, 4, 4, "#202024");
      R(ctx, x + 6, y - 4, 4, 4, "#202024");
      return;
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, f: StreetFrame, fx: Fx, now: number, assets: Assets) {
  const x = laneX(f.lane),
    bottom = pctY(PLAYER_Y) + 24;
  ctx.fillStyle = "rgba(0,0,0,0.32)";
  ctx.fillRect(Math.round(x - 28), Math.round(bottom - 6), 56, 8);
  if (now - fx.skidAt < 260) {
    R(ctx, x - 20, bottom, 4, 14, "#24272c");
    R(ctx, x + 16, bottom, 4, 14, "#24272c");
  }
  if (f.boost > 0) {
    const flick = Math.floor(now / 60) % 2;
    R(ctx, x - 14, bottom - 2, 5, 8 + flick * 4, flick ? "#f8d848" : "#f08830");
    R(ctx, x + 9, bottom - 2, 5, 12 - flick * 4, flick ? "#f08830" : "#f8d848");
  }
  if (f.invulnerable > 0 && Math.floor(now / 80) % 2) return;
  blit(ctx, assets.suv, x, bottom);
  if (f.damaged > 0) {
    const t = (now / 500) % 1;
    ctx.fillStyle = `rgba(150,150,160,${0.85 - t * 0.7})`;
    ctx.fillRect(Math.round(x - 6 - t * 8), Math.round(bottom - 60 - t * 24), 10, 10);
  }
}

function drawHud(ctx: CanvasRenderingContext2D, f: StreetFrame) {
  R(ctx, 0, 0, SCREEN_W, HUD_H, "#1c2850");
  R(ctx, 0, HUD_H - 2, SCREEN_W, 2, "#f4f4ec");
  R(ctx, 0, HUD_H - 6, SCREEN_W, 4, "#0c1230");
  R(ctx, 0, HUD_H - 6, Math.round(SCREEN_W * Math.min(1, 1 - f.time / f.totalTime)), 4, "#f8d848");
  drawText(ctx, `${f.day} · ${f.street}`, 6, 4, "#f8d848", { scale: 2 });
  drawText(ctx, `${f.score}`.padStart(6, "0"), SCREEN_W - 6, 4, "#f4f4ec", { scale: 2, align: "right" });
  const met = f.routeDelivered >= f.quota;
  drawText(ctx, `ORDERS ${f.routeDelivered}/${f.deliveries}  NEED ${f.quota}`, 6, 22, met ? "#9cdc64" : "#f4f4ec");
  drawText(ctx, `SUBS ${f.ammo}`, 200, 22, f.ammo < 3 ? "#ff6050" : "#f4f4ec");
  drawText(ctx, `${Math.ceil(f.time)}S`, 272, 22, f.time < 11 ? "#ff6050" : "#f4f4ec");
  if (f.combo > 1) drawText(ctx, `TIPS ×${Math.min(4, f.combo)}`, 320, 22, "#f8d848");
  const s = sprites();
  for (let i = 0; i < 3; i++) {
    ctx.save();
    ctx.translate(SCREEN_W - 54 + i * 16, 20);
    ctx.scale(2, 2);
    ctx.drawImage(i < f.health ? s.heart : s.heartEmpty, 0, 0);
    ctx.restore();
  }
}

/** Renders a whole frame. */
export function drawStreet(
  ctx: CanvasRenderingContext2D,
  f: StreetFrame,
  fx: Fx,
  overlay: Overlay,
  now: number,
  assets: Assets,
) {
  const s = sprites();
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  if (!overlay.reducedEffects && now - fx.shakeAt < 210)
    ctx.translate(Math.round((hash(now) - 0.5) * 8), Math.round((hash(now + 1) - 0.5) * 8));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, PLAY_Y, SCREEN_W, PLAY_H);
  ctx.clip();
  const distancePx = (f.distance / 100) * PLAY_H;
  const offset = ((distancePx % TILE) + TILE) % TILE;
  const tile = ground();
  for (let y = PLAY_Y - TILE + offset; y < SCREEN_H; y += TILE) ctx.drawImage(tile, 0, Math.round(y));
  const night = f.stage >= 4;
  // Far things first so nearer houses overlap the ones up the street.
  for (const house of [...f.houses].sort((a, b) => a.y - b.y)) drawLot(ctx, house, now, night);
  for (const item of [...f.scenery].sort((a, b) => a.y - b.y)) drawScenery(ctx, item, assets);
  for (const thing of [...f.things].sort((a, b) => a.y - b.y)) {
    drawThing(ctx, thing, assets, now, night);
    if (DEADLY.has(thing.type) && thing.y < 14 && Math.floor(now / 140) % 2)
      drawText(ctx, "!", laneX(thing.lane), PLAY_Y + 6, "#ff6050", { align: "center", shadow: "#14141c", scale: 3 });
  }
  drawPlayer(ctx, f, fx, now, assets);
  for (const t of fx.throws) {
    const p = Math.min(1, (now - t.at) / 320);
    const x = t.fromX + (t.toX - t.fromX) * p,
      y = t.fromY + (t.toY - t.fromY) * p - Math.sin(p * Math.PI) * 30;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(Math.round(p * 8) * (Math.PI / 4));
    ctx.scale(2, 2);
    ctx.drawImage(s.sub, -4, -2);
    ctx.restore();
  }
  for (const part of fx.particles) {
    const t = (now - part.at) / 600;
    const colors = ["#f8d848", "#d8302c", "#9cdc64", "#f4f4ec"];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      R(ctx, part.x + Math.cos(a) * t * 36, part.y + Math.sin(a) * t * 26 + t * t * 20, 2, 2, colors[i % 4]);
    }
  }
  // Same street all week: lunch on Monday through Friday night.
  const tint = [null, "rgba(255,150,60,0.08)", "rgba(255,110,60,0.16)", "rgba(20,24,70,0.46)", "rgba(6,8,40,0.64)"][f.stage - 1];
  if (tint) R(ctx, 0, PLAY_Y, SCREEN_W, PLAY_H, tint);
  if (night) {
    ctx.globalCompositeOperation = "lighter";
    const x = laneX(f.lane),
      y = pctY(PLAYER_Y) - 20;
    const beam = ctx.createLinearGradient(0, y, 0, y - 150);
    beam.addColorStop(0, "rgba(255,240,170,0.32)");
    beam.addColorStop(1, "rgba(255,240,170,0)");
    ctx.fillStyle = beam;
    ctx.beginPath();
    ctx.moveTo(x - 16, y);
    ctx.lineTo(x + 16, y);
    ctx.lineTo(x + 54, y - 150);
    ctx.lineTo(x - 54, y - 150);
    ctx.fill();
    for (const house of f.houses)
      if (house.customer && house.state === "pending") {
        const p = porchPoint(house.side, house.y, house);
        const glow = ctx.createRadialGradient(p.x, p.y - 20, 2, p.x, p.y - 20, 36);
        glow.addColorStop(0, "rgba(255,210,120,0.45)");
        glow.addColorStop(1, "rgba(255,210,120,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(p.x - 36, p.y - 56, 72, 72);
      }
    for (const item of f.scenery)
      if (item.kind === "pole") {
        const px = item.side === "left" ? SIDEWALK.left[1] : SIDEWALK.right[0],
          py = pctY(item.y) - 110;
        const glow = ctx.createRadialGradient(px, py + 60, 4, px, py + 60, 60);
        glow.addColorStop(0, "rgba(255,190,110,0.28)");
        glow.addColorStop(1, "rgba(255,190,110,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(px - 60, py, 120, 120);
      }
    ctx.globalCompositeOperation = "source-over";
  }
  for (const burst of fx.bursts) {
    const t = (now - burst.at) / 900;
    drawText(ctx, burst.text, laneX(f.lane), Math.round(pctY(PLAYER_Y) - 70 - t * 50),
      burst.good ? "#9cdc64" : "#ff6050", { align: "center", shadow: "#14141c", scale: 2 });
  }
  if (fx.toast) {
    const lines = wrapText(fx.toast.text, SCREEN_W - 48, 2).slice(0, 6);
    const h = lines.length * 18 + 12;
    box(ctx, 14, PLAY_Y + 14, SCREEN_W - 28, h);
    lines.forEach((line, i) =>
      drawText(ctx, line, SCREEN_W / 2, PLAY_Y + 22 + i * 18, "#f4f4ec", { align: "center", scale: 2 }),
    );
  }
  if (!overlay.reducedEffects && now - fx.flashAt < 160)
    R(ctx, 0, PLAY_Y, SCREEN_W, PLAY_H, `rgba(255,255,255,${0.5 - (now - fx.flashAt) / 320})`);
  if (overlay.countdown !== null) {
    R(ctx, 0, PLAY_Y, SCREEN_W, PLAY_H, "rgba(8,10,24,0.55)");
    box(ctx, 56, 140, 400, 152);
    drawText(ctx, f.dayName, SCREEN_W / 2, 156, "#f8d848", { align: "center", scale: 2 });
    drawText(ctx, `${f.street} · OGDENSBURG`, SCREEN_W / 2, 176, "#c8c8c0", { align: "center" });
    drawText(ctx, overlay.countdown === 0 ? "GO!" : String(overlay.countdown), SCREEN_W / 2, 192, "#f4f4ec",
      { align: "center", scale: 7, shadow: "#14141c" });
    drawText(ctx, `${f.deliveries} ORDERS · NEED ${f.quota} · ${f.ammo} SUBS`, SCREEN_W / 2, 262, "#f4f4ec",
      { align: "center", scale: 2 });
  }
  if (overlay.wrecked) {
    R(ctx, 0, PLAY_Y, SCREEN_W, PLAY_H, "rgba(200,20,10,0.28)");
    box(ctx, 76, 194, 360, 54);
    drawText(ctx, overlay.wrecked === "fired" ? "YOU'RE FIRED" : "SHIFT OVER", SCREEN_W / 2, 204, "#ff6050",
      { align: "center", scale: 4, shadow: "#14141c" });
  }
  ctx.restore();
  drawHud(ctx, f);
  ctx.restore();
}
