import test from "node:test";
import assert from "node:assert/strict";
import { validateRushReplay, MAX_RUSH_ACTIONS } from "../src/lib/games/pizza-rush/replay.js";
import { PizzaRush } from "../src/lib/games/pizza-rush/engine.js";
import { playRushReplay } from "./fixtures/pizza-rush-replay.js";

const win = playRushReplay(3);

test("real seeded gameplay reproduces exact earned stats", () => {
  assert.equal(win.state,"won");
  assert.ok(win.stats.delivered>=40);
  assert.deepEqual(validateRushReplay(3,win.actions,win.stats),win.stats);
});
test("fabricated counters, missing play and another run's seed cannot earn a prize", () => {
  assert.throws(()=>validateRushReplay(3,undefined,win.stats),/replay/);
  assert.throws(()=>validateRushReplay(3,win.actions,{...win.stats,score:win.stats.score+500}),/claimed result/);
  assert.throws(()=>validateRushReplay(4,win.actions,win.stats));
  assert.throws(()=>validateRushReplay(3,win.actions.slice(0,-1),win.stats),/claimed result/);
});
test("replay resource limits reject giant canvases, impossible time and oversized logs", () => {
  for (const actions of [[[1,1e9,1e9],[0,.02]],[[1,400,700],[0,110]],[[1,400,700],[0,NaN]],Array(MAX_RUSH_ACTIONS+1).fill([0,.02]),[[1,400,700],[3,100,100]]]) {
    assert.throws(()=>validateRushReplay(3,actions,win.stats));
  }
});
test("paused frames do not change replay state and restarting resets the seeded game", () => {
  const game=new PizzaRush(3); game.start(3); game.update(.05); game.slowMo=2; game.state="ready";
  game.update(.05); assert.equal(game.time,.05); assert.equal(game.slowMo,2);
  game.start(3); assert.equal(game.time,0); assert.equal(game.score,0); assert.equal(game.state,"play");
});
