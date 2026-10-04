// Draws one frame of the Delivery Boy street at native 256×224 resolution.
import { drawText, sprites, wrapText, type Sprite } from "./pixel-art";
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

const ROOFS = ["#a83a30", "#3a5a8c", "#5a6a3a", "#8c6a3a", "#6a4a7a", "#56565e"];
const WALLS = ["#e8dcc0", "#c8d8e0", "#e0c8b0", "#d0d0c8"];
const SIDEWALK = { left: [60, 70], right: [186, 196] } as const;

function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * amount)));
  return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
}
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

let groundTile: HTMLCanvasElement | null = null;
/** A 256px-tall strip of lawn, sidewalk, curb and road that tiles vertically. */
function ground() {
  if (groundTile) return groundTile;
  const tile = document.createElement("canvas");
  tile.width = SCREEN_W;
  tile.height = 256;
  const g = tile.getContext("2d")!;
  g.fillStyle = "#5cac3c";
  g.fillRect(0, 0, SCREEN_W, 256);
  for (let i = 0; i < 700; i++) {
    g.fillStyle = hash(i) > 0.5 ? "#4e9a34" : "#6cbc48";
    g.fillRect(Math.floor(hash(i + 0.3) * SCREEN_W), Math.floor(hash(i + 0.7) * 256), 1, 1);
  }
  for (const side of ["left", "right"] as const) {
    const [a, b] = SIDEWALK[side];
    g.fillStyle = "#c8c4b8";
    g.fillRect(a, 0, b - a, 256);
    g.fillStyle = "#a09c90";
    for (let y = 0; y < 256; y += 16) g.fillRect(a, y, b - a, 1);
    g.fillStyle = "#7c7a74";
    g.fillRect(side === "left" ? b : ROAD_RIGHT, 0, 2, 256);
  }
  g.fillStyle = "#454b52";
  g.fillRect(ROAD_LEFT, 0, ROAD_RIGHT - ROAD_LEFT, 256);
  for (let i = 0; i < 500; i++) {
    g.fillStyle = hash(i + 9) > 0.5 ? "#3b4147" : "#50565d";
    g.fillRect(
      ROAD_LEFT + Math.floor(hash(i + 4.1) * (ROAD_RIGHT - ROAD_LEFT)),
      Math.floor(hash(i + 2.9) * 256),
      1,
      1,
    );
  }
  g.fillStyle = "#e8e8e0";
  g.fillRect(ROAD_LEFT + 2, 0, 1, 256);
  g.fillRect(ROAD_RIGHT - 3, 0, 1, 256);
  g.fillStyle = "#f0c838";
  for (let y = 0; y < 256; y += 32) g.fillRect(127, y, 2, 16);
  groundTile = tile;
  return tile;
}

function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: Sprite,
  cx: number,
  cy: number,
  flip = false,
) {
  const x = Math.round(cx - sprite.width / 2),
    y = Math.round(cy - sprite.height / 2);
  if (!flip) {
    ctx.drawImage(sprite, x, y);
    return;
  }
  ctx.save();
  ctx.translate(x + sprite.width, y);
  ctx.scale(-1, 1);
  ctx.drawImage(sprite, 0, 0);
  ctx.restore();
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = "#14141c";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = "#f4f4ec";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#1c2c64";
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
}

