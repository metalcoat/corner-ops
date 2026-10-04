// Draws one frame of the Delivery Boy street at 512×448 (SNES hi-res), seen
// from above like Paperboy: roofs, porches facing the road, top-down traffic.
import type { Assets } from "./art-assets";
import { LOT_GROUND, LOT_W, lotCanvas } from "./lots";
import { drawText, sprites, wrapText } from "./pixel-art";
import {
  DEADLY,
  HUD_H,
  inThrowWindow,
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
import {
  PAINTS,
  drawAnimated,
  drawCarTop,
  drawCartTop,
  drawDumpsterTop,
  drawEbikeTop,
  drawMowerTop,
  drawPickup,
  drawPoleTop,
  drawPotholeTop,
  drawTentTop,
  drawTrashTop,
  headlightBeams,
  type CarOptions,
} from "./topdown-art";

export type StreetFrame = {
  stage: number;
  day: string;
  dayName: string;
  street: string;
  lane: number;
  steer: number;
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
    const roll = hash(i);
    R(g, Math.floor(hash(i + 0.3) * SCREEN_W), Math.floor(hash(i + 0.7) * TILE), 1, 2,
      roll > 0.66 ? "#4c8a32" : roll > 0.33 ? "#6aaa44" : "#5a9a3a");
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
      R(g, a + 3 + Math.floor(hash(i + 2) * 10), y, 1, 6, "#8c887c");
    }
    R(g, side === "left" ? b : ROAD_RIGHT, 0, 4, TILE, "#9a968e");
    R(g, side === "left" ? b + 3 : ROAD_RIGHT, 0, 1, TILE, "#5e5a54");
  }
  R(g, ROAD_LEFT, 0, ROAD_RIGHT - ROAD_LEFT, TILE, "#474c53");
  for (let i = 0; i < 2600; i++)
    R(g, ROAD_LEFT + Math.floor(hash(i + 4.1) * (ROAD_RIGHT - ROAD_LEFT)), Math.floor(hash(i + 2.9) * TILE), 1, 1,
      hash(i + 9) > 0.5 ? "#3d4248" : "#555a61");
  // Patches and cracks: the city fixes potholes one rectangle at a time.
  for (let i = 0; i < 11; i++) {
    const x = ROAD_LEFT + 10 + Math.floor(hash(i + 31) * (ROAD_RIGHT - ROAD_LEFT - 60)),
      y = Math.floor(hash(i + 17) * (TILE - 60)),
      w = 18 + Math.floor(hash(i + 5) * 34),
      h = 14 + Math.floor(hash(i + 8) * 34);
    R(g, x, y, w, h, "#3a3e44");
    R(g, x, y, w, 1, "#2e3238");
  }
  for (let i = 0; i < 18; i++) {
    let x = ROAD_LEFT + 6 + Math.floor(hash(i + 51) * (ROAD_RIGHT - ROAD_LEFT - 12)),
      y = Math.floor(hash(i + 61) * TILE);
    for (let s = 0; s < 14; s++) {
      R(g, x, y, 1, 2, "#2a2e33");
      x += hash(i * 20 + s) > 0.5 ? 1 : -1;
      y += 2;
    }
  }
  // Manhole covers.
  for (const y of [120, 380]) {
    g.fillStyle = "#33373c";
    g.beginPath();
    g.arc(ROAD_LEFT + 60 + (y % 7) * 14, y, 9, 0, Math.PI * 2);
    g.fill();
    R(g, ROAD_LEFT + 54 + (y % 7) * 14, y - 1, 12, 2, "#2a2d31");
  }
  R(g, ROAD_LEFT + 4, 0, 2, TILE, "#d8d6cc");
  R(g, ROAD_RIGHT - 6, 0, 2, TILE, "#d8d6cc");
  // Faded double yellow down the middle.
  const mid = (ROAD_LEFT + ROAD_RIGHT) / 2;
  for (let y = 0; y < TILE; y++)
    if (hash(y * 0.37) > 0.12) {
      R(g, mid - 4, y, 2, 1, "#d8b434");
      R(g, mid + 2, y, 2, 1, "#d8b434");
    }
  groundTile = tile;
  return tile;
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  R(ctx, x - 2, y - 2, w + 4, h + 4, "#14141c");
  R(ctx, x, y, w, h, "#f4f4ec");
  R(ctx, x + 2, y + 2, w - 4, h - 4, "#1c2c64");
}

