import { bossFrame, bossPortrait } from "./art/bosses";
import { ANCHOR_X, HEAD_ICON, playerFrame } from "./art/player";
import { MAX_ENERGY, SCREEN_H, SCREEN_W } from "./constants";
import { BOSSES, SELECT_GRID, WEAPONS } from "./data";
import { drawText, textWidth, wrap } from "./font";
import type { Game } from "./game";
import { drawHBar, drawLives } from "./hud";
import { draw, silhouette, sprite } from "./sprites";
import { tileset } from "./tiles";

/* Menu screens. Everything draws in native 256x240 space. */

function starfield(ctx: CanvasRenderingContext2D, t: number, speed = 1) {
  for (let i = 0; i < 60; i++) {
    const layer = (i % 3) + 1;
    const x = (((i * 97) % SCREEN_W) - ((t * layer * speed) / 2) % SCREEN_W + SCREEN_W) % SCREEN_W;
    const y = (i * 53) % SCREEN_H;
    ctx.fillStyle = layer === 3 ? "#fcfcfc" : layer === 2 ? "#bcbcbc" : "#7c7c7c";
    ctx.fillRect(Math.floor(x), y, layer === 3 ? 2 : 1, 1);
  }
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill = "#000000", border = "#fcfcfc") {
  ctx.fillStyle = border;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#000000";
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = border;
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
  ctx.fillStyle = fill;
  ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
}

function logo(ctx: CanvasRenderingContext2D, text: string, cx: number, y: number, scale: number, main: string, shade: string) {
  const left = cx - textWidth(text, scale) / 2;
  for (const [dx, dy] of [
    [-2, 0],
    [2, 0],
    [0, -2],
    [0, 2],
    [-2, -2],
    [2, 2],
    [-2, 2],
    [2, -2],
    [0, 4],
    [2, 4],
    [-2, 4],
  ])
    drawText(ctx, text, left + dx, y + dy, "#000000", { scale });
  drawText(ctx, text, left, y + 2, shade, { scale });
  drawText(ctx, text, left, y, main, { scale });
}

function playerSprite(weapon = "buster", pose: "idle" | "jump" | "run1" | "run2" | "run3" = "idle", shoot = false) {
  const w = WEAPONS[weapon as keyof typeof WEAPONS] ?? WEAPONS.buster;
  return sprite(`p:${weapon}:${pose}:${shoot}`, playerFrame(pose, shoot), { B: w.primary, b: w.secondary });
}

/* ---------------- title ---------------- */

export function drawTitle(ctx: CanvasRenderingContext2D, game: Game) {
  const t = game.t;
  const river = tileset(BOSSES.goose.theme);
  ctx.drawImage(river.far, -Math.floor(t / 4) % 512, 0);
  ctx.drawImage(river.far, (-Math.floor(t / 4) % 512) + 512, 0);
  const street = tileset(BOSSES.pothole.theme);
  for (let x = 0; x < SCREEN_W; x += 16) {
    ctx.drawImage(street.top, x, 208);
    ctx.drawImage(street.fill, x, 224);
  }
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(0, 0, SCREEN_W, 208);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 16, SCREEN_W, 90);
  logo(ctx, "DELI MAN", SCREEN_W / 2, 26, 4, "#f8b800", "#d82800");
  drawText(ctx, "THE LAST JUMBO", SCREEN_W / 2, 66, "#fcfcfc", { scale: 2, align: "center", shadow: "#d82800" });
  draw(ctx, playerSprite(), 40 - ANCHOR_X, 184);
  // the deli: a little storefront on the right
  ctx.fillStyle = "#000000";
  ctx.fillRect(176, 150, 72, 58);
  ctx.fillStyle = "#c84c0c";
  ctx.fillRect(177, 151, 70, 57);
  for (let i = 0; i < 7; i++) {
    ctx.fillStyle = i % 2 ? "#fcfcfc" : "#d82800";
    ctx.fillRect(176 + i * 10, 146, 10, 10);
  }
  ctx.fillStyle = "#000000";
  ctx.fillRect(176, 156, 72, 1);
  drawText(ctx, "CORNER", 194, 160, "#f8b800");
  drawText(ctx, "DELI", 200, 169, "#f8b800");
  ctx.fillStyle = "#3cbcfc";
  ctx.fillRect(182, 180, 22, 20);
  ctx.fillStyle = "#503000";
  ctx.fillRect(214, 178, 18, 30);
  ctx.fillStyle = "#f8b800";
  ctx.fillRect(228, 192, 2, 2);
  drawText(ctx, "OPEN", 184, 188, "#d82800");

  const hasSave = game.save.defeated.length > 0;
  if (hasSave) {
    const options = [`CONTINUE  ${game.save.defeated.length}/8`, "NEW GAME"];
    options.forEach((label, i) => {
      const y = 154 + i * 14;
      drawText(ctx, label, 96, y, i === game.menu ? "#fcfcfc" : "#7c7c7c", { align: "center", shadow: "#000000" });
      if (i === game.menu && t % 30 < 20) drawText(ctx, ">", 40, y, "#f8b800");
    });
  } else if (t % 40 < 26) drawText(ctx, "PRESS START", SCREEN_W / 2, 120, "#fcfcfc", { align: "center", shadow: "#000000" });
  drawText(ctx, "AN OGDENSBURG, NY DELI PARODY", SCREEN_W / 2, 94, "#a4e4fc", { align: "center", shadow: "#000000" });
  drawText(ctx, "(C) CORNER DELI", SCREEN_W / 2, 230, "#fcfcfc", { align: "center", shadow: "#000000" });
}

