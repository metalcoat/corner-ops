import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/lib/games/sub-mission/game.js";

type B = "left" | "right" | "up" | "down" | "jump" | "shoot" | "start";

/** A bout in progress, with the customer holding still until a test starts an attack. */
function fighting(seed = 3) {
  const game = new Game(seed);
  game.startGame();
  game.state = "fight";
  game.foe.dur = 1e9;
  return game;
}

/** Holds the given buttons for one simulation frame. */
function frame(game: Game, ...buttons: B[]) {
  for (const b of buttons) game.input.setTouch(b, true);
  game.update();
  for (const b of buttons) game.input.setTouch(b, false);
}

function run(game: Game, frames: number) {
  for (let i = 0; i < frames; i++) frame(game);
}

test("ducking an over-the-counter grab sticks the customer to the sneeze guard, and the first hit earns a tip star", () => {
  const game = fighting();
  game.startAttack("choke", 20);
  run(game, 12);
  frame(game, "down");
  run(game, 35);
  assert.equal(game.foe.state, "stuck");
  const before = game.foe.hangry;
  frame(game, "shoot");
  run(game, 6);
  assert.ok(game.foe.hangry < before);
  assert.equal(game.stars, 1);
});

test("a grab that lands holds you until you ring the bell enough times", () => {
  const game = fighting();
  game.startAttack("choke", 10);
  run(game, 25);
  assert.equal(game.me.state, "grabbed");
  const grip = game.me.grip;
  for (let i = 0; i < grip; i++) {
    frame(game, i % 2 ? "shoot" : "jump");
    frame(game);
  }
  assert.equal(game.me.state, "idle");
  assert.equal(game.foe.state, "recover");
  assert.ok(game.me.chill < 100 && game.me.chill > 50);
});

test("a coupon slap has to be dodged sideways; ducking doesn't help", () => {
  const dodged = fighting();
  dodged.startAttack("slap", 10);
  run(dodged, 6);
  frame(dodged, "left");
  run(dodged, 15);
  assert.equal(dodged.me.chill, 100);
  assert.equal(dodged.foe.state, "recover");

  const ducked = fighting();
  ducked.startAttack("slap", 10);
  run(ducked, 6);
  frame(ducked, "down");
  run(ducked, 15);
  assert.equal(ducked.me.chill, 88);
});

test("feeding the customer down to zero hangry is a food coma, then the next customer comes up", () => {
  const game = fighting();
  game.foe.hangry = 2;
  game.foe.state = "recover";
  game.foe.dur = 1e9;
  frame(game, "shoot");
  run(game, 6);
  assert.equal(game.state, "koed");
  assert.equal(game.foe.state, "ko");
  assert.ok(game.score >= 1000);
  run(game, 240);
  assert.equal(game.state, "corner");
  frame(game, "start");
  assert.equal(game.state, "intro");
  assert.equal(game.foe.c.id, "randy");
});

test("the Jumbo needs a tip star and can't be blocked", () => {
  const game = fighting();
  frame(game, "up", "shoot");
  assert.equal(game.me.state, "idle");
  frame(game);
  game.stars = 1;
  const before = game.foe.hangry;
  frame(game, "up", "shoot");
  assert.equal(game.me.state, "jumbo");
  run(game, 25);
  assert.equal(game.stars, 0);
  assert.equal(game.foe.hangry, before - 28);
});

test("three knockdowns in one bout clock you out", () => {
  const game = fighting();
  for (let down = 1; down <= 3; down++) {
    game.me.invuln = 0;
    game.me.state = "idle";
    game.hurt(200, "TEST");
    if (down < 3) {
      assert.equal(game.me.state, "down");
      for (let i = 0; i < game.me.need; i++) {
        frame(game, "shoot");
        frame(game);
      }
      assert.equal(game.me.state, "idle");
    }
  }
  assert.equal(game.state, "gameover");
});
