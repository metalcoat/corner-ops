// JUMBO RUSH — the Earn Your Jumbo game. Pizzas fly out of the oven; swipe to
// slice them before they drop. Ringing phones, 1-star reviews and expired coupons
// fly too: slice one of those and it's a strike. Three strikes ends the shift.
// Survive the whole rush with at least MIN_DELIVERED pizzas sliced and the server
// issues a free Jumbo Cheese Pizza code (src/lib/pizza-gauntlet/server.ts).
//
// DOM-free so it runs in node tests. Coordinates are CSS pixels of the play area;
// the size of everything scales with the screen.
import { PERFECT_PENALTY_LINES } from "../complaints";

export const SHIFT_SECONDS = 110;
export const CHECKPOINT_SECONDS = 10;
export const MAX_STRIKES = 3;
/** Pizzas a prize run must slice; the server checks the same number. */
export const MIN_DELIVERED = 40;
/** The server rejects a checkpoint that delivers more than this since the last one. */
export const MAX_DELIVERED_PER_CHECKPOINT = 60;

export type Topping = "cheese" | "pepperoni" | "mushroom" | "peppers" | "olives" | "supreme";
export type HazardKind = "phone" | "review" | "coupon";
export type FlyerKind = "pizza" | "jumbo" | "espresso" | HazardKind;

export type Flyer = {
  id: number;
  kind: FlyerKind;
  topping: Topping;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  spin: number;
  angle: number;
  hp: number;
  hitStroke: number;
  gone: boolean;
};
export type Half = { x: number; y: number; vx: number; vy: number; r: number; angle: number; spin: number; cut: number; side: 1 | -1; topping: Topping; jumbo: boolean; life: number };
export type Splat = { x: number; y: number; r: number; life: number; color: string };
export type Floater = { x: number; y: number; text: string; color: string; size: number; t: number };
export type Phase = { at: number; name: string; line: string; interval: number; volley: [number, number]; hazard: number; extra: number };
export type Stats = { elapsed: number; score: number; delivered: number; perfects: number; ruined: number };

export const PHASES: Phase[] = [
  { at: 0, name: "TRAINING SHIFT", line: "THE OVEN STILL TELLS THE TRUTH.", interval: 1.15, volley: [1, 1], hazard: 0.06, extra: 0 },
  { at: 20, name: "DINNER RUSH", line: "TWO HANDS. FOUR PIZZAS. GOOD LUCK.", interval: 1.05, volley: [1, 2], hazard: 0.15, extra: 0.05 },
  { at: 45, name: "FRIDAY NIGHT", line: "THE PHONE HAS DISCOVERED FREE WILL.", interval: 1.1, volley: [2, 3], hazard: 0.2, extra: 0.06 },
  { at: 70, name: "FOOTBALL SUNDAY", line: "NOBODY PLANNED AHEAD. YOUR FAULT.", interval: 1.0, volley: [2, 4], hazard: 0.22, extra: 0.06 },
  { at: 95, name: "FINAL RUSH", line: "7:52 PM. THE PHONE RINGS.", interval: 0.85, volley: [3, 4], hazard: 0.25, extra: 0.04 },
];

const TOPPINGS: Topping[] = ["cheese", "pepperoni", "pepperoni", "mushroom", "peppers", "olives", "supreme"];
const TOPPING_POINTS: Record<Topping, number> = { cheese: 50, pepperoni: 60, mushroom: 60, peppers: 60, olives: 70, supreme: 90 };