/* ---------------- stage select ---------------- */

export const SELECT_CELLS = SELECT_GRID.map((_, i) => ({
  x: 40 + (i % 3) * 60,
  y: 30 + Math.floor(i / 3) * 62,
  w: 56,
  h: 58,
}));

export function drawSelect(ctx: CanvasRenderingContext2D, game: Game) {
  const t = game.t;
  ctx.fillStyle = "#0028a8";
  ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  for (let y = 0; y < SCREEN_H; y += 8) {
    ctx.fillStyle = "#0018a0";
    ctx.fillRect(0, y, SCREEN_W, 4);
  }
  drawText(ctx, "STAGE SELECT", SCREEN_W / 2, 12, "#fcfcfc", { align: "center", shadow: "#000000" });
  SELECT_GRID.forEach((id, i) => {
    const c = SELECT_CELLS[i];
    const def = BOSSES[id];
    const beaten = game.save.defeated.includes(id);
    const center = id === "margin";
    box(ctx, c.x, c.y, c.w, 40, center ? "#202020" : "#000000", "#a4e4fc");
    const px = c.x + c.w / 2 - 16;
    const py = c.y + 8;
    if (center && !game.finalUnlocked) {
      const head = sprite("selectHead", HEAD_ICON);
      ctx.save();
      ctx.translate(px - 2, py - 2);
      ctx.scale(2, 2);
      ctx.drawImage(head.right, 0, 0);
      ctx.restore();
    } else if (!beaten || center) {
      const art = bossPortrait(def.head);
      const s = sprite(`portrait:${id}`, art, { A: def.A, a: def.a, Z: def.Z });
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(2, 2);
      ctx.drawImage(s.right, 0, 0);
      ctx.restore();
    } else {
      drawText(ctx, "CLEAR", c.x + c.w / 2, c.y + 17, "#7c7c7c", { align: "center" });
    }
    const label = center ? (game.finalUnlocked ? "HQ" : "DELI MAN") : def.name.replace(/ MAN$/, "");
    const short = label === "PRICE SLASHER" ? "SLASHER" : label;
    drawText(ctx, short, c.x + c.w / 2, c.y + 43, beaten && !center ? "#7c7c7c" : "#fcfcfc", { align: "center", shadow: "#000000" });
    if (!center) drawText(ctx, "MAN", c.x + c.w / 2, c.y + 51, beaten ? "#7c7c7c" : "#f8b800", { align: "center", shadow: "#000000" });
  });
  // blinking selector corners
  if (t % 16 < 11) {
    const c = SELECT_CELLS[game.cursor];
    ctx.fillStyle = "#f8b800";
    const L = 7;
    for (const [x, y, sx, sy] of [
      [c.x - 3, c.y - 3, 1, 1],
      [c.x + c.w + 2, c.y - 3, -1, 1],
      [c.x - 3, c.y + 42, 1, -1],
      [c.x + c.w + 2, c.y + 42, -1, -1],
    ]) {
      ctx.fillRect(sx > 0 ? x : x - L + 1, y, L, 2);
      ctx.fillRect(x - (sx > 0 ? 0 : 1), sy > 0 ? y : y - L + 1, 2, L);
    }
  }
  const id = SELECT_GRID[game.cursor];
  const def = BOSSES[id];
  const locked = id === "margin" && !game.finalUnlocked;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 216, SCREEN_W, 24);
  drawText(ctx, locked ? "BEAT ALL 8 TO FIND THE KIOSK" : def.stage, SCREEN_W / 2, 220, locked ? "#7c7c7c" : "#f8b800", { align: "center" });
  drawText(ctx, "PRESS START", SCREEN_W / 2, 230, t % 40 < 26 ? "#fcfcfc" : "#7c7c7c", { align: "center" });
}

