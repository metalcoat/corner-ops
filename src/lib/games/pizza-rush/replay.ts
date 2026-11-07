import { PizzaRush, SHIFT_SECONDS, type Stats } from "./engine";

// Numeric tuples keep a normal two-minute run well below the request limit.
export type RushAction = [0, number] | [1, number, number] | [2, number, number] | [3, number, number] | [4];
export const MAX_RUSH_ACTIONS = 50_000;
export const MAX_RUSH_BODY_BYTES = 2_000_000;

export function applyRushAction(game: PizzaRush, action: RushAction) {
  switch (action[0]) {
    case 0: game.update(action[1]); break;
    case 1: game.resize(action[1], action[2]); break;
    case 2: game.beginStroke(action[1], action[2]); break;
    case 3: game.swipeTo(action[1], action[2]); break;
    case 4: game.endStroke(); break;
  }
}

export function validateRushReplay(seed: number, value: unknown, expected: Stats): Stats {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_RUSH_ACTIONS) throw new Error("A complete gameplay replay is required.");
  const game = new PizzaRush(seed);
  game.start(seed);
  let elapsed = 0, stroke = false, resizes = 0;
  for (let index = 0; index < value.length; index++) {
    const action = value[index];
    if (!Array.isArray(action) || !action.every(Number.isFinite)) throw new Error("Invalid gameplay replay.");
    if (game.state !== "play") throw new Error("Gameplay continued after the shift ended.");
    switch (action[0]) {
      case 0:
        if (action.length !== 2 || action[1] < 0.001 || action[1] > 0.05) throw new Error("Invalid gameplay timing.");
        elapsed += action[1];
        if (elapsed > SHIFT_SECONDS + 0.05) throw new Error("Gameplay exceeds the shift length.");
        break;
      case 1:
        if (action.length !== 3 || ++resizes > 100 || action[1] < 200 || action[1] > 1920 || action[2] < 300 || action[2] > 1440) throw new Error("Invalid gameplay dimensions.");
        break;
      case 2:
      case 3:
        if (action.length !== 3 || Math.abs(action[1]) > game.W * 3 || Math.abs(action[2]) > game.H * 3) throw new Error("Invalid swipe coordinates.");
        if (action[0] === 2) stroke = true;
        else if (!stroke) throw new Error("A swipe must start with a finger down.");
        break;
      case 4:
        if (action.length !== 1) throw new Error("Invalid swipe end.");
        stroke = false;
        break;
      default: throw new Error("Unknown gameplay action.");
    }
    if (index === 0 && action[0] !== 1) throw new Error("Gameplay dimensions are required.");
    applyRushAction(game, action as RushAction);
  }
  const actual = game.stats();
  if (String(game.state) !== "won" || actual.elapsed !== SHIFT_SECONDS
    || (Object.keys(actual) as Array<keyof Stats>).some((key) => actual[key] !== expected[key])) throw new Error("The claimed result does not match the gameplay replay.");
  return actual;
}
