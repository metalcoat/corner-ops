import test from "node:test";
import assert from "node:assert/strict";
import { Game } from "../src/lib/games/rampage/game.js";

function playing(seed = 7, monster = 0) {
  const game = new Game(seed);
  game.startGame(monster);
  game.state = "play";
  game.spawnT = 1e9;
  game.inspectorT = 1e9;
  game.copterT = 1e9;
  return game;
}

/** Holds the given buttons for one simulation frame. */
function frame(game: Game, ...buttons: Array<"left" | "right" | "up" | "down" | "jump" | "shoot" | "start">) {
  for (const b of buttons) game.input.setTouch(b, true);
  game.update();
  for (const b of buttons) game.input.setTouch(b, false);
}

test("a block has 3 buildings early on and 4 later, with room to walk between them", () => {
  const game = new Game(1);
  for (const level of [1, 3, 6]) {
    const block = game.makeBlock(level);
    assert.equal(block.length, level <= 2 ? 3 : 4);
    for (let i = 1; i < block.length; i++) assert.ok(block[i].x - (block[i - 1].x + block[i - 1].w) >= 20);
    for (const b of block) assert.ok(b.roof >= 40 && b.floors >= 4 && b.floors <= 8);
  }
});

test("walking into a wall climbs it, and climbing to the top puts you on the roof", () => {
  const game = playing();
  const first = game.buildings[0];
  game.player.x = first.x - 30;
  for (let i = 0; i < 40 && game.player.mode !== "climb"; i++) frame(game, "right");
  assert.equal(game.player.mode, "climb");
  for (let i = 0; i < 300 && game.player.mode === "climb"; i++) frame(game, "up");
  assert.equal(game.player.mode, "stand");
  assert.equal(game.player.on, first);
  assert.equal(game.player.y, first.roof);
});

test("punching enough of a wall brings the building down for points", () => {
  const game = playing();
  const b = game.buildings[0];
  const before = game.score;
  for (let r = 0; r < b.floors; r++) for (let c = 0; c < b.cols; c++) {
    game.hitCell(b, r, c);
    game.hitCell(b, r, c);
  }
  assert.ok(b.collapsing);
  assert.ok(game.score >= before + 1000);
  for (let i = 0; i < 400 && !b.gone; i++) game.update();
  assert.ok(b.gone);
});

test("punching a complainer's window serves them instead of breaking the wall", () => {
  const game = playing();
  const b = game.buildings[1];
  const cell = b.cells[1][1];
  cell.occupant = { kind: "complainer", life: 400, age: 20, line: "TOO HOT!", throwT: 999, hair: "#000", skin: "#fff" };
  const before = game.score;
  game.hitCell(b, 1, 1);
  assert.equal(cell.occupant, null);
  assert.equal(cell.hp, 2);
  assert.equal(game.score, before + 500);
});

test("a free sub restores patience and a hot pepper costs some", () => {
  const game = playing();
  const b = game.buildings[0];
  game.player.patience = 50;
  game.player.invuln = 0;
  b.cells[0][0].occupant = { kind: "food", life: 300, age: 20, line: "", throwT: 0, hair: "", skin: "" };
  game.hitCell(b, 0, 0);
  assert.equal(game.player.patience, 75);
  b.cells[0][1].occupant = { kind: "pepper", life: 300, age: 20, line: "", throwT: 0, hair: "", skin: "" };
  game.hitCell(b, 0, 1);
  assert.equal(game.player.patience, 63);
});

test("running out of patience costs a life, and the last one ends the game", () => {
  const game = playing();
  for (let life = 3; life >= 1; life--) {
    game.player.invuln = 0;
    game.hurt(9999);
    assert.equal(game.player.mode, "dead");
    for (let i = 0; i < 200 && game.player.mode === "dead" && game.state === "play"; i++) game.update();
    assert.equal(game.lives, life - 1);
  }
  assert.equal(game.state, "gameover");
});

test("bringing the whole block down clears it and moves to the next street", () => {
  const game = playing();
  for (const b of game.buildings) for (let r = 0; r < b.floors; r++) for (let c = 0; c < b.cols; c++) { game.hitCell(b, r, c); game.hitCell(b, r, c); }
  for (let i = 0; i < 600 && game.state === "play"; i++) game.update();
  assert.equal(game.state, "clear");
  for (let i = 0; i < 400 && game.state === "clear"; i++) game.update();
  assert.equal(game.level, 2);
  assert.equal(game.state, "intro");
});

test("a punch from the street swats a thrown 1-star review", () => {
  const game = playing();
  const [first] = game.buildings;
  game.player.x = first.x + first.w + 13;
  game.player.y = 160;
  game.player.facing = 1;
  game.projectiles.push({ x: game.player.x + 17, y: 140, vx: 0, vy: 0, g: 0, kind: "star", spin: 0, dead: false });
  frame(game, "shoot");
  for (let i = 0; i < 5; i++) game.update();
  assert.equal(game.projectiles.length, 0);
  assert.ok(game.score >= 50);
});

test("the game runs a long stretch on every monster without errors", () => {
  for (let m = 0; m < 3; m++) {
    const game = new Game(42 + m);
    game.startGame(m);
    const buttons = ["left", "right", "up", "down", "jump", "shoot"] as const;
    for (let i = 0; i < 6000; i++) {
      if (game.state === "entry" || game.state === "scores" || game.state === "title") break;
      frame(game, buttons[(i >> 5) % buttons.length], i % 9 === 0 ? "shoot" : "right");
    }
    assert.ok(game.score > 0);
  }
});
