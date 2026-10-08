import { ENEMY_SHOT } from "./art/enemies";
import { makeBody, type Bullet, type BulletKind } from "./entities";
import { moveBody } from "./physics";
import { draw, sprite } from "./sprites";
import type { Stage } from "./stage";

const ART: Partial<Record<BulletKind, string[]>> = {
  pellet: ENEMY_SHOT,
  asphalt: ["..KKKK..", ".KddddK.", "KddoddK.", "KdddddoK", "KdoddddK", ".KddddK.", "..KKKK.."],
  snowball: ["..KKKK..", ".KWWWWK.", "KWWLWWWK", "KWWWWWLK", "KLWWWWWK", "KWWWLWWK", ".KWWWWK.", "..KKKK.."],
  icicle: ["KKKKKKKK", "KLLWWLLK", ".KLWWLK.", ".KLWWLK.", ".KLWLK..", "..KWLK..", "..KLLK..", "..KLK...", "...KK...", "...K...."],
  antler: [".KK.....", "KNNK.KK.", ".KNNKNNK", "..KNNNK.", "..KNNNK.", ".KNNK...", "KNNK....", ".KK....."],
  egg: ["..KKKK..", ".KWWWWK.", "KWWWWWWK", "KWWyWWWK", "KWWWWyWK", "KWyWWWWK", ".KWWWWK.", "..KKKK.."],
  coupon: ["KKKKKKKKKKKK", "KGYGYGYGYGGK", "KYGGKKKKGGYK", "KGGGKKKKGGGK", "KYGYGYGYGYGK", "KKKKKKKKKKKK"],
  bubble: [".KKKKKK.", "KWWWWWWK", "KWWKKWWK", "KWWKKWWK", "KWWWWWWK", "KWWKKWWK", ".KKKKKK.", "..KK...."],
  thumb: ["..KKKK....", ".KCCCCKKK.", "KCLCCCCCCK", "KCCCCCCCCK", "KCCCCCCCK.", ".KCCKKKK..", ".KCCK.....", ".KCCK.....", "..KK......"],
  percent: ["KK.....KK.", "KYK...KYK.", "KK...KYK..", "....KYK...", "...KYK....", "..KYK...KK", ".KYK...KYK", ".KK.....KK"],
  coin: ["..KKKK..", ".KYYYYK.", "KYyKKYYK", "KYKYYYYK", "KYYKKYYK", "KYYYYKYK", ".KYKKYK.", "..KKKK.."],
};

export function makeBullet(
  kind: BulletKind,
  x: number,
  y: number,
  vx: number,
  vy: number,
  opts: Partial<Bullet> = {},
): Bullet {
  const art = ART[kind];
  const w = opts.w ?? (art ? art[0].length - 2 : 6);
  const h = opts.h ?? (art ? art.length - 2 : 6);
  return {
    ...makeBody(x, y, w, h),
    vx,
    vy,
    kind,
    dmg: kind === "crack" ? 4 : 3,
    t: 0,
    life: 400,
    gravity: 0,
    dead: false,
    a: 0,
    b: 0,
    ...opts,
  };
}