function drawHouse(
  ctx: CanvasRenderingContext2D,
  house: House,
  now: number,
  dark: boolean,
) {
  const cy = Math.round(pctY(house.y));
  const mirror = house.side === "right";
  // Lay the lot out for the left side and mirror it for the right.
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(mirror ? SCREEN_W - x - w : x, y, w, h);
  };
  const X = (x: number) => (mirror ? SCREEN_W - x : x);
  const lit = house.customer && house.state === "pending";
  const roof = ROOFS[house.look % ROOFS.length],
    wall = WALLS[house.look % WALLS.length],
    dim = house.customer ? 1 : 0.62;
  // Shadow, roof (two pitches meeting at a ridge parallel to the street), walls.
  rect(6, cy - 17, 42, 33, "rgba(0,0,0,0.25)");
  rect(4, cy - 20, 21, 32, shade(roof, 0.72 * dim));
  rect(25, cy - 20, 20, 32, shade(roof, 1 * dim));
  for (let y = cy - 18; y < cy + 12; y += 3) rect(4, y, 41, 1, shade(roof, 0.58 * dim));
  rect(24, cy - 20, 2, 32, shade(roof, 0.45 * dim));
  rect(45, cy - 20, 4, 32, shade(wall, dim));
  const window = lit ? "#f8d848" : dark ? "#283048" : "#5878a0";
  rect(46, cy - 16, 2, 5, window);
  rect(46, cy + 5, 2, 5, window);
  rect(46, cy - 3, 3, 7, "#4a2c14");
  // Porch, walkway and mailbox.
  rect(49, cy - 7, 7, 15, house.customer ? "#c8a070" : "#8c7458");
  for (let y = cy - 6; y < cy + 8; y += 2) rect(49, y, 7, 1, "#a8804c");
  rect(56, cy - 2, 4, 4, "#d8d4c8");
  rect(58, cy + 7, 1, 6, "#4a2c14");
  rect(56, cy + 4, 5, 3, "#8c94a0");
  if (lit) {
    rect(60, cy + 1, 1, 4, "#d8302c");
    rect(61, cy + 1, 2, 2, "#d8302c");
    if (Math.floor(now / 260) % 2) rect(50, cy - 9, 2, 2, "#fff8b0");
  }
  const s = sprites();
  if (house.state === "delivered" || house.state === "sampled")
    drawSprite(ctx, s.bag, X(52), cy + 1);
  const label = String(house.number);
  drawText(ctx, label, X(27), cy + 13, lit ? "#f8d848" : "#e8e8e0", {
    align: "center",
    shadow: "#14141c",
  });
  if (house.state === "delivered")
    drawText(ctx, house.landed === "porch" ? "✓" : "✓", X(52), cy - 18, "#9cdc64", {
      align: "center",
      shadow: "#14141c",
    });
  else if (house.state === "missed")
    drawText(ctx, "×", X(52), cy - 18, "#ff6050", { align: "center", shadow: "#14141c" });
  else if (lit) {
    const bob = Math.floor(now / 180) % 2;
    drawText(ctx, "ORDER", X(27), cy - 29 + bob, "#f8d848", {
      align: "center",
      shadow: "#14141c",
    });
    if (inThrowWindow(house.y) && Math.floor(now / 120) % 2) {
      const porch = house.y >= PORCH_WINDOW.start && house.y <= PORCH_WINDOW.end;
      drawText(ctx, mirror ? "▶" : "◀", mirror ? ROAD_RIGHT - 9 : ROAD_LEFT + 4, cy - 3,
        porch ? "#9cdc64" : "#f8d848", { shadow: "#14141c" });
    }
  }
}

