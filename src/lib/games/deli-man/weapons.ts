import { PELLET, SUB_JUMBO, SUB_MID, GOOSE_A } from "./art/enemies";
import { SCREEN_W } from "./constants";
import { WEAPONS, type WeaponId } from "./data";
import { makeBody, type Shot, type ShotKind } from "./entities";
import type { Input } from "./input";
import { moveBody } from "./physics";
import { draw, sprite } from "./sprites";
import type { Player } from "./player";
import type { Stage } from "./stage";

export const CHARGE_1 = 28;
export const CHARGE_2 = 78;

const PATCH_ART = ["..KKKK..", ".KddddK.", "KddoddK.", "KdddddoK", "KdoddddK", ".KddddK.", "..KKKK.."];
const PUDDLE_ART = ["..KKKKKKKKKKKK..", ".KddoddddddoddK.", "KdddddoddddddddK", "KKKKKKKKKKKKKKKK"];
const PLOW_ART = [
  "........KK......",
  "......KKLLK.....",
  ".....KLWWWLK....",
  "....KLWWWWWLK...",
  "...KLWWWWWWWLK..",
  "..KLWWWLWWWWWLK.",
  "..KWWWWWWWLWWWK.",
  ".KLWWLWWWWWWWWLK",
  ".KWWWWWWWWLWWWWK",
  "KLWWWWWLWWWWWWWK",
  "KWWWLWWWWWWWLWWK",
  "KKKKKKKKKKKKKKKK",
];
const COUPON_ART = ["KKKKKKKKKK", "KGYGYGYGGK", "KYGKKKGGYK", "KGGKKKGGGK", "KYGYGYGYGK", "KKKKKKKKKK"];
const HAMMER_ART = [
  "KKKKKKKKKK....",
  "KCCCCCCCCK....",
  "KCLLLLLLCK....",
  "KCCCCCCCCK....",
  "KKKKKKKKKK....",
  "....KNNK......",
  "....KNNK......",
  "....KNNK......",
  "....KNNK......",
  "....KnnK......",
  "....KKKK......",
];
const SLASH_ART = [
  "........KKKKK...........",
  ".....KKKWWWWWKK.........",
  "...KKWWWRRRRRWWK........",
  "..KWWRRK.....KRWK.......",
  ".KWRRK........KRWK......",
  ".KWRK..........KRWK.....",
  "KWRK............KRWK....",
  "KWRK.............KRK....",
  "KWK..............KRWK...",
  "KWK...............KRK...",
];

/** Weapons that ignore hard-hat style shields. */
export const SHIELD_PIERCING: ShotKind[] = ["plow", "puddle", "ban", "slash"];

const LIMITS: Partial<Record<WeaponId, number>> = {
  buster: 3,
  patch: 2,
  plow: 1,
  antler: 3,
  honk: 2,
  coupon: 1,
  ban: 1,
  slash: 1,
};

function countShots(stage: Stage, weapon: WeaponId) {
  return stage.shots.filter((s) => s.weapon === weapon && !s.dead && s.kind !== "puddle").length;
}

function makeShot(
  stage: Stage,
  player: Player,
  kind: ShotKind,
  w: number,
  h: number,
  overrides: Partial<Shot> = {},
): Shot {
  const muzzle = player.muzzle();
  const shot: Shot = {
    ...makeBody(muzzle.x - w / 2, muzzle.y - h / 2, w, h),
    kind,
    weapon: player.weapon,
    charge: 0,
    dmg: 1,
    pierce: false,
    t: 0,
    life: 600,
    facing: player.facing,
    dead: false,
    deflected: false,
    hit: new Set(),
    ...overrides,
  };
  stage.shots.push(shot);
  player.shootPose = 16;
  return shot;
}