export const HAZARD_LINES: Record<HazardKind, string[]> = {
  phone: ["PHONE: \"IS IT READY?\" (ORDERED 40 SEC AGO)", "PHONE: \"WHERE'S THE DRIVER?\" (IT'S PICKUP)", "PHONE: \"DO YOU HAVE PIZZA?\""],
  review: ["1-STAR REVIEW: \"TOO ROUND\"", "1-STAR REVIEW: \"TASTED LIKE PIZZA\"", "1-STAR REVIEW: \"CHEESE WAS HOT\""],
  coupon: ["COUPON EXPIRED 2009. THEY WANT IT HONORED.", "COUPON IS FOR A DIFFERENT RESTAURANT.", "COUPON IS A DRAWING OF A COUPON."],
};
const DROP_LINES = ["DROPPED! THEY STILL WANT IT.", "ON THE FLOOR. 5-SECOND RULE?", "DROPPED! CUSTOMER SAW.", "THE DOG ATE IT."];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PizzaRush {
  W = 400;
  H = 700;
  state: "ready" | "play" | "won" | "lost" = "ready";
  /** Shift time in seconds (stops while paused). */
  time = 0;
  score = 0;
  delivered = 0;
  perfects = 0;
  strikes = 0;
  streak = 0;
  bestStreak = 0;
  flyers: Flyer[] = [];
  halves: Half[] = [];
  splats: Splat[] = [];
  floaters: Floater[] = [];
  phaseIndex = 0;
  banner = 0;
  flash = 0;
  slowMo = 0;
  shake = 0;
  lastJoke = "";
  /** Fired every CHECKPOINT_SECONDS of shift time, and once more at the end. */
  onCheckpoint: (stats: Stats) => void = () => {};
  onEnd: (won: boolean, stats: Stats) => void = () => {};
  onSound: (name: "slice" | "jumbo" | "hazard" | "drop" | "combo" | "espresso" | "phase" | "whoosh") => void = () => {};

  private rand: () => number;
  private nextId = 1;
  private spawnT = 0.6;
  private nextCheckpoint = CHECKPOINT_SECONDS;
  private windowStartDelivered = 0;
  private spawnedThisWindow = 0;
  private stroke = 0;
  private strokeHits = 0;
  private strokeX = 0;
  private strokeY = 0;

  constructor(seed = Date.now()) {
    this.rand = mulberry32(seed);
  }

  resize(W: number, H: number) {
    this.W = Math.max(200, W);
    this.H = Math.max(300, H);
  }

  /** Pizza radius for the current screen. */
  get radius() {
    return Math.max(26, Math.min(58, Math.min(this.W, this.H) * 0.085));
  }

  get gravity() {
    return this.H * 1.45;
  }

  get phase() {
    return PHASES[this.phaseIndex];
  }

  get multiplier() {
    return Math.min(3, 1 + Math.floor(this.streak / 10) * 0.5);
  }

  stats(): Stats {
    return { elapsed: Math.floor(this.time), score: this.score, delivered: this.delivered, perfects: this.perfects, ruined: this.strikes };
  }

  start() {
    Object.assign(this, { state: "play", time: 0, score: 0, delivered: 0, perfects: 0, strikes: 0, streak: 0, bestStreak: 0, phaseIndex: 0, banner: 2.5, flash: 0, slowMo: 0, shake: 0 });
    this.flyers = [];
    this.halves = [];
    this.splats = [];
    this.floaters = [];
    this.spawnT = 0.8;
    this.nextCheckpoint = CHECKPOINT_SECONDS;
    this.windowStartDelivered = 0;
    this.spawnedThisWindow = 0;
    this.stroke = 0;
    this.strokeHits = 0;
  }

  private pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)];
  }

  /** Advance by dt real seconds. */
  update(dt: number) {
    dt = Math.min(0.05, Math.max(0, dt));
    const sim = this.slowMo > 0 ? dt * 0.45 : dt;
    if (this.slowMo > 0) this.slowMo = Math.max(0, this.slowMo - dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
    if (this.banner > 0) this.banner = Math.max(0, this.banner - dt);
    this.updateEffects(sim, dt);
    if (this.state !== "play") return;

    this.time += dt;
    const next = PHASES[this.phaseIndex + 1];
    if (next && this.time >= next.at) {
      this.phaseIndex++;
      this.banner = 2.5;
      this.onSound("phase");
    }
    if (this.time >= this.nextCheckpoint && this.time < SHIFT_SECONDS) {
      this.nextCheckpoint += CHECKPOINT_SECONDS;
      this.windowStartDelivered = this.delivered;
      this.spawnedThisWindow = 0;
      this.onCheckpoint(this.stats());
    }
    if (this.time >= SHIFT_SECONDS) {
      this.time = SHIFT_SECONDS;
      this.finish(true);
      return;
    }

    // Launch the next volley. Nothing new in the last 2.5 seconds, so the rush can land.
    this.spawnT -= sim;
    if (this.spawnT <= 0 && this.time < SHIFT_SECONDS - 2.5) {
      const p = this.phase;
      this.spawnT = p.interval * (0.85 + this.rand() * 0.3);
      const count = p.volley[0] + Math.floor(this.rand() * (p.volley[1] - p.volley[0] + 1));
      for (let i = 0; i < count; i++) this.launch(i * 0.12);
      if (count > 1) this.onSound("whoosh");
    }

    const g = this.gravity;
    for (const f of this.flyers) {
      if (f.gone) continue;
      f.vy += g * sim;
      f.x += f.vx * sim;
      f.y += f.vy * sim;
      f.angle += f.spin * sim;
      if (f.vy > 0 && f.y - f.r > this.H) {
        f.gone = true;
        if (f.kind === "pizza") this.drop(f);
      }
    }
    this.flyers = this.flyers.filter((f) => !f.gone);
  }

  private launch(delay: number) {
    const p = this.phase;
    const r = this.radius;
    const roll = this.rand();
    let kind: FlyerKind = "pizza";
    if (this.time > 6 && roll < p.hazard) kind = this.pick(["phone", "review", "coupon"] as const);
    else if (roll < p.hazard + p.extra) kind = this.rand() < 0.6 ? "jumbo" : "espresso";
    // Keep pizzas under the server's per-checkpoint limit, with room to spare.
    if ((kind === "pizza" || kind === "jumbo") && this.spawnedThisWindow >= MAX_DELIVERED_PER_CHECKPOINT - 8) kind = this.pick(["phone", "review", "coupon"] as const);
    if (kind === "pizza" || kind === "jumbo") this.spawnedThisWindow++;
    const size = kind === "jumbo" ? r * 1.4 : kind === "pizza" ? r : r * 0.85;
    const x0 = this.W * (0.12 + this.rand() * 0.76);
    const y0 = this.H + size + delay * this.H * 0.4;
    const peak = this.H * (0.12 + this.rand() * 0.3);
    const g = this.gravity;
    const vy = -Math.sqrt(2 * g * (y0 - peak));
    const flight = (2 * -vy) / g;
    const tx = this.W * (0.2 + this.rand() * 0.6);
    this.flyers.push({
      id: this.nextId++, kind, topping: this.pick(TOPPINGS), x: x0, y: y0, vx: (tx - x0) / flight, vy, r: size,
      spin: (this.rand() - 0.5) * 6, angle: this.rand() * Math.PI * 2, hp: kind === "jumbo" ? 4 : 1, hitStroke: -1, gone: false,
    });
  }

  private drop(f: Flyer) {
    this.strike(f.x, this.H - 40, this.pick(DROP_LINES));
    this.onSound("drop");
  }

  private strike(x: number, y: number, line: string) {
    this.strikes++;
    this.streak = 0;
    this.flash = 0.35;
    this.shake = 0.35;
    this.lastJoke = line;
    this.float(x, y, line, "#ff6b5b", 15);
    this.float(x, y + 22, this.pick(PERFECT_PENALTY_LINES), "#ffd166", 11);
    if (this.strikes >= MAX_STRIKES) this.finish(false);
  }

  private finish(won: boolean) {
    if (this.state !== "play") return;
    this.state = won ? "won" : "lost";
    this.flyers = this.flyers.filter((f) => f.kind !== "pizza" && f.kind !== "jumbo");
    // The shift's last checkpoint goes out before the prize is claimed.
    this.onCheckpoint(this.stats());
    this.onEnd(won, this.stats());
  }

  /** Start a new swipe (finger down). */
  beginStroke(x: number, y: number) {
    this.endStroke();
    this.stroke++;
    this.strokeHits = 0;
    this.strokeX = x;
    this.strokeY = y;
  }

  /** The swipe moved to (x, y): slices everything along the way. */
  swipeTo(x: number, y: number) {
    const ax = this.strokeX;
    const ay = this.strokeY;
    this.strokeX = x;
    this.strokeY = y;
    if (this.state !== "play") return;
    if (Math.hypot(x - ax, y - ay) < 3) return;
    for (const f of this.flyers) {
      if (f.gone || f.hitStroke === this.stroke) continue;
      if (distToSegment(f.x, f.y, ax, ay, x, y) > f.r) continue;
      f.hitStroke = this.stroke;
      this.slice(f, Math.atan2(y - ay, x - ax));
      if (this.state !== "play") return;
    }
  }

  /** Finger lifted: score the swipe's combo. */
  endStroke() {
    if (this.strokeHits >= 3) {
      const bonus = this.strokeHits * 50;
      this.score += bonus;
      this.perfects++;
      this.float(this.strokeX, this.strokeY - 30, `${this.strokeHits}-PIZZA COMBO! +${bonus}`, "#7cf29a", 18);
      this.onSound("combo");
    }
    this.strokeHits = 0;
  }

  private slice(f: Flyer, cut: number) {
    if (f.kind === "phone" || f.kind === "review" || f.kind === "coupon") {
      f.gone = true;
      for (let i = 0; i < 10; i++) this.splats.push({ x: f.x + (this.rand() - 0.5) * f.r, y: f.y + (this.rand() - 0.5) * f.r, r: 3 + this.rand() * 5, life: 0.6, color: "#ff5040" });
      this.onSound("hazard");
      this.strike(f.x, f.y, this.pick(HAZARD_LINES[f.kind]));
      return;
    }
    if (f.kind === "espresso") {
      f.gone = true;
      this.slowMo = 4;
      this.float(f.x, f.y, "ESPRESSO! SLOW-MO", "#c9a27a", 16);
      this.onSound("espresso");
      return;
    }
    if (f.kind === "jumbo" && --f.hp > 0) {
      f.vy = Math.min(f.vy, -this.H * 0.55);
      this.score += 40;
      this.float(f.x, f.y - f.r, `JUMBO ${4 - f.hp}/4`, "#ffd166", 14);
      this.onSound("slice");
      return;
    }
    f.gone = true;
    this.delivered++;
    this.streak++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.strokeHits++;
    const base = f.kind === "jumbo" ? 500 : TOPPING_POINTS[f.topping];
    const points = Math.round(base * this.multiplier);
    this.score += points;
    if (f.kind === "jumbo") this.perfects++;
    this.float(f.x, f.y - f.r * 0.6, f.kind === "jumbo" ? `JUMBO! +${points}` : `+${points}`, f.kind === "jumbo" ? "#ffd166" : "#ffffff", f.kind === "jumbo" ? 20 : 14);
    if (this.streak > 0 && this.streak % 10 === 0) this.float(this.W / 2, this.H * 0.3, `STREAK ${this.streak}! x${this.multiplier}`, "#7cd3ff", 18);
    for (const side of [1, -1] as const) {
      const push = this.H * 0.12;
      this.halves.push({
        x: f.x, y: f.y, vx: f.vx * 0.4 + Math.cos(cut + Math.PI / 2) * push * side, vy: Math.min(f.vy, 0) * 0.3 + Math.sin(cut + Math.PI / 2) * push * side - this.H * 0.1,
        r: f.r, angle: f.angle, spin: side * (2 + this.rand() * 3), cut, side, topping: f.topping, jumbo: f.kind === "jumbo", life: 2,
      });
    }
    for (let i = 0; i < 6; i++) this.splats.push({ x: f.x + (this.rand() - 0.5) * f.r * 1.4, y: f.y + (this.rand() - 0.5) * f.r * 1.4, r: 2 + this.rand() * 5, life: 0.5 + this.rand() * 0.4, color: this.rand() < 0.5 ? "#d8432f" : "#f5d56b" });
    this.onSound(f.kind === "jumbo" ? "jumbo" : "slice");
  }

  private updateEffects(sim: number, dt: number) {
    const g = this.gravity;
    for (const h of this.halves) {
      h.vy += g * sim;
      h.x += h.vx * sim;
      h.y += h.vy * sim;
      h.angle += h.spin * sim;
      h.life -= dt;
    }
    this.halves = this.halves.filter((h) => h.life > 0 && h.y - h.r < this.H + 40);
    for (const s of this.splats) s.life -= dt;
    this.splats = this.splats.filter((s) => s.life > 0);
    for (const f of this.floaters) {
      f.t += dt;
      f.y -= 26 * dt;
    }
    this.floaters = this.floaters.filter((f) => f.t < 1.6);
  }

  private float(x: number, y: number, text: string, color: string, size: number) {
    const half = Math.min(this.W / 2 - 8, text.length * size * 0.32);
    x = Math.max(half + 8, Math.min(this.W - half - 8, x));
    y = Math.max(90, Math.min(this.H - 60, y));
    while (this.floaters.some((f) => f.t < 0.6 && Math.abs(f.y - y) < size + 4 && Math.abs(f.x - x) < half * 2)) y -= size + 6;
    this.floaters.push({ x, y, text, color, size, t: 0 });
  }
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
