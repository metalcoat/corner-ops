import test from "node:test";
import assert from "node:assert/strict";
import { MAX_DELIVERED_PER_CHECKPOINT, MIN_DELIVERED, PizzaRush, SHIFT_SECONDS, distToSegment, type Flyer, type Stats } from "../src/lib/games/pizza-rush/engine.js";

function game(seed = 3) {
  const g = new PizzaRush(seed);
  g.resize(400, 700);
  g.start();
  return g;
}
const flyer = (g: PizzaRush, kind: Flyer["kind"], x = 200, y = 300): Flyer => {
  const f: Flyer = { id: 999, kind, topping: "pepperoni", x, y, vx: 0, vy: -10, r: g.radius, spin: 0, angle: 0, hp: kind === "jumbo" ? 4 : 1, hitStroke: -1, gone: false };
  g.flyers.push(f);
  return f;
};
const swipe = (g: PizzaRush, y: number) => {
  g.beginStroke(10, y);
  g.swipeTo(390, y);
  g.endStroke();
};

/** Plays a whole shift with a perfect slicer that never touches a hazard. */
function autoplay(g: PizzaRush, onCheckpoint: (s: Stats) => void = () => {}) {
  g.onCheckpoint = onCheckpoint;
  for (let i = 0; i < 60 * (SHIFT_SECONDS + 5) && g.state === "play"; i++) {
    g.update(1 / 60);
    for (const f of g.flyers) {
      if (f.gone || f.y > g.H - f.r || f.y < 70) continue;
      if (f.kind !== "pizza" && f.kind !== "jumbo") continue;
      // A careful player waits when a hazard is overlapping the pizza.
      if (g.flyers.some((h) => !h.gone && h.kind !== "pizza" && h.kind !== "jumbo" && Math.hypot(h.x - f.x, h.y - f.y) < h.r + 4)) continue;
      g.beginStroke(f.x - 4, f.y);
      g.swipeTo(f.x + 4, f.y);
      g.endStroke();
    }
  }
}

test("segment distance", () => {
  assert.equal(distToSegment(5, 5, 0, 0, 10, 0), 5);
  assert.equal(distToSegment(-3, 4, 0, 0, 10, 0), 5);
});

test("slicing a pizza scores and counts it as delivered", () => {
  const g = game();
  flyer(g, "pizza");
  swipe(g, 300);
  assert.equal(g.delivered, 1);
  assert.equal(g.score, 60);
  assert.equal(g.halves.length, 2);
});

test("three pizzas in one swipe is a combo", () => {
  const g = game();
  flyer(g, "pizza", 80);
  flyer(g, "pizza", 200);
  flyer(g, "pizza", 320);
  swipe(g, 300);
  assert.equal(g.delivered, 3);
  assert.equal(g.perfects, 1);
  assert.equal(g.score, 3 * 60 + 150);
});

test("slicing a hazard is a strike, and three strikes ends the shift", () => {
  const g = game();
  let ended: boolean | null = null;
  g.onEnd = (won) => (ended = won);
  for (const kind of ["phone", "review", "coupon"] as const) {
    flyer(g, kind);
    swipe(g, 300);
  }
  assert.equal(g.strikes, 3);
  assert.equal(g.state, "lost");
  assert.equal(ended, false);
});

test("a dropped pizza is a strike; a dropped hazard is not", () => {
  const g = game();
  const p = flyer(g, "pizza", 200, 700 + 100);
  p.vy = 10;
  const h = flyer(g, "phone", 100, 700 + 100);
  h.vy = 10;
  g.update(0.02);
  assert.equal(g.strikes, 1);
});

test("the golden jumbo takes four swipes", () => {
  const g = game();
  const j = flyer(g, "jumbo");
  for (let i = 0; i < 3; i++) {
    swipe(g, j.y);
    assert.equal(g.delivered, 0);
  }
  swipe(g, j.y);
  assert.equal(g.delivered, 1);
  assert.ok(g.score >= 500);
});

test("espresso slows time", () => {
  const g = game();
  flyer(g, "espresso");
  swipe(g, 300);
  assert.ok(g.slowMo > 0);
  assert.equal(g.strikes, 0);
});

test("a clean shift reports checkpoints the prize server accepts and ends in a win", () => {
  const g = game(11);
  const checkpoints: Stats[] = [];
  let won: boolean | null = null;
  g.onEnd = (w) => (won = w);
  autoplay(g, (s) => checkpoints.push(s));
  assert.equal(won, true);
  assert.equal(g.state, "won");
  assert.ok(g.strikes < 3);
  assert.ok(g.delivered >= MIN_DELIVERED, `delivered ${g.delivered}`);
  // Mirrors checkpointArcadeRun/completeArcadeRun in src/lib/pizza-gauntlet/server.ts.
  assert.ok(checkpoints.length >= 9);
  let prev = { elapsed: 0, delivered: 0 };
  for (const c of checkpoints) {
    assert.ok(c.elapsed >= prev.elapsed && c.elapsed - prev.elapsed <= 15 && c.elapsed <= 130);
    assert.ok(c.delivered >= prev.delivered && c.delivered - prev.delivered <= MAX_DELIVERED_PER_CHECKPOINT);
    assert.ok(c.perfects <= c.delivered * 3 + 6 && c.score <= 250000 && c.ruined <= 3);
    prev = c;
  }
  const last = checkpoints.at(-1)!;
  assert.equal(last.elapsed, SHIFT_SECONDS);
  assert.ok(last.elapsed >= 100);
  assert.equal(last.delivered, g.delivered);
  assert.equal(last.score, g.score);
});

test("the rush keeps getting busier", () => {
  const g = game(5);
  let early = 0;
  let late = 0;
  for (let i = 0; i < 60 * SHIFT_SECONDS && g.state === "play"; i++) {
    const before = new Set(g.flyers.map((f) => f.id));
    g.update(1 / 60);
    const fresh = g.flyers.filter((f) => !before.has(f.id)).length;
    if (g.time < 20) early += fresh;
    if (g.time >= 90 && g.time < 107.5) late += fresh;
    // Keep the shift going: clear everything off-screen-bound so nothing drops.
    for (const f of g.flyers) if (f.vy > 0 && f.y > g.H - 5) f.gone = true;
  }
  assert.ok(late > early * 1.5, `early ${early}, late ${late}`);
});
