/* Weapons, bosses and stage themes for DELI MAN: The Last Jumbo. */

export type WeaponId =
  | "buster"
  | "patch"
  | "plow"
  | "antler"
  | "honk"
  | "coupon"
  | "manager"
  | "ban"
  | "slash";

export type WeaponDef = {
  id: WeaponId;
  name: string;
  short: string;
  primary: string;
  secondary: string;
  cost: number;
  blurb: string;
};

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  buster: {
    id: "buster",
    name: "PICKLE BUSTER",
    short: "P",
    primary: "#0078f8",
    secondary: "#0028a8",
    cost: 0,
    blurb: "HOLD SHOOT TO CHARGE A JUMBO SHOT.",
  },
  patch: {
    id: "patch",
    name: "COLD PATCH",
    short: "CP",
    primary: "#7c7c7c",
    secondary: "#e45c10",
    cost: 2,
    blurb: "LOBS HOT ASPHALT. FIXES NOTHING.",
  },
  plow: {
    id: "plow",
    name: "SNOW PLOW",
    short: "SP",
    primary: "#a4e4fc",
    secondary: "#3cbcfc",
    cost: 3,
    blurb: "A GROUND WAVE OF DIRTY SNOW. BURIES YOUR MAILBOX.",
  },
  antler: {
    id: "antler",
    name: "ANTLER SPREAD",
    short: "AS",
    primary: "#ac7c00",
    secondary: "#503000",
    cost: 1,
    blurb: "THREE-WAY SHOT. DOES NOT LOOK BOTH WAYS.",
  },
  honk: {
    id: "honk",
    name: "GOOSE HONK",
    short: "GH",
    primary: "#bcbcbc",
    secondary: "#4c4c4c",
    cost: 2,
    blurb: "A HOMING GOOSE. IT WILL FIND THEM.",
  },
  coupon: {
    id: "coupon",
    name: "COUPON CUTTER",
    short: "CC",
    primary: "#58d854",
    secondary: "#007800",
    cost: 1,
    blurb: "BOOMERANG SCISSORS. EXPIRED YESTERDAY.",
  },
  manager: {
    id: "manager",
    name: "MANAGER CALL",
    short: "MC",
    primary: "#d800cc",
    secondary: "#6844fc",
    cost: 7,
    blurb: "HITS EVERYTHING ON SCREEN. NOBODY WINS.",
  },
  ban: {
    id: "ban",
    name: "BAN HAMMER",
    short: "BH",
    primary: "#3cbcfc",
    secondary: "#0028a8",
    cost: 3,
    blurb: "HEAVY ARC THAT PIERCES. POST REMOVED.",
  },
  slash: {
    id: "slash",
    name: "PRICE SLASH",
    short: "PS",
    primary: "#f83800",
    secondary: "#881400",
    cost: 1,
    blurb: "CLOSE-RANGE CUT. 40% OFF THEIR HEALTH.",
  },
};

export const WEAPON_ORDER: WeaponId[] = [
  "buster",
  "patch",
  "plow",
  "antler",
  "honk",
  "coupon",
  "manager",
  "ban",
  "slash",
];

export type GroundStyle = "asphalt" | "snow" | "grass" | "boards" | "tile" | "carpet" | "circuit" | "steel";
export type Backdrop = "city" | "winter" | "forest" | "river" | "store" | "office" | "cyber" | "warehouse" | "hq";

export type Theme = {
  sky: string;
  sky2: string;
  far: string;
  farDark: string;
  mid: string;
  midDark: string;
  top: string;
  topLight: string;
  fill: string;
  fillDark: string;
  block: string;
  blockLight: string;
  blockDark: string;
  ladder: string;
  ground: GroundStyle;
  backdrop: Backdrop;
  signs: string[];
  /** Enemy remaps for this stage, e.g. carts become deer. */
  swap?: Partial<Record<string, string>>;
};

export type BossId =
  | "pothole"
  | "snowbank"
  | "deer"
  | "goose"
  | "coupon"
  | "complaint"
  | "admin"
  | "slasher"
  | "margin";