export function updateBullet(stage: Stage, b: Bullet) {
  b.t++;
  if (b.t > b.life) b.dead = true;
  const p = stage.player;
  switch (b.kind) {
    case "asphalt":
    case "snowball":
    case "coin": {
      b.vy = Math.min(b.vy + b.gravity, 7);
      const r = moveBody(stage.level, b, { ladderTops: false });
      if (r.landed || r.wall || r.ceiling) {
        b.dead = true;
        stage.addEffect("spark", b.x + b.w / 2, b.y + b.h);
      }
      break;
    }
    case "egg": {
      b.vy = Math.min(b.vy + b.gravity, 6);
      const r = moveBody(stage.level, b, { ladderTops: false });
      if (r.landed) {
        b.dead = true;
        stage.fireBullet("pellet", b.x, b.y + 2, -2, -1.5, { gravity: 0 });
        stage.fireBullet("pellet", b.x, b.y + 2, 2, -1.5, { gravity: 0 });
        stage.sfx("hit");
      }
      break;
    }
    case "crack":
      b.x += b.vx;
      if (b.t % 6 === 0) stage.addEffect("dust", b.x + b.w / 2, b.y + b.h);
      if (b.x < stage.room().left - 4 || b.x + b.w > stage.room().right + 4) b.dead = true;
      break;
    case "icicle":
      if (b.t > b.a) {
        b.vy = Math.min(b.vy + 0.3, 7);
        const r = moveBody(stage.level, b, { ladderTops: false });
        if (r.landed) {
          b.dead = true;
          stage.addEffect("spark", b.x + 4, b.y + b.h);
        }
      }
      break;
    case "coupon":
      if (b.a !== 0) {
        // boomerang: slows, turns and comes back the other way
        b.vx -= b.a * 0.09;
        b.y += Math.sin(b.t / 8) * 0.6;
      } else b.y += b.vy;
      b.x += b.vx;
      break;
    case "thumb": {
      if (b.t < 120) {
        const dx = p.cx - (b.x + b.w / 2);
        const dy = p.y + 10 - (b.y + b.h / 2);
        const d = Math.hypot(dx, dy) || 1;
        b.vx += (dx / d) * 0.06;
        b.vy += (dy / d) * 0.06;
        const s = Math.hypot(b.vx, b.vy) || 1;
        const max = 1.7;
        if (s > max) {
          b.vx = (b.vx / s) * max;
          b.vy = (b.vy / s) * max;
        }
      }
      b.x += b.vx;
      b.y += b.vy;
      break;
    }
    case "beam":
      break;
    case "slashwave": {
      const boss = stage.boss;
      if (!boss || boss.state !== "slash") {
        b.dead = true;
        break;
      }
      b.x = boss.facing > 0 ? boss.x + boss.w - 4 : boss.x - b.w + 4;
      b.y = boss.y;
      b.a = boss.facing;
      break;
    }
    default:
      b.vy += b.gravity;
      b.x += b.vx;
      b.y += b.vy;
  }
  if (b.x + b.w < stage.camX - 24 || b.x > stage.camX + 280 || b.y > 250 || b.y < -80) b.dead = true;
}

const SLASH_WAVE = [
  "....KKKK..............",
  "..KKWWWWKK............",
  ".KWWRRRRWWK...........",
  "KWRRK..KRRWK..........",
  "KWRK.....KRWK.........",
  "KWK.......KRWK........",
  "KWK........KRWK.......",
  ".K..........KRK.......",
];

export function drawBullet(ctx: CanvasRenderingContext2D, stage: Stage, b: Bullet) {
  const x = Math.round(b.x - stage.camX);
  const y = Math.round(b.y + stage.shakeY);
  const blink = stage.frame % 4 < 2;
  switch (b.kind) {
    case "crack": {
      ctx.fillStyle = "#000000";
      ctx.fillRect(x, y + 2, b.w, b.h - 2);
      ctx.fillStyle = blink ? "#f87858" : "#f8b800";
      for (let i = 0; i < b.w; i += 4) ctx.fillRect(x + i, y + 4 + ((i / 4) % 2) * 2, 3, 2);
      ctx.fillStyle = "#4c4c4c";
      ctx.fillRect(x + 2, y, 4, 3);
      ctx.fillRect(x + 9, y + 1, 4, 2);
      break;
    }
    case "beam": {
      ctx.fillStyle = blink ? "#fcfcfc" : "#3cbcfc";
      ctx.fillRect(x, y, b.w, b.h);
      ctx.fillStyle = "#0028a8";
      ctx.fillRect(x, y + 3, b.w, 3);
      break;
    }
    case "slashwave":
      if (b.t % 4 < 3) draw(ctx, sprite("bossSlash", SLASH_WAVE), x, y + 4, b.a < 0);
      break;
    case "icicle":
      draw(ctx, sprite("b:icicle", ART.icicle!), x - 1 + (b.t < b.a && b.t % 4 < 2 ? 1 : 0), y - 1);
      break;
    default: {
      const art = ART[b.kind];
      if (!art) break;
      const spin = b.kind === "coupon" || b.kind === "percent" || b.kind === "antler";
      draw(ctx, sprite(`b:${b.kind}`, art), x - 1, y - 1, spin ? stage.frame % 8 < 4 : b.vx > 0);
    }
  }
}