/** Handles the shoot button for the equipped weapon (incl. buster charging). */
export function handleFire(stage: Stage, player: Player, input: Input) {
  const weapon = player.weapon;
  const f = player.facing;
  if (weapon === "buster") {
    if (input.pressed("shoot") && countShots(stage, "buster") < 3) {
      makeShot(stage, player, "pellet", 6, 6, { vx: 4.5 * f });
      stage.sfx("shoot");
    }
    if (input.held("shoot")) {
      player.charge++;
      if (player.charge === CHARGE_1) stage.sfx("charge");
      if (player.charge > CHARGE_2 && player.charge % 10 === 0) stage.sfx("chargeHum");
    } else if (player.charge > 0) {
      if (player.charge >= CHARGE_2) {
        makeShot(stage, player, "jumbo", 22, 10, { vx: 5 * f, dmg: 3, charge: 2 });
        stage.sfx("bigShot");
      } else if (player.charge >= CHARGE_1) {
        makeShot(stage, player, "mid", 10, 6, { vx: 5 * f, dmg: 2, charge: 1 });
        stage.sfx("midShot");
      }
      player.charge = 0;
    }
    return;
  }
  player.charge = 0;
  if (!input.pressed("shoot")) return;
  const def = WEAPONS[weapon];
  if (player.energy[weapon] < def.cost) {
    stage.sfx("tink");
    return;
  }
  if (weapon === "manager") {
    if (stage.flash > 0) return;
    player.energy[weapon] -= def.cost;
    player.shootPose = 20;
    stage.managerCall();
    return;
  }
  if (countShots(stage, weapon) >= (LIMITS[weapon] ?? 1)) return;
  player.energy[weapon] -= def.cost;
  switch (weapon) {
    case "patch":
      makeShot(stage, player, "patch", 8, 7, { vx: 2.4 * f, vy: -4.2, dmg: 2 });
      stage.sfx("midShot");
      break;
    case "plow": {
      const s = makeShot(stage, player, "plow", 16, 12, { vx: 0, vy: 0, dmg: 2, pierce: true });
      s.y = player.y + player.h - s.h;
      s.x = f > 0 ? player.x + player.w : player.x - s.w;
      stage.sfx("bigShot");
      break;
    }
    case "antler":
      for (const vy of [-1.4, 0, 1.4]) makeShot(stage, player, "antler", 6, 6, { vx: 4 * f, vy, dmg: 1 });
      stage.sfx("shoot");
      break;
    case "honk":
      makeShot(stage, player, "honk", 14, 10, { vx: 2.6 * f, dmg: 2, life: 160 });
      stage.sfx("honk");
      break;
    case "coupon":
      makeShot(stage, player, "coupon", 10, 6, { vx: 5 * f, dmg: 2, pierce: true, life: 160 });
      stage.sfx("shoot");
      break;
    case "ban":
      makeShot(stage, player, "ban", 12, 12, { vx: 2.4 * f, vy: -5.2, dmg: 3, pierce: true });
      stage.sfx("midShot");
      break;
    case "slash":
      makeShot(stage, player, "slash", 24, 22, { dmg: 3, pierce: true, life: 12 });
      stage.sfx("midShot");
      break;
  }
}