export type BossDef = {
  id: BossId;
  name: string;
  head: string;
  A: string;
  a: string;
  Z: string;
  weapon: WeaponId | null;
  weakness: WeaponId;
  stage: string;
  tagline: string;
  screens: string[];
  theme: Theme;
  music: number;
};

const T = (theme: Theme) => theme;

export const BOSSES: Record<BossId, BossDef> = {
  pothole: {
    id: "pothole",
    name: "POTHOLE MAN",
    head: "pothole",
    A: "#7c7c7c",
    a: "#4c4c4c",
    Z: "#f87858",
    weapon: "patch",
    weakness: "plow",
    stage: "FORD ST. ROADWORK",
    tagline: "HE WAS HERE BEFORE THE ROAD.",
    screens: ["start", "flat_mets", "pit1", "steps", "turret_wall", "hop_pit", "checkpoint", "cart_run", "pillars", "spike_jumps", "ladder_wall", "corridor", "boss"],
    music: 0,
    theme: T({
      sky: "#3cbcfc",
      sky2: "#a4e4fc",
      far: "#7c7c7c",
      farDark: "#4c4c4c",
      mid: "#ac7c00",
      midDark: "#503000",
      top: "#4c4c4c",
      topLight: "#f8b800",
      fill: "#7c7c7c",
      fillDark: "#4c4c4c",
      block: "#e45c10",
      blockLight: "#fcfcfc",
      blockDark: "#881400",
      ladder: "#f8b800",
      ground: "asphalt",
      backdrop: "city",
      signs: ["FORD ST", "ROAD WORK AHEAD", "SINCE 1987", "POTHOLE SEASON: ALWAYS"],
    }),
  },
  snowbank: {
    id: "snowbank",
    name: "SNOWBANK MAN",
    head: "snowbank",
    A: "#fcfcfc",
    a: "#a4e4fc",
    Z: "#d82800",
    weapon: "plow",
    weakness: "antler",
    stage: "PLOW DAY",
    tagline: "THE CITY PLOWED HIM INTO YOUR DRIVEWAY.",
    screens: ["start", "steps", "hop_pit", "ladder_spikes", "flat_mets", "checkpoint", "pillars", "turret_wall", "pit1", "met_stairs", "ladder_wall", "corridor", "boss"],
    music: 1,
    theme: T({
      sky: "#6888fc",
      sky2: "#a4e4fc",
      far: "#fcfcfc",
      farDark: "#a4e4fc",
      mid: "#007800",
      midDark: "#004000",
      top: "#fcfcfc",
      topLight: "#fcfcfc",
      fill: "#a4e4fc",
      fillDark: "#3cbcfc",
      block: "#bcbcbc",
      blockLight: "#fcfcfc",
      blockDark: "#4c4c4c",
      ladder: "#d82800",
      ground: "snow",
      backdrop: "winter",
      signs: ["SNOW EMERGENCY", "NO PARKING", "ALTERNATE SIDE", "IT'S APRIL"],
    }),
  },
  deer: {
    id: "deer",
    name: "DEER MAN",
    head: "deer",
    A: "#ac7c00",
    a: "#503000",
    Z: "#fce0a8",
    weapon: "antler",
    weakness: "honk",
    stage: "ROUTE 37 AFTER DARK",
    tagline: "HE WILL STAND IN THE ROAD. FOREVER.",
    screens: ["start", "cart_run", "pillars", "flat_mets", "pit1", "checkpoint", "cart_run", "steps", "ladder_spikes", "spike_jumps", "fliers", "corridor", "boss"],
    music: 2,
    theme: T({
      sky: "#000040",
      sky2: "#200060",
      far: "#004000",
      farDark: "#002000",
      mid: "#005800",
      midDark: "#003000",
      top: "#4c4c4c",
      topLight: "#fcfcfc",
      fill: "#503000",
      fillDark: "#2c1800",
      block: "#ac7c00",
      blockLight: "#f8b800",
      blockDark: "#503000",
      ladder: "#f8b800",
      ground: "asphalt",
      backdrop: "forest",
      signs: ["DEER XING", "NEXT 40 MI", "RT 37", "THEY KNOW"],
      swap: { C: "R" },
    }),
  },
  goose: {
    id: "goose",
    name: "GOOSE MAN",
    head: "goose",
    A: "#ac9c84",
    a: "#5c4c3c",
    Z: "#fcfcfc",
    weapon: "honk",
    weakness: "patch",
    stage: "RIVERFRONT PARK",
    tagline: "THE RIVERFRONT IS HIS. YOU ARE VISITING.",
    screens: ["start", "pit1", "fliers", "spike_jumps", "flat_mets", "checkpoint", "hop_pit", "pit1", "turret_wall", "ladder_spikes", "fliers", "corridor", "boss"],
    music: 3,
    theme: T({
      sky: "#fca044",
      sky2: "#fce0a8",
      far: "#0078f8",
      farDark: "#0028a8",
      mid: "#007800",
      midDark: "#004000",
      top: "#58d854",
      topLight: "#b8f818",
      fill: "#ac7c00",
      fillDark: "#503000",
      block: "#bcbcbc",
      blockLight: "#fcfcfc",
      blockDark: "#4c4c4c",
      ladder: "#fcfcfc",
      ground: "grass",
      backdrop: "river",
      signs: ["CANADA ->", "NO FEEDING THE GEESE", "MAPLE CITY", "BRIDGE TOLL"],
    }),
  },
  coupon: {
    id: "coupon",
    name: "COUPON MAN",
    head: "coupon",
    A: "#58d854",
    a: "#007800",
    Z: "#f8b800",
    weapon: "coupon",
    weakness: "slash",
    stage: "SUPERMARKET AISLE 9",
    tagline: "THIS COUPON EXPIRED IN 2009. HE WILL WAIT.",
    screens: ["start", "cart_run", "steps", "cart_run", "flat_mets", "checkpoint", "turret_wall", "ladder_wall", "pillars", "hop_pit", "met_stairs", "corridor", "boss"],
    music: 0,
    theme: T({
      sky: "#fce0a8",
      sky2: "#fcfcfc",
      far: "#d82800",
      farDark: "#881400",
      mid: "#0078f8",
      midDark: "#0028a8",
      top: "#bcbcbc",
      topLight: "#fcfcfc",
      fill: "#7c7c7c",
      fillDark: "#4c4c4c",
      block: "#d82800",
      blockLight: "#fca044",
      blockDark: "#881400",
      ladder: "#0078f8",
      ground: "tile",
      backdrop: "store",
      signs: ["AISLE 9", "CLEAN-UP ON 9", "LIMIT 4", "BOGO*"],
    }),
  },
  complaint: {
    id: "complaint",
    name: "COMPLAINT MAN",
    head: "complaint",
    A: "#d800cc",
    a: "#6800a0",
    Z: "#fcfcfc",
    weapon: "manager",
    weakness: "coupon",
    stage: "CUSTOMER SERVICE DESK",
    tagline: "HE WOULD LIKE TO SPEAK TO YOUR MANAGER.",
    screens: ["start", "flat_mets", "turret_wall", "ladder_spikes", "checkpoint", "spike_jumps", "steps", "ladder_wall", "met_stairs", "fliers", "corridor", "boss"],
    music: 1,
    theme: T({
      sky: "#fcd8a8",
      sky2: "#f8b888",
      far: "#c84c0c",
      farDark: "#881400",
      mid: "#ac7c00",
      midDark: "#503000",
      top: "#6844fc",
      topLight: "#a4a4fc",
      fill: "#4428bc",
      fillDark: "#240088",
      block: "#ac7c00",
      blockLight: "#fca044",
      blockDark: "#503000",
      ladder: "#fcfcfc",
      ground: "carpet",
      backdrop: "office",
      signs: ["PLEASE WAIT", "NOW SERVING #0", "NO REFUNDS", "1 STAR"],
    }),
  },
  admin: {
    id: "admin",
    name: "ADMIN MAN",
    head: "admin",
    A: "#3c78f8",
    a: "#0028a8",
    Z: "#fcfcfc",
    weapon: "ban",
    weakness: "manager",
    stage: "THE COMMUNITY GROUP",
    tagline: "MODERATES 4 TOWN GROUPS. READS NONE OF THEM.",
    screens: ["start", "steps", "pit1", "spike_jumps", "checkpoint", "ladder_spikes", "turret_wall", "pillars", "fliers", "hop_pit", "corridor", "boss"],
    music: 2,
    theme: T({
      sky: "#000020",
      sky2: "#002060",
      far: "#0028a8",
      farDark: "#001860",
      mid: "#3c78f8",
      midDark: "#0028a8",
      top: "#3cbcfc",
      topLight: "#fcfcfc",
      fill: "#0028a8",
      fillDark: "#001860",
      block: "#3c78f8",
      blockLight: "#a4e4fc",
      blockDark: "#0028a8",
      ladder: "#fcfcfc",
      ground: "circuit",
      backdrop: "cyber",
      signs: ["WHO'S DRIVING THE LOUD CAR", "COMMENTS OFF", "ANYONE ELSE HEAR THAT?", "POST REMOVED"],
    }),
  },
  slasher: {
    id: "slasher",
    name: "PRICE SLASHER MAN",
    head: "slasher",
    A: "#f83800",
    a: "#a81000",
    Z: "#f8b800",
    weapon: "slash",
    weakness: "ban",
    stage: "THE BIG SALE",
    tagline: "EVERYDAY LOW-ISH PRICES. NO RAIN CHECKS.",
    screens: ["start", "cart_run", "flat_mets", "ladder_wall", "checkpoint", "cart_run", "spike_jumps", "pillars", "turret_wall", "met_stairs", "corridor", "boss"],
    music: 3,
    theme: T({
      sky: "#4c4c4c",
      sky2: "#7c7c7c",
      far: "#881400",
      farDark: "#4c0000",
      mid: "#ac7c00",
      midDark: "#503000",
      top: "#f8b800",
      topLight: "#fce0a8",
      fill: "#7c7c7c",
      fillDark: "#4c4c4c",
      block: "#ac7c00",
      blockLight: "#fca044",
      blockDark: "#503000",
      ladder: "#f8b800",
      ground: "steel",
      backdrop: "warehouse",
      signs: ["SALE!!", "70% OFF*", "*EXCLUSIONS APPLY", "NO RAIN CHECKS"],
    }),
  },
  margin: {
    id: "margin",
    name: "DR. MARGIN",
    head: "margin",
    A: "#4c4c4c",
    a: "#202020",
    Z: "#f8b800",
    weapon: null,
    weakness: "manager",
    stage: "CORPORATE CHAIN HQ",
    tagline: "HE WANTS TO REPLACE THE CORNER DELI WITH A KIOSK.",
    screens: ["start", "flat_mets", "steps", "ladder_spikes", "spike_jumps", "checkpoint", "turret_wall", "cart_run", "fliers", "met_stairs", "hop_pit", "ladder_wall", "corridor", "boss"],
    music: 4,
    theme: T({
      sky: "#200020",
      sky2: "#400040",
      far: "#4c4c4c",
      farDark: "#202020",
      mid: "#881400",
      midDark: "#400000",
      top: "#bcbcbc",
      topLight: "#fcfcfc",
      fill: "#4c4c4c",
      fillDark: "#202020",
      block: "#881400",
      blockLight: "#d82800",
      blockDark: "#400000",
      ladder: "#f8b800",
      ground: "steel",
      backdrop: "hq",
      signs: ["SYNERGY", "KIOSKS ARE THE FUTURE", "ALL SUBS NOW 6 INCH", "Q4"],
      swap: { C: "R" },
    }),
  },
};

/** Stage-select layout: 3x3 grid with the final stage in the middle. */
export const SELECT_GRID: BossId[] = [
  "pothole",
  "snowbank",
  "deer",
  "goose",
  "margin",
  "coupon",
  "complaint",
  "admin",
  "slasher",
];

export const ROBOT_MASTERS: BossId[] = SELECT_GRID.filter((id) => id !== "margin");

/** Damage a boss takes from each weapon (weakness hits hard). */
export function bossDamage(boss: BossDef, weapon: WeaponId, charge: number) {
  if (weapon === boss.weakness) return 4;
  if (weapon === "buster") return charge >= 2 ? 3 : charge === 1 ? 2 : 1;
  if (boss.weapon && weapon === boss.weapon) return 0;
  return 1;
}
