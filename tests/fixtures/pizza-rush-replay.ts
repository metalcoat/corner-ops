import { PizzaRush, SHIFT_SECONDS } from "../../src/lib/games/pizza-rush/engine.js";
import { applyRushAction, type RushAction } from "../../src/lib/games/pizza-rush/replay.js";

/** A deterministic legal input trace for replay tests; never edits game counters. */
export function playRushReplay(seed: number) {
  const game = new PizzaRush(seed), actions: RushAction[] = [[1,400,700]];
  game.start(seed);
  applyRushAction(game, actions[0]);
  const act = (action: RushAction) => { actions.push(action); applyRushAction(game, action); };
  for (let step = 0; step < 64 * (SHIFT_SECONDS + 1) && game.state === "play"; step++) {
    act([0,1/64]);
    if (String(game.state) !== "play") break;
    for (const flyer of game.flyers) {
      if (flyer.gone || flyer.y > game.H - flyer.r || flyer.y < 70 || !["pizza","jumbo"].includes(flyer.kind)) continue;
      if (game.flyers.some((hazard)=>!hazard.gone && !["pizza","jumbo"].includes(hazard.kind) && Math.hypot(hazard.x-flyer.x,hazard.y-flyer.y)<hazard.r+5)) continue;
      act([2,flyer.x-4,flyer.y]); act([3,flyer.x+4,flyer.y]);
      if (String(game.state) !== "play") break;
      act([4]);
    }
  }
  return { actions, stats:game.stats(), state:game.state };
}