/** Where a sub is tossed to for a house: its front porch. */
export function porchPoint(side: Side, y: number, house?: House) {
  const door = house ? lotCanvas(house, false).door : LOT_W - 24;
  return { x: side === "left" ? door : SCREEN_W - door, y: pctY(y) };
}

function drawLot(ctx: CanvasRenderingContext2D, house: House, now: number, night: boolean) {
  const base = pctY(house.y),
    { canvas, sign } = lotCanvas(house, night),
    top = Math.round(base - LOT_GROUND);
  if (house.side === "left") ctx.drawImage(canvas, 0, top);
  else {
    ctx.save();
    ctx.translate(SCREEN_W, top);
    ctx.scale(-1, 1);
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
  }
  if (sign) {
    const x = house.side === "left" ? sign.x : SCREEN_W - sign.x - sign.w;
    R(ctx, x + 2, top + sign.y + 2, sign.w, 11, "rgba(0,0,0,0.3)");
    R(ctx, x, top + sign.y, sign.w, 11, sign.bg);
    drawText(ctx, sign.text, x + sign.w / 2, top + sign.y + 2, sign.fg, { align: "center" });
  }
  const pending = house.customer && house.state === "pending",
    p = porchPoint(house.side, house.y, house);
  // Mailbox at the edge of the sidewalk; the flag is up for an order.
  const mx = house.side === "left" ? SIDEWALK.left[0] + 3 : SIDEWALK.right[1] - 3,
    my = base + 12;
  R(ctx, mx - 1, my - 2, 3, 8, "#5a3a22");
  R(ctx, mx - 5, my - 8, 10, 7, "#3a4a5a");
  R(ctx, mx - 5, my - 8, 10, 2, "#5a6a7a");
  if (pending) {
    const wave = Math.floor(now / 300) % 2;
    R(ctx, mx + (house.side === "left" ? 4 : -6), my - 16 + wave, 2, 9, "#d8302c");
    R(ctx, mx + (house.side === "left" ? 4 : -9), my - 16 + wave, 5, 4, "#d8302c");
  }
  drawText(ctx, String(house.number), house.side === "left" ? mx - 8 : mx + 8, my + 8, pending ? "#f8d848" : "#f4f4ec", {
    align: house.side === "left" ? "right" : "left",
    shadow: "#14141c",
  });
  const s = sprites();
  if (house.state === "delivered" || house.state === "sampled") {
    ctx.save();
    ctx.translate(p.x - 6, p.y - 6);
    ctx.scale(2, 2);
    ctx.drawImage(s.bag, 0, 0);
    ctx.restore();
  }
  if (house.state === "delivered")
    drawText(ctx, "✓", p.x, p.y - 34, "#9cdc64", { align: "center", shadow: "#14141c", scale: 2 });
  else if (house.state === "missed")
    drawText(ctx, "×", p.x, p.y - 34, "#ff6050", { align: "center", shadow: "#14141c", scale: 2 });
  else if (pending) {
    const bob = Math.floor(now / 200) % 2;
    box(ctx, p.x - 30, p.y - 56 + bob, 60, 22);
    drawText(ctx, "ORDER", p.x, p.y - 52 + bob, "#f8d848", { align: "center" });
    drawText(ctx, house.item.split(" ")[0], p.x, p.y - 43 + bob, "#f4f4ec", { align: "center" });
    if (inThrowWindow(house.y) && Math.floor(now / 120) % 2) {
      const porch = house.y >= PORCH_WINDOW.start && house.y <= PORCH_WINDOW.end;
      drawText(ctx, house.side === "right" ? "▶" : "◀", house.side === "right" ? ROAD_RIGHT - 18 : ROAD_LEFT + 6,
        base - 8, porch ? "#9cdc64" : "#f8d848", { shadow: "#14141c", scale: 2 });
    }
  }
}

function carLook(thing: Thing): Partial<CarOptions> {
  const v = thing.variant ?? 0;
  return {
    paint: PAINTS[v % PAINTS.length],
    kind: thing.type === "van" ? "van" : v % 5 === 0 ? "pickup" : v % 7 === 3 ? "suv" : "car",
    roofLoad: thing.type === "car" && v === 11 ? "mattress" : thing.type === "car" && v === 10 ? "kayak" : null,
    rusty: v % 4 === 1,
  };
}

