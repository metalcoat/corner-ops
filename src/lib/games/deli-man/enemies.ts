import {
  CART_A,
  CART_B,
  DEER_A,
  DEER_B,
  GOOSE_A,
  GOOSE_B,
  HARDHAT_CLOSED,
  HARDHAT_OPEN,
  HOPPER_JUMP,
  HOPPER_SIT,
  TURRET_CLOSED,
  TURRET_OPEN,
} from "./art/enemies";
import { makeBody, type Enemy, type EnemyKind } from "./entities";
import { moveBody } from "./physics";
import { draw, silhouette, sprite } from "./sprites";
import type { Stage } from "./stage";

const BUBBLE_ART = [
  ".KKKKKKKK.",
  "KWWWWWWWWK",
  "KWKWKWKWWK",
  "KWWWWWWWWK",
  ".KKKWKKKK.",
  "....KK....",
];

type Spec = { w: number; h: number; hp: number; contact: number };

const SPECS: Record<EnemyKind, Spec> = {
  M: { w: 16, h: 13, hp: 1, contact: 3 },
  F: { w: 16, h: 11, hp: 1, contact: 3 },
  T: { w: 15, h: 14, hp: 3, contact: 3 },
  P: { w: 16, h: 12, hp: 2, contact: 3 },
  C: { w: 15, h: 14, hp: 3, contact: 4 },
  R: { w: 20, h: 14, hp: 2, contact: 4 },
  m: { w: 10, h: 6, hp: 1, contact: 2 },
};

export function spawnEnemy(stage: Stage, kind: EnemyKind, x: number, y: number, spawnId = -1): Enemy {
  const spec = SPECS[kind];
  const enemy: Enemy = {
    ...makeBody(x + (16 - spec.w) / 2, y + 16 - spec.h, spec.w, spec.h),
    kind,
    hp: spec.hp,
    facing: stage.player.cx < x + 8 ? -1 : 1,
    t: 0,
    state: 0,
    baseY: y,
    flash: 0,
    shielded: kind === "M" || kind === "T",
    spawnId,
    dead: false,
    contact: spec.contact,
  };
  if (kind === "F") enemy.vx = enemy.facing * 0.9;
  if (kind === "C") enemy.vx = enemy.facing * 1.3;
  stage.enemies.push(enemy);
  return enemy;
}

function towardPlayer(stage: Stage, e: Enemy): 1 | -1 {
  return stage.player.cx < e.x + e.w / 2 ? -1 : 1;
}

function aimAt(stage: Stage, x: number, y: number, speed: number) {
  const dx = stage.player.cx - x;
  const dy = stage.player.y + 10 - y;
  const d = Math.hypot(dx, dy) || 1;
  return { vx: (dx / d) * speed, vy: (dy / d) * speed };
}

export function updateEnemy(stage: Stage, e: Enemy) {
  e.t++;
  if (e.flash > 0) e.flash--;
  const p = stage.player;
  const dist = Math.abs(p.cx - (e.x + e.w / 2));
  switch (e.kind) {
    case "M": {
      // Hard-hat health inspector: hides under the hat, peeks, fires a spread.
      e.facing = towardPlayer(stage, e);
      if (e.state === 0) {
        e.shielded = true;
        if (e.t > 50 && dist < 100) {
          e.state = 1;
          e.t = 0;
        }
      } else {
        e.shielded = false;
        if (e.t === 10) {
          for (const vy of [-1, 0, 1])
            stage.fireBullet("pellet", e.x + e.w / 2 - 2, e.y + 6, e.facing * 2, vy * 0.9);
        }
        if (e.t > 44) {
          e.state = 0;
          e.t = 0;
        }
      }
      e.vy = Math.min(e.vy + 0.25, 6);
      moveBody(stage.level, e);
      break;
    }
    case "F": {
      e.x += e.vx;
      e.y = e.baseY + Math.sin(e.t / 14) * 14;
      e.facing = e.vx < 0 ? -1 : 1;
      break;
    }
    case "T": {
      e.facing = towardPlayer(stage, e);
      const cycle = e.t % 120;
      e.shielded = cycle < 60;
      if (cycle === 80 && dist < 180) {
        const v = aimAt(stage, e.x + e.w / 2, e.y + 6, 1.8);
        stage.fireBullet("pellet", e.x + (e.facing < 0 ? -2 : e.w - 2), e.y + 5, v.vx, v.vy);
      }
      e.vy = Math.min(e.vy + 0.25, 6);
      moveBody(stage.level, e);
      break;
    }
    case "P": {
      if (e.grounded) {
        e.vx = 0;
        e.state++;
        if (e.state > 40) {
          e.state = 0;
          e.facing = towardPlayer(stage, e);
          e.vx = e.facing * 1.2;
          e.vy = e.t % 2 ? -5 : -3.5;
          e.grounded = false;
        }
      }
      e.vy = Math.min(e.vy + 0.25, 6);
      moveBody(stage.level, e);
      break;
    }
    case "C": {
      e.vy = Math.min(e.vy + 0.3, 6);
      const r = moveBody(stage.level, e);
      if (r.wall) {
        e.vx = -e.vx;
        e.x += e.vx;
      }
      e.facing = e.vx < 0 ? -1 : 1;
      break;
    }
    case "R": {
      if (e.state === 0) {
        e.facing = towardPlayer(stage, e);
        if (dist < 150) {
          e.state = 1;
          e.vx = e.facing * 3;
          stage.sfx("honk");
        }
      }
      e.vy = Math.min(e.vy + 0.3, 6);
      moveBody(stage.level, e);
      break;
    }
    case "m": {
      const v = aimAt(stage, e.x + e.w / 2, e.y + e.h / 2, 0.9);
      e.x += v.vx;
      e.y += v.vy;
      e.facing = v.vx < 0 ? -1 : 1;
      break;
    }
  }
  if (e.y > 260) e.dead = true;
}

export function drawEnemy(ctx: CanvasRenderingContext2D, stage: Stage, e: Enemy) {
  const x = Math.round(e.x - stage.camX);
  const y = Math.round(e.y + stage.shakeY);
  const left = e.facing < 0;
  const anim = Math.floor(e.t / 8) % 2 === 0;
  const pick = (key: string, rows: string[], overrides: Record<string, string> = {}) =>
    e.flash > 0 && e.flash % 4 < 2 ? silhouette(key, rows, "#fcfcfc") : sprite(key, rows, overrides);
  switch (e.kind) {
    case "M":
      draw(ctx, e.state === 0 ? pick("hhC", HARDHAT_CLOSED) : pick("hhO", HARDHAT_OPEN), x, y + e.h - 16, !left);
      break;
    case "F":
      draw(ctx, anim ? pick("gooseA", GOOSE_A) : pick("gooseB", GOOSE_B), x, y - 1, !left);
      break;
    case "T":
      draw(ctx, e.shielded ? pick("turC", TURRET_CLOSED) : pick("turO", TURRET_OPEN), x - 1, y - 1, !left);
      break;
    case "P":
      draw(ctx, e.grounded ? pick("hopS", HOPPER_SIT) : pick("hopJ", HOPPER_JUMP), x, y + e.h - 14, !left);
      break;
    case "C":
      draw(ctx, anim ? pick("cartA", CART_A) : pick("cartB", CART_B), x, y + e.h - 15, !left);
      break;
    case "R":
      draw(ctx, anim || e.state === 0 ? pick("deerA", DEER_A) : pick("deerB", DEER_B), x, y + e.h - 16, !left);
      break;
    case "m":
      draw(ctx, pick("bubble", BUBBLE_ART), x, y, false);
      break;
  }
}