function drawDecor(ctx: CanvasRenderingContext2D, distancePx: number) {
  const s = sprites();
  const first = Math.floor(distancePx / 22) - 2;
  for (let k = first; k < first + 14; k++) {
    const screenY = PLAY_Y + PLAY_H - (k * 22 - distancePx);
    for (const side of [0, 1]) {
      const roll = hash(k * 2 + side);
      const x = side ? SCREEN_W - 6 : 6;
      if (roll < 0.28) drawSprite(ctx, s.tree, x, screenY);
      else if (roll < 0.55) drawSprite(ctx, s.bush, x, screenY);
      else if (roll < 0.65) drawSprite(ctx, s.flowers, side ? SCREEN_W - 14 : 14, screenY);
    }
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, f: StreetFrame, fx: Fx, now: number) {
  const s = sprites(),
    x = laneX(f.lane),
    y = pctY(PLAYER_Y);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(Math.round(x - 7), Math.round(y - 9), 16, 23);
  if (now - fx.skidAt < 260) {
    ctx.fillStyle = "#2a2e34";
    ctx.fillRect(Math.round(x - 6), Math.round(y + 12), 2, 8);
    ctx.fillRect(Math.round(x + 4), Math.round(y + 12), 2, 8);
  }
  if (f.boost > 0) {
    const flick = Math.floor(now / 60) % 2;
    ctx.fillStyle = flick ? "#f8d848" : "#f08830";
    ctx.fillRect(Math.round(x - 4), Math.round(y + 12), 2, 3 + flick * 2);
    ctx.fillRect(Math.round(x + 2), Math.round(y + 12), 2, 5 - flick * 2);
  }
  if (f.invulnerable > 0 && Math.floor(now / 80) % 2) return;
  drawSprite(ctx, s.player, x, y);
  if (f.damaged > 0) {
    const t = (now / 400) % 1;
    ctx.fillStyle = `rgba(160,160,170,${0.8 - t * 0.6})`;
    ctx.fillRect(Math.round(x - 2 - t * 4), Math.round(y - 14 - t * 10), 4, 4);
  }
}

function drawHud(ctx: CanvasRenderingContext2D, f: StreetFrame) {
  ctx.fillStyle = "#1c2850";
  ctx.fillRect(0, 0, SCREEN_W, HUD_H);
  ctx.fillStyle = "#f4f4ec";
  ctx.fillRect(0, HUD_H - 1, SCREEN_W, 1);
  ctx.fillStyle = "#0c1230";
  ctx.fillRect(0, HUD_H - 3, SCREEN_W, 2);
  ctx.fillStyle = "#f8d848";
  ctx.fillRect(0, HUD_H - 3, Math.round(SCREEN_W * Math.min(1, 1 - f.time / f.totalTime)), 2);
  drawText(ctx, `${f.day} · ${f.street}`, 3, 2, "#f8d848");
  drawText(ctx, `SUBS ${f.ammo}`, 112, 2, f.ammo < 3 ? "#ff6050" : "#f4f4ec");
  drawText(ctx, `${f.score}`.padStart(6, "0"), 253, 2, "#f4f4ec", { align: "right" });
  const met = f.routeDelivered >= f.quota;
  drawText(
    ctx,
    `ORDERS ${f.routeDelivered}/${f.deliveries} NEED ${f.quota}`,
    3,
    10,
    met ? "#9cdc64" : "#f4f4ec",
  );
  drawText(ctx, `${Math.ceil(f.time)}S`, 160, 10, f.time < 11 ? "#ff6050" : "#f4f4ec");
  if (f.combo > 1) drawText(ctx, `×${Math.min(4, f.combo)}`, 186, 10, "#f8d848");
  const s = sprites();
  for (let i = 0; i < 3; i++)
    ctx.drawImage(i < f.health ? s.heart : s.heartEmpty, 230 + i * 8, 10);
}

/** Renders a whole frame. */
export function drawStreet(
  ctx: CanvasRenderingContext2D,
  f: StreetFrame,
  fx: Fx,
  overlay: Overlay,
  now: number,
) {
  const s = sprites();
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  if (!overlay.reducedEffects && now - fx.shakeAt < 210)
    ctx.translate(Math.round((hash(now) - 0.5) * 4), Math.round((hash(now + 1) - 0.5) * 4));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, PLAY_Y, SCREEN_W, PLAY_H);
  ctx.clip();
  const distancePx = (f.distance / 100) * PLAY_H;
  const offset = ((distancePx % 256) + 256) % 256;
  const tile = ground();
  for (let y = PLAY_Y - 256 + offset; y < SCREEN_H; y += 256) ctx.drawImage(tile, 0, Math.round(y));
  drawDecor(ctx, distancePx);
  const night = f.stage >= 4;
  for (const house of f.houses) drawHouse(ctx, house, now, night);
  // Order coming up just off the top of the screen.
  for (const house of f.houses)
    if (house.customer && house.state === "pending" && pctY(house.y) < PLAY_Y + 4)
      drawText(ctx, house.side === "left" ? `▲${house.number}` : `${house.number}▲`,
        house.side === "left" ? 4 : SCREEN_W - 4, PLAY_Y + 3, "#f8d848",
        { align: house.side === "left" ? "left" : "right", shadow: "#14141c" });
  for (const item of f.scenery) {
    const x = item.side === "left" ? 65 : 191;
    drawSprite(ctx, s[item.kind], x, pctY(item.y), item.side === "right");
  }
  for (const thing of f.things) {
    const sprite = s[thing.type];
    drawSprite(ctx, sprite, laneX(thing.lane), pctY(thing.y), (thing.vx ?? 0) < 0);
    if (DEADLY.has(thing.type) && thing.y < 14 && Math.floor(now / 140) % 2)
      drawText(ctx, "!", laneX(thing.lane), PLAY_Y + 4, "#ff6050", {
        align: "center",
        shadow: "#14141c",
        scale: 2,
      });
  }
  drawPlayer(ctx, f, fx, now);
  for (const t of fx.throws) {
    const p = Math.min(1, (now - t.at) / 320);
    const x = t.fromX + (t.toX - t.fromX) * p,
      y = t.fromY + (t.toY - t.fromY) * p - Math.sin(p * Math.PI) * 14;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    ctx.rotate(Math.round(p * 8) * (Math.PI / 4));
    ctx.drawImage(s.sub, -4, -2);
    ctx.restore();
  }
  for (const part of fx.particles) {
    const t = (now - part.at) / 600;
    const colors = ["#f8d848", "#d8302c", "#9cdc64", "#f4f4ec"];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      ctx.fillStyle = colors[i % 4];
      ctx.fillRect(
        Math.round(part.x + Math.cos(a) * t * 18),
        Math.round(part.y + Math.sin(a) * t * 14 + t * t * 10),
        1,
        1,
      );
    }
  }
  // Time of day: the same street, lunch on Monday through Friday night.
  const tint = [null, "rgba(255,150,60,0.08)", "rgba(255,110,60,0.14)",
    "rgba(20,24,70,0.38)", "rgba(10,12,48,0.52)"][f.stage - 1];
  if (tint) {
    ctx.fillStyle = tint;
    ctx.fillRect(0, PLAY_Y, SCREEN_W, PLAY_H);
  }
  if (night) {
    ctx.globalCompositeOperation = "lighter";
    const x = laneX(f.lane),
      y = pctY(PLAYER_Y) - 12;
    ctx.fillStyle = "rgba(255,240,170,0.16)";
    ctx.beginPath();
    ctx.moveTo(x - 5, y);
    ctx.lineTo(x + 5, y);
    ctx.lineTo(x + 24, y - 70);
    ctx.lineTo(x - 24, y - 70);
    ctx.fill();
    for (const house of f.houses)
      if (house.customer && house.state === "pending") {
        const hx = house.side === "left" ? 51 : SCREEN_W - 51;
        ctx.fillStyle = "rgba(255,220,120,0.22)";
        ctx.fillRect(hx - 6, pctY(house.y) - 12, 12, 12);
      }
    ctx.globalCompositeOperation = "source-over";
  }
  for (const burst of fx.bursts) {
    const t = (now - burst.at) / 900;
    drawText(ctx, burst.text, laneX(f.lane), Math.round(pctY(PLAYER_Y) - 22 - t * 26),
      burst.good ? "#9cdc64" : "#ff6050", { align: "center", shadow: "#14141c" });
  }
  if (fx.toast) {
    const lines = wrapText(fx.toast.text, SCREEN_W - 24).slice(0, 3);
    const h = lines.length * 9 + 6;
    box(ctx, 8, PLAY_Y + 8, SCREEN_W - 16, h);
    lines.forEach((line, i) =>
      drawText(ctx, line, SCREEN_W / 2, PLAY_Y + 12 + i * 9, "#f4f4ec", { align: "center" }),
    );
  }
  if (!overlay.reducedEffects && now - fx.flashAt < 160) {
    ctx.fillStyle = `rgba(255,255,255,${0.5 - (now - fx.flashAt) / 320})`;
    ctx.fillRect(0, PLAY_Y, SCREEN_W, PLAY_H);
  }
  if (overlay.countdown !== null) {
    ctx.fillStyle = "rgba(8,10,24,0.55)";
    ctx.fillRect(0, PLAY_Y, SCREEN_W, PLAY_H);
    box(ctx, 28, 70, 200, 76);
    drawText(ctx, `${f.dayName}`, SCREEN_W / 2, 78, "#f8d848", { align: "center" });
    drawText(ctx, overlay.countdown === 0 ? "GO!" : String(overlay.countdown),
      SCREEN_W / 2, 92, "#f4f4ec", { align: "center", scale: 4, shadow: "#14141c" });
    drawText(ctx, `${f.deliveries} ORDERS · NEED ${f.quota}`, SCREEN_W / 2, 126, "#f4f4ec", {
      align: "center",
    });
    drawText(ctx, `${f.ammo} SUBS IN THE BAG`, SCREEN_W / 2, 135, "#c8c8c0", { align: "center" });
  }
  if (overlay.wrecked) {
    ctx.fillStyle = "rgba(200,20,10,0.28)";
    ctx.fillRect(0, PLAY_Y, SCREEN_W, PLAY_H);
    box(ctx, 48, 98, 160, 26);
    drawText(ctx, overlay.wrecked === "fired" ? "YOU'RE FIRED" : "SHIFT OVER", SCREEN_W / 2, 104,
      "#ff6050", { align: "center", scale: 2, shadow: "#14141c" });
  }
  ctx.restore();
  drawHud(ctx, f);
  ctx.restore();
}

export function porchPoint(side: Side, y: number) {
  return { x: side === "left" ? 52 : SCREEN_W - 52, y: pctY(y) };
}