const GAIT: Partial<Record<Thing["type"], "trot" | "walk" | "waddle" | "hop" | "graze">> = {
  dog: "trot",
  cat: "walk",
  squirrel: "hop",
  raccoon: "walk",
  goose: "waddle",
  deer: "hop",
  cow: "graze",
  person: "walk",
};

function drawThing(ctx: CanvasRenderingContext2D, thing: Thing, assets: Assets, now: number, night: boolean) {
  const x = laneX(thing.lane),
    y = pctY(thing.y);
  switch (thing.type) {
    case "pothole":
      drawPotholeTop(ctx, x, y, thing.size ?? 1);
      return;
    case "car":
    case "van":
      drawCarTop(ctx, x, y, { ...carLook(thing), paint: carLook(thing).paint!, angle: Math.PI, headlights: night });
      return;
    case "parked":
      // Left-side cars face us (nose down); right-side ones face away.
      drawCarTop(ctx, x, y, { ...carLook(thing), paint: carLook(thing).paint!, angle: thing.size === 1 ? 0 : Math.PI });
      return;
    case "tarpcar":
      drawCarTop(ctx, x, y, { paint: "#2f6fc4", angle: thing.lane < 1 ? Math.PI : 0, tarp: true, time: now });
      return;
    case "racer": {
      const up = (thing.speed ?? 1) < 0;
      drawCarTop(ctx, x, y, { paint: ["#e8d020", "#e02020", "#20a0e0", "#f0f0f0"][(thing.variant ?? 0) % 4], kind: "car", angle: up ? 0 : Math.PI, headlights: true, brake: false });
      // Speed lines behind it.
      for (let i = 0; i < 4; i++) R(ctx, x - 14 + i * 9, up ? y + 46 : y - 66, 2, 20, "rgba(255,255,255,0.35)");
      return;
    }
    case "ebike":
      drawEbikeTop(ctx, x, y, Math.PI + Math.cos(thing.phase ?? 0) * 0.35, thing.variant ?? 0, now);
      return;
    case "mower":
      drawMowerTop(ctx, x, y, now);
      return;
    case "boost":
    case "slow":
    case "restock":
      drawPickup(ctx, thing.type, x, y, now);
      return;
    default: {
      const art = assets[thing.type];
      if (!art) return;
      const vx = thing.vx ?? 0,
        // Painted animals face left; the walker faces right.
        facesRight = thing.type === "person",
        flip = facesRight ? vx < 0 : vx > 0,
        moving = vx !== 0 || thing.type === "person" || thing.type === "goose" || thing.type === "dog";
      drawAnimated(ctx, art, x, y + art.height / 2, { flip, time: now + thing.id * 97, gait: GAIT[thing.type] ?? "walk", moving });
      if (thing.type === "goose" && Math.floor((now + thing.id * 300) / 1400) % 3 === 0)
        drawText(ctx, "HONK!", x, y - art.height / 2 - 10, "#f4f4ec", { align: "center", shadow: "#14141c" });
      if (thing.type === "cow" && Math.floor((now + thing.id * 300) / 1800) % 4 === 0)
        drawText(ctx, "MOO", x, y - art.height / 2 - 10, "#f4f4ec", { align: "center", shadow: "#14141c" });
      if (night && thing.type === "deer") {
        // Eyes in the headlights.
        R(ctx, x + (flip ? 8 : -12), y - art.height / 2 + 8, 2, 2, "#fff8c0");
      }
    }
  }
}

