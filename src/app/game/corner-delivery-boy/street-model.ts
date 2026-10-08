// Shared game model for Delivery Boy: simulation types, tuning, and the
// 544×576 screen geometry the renderer and the simulation both use.

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
  | "pothole"
  | "ebike"
  | "tarpcar"
  | "parked"
  | "racer";
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
  /** Pothole size (0.6–1.6) or e-bike weave phase / car paint variant. */
  size?: number;
  phase?: number;
  variant?: number;
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
  /** What stands on the lot; fixed per address so a street looks the same every run. */
  kind: LotKind;
  seed: number;
  state: "pending" | "delivered" | "missed" | "sampled";
  landed?: "porch" | "lawn";
};
export type LotKind =
  | "victorian"
  | "foursquare"
  | "ranch"
  | "duplex"
  | "trailer"
  | "brick"
  | "vacant"
  | "minimart"
  | "dollar"
  | "church";
export const RESIDENTIAL = new Set<LotKind>([
  "victorian",
  "foursquare",
  "ranch",
  "duplex",
  "trailer",
  "brick",
]);
export type Scenery = {
  id: number;
  kind: "abandoned" | "tent" | "cart" | "trash" | "dumpster" | "pole" | "sign";
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

// ---- screen geometry (544×576) ----
export const SCREEN_W = 544;
export const SCREEN_H = 576;
export const HUD_H = 40;
export const PLAY_Y = HUD_H;
export const PLAY_H = SCREEN_H - HUD_H;
// Lots | sidewalk | curb | a two-lane road wide enough for two cars to pass
// (parked cars narrow it) | curb | sidewalk | lots.
export const LOT_SPAN = 116;
export const ROAD_LEFT = 136;
export const ROAD_RIGHT = 408;
export const SIDEWALK = { left: [116, 132], right: [412, 428] } as const;
export const LANE_PX = (ROAD_RIGHT - ROAD_LEFT) / 2;
export const laneX = (lane: number) => ROAD_LEFT + lane * LANE_PX;
export const pctY = (y: number) => PLAY_Y + (y / 100) * PLAY_H;
/** The car sits low on the screen so you can see plenty of road ahead. */
export const PLAYER_Y = 86;

// ---- tuning ----
// The driver can roam from curb to curb; hazards stay on the asphalt.
export const LANE_MIN = -0.12;
export const LANE_MAX = 2.12;
/** You drive in the right lane; oncoming traffic keeps to the left lane. */
export const START_LANE = 1.5;
export const ONCOMING_LANE = { min: 0.44, max: 0.58 };
/** Where parked cars sit against each curb (tyres at the curb). */
export const PARKED_LANE = { left: 0.12, right: 1.88 };
export const HAZARD_LANE_MIN = 0.15;
export const HAZARD_LANE_SPAN = 1.7;
export const STEER_RATE = 1.7;
/** Percent of the screen per second, per 100 points of route speed. */
export const SCROLL_RATE = 13.7;
export const THROW_WINDOW = { start: 58, end: 90 };
export const PORCH_WINDOW = { start: 69, end: 81 };
/** Distance (in screen %) between houses on the same side of the street. */
export const LOT_SPACING = 25;
export const LOT_JITTER = 6;
export const HOUSE_SPAWN_Y = -12;
export const INVULNERABLE_SECONDS = 1.2;
export const WRECK_SECONDS = 1.1;
export const EXTRA_SUBS = 3;
export const RESTOCK_SUBS = 3;
export const SUBS_LEFT_BONUS = 50;
export const CONDITION_BONUS_PER_POINT = 150;
export const PERFECT_SHIFT_BONUS = 1000;
export const SAMPLE_POINTS = 75;
export const DEADLY = new Set<Thing["type"]>([
  "racer",
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

/**
 * How close (in lanes, 136 px each) a thing's centre must be to the car's
 * centre to touch it: half its drawn width plus most of the car's half-width.
 */
export function collisionRadius(type: Thing["type"], size = 1) {
  // Half the thing's drawn width plus most of the car's half-width, in lanes.
  switch (type) {
    case "car":
    case "van":
    case "tarpcar":
    case "parked":
    case "racer":
      return 0.26;
    case "cow":
      return 0.32;
    case "deer":
      return 0.28;
    case "mower":
      return 0.25;
    case "person":
      return 0.22;
    case "dog":
      return 0.21;
    case "ebike":
      return 0.2;
    case "goose":
      return 0.19;
    case "cat":
    case "raccoon":
      return 0.18;
    case "squirrel":
      return 0.15;
    case "pothole":
      return (15 * size + 12) / 136;
    default:
      return 0.2;
  }
}

/** The car's half-length plus a thing's half-length, in screen %, for collisions. */
export const PLAYER_HALF = 6.2;
export function halfLength(type: Thing["type"]) {
  switch (type) {
    case "car":
    case "van":
    case "parked":
    case "tarpcar":
    case "racer":
      return 6;
    case "pothole":
      return 1.8;
    case "ebike":
    case "mower":
    case "deer":
    case "cow":
    case "person":
      return 4.5;
    default:
      return 3;
  }
}
export const touchesPlayer = (type: Thing["type"], y: number) =>
  Math.abs(y - PLAYER_Y) < PLAYER_HALF + halfLength(type) - 2;

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