/* ---------------- boss intro ---------------- */

export function drawBossIntro(ctx: CanvasRenderingContext2D, game: Game) {
  const t = game.t;
  const def = BOSSES[game.bossId];
  starfield(ctx, t, 3);
  if (t < 8 && t % 4 < 2) {
    ctx.fillStyle = "#fcfcfc";
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H);
  }
  ctx.fillStyle = "#0028a8";
  ctx.fillRect(0, 84, SCREEN_W, 72);
  ctx.fillStyle = "#3cbcfc";
  ctx.fillRect(0, 84, SCREEN_W, 2);
  ctx.fillRect(0, 154, SCREEN_W, 2);
  const landY = 112;
  const y = Math.min(landY, -30 + t * 6);
  const pose = y < landY ? "jump" : t % 60 < 30 && t > 60 ? "throw" : "stand";
  const s = sprite(`boss:${def.id}:${pose}`, bossFrame(def.head, pose), { A: def.A, a: def.a, Z: def.Z });
  ctx.save();
  ctx.translate(SCREEN_W / 2 - 24, y - 12);
  ctx.scale(2, 2);
  ctx.drawImage(s.right, 0, 0);
  ctx.restore();
  const name = def.name.slice(0, Math.max(0, Math.floor((t - 50) / 4)));
  drawText(ctx, name, SCREEN_W / 2, 168, "#fcfcfc", { align: "center", scale: 2, shadow: "#d82800" });
  if (t > 110) {
    wrap(def.tagline, 38).forEach((line, i) => drawText(ctx, line, SCREEN_W / 2, 194 + i * 9, "#a4e4fc", { align: "center" }));
  }
  drawText(ctx, def.stage, SCREEN_W / 2, 60, "#f8b800", { align: "center" });
}

/* ---------------- pause ---------------- */

export function pauseLayout(rows: number) {
  const h = 62 + rows * 16;
  return { h, top: Math.max(8, Math.floor((SCREEN_H - h) / 2) - 10) };
}

export function drawPause(ctx: CanvasRenderingContext2D, game: Game) {
  const stage = game.stage!;
  const rows = game.pauseRows();
  const { top, h } = pauseLayout(rows.length);
  box(ctx, 40, top, 176, h, "#000000", "#3cbcfc");
  drawText(ctx, "PAUSE", SCREEN_W / 2, top + 10, "#f8b800", { align: "center" });
  rows.forEach((row, i) => {
    const y = top + 24 + i * 16;
    const active = i === game.menu;
    if (row === "exit") {
      drawText(ctx, "EXIT STAGE", 64, y + 2, active ? "#fcfcfc" : "#7c7c7c");
    } else {
      const w = WEAPONS[row];
      drawText(ctx, w.short.padEnd(2, " "), 64, y + 2, active ? "#fcfcfc" : "#7c7c7c");
      drawHBar(ctx, 84, y + 2, row === "buster" ? stage.player.hp : stage.player.energy[row], row === "buster" ? "#fce0a8" : w.primary, MAX_ENERGY);
      if (active) drawText(ctx, w.name, SCREEN_W / 2, top + 26 + rows.length * 16, "#f8b800", { align: "center" });
    }
    if (active && game.t % 30 < 20) drawText(ctx, ">", 52, y + 2, "#f8b800");
  });
  drawLives(ctx, 54, top + h - 20, game.lives);
  drawText(ctx, "START: RESUME", 204, top + h - 15, "#7c7c7c", { align: "right" });
}

/* ---------------- weapon get ---------------- */