function drawScenery(ctx: CanvasRenderingContext2D, item: Scenery, night: boolean) {
  const left = item.side === "left",
    x = left ? (SIDEWALK.left[0] + SIDEWALK.left[1]) / 2 : (SIDEWALK.right[0] + SIDEWALK.right[1]) / 2,
    y = pctY(item.y);
  switch (item.kind) {
    case "abandoned":
      drawCarTop(ctx, x + (left ? -14 : 14), y, { paint: "#8a6a4a", angle: left ? Math.PI : 0, rusty: true });
      return;
    case "tent":
      drawTentTop(ctx, x + (left ? -8 : 8), y);
      return;
    case "dumpster":
      drawDumpsterTop(ctx, x, y);
      return;
    case "pole":
      drawPoleTop(ctx, left ? SIDEWALK.left[1] - 2 : SIDEWALK.right[0] + 2, y, item.side, night);
      return;
    case "trash":
      drawTrashTop(ctx, x, y);
      return;
    case "cart":
      drawCartTop(ctx, x, y);
      return;
    case "sign":
      R(ctx, x - 1, y - 2, 3, 6, "#6a6e74");
      R(ctx, x - 22, y - 10, 44, 9, "#2a8a4a");
      return;
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, f: StreetFrame, fx: Fx, now: number) {
  const x = laneX(f.lane),
    y = pctY(PLAYER_Y);
  if (now - fx.skidAt < 260) {
    R(ctx, x - 18, y + 30, 5, 22, "#24272c");
    R(ctx, x + 13, y + 30, 5, 22, "#24272c");
  }
  if (f.boost > 0) {
    const flick = Math.floor(now / 60) % 2;
    R(ctx, x - 12, y + 42, 6, 10 + flick * 6, flick ? "#f8d848" : "#f08830");
    R(ctx, x + 6, y + 42, 6, 16 - flick * 6, flick ? "#f08830" : "#f8d848");
  }
  if (f.invulnerable > 0 && Math.floor(now / 80) % 2) return;
  // The car turns as you steer, wheels and all.
  drawCarTop(ctx, x, y, {
    paint: "#e8e6de",
    kind: "delivery",
    angle: f.steer * 0.22,
    steer: f.steer * 0.4,
    headlights: f.stage >= 4,
    brake: f.slow > 0,
  });
  if (f.damaged > 0) {
    const t = (now / 500) % 1;
    ctx.fillStyle = `rgba(150,150,160,${0.85 - t * 0.7})`;
    ctx.beginPath();
    ctx.arc(x - 4 - t * 8, y - 30 - t * 24, 6 + t * 6, 0, Math.PI * 2);
    ctx.fill();
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
  for (const house of [...f.houses].sort((a, b) => a.y - b.y)) drawLot(ctx, house, now, night);
  for (const item of [...f.scenery].sort((a, b) => a.y - b.y)) drawScenery(ctx, item, night);
  for (const thing of [...f.things].sort((a, b) => a.y - b.y)) {
    drawThing(ctx, thing, assets, now, night);
    if (DEADLY.has(thing.type) && thing.y < 14 && thing.y > -30 && Math.floor(now / 140) % 2)
      drawText(ctx, "!", laneX(thing.lane), PLAY_Y + 6, "#ff6050", { align: "center", shadow: "#14141c", scale: 3 });
    if (thing.type === "racer" && thing.y > 96 && Math.floor(now / 120) % 2)
      drawText(ctx, "!", laneX(thing.lane), SCREEN_H - 26, "#ff6050", { align: "center", shadow: "#14141c", scale: 3 });
  }
  drawPlayer(ctx, f, fx, now);
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
    headlightBeams(ctx, laneX(f.lane), pctY(PLAYER_Y), f.steer * 0.22, 170, "delivery");
    for (const thing of f.things)
      if (thing.type === "car" || thing.type === "van" || thing.type === "racer")
        headlightBeams(ctx, laneX(thing.lane), pctY(thing.y), (thing.speed ?? 1) < 0 ? 0 : Math.PI, 110);
    for (const house of f.houses)
      if (house.customer && house.state === "pending") {
        const p = porchPoint(house.side, house.y, house);
        const glow = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 34);
        glow.addColorStop(0, "rgba(255,210,120,0.5)");
        glow.addColorStop(1, "rgba(255,210,120,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(p.x - 34, p.y - 34, 68, 68);
      }
    for (const item of f.scenery)
      if (item.kind === "pole") {
        const px = item.side === "left" ? SIDEWALK.left[1] + 28 : SIDEWALK.right[0] - 28,
          py = pctY(item.y);
        const glow = ctx.createRadialGradient(px, py, 4, px, py, 70);
        glow.addColorStop(0, "rgba(255,190,110,0.3)");
        glow.addColorStop(1, "rgba(255,190,110,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(px - 70, py - 70, 140, 140);
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
