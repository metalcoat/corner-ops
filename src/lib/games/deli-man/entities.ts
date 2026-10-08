import type { WeaponId } from "./data";
import type { Body } from "./physics";

export type ShotKind =
  | "pellet"
  | "mid"
  | "jumbo"
  | "patch"
  | "puddle"
  | "plow"
  | "antler"
  | "honk"
  | "coupon"
  | "ban"
  | "slash";

/** A projectile fired by Deli Man. */
export type Shot = Body & {
  kind: ShotKind;
  weapon: WeaponId;
  charge: number;
  dmg: number;
  pierce: boolean;
  t: number;
  life: number;
  facing: 1 | -1;
  dead: boolean;
  deflected: boolean;
  hit: Set<object>;
};

export type BulletKind =
  | "pellet"
  | "asphalt"
  | "crack"
  | "snowball"
  | "icicle"
  | "antler"
  | "egg"
  | "coupon"
  | "bubble"
  | "thumb"
  | "beam"
  | "percent"
  | "slashwave"
  | "coin";

/** A hostile projectile. */
export type Bullet = Body & {
  kind: BulletKind;
  dmg: number;
  t: number;
  life: number;
  gravity: number;
  dead: boolean;
  /** Generic per-kind scratch values. */
  a: number;
  b: number;
};

export type EnemyKind = "M" | "F" | "T" | "P" | "C" | "R" | "m";

export type Enemy = Body & {
  kind: EnemyKind;
  hp: number;
  facing: 1 | -1;
  t: number;
  state: number;
  baseY: number;
  flash: number;
  shielded: boolean;
  spawnId: number;
  dead: boolean;
  contact: number;
};

export type ItemKind = "e" | "E" | "w" | "W" | "U";

export type Item = Body & {
  kind: ItemKind;
  /** Frames left before a dropped item vanishes, or -1 for placed items. */
  ttl: number;
  placedId: number;
  dead: boolean;
};

export type EffectKind = "explode" | "orb" | "spark" | "dust" | "text" | "charge";

export type Effect = {
  kind: EffectKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  t: number;
  life: number;
  text?: string;
  color?: string;
};

export function makeBody(x: number, y: number, w: number, h: number): Body {
  return { x, y, w, h, vx: 0, vy: 0, grounded: false };
}