export function drawWeaponGet(ctx: CanvasRenderingContext2D, game: Game) {
  const t = game.t;
  const weapon = game.earned ?? "buster";
  const def = WEAPONS[weapon];
  starfield(ctx, t, 1);
  ctx.fillStyle = "#0028a8";
  ctx.fillRect(0, 60, SCREEN_W, 80);
  ctx.fillStyle = "#3cbcfc";
  ctx.fillRect(0, 60, SCREEN_W, 2);
  ctx.fillRect(0, 138, SCREEN_W, 2);
  const flashing = t < 90 && Math.floor(t / 6) % 2 === 0;
  const s = playerSprite(flashing ? "buster" : weapon, t > 100 && t % 50 < 25 ? "idle" : "idle", t > 100 && t % 50 < 25);
  ctx.save();
  ctx.translate(SCREEN_W / 2 - 24, 76);
  ctx.scale(2, 2);
  ctx.drawImage(s.right, 0, 0);
  ctx.restore();
  if (t > 40) drawText(ctx, "YOU GOT", SCREEN_W / 2, 158, "#fcfcfc", { align: "center", scale: 1 });
  if (t > 60) {
    const shown = def.name.slice(0, Math.floor((t - 60) / 3));
    drawText(ctx, shown, SCREEN_W / 2, 172, "#f8b800", { align: "center", scale: 2, shadow: def.secondary });
  }
  if (t > 110) {
    wrap(def.blurb, 38).forEach((line, i) => drawText(ctx, line, SCREEN_W / 2, 194 + i * 9, "#a4e4fc", { align: "center" }));
    const victim = Object.values(BOSSES).find((b) => b.weakness === weapon && !game.save.defeated.includes(b.id));
    if (victim) drawText(ctx, `TRY IT ON ${victim.name}`, SCREEN_W / 2, 214, "#f8b800", { align: "center" });
  }
  if (t > 120 && t % 40 < 26) drawText(ctx, "PRESS START", SCREEN_W / 2, 228, "#fcfcfc", { align: "center" });
  drawText(ctx, "Q/E OR WPN BUTTON TO SWITCH WEAPONS", SCREEN_W / 2, 30, "#7c7c7c", { align: "center" });
}

/* ---------------- game over ---------------- */

export function drawGameOver(ctx: CanvasRenderingContext2D, game: Game) {
  const t = game.t;
  starfield(ctx, t, 0.3);
  logo(ctx, "GAME OVER", SCREEN_W / 2, 70, 3, "#d82800", "#881400");
  drawText(ctx, "THE LINE IS OUT THE DOOR.", SCREEN_W / 2, 104, "#a4e4fc", { align: "center" });
  if (t > 30) {
    ["CONTINUE", "STAGE SELECT"].forEach((label, i) => {
      const y = 128 + i * 20;
      drawText(ctx, label, SCREEN_W / 2, y, i === game.menu ? "#fcfcfc" : "#7c7c7c", { align: "center" });
      if (i === game.menu && t % 30 < 20) drawText(ctx, ">", SCREEN_W / 2 - 50, y, "#f8b800");
    });
  }
  const dead = silhouette("p:dead", playerFrame("hurt", false), "#4c4c4c");
  draw(ctx, dead, SCREEN_W / 2 - 16, 186);
}

/* ---------------- ending ---------------- */

const ENDING = [
  "DR. MARGIN'S KIOSK WAS RETURNED TO SENDER.",
  "",
  "THE CORNER DELI STAYS OPEN.",
  "THE LAST JUMBO IS SAFE.",
  "",
  "THE POTHOLES ARE STILL THERE.",
  "THE GEESE ARE STILL THERE.",
  "SOMEONE ONLINE IS STILL MAD.",
  "",
  "BUT THE SUBS ARE HOT",
  "AND THE PIZZA IS JUMBO.",
  "",
  "THANK YOU FOR PLAYING",
  "",
  "CORNER DELI - OGDENSBURG, NY",
];

export function drawEnding(ctx: CanvasRenderingContext2D, game: Game) {
  const t = game.t;
  const city = tileset(BOSSES.pothole.theme);
  ctx.drawImage(city.far, -Math.floor(t / 2) % 512, 0);
  ctx.drawImage(city.far, (-Math.floor(t / 2) % 512) + 512, 0);
  for (let x = -16; x < SCREEN_W + 16; x += 16) {
    ctx.drawImage(city.top, x - (t % 16), 208);
    ctx.drawImage(city.fill, x - (t % 16), 224);
  }
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, SCREEN_W, 200);
  const cycle = ["run1", "run2", "run3", "run2"] as const;
  draw(ctx, playerSprite("buster", cycle[Math.floor(t / 7) % 4]), 110, 184);
  const scroll = Math.min(ENDING.length * 12 + 40 - 150, Math.max(0, t - 20) / 2.2);
  ENDING.forEach((line, i) => {
    const y = 210 - scroll + i * 12;
    if (y > -8 && y < 196) drawText(ctx, line, SCREEN_W / 2, y, i >= 12 ? "#f8b800" : "#fcfcfc", { align: "center" });
  });
  if (t > 240 && t % 40 < 26) drawText(ctx, "PRESS START", SCREEN_W / 2, 230, "#fcfcfc", { align: "center", shadow: "#000000" });
}
