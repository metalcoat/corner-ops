// Shared game model for Delivery Boy: simulation types, tuning, and the
// 256×224 screen geometry the renderer and the simulation both use.

export type HazardType =
  | "deer"
  | "dog"
  | "cat"
  | "goose"
  | "raccoon"
  | "mower"
  | "van"
  | "squirrel"
  | "cow"
  | "person"
  | "car"
  | "pothole";
export type Pickup = "boost" | "slow" | "restock";
export type Side = "left" | "right";
export type Thing = {
  id: number;
  type: HazardType | Pickup;
  lane: number;
  y: number;
  /** Multiplier on top of the street scroll (oncoming traffic is faster). */
  speed?: number;
  /** Lanes per second, for animals running across the street. */
  vx?: number;
};
// Paperboy rules: houses that ordered glow and want their food on the porch;
// houses that didn't order can still be hit with a "free sample".
export type House = {
  id: number;
  side: Side;
  y: number;
  customer: boolean;
  number: number;
  address: string;
  item: string;
  look: number;
  state: "pending" | "delivered" | "missed" | "sampled";
  landed?: "porch" | "lawn";
};
export type Scenery = {
  id: number;
  kind: "abandoned" | "tent" | "cart" | "trash";
  side: Side;
  y: number;
};
export type Stats = {
  score: number;
  delivered: number;
  missed: number;
  hits: number;
  combo: number;
  bestCombo: number;
};

// ---- screen geometry (native SNES-ish resolution) ----
export const SCREEN_W = 256;
export const SCREEN_H = 224;
export const HUD_H = 21;
export const PLAY_Y = HUD_H;
export const PLAY_H = SCREEN_H - HUD_H;
export const ROAD_LEFT = 72;
export const ROAD_RIGHT = 184;
export const LANE_PX = (ROAD_RIGHT - ROAD_LEFT) / 2;
export const laneX = (lane: number) => ROAD_LEFT + lane * LANE_PX;
export const pctY = (y: number) => PLAY_Y + (y / 100) * PLAY_H;
export const PLAYER_Y = 84;

// ---- tuning ----
// The driver can roam from curb to curb; hazards stay on the asphalt.
export const LANE_MIN = -0.18;
export const LANE_MAX = 2.18;
export const HAZARD_LANE_MIN = 0.15;
export const HAZARD_LANE_SPAN = 1.7;
export const STEER_RATE = 1.7;
/** Percent of the screen per second, per 100 points of route speed. */
export const SCROLL_RATE = 18;
export const THROW_WINDOW = { start: 58, end: 90 };
export const PORCH_WINDOW = { start: 69, end: 81 };
/** Distance (in screen %) between houses on the same side of the street. */
export const LOT_SPACING = 27;
export const LOT_JITTER = 6;
export const HOUSE_SPAWN_Y = -24;
export const INVULNERABLE_SECONDS = 1.2;
export const WRECK_SECONDS = 1.1;
export const EXTRA_SUBS = 3;
export const RESTOCK_SUBS = 3;
export const SUBS_LEFT_BONUS = 50;
export const CONDITION_BONUS_PER_POINT = 150;
export const PERFECT_SHIFT_BONUS = 1000;
export const SAMPLE_POINTS = 75;
export const DEADLY = new Set<Thing["type"]>([
  "car",
  "van",
  "cow",
  "person",
  "mower",
]);
export const PICKUPS = new Set<Thing["type"]>(["boost", "slow", "restock"]);
export const CRITTERS = new Set<Thing["type"]>([
  "dog",
  "cat",
  "squirrel",
  "raccoon",
  "goose",
  "deer",
]);
export const inThrowWindow = (y: number) =>
  y >= THROW_WINDOW.start && y <= THROW_WINDOW.end;

/** One street per weekday; the neighbourhood stays the same all week. */
export const STREETS = [
  "JAY ST",
  "PROCTOR AVE",
  "KNOX ST",
  "STATE ST",
  "FORD ST",
] as const;

export function collisionRadius(type: Thing["type"]) {
  switch (type) {
    case "car":
    case "van":
      return 0.36;
    case "cow":
      return 0.29;
    case "deer":
      return 0.21;
    case "mower":
      return 0.2;
    case "goose":
      return 0.15;
    case "dog":
    case "person":
      return 0.13;
    case "cat":
    case "raccoon":
      return 0.11;
    case "squirrel":
      return 0.07;
    default:
      return 0.18;
  }
}

/** Cosmetic effects the renderer animates; times are performance.now() ms. */
export type Fx = {
  toast: { text: string; at: number } | null;
  bursts: { id: number; text: string; good: boolean; at: number }[];
  throws: {
    id: number;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
    at: number;
  }[];
  particles: { id: number; x: number; y: number; at: number }[];
  shakeAt: number;
  flashAt: number;
  skidAt: number;
};
export const freshFx = (): Fx => ({
  toast: null,
  bursts: [],
  throws: [],
  particles: [],
  shakeAt: -1e9,
  flashAt: -1e9,
  skidAt: -1e9,
});