export function updateShot(stage: Stage, shot: Shot) {
  shot.t++;
  if (shot.t > shot.life) shot.dead = true;
  const player = stage.player;
  if (shot.deflected) {
    shot.x += shot.vx;
    shot.y += shot.vy;
  } else
    switch (shot.kind) {
      case "patch": {
        shot.vy = Math.min(shot.vy + 0.25, 6);
        const hit = moveBody(stage.level, shot, { ladderTops: false });
        if (hit.landed) {
          shot.kind = "puddle";
          shot.y += shot.h - 4;
          shot.x -= 4;
          shot.w = 16;
          shot.h = 4;
          shot.pierce = true;
          shot.life = shot.t + 90;
          stage.sfx("thud");
        } else if (hit.wall) shot.dead = true;
        break;
      }
      case "puddle":
        break;
      case "plow": {
        if (shot.grounded) shot.vx = 3 * shot.facing;
        shot.vy = Math.min(shot.vy + 0.35, 6);
        const hit = moveBody(stage.level, shot, { ladderTops: true });
        if (hit.wall) shot.dead = true;
        if (shot.t % 6 === 0) stage.addEffect("dust", shot.x + shot.w / 2, shot.y + shot.h);
        break;
      }
      case "honk": {
        const target = stage.nearestTarget(shot.x + shot.w / 2, shot.y + shot.h / 2);
        if (target && shot.t > 8) {
          const dx = target.x - (shot.x + shot.w / 2);
          const dy = target.y - (shot.y + shot.h / 2);
          const d = Math.hypot(dx, dy) || 1;
          shot.vx += (dx / d) * 0.35;
          shot.vy += (dy / d) * 0.35;
          const speed = Math.hypot(shot.vx, shot.vy) || 1;
          shot.vx = (shot.vx / speed) * 3;
          shot.vy = (shot.vy / speed) * 3;
        }
        shot.x += shot.vx;
        shot.y += shot.vy;
        break;
      }
      case "coupon": {
        if (shot.t < 18) {
          shot.vx -= 0.28 * shot.facing;
        } else {
          const dx = player.x + player.w / 2 - (shot.x + shot.w / 2);
          const dy = player.y + 10 - (shot.y + shot.h / 2);
          const d = Math.hypot(dx, dy) || 1;
          shot.vx = (dx / d) * 4.5;
          shot.vy = (dy / d) * 4.5;
          if (d < 10) shot.dead = true;
        }
        shot.x += shot.vx;
        shot.y += shot.vy;
        break;
      }
      case "ban":
        shot.vy = Math.min(shot.vy + 0.25, 6);
        shot.x += shot.vx;
        shot.y += shot.vy;
        break;
      case "slash": {
        const m = player.muzzle();
        shot.x = player.facing > 0 ? player.x + player.w - 4 : player.x - shot.w + 4;
        shot.y = m.y - 14;
        shot.facing = player.facing;
        break;
      }
      default:
        shot.x += shot.vx;
        shot.y += shot.vy;
    }
  if (shot.x + shot.w < stage.camX - 8 || shot.x > stage.camX + SCREEN_W + 8 || shot.y > 260 || shot.y < -60)
    shot.dead = true;
}

export function drawShot(ctx: CanvasRenderingContext2D, stage: Stage, shot: Shot) {
  const x = shot.x - stage.camX;
  const y = shot.y + stage.shakeY;
  const left = shot.facing < 0;
  const blink = stage.frame % 4 < 2;
  switch (shot.kind) {
    case "pellet":
      draw(ctx, sprite("pellet", PELLET), x, y);
      break;
    case "antler":
      draw(ctx, sprite("antlerShot", PELLET, { G: "#ac7c00", y: "#fce0a8" }), x, y);
      break;
    case "mid":
      draw(ctx, sprite("subMid", SUB_MID), x, y - 0, left);
      break;
    case "jumbo":
      draw(ctx, blink ? sprite("subJumbo", SUB_JUMBO) : sprite("subJumbo2", SUB_JUMBO, { y: "#fcfcfc", T: "#f8b800" }), x, y - 1, left);
      break;
    case "patch":
      draw(ctx, sprite("patch", PATCH_ART), x, y);
      break;
    case "puddle":
      if (shot.life - shot.t > 20 || blink) draw(ctx, sprite("puddle", PUDDLE_ART), x, y);
      break;
    case "plow":
      draw(ctx, sprite("plow", PLOW_ART), x, y, left);
      break;
    case "honk":
      draw(ctx, sprite("honk", GOOSE_A), x - 1, y - 1, shot.vx > 0);
      break;
    case "coupon":
      draw(ctx, sprite("couponShot", COUPON_ART), x, y, stage.frame % 8 < 4);
      break;
    case "ban": {
      ctx.save();
      ctx.translate(Math.round(x + 6), Math.round(y + 6));
      ctx.rotate(Math.floor(shot.t / 4) * (Math.PI / 2) * shot.facing);
      ctx.drawImage(sprite("hammer", HAMMER_ART).right, -7, -6);
      ctx.restore();
      break;
    }
    case "slash":
      if (shot.t < 10) draw(ctx, sprite("slash", SLASH_ART), x, y, left);
      break;
  }
}
