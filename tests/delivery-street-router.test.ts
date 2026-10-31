import assert from "node:assert/strict";
import test from "node:test";
import { StreetRouter, planStreetRoute, type RouteMapData } from "../src/lib/delivery-street-router.js";

// A ladder of streets ~110 m apart: "Quiet St" along the top (preferred), "Busy St" along the bottom
// with a stop sign at every crossing, joined by short cross streets. Node i: x = i % 5, y = row.
const lat = (row: number) => 44.69 + row * 0.001, lng = (column: number) => -75.49 + column * 0.0014;
const nodes: Array<[number, number]> = [];
for (let row = 0; row < 2; row++) for (let column = 0; column < 5; column++) nodes.push([lat(row), lng(column)]);
const base = (prefs: RouteMapData["prefs"], stops: RouteMapData["stops"], oneway = 0): RouteMapData => ({
  names: ["Busy Street", "Quiet Street", "Cross Street"],
  classes: ["residential"],
  nodes,
  ways: [[0, 0, 0, [0, 1, 2, 3, 4]], [1, 0, oneway, [5, 6, 7, 8, 9]], [2, 0, 0, [0, 5]], [2, 0, 0, [4, 9]], [2, 0, 0, [2, 7]]],
  signals: [],
  stops,
  prefs,
});
const from = { latitude: lat(0), longitude: lng(0) - 0.00001 }, to = { latitude: lat(0), longitude: lng(4) + 0.00001 };

test("goes round on the preferred street instead of through the stop signs", () => {
  const stopEveryBlock: RouteMapData["stops"] = [[1, 0], [2, 1], [3, 2], [4, 3]];
  const leg = new StreetRouter(base({ "Quiet Street": "prefer", "Busy Street": "avoid" }, stopEveryBlock)).route(from, to)!;
  assert.deepEqual(leg.streets, ["Cross Street", "Quiet Street", "Cross Street"]);
  assert.equal(leg.stopSigns, 0);
  assert.ok(leg.preferredMetres > 400);
});

test("one stop sign isn't worth a detour; four in a row are", () => {
  const one = new StreetRouter(base({}, [[2, 1]])).route(from, to)!;
  assert.deepEqual(one.streets, ["Busy Street"]);
  assert.equal(one.stopSigns, 1);
  const four = new StreetRouter(base({}, [[1, 0], [2, 1], [3, 2], [4, 3]])).route(from, to)!;
  assert.equal(four.stopSigns, 0, four.streets.join(" → "));
});

test("never drives a one-way street the wrong way", () => {
  // Quiet Street one-way westbound (backwards along its node list): going east it can't be used.
  const leg = new StreetRouter(base({ "Quiet Street": "prefer", "Busy Street": "avoid" }, [], -1)).route(from, to)!;
  assert.deepEqual(leg.streets, ["Busy Street"]);
});

test("a round trip visits every stop once, comes back, and pins Google Maps to the preferred street", () => {
  const router = new StreetRouter(base({ "Quiet Street": "prefer" }, []));
  const now = new Date("2026-10-29T17:00:00Z");
  const stop = (id: string, column: number) => ({ deliveryId: id, displayNumber: id, customerName: id, address: id, latitude: lat(1), longitude: lng(column), timingMode: "asap", scheduledFor: null, createdAt: now.toISOString() });
  const plan = planStreetRoute([stop("far", 4), stop("near", 1)], { latitude: lat(0), longitude: lng(0) }, router, now)!;
  assert.deepEqual(plan.stops.map((s) => s.displayNumber), ["near", "far"]);
  assert.ok(plan.navigationUrl!.includes(`destination=${lat(0)}%2C${lng(0)}`), "ends back at the deli");
  assert.ok(plan.loopMinutes >= 1 && plan.path.length > 4);
});

test("an avoid street is closed unless the trip starts or ends on it", () => {
  // Busy St avoided, Quiet St neutral: the 4-block (~470 m) run along Busy St must go round on Quiet St.
  const router = new StreetRouter(base({ "Busy Street": "avoid" }, []));
  assert.deepEqual(router.route(from, to)!.streets, ["Cross Street", "Quiet Street", "Cross Street"]);
  // A house in the middle of Busy St: reach it, using Busy St only for the last block.
  const leg = router.route({ latitude: lat(1), longitude: lng(0) }, { latitude: lat(0), longitude: lng(1) })!;
  assert.equal(leg.streets.at(-1), "Busy Street");
  assert.ok(leg.avoidMetres < 250, String(leg.avoidMetres));
});

test("turn-by-turn steps name each street and the turn onto it", () => {
  const leg = new StreetRouter(base({ "Busy Street": "avoid" }, [])).route(from, to)!;
  assert.deepEqual(leg.steps.map((step) => step.maneuver), ["depart", "right", "right", "arrive"]);
  assert.equal(leg.steps[0].instruction, "Head north on Cross Street");
  assert.equal(leg.steps[1].instruction, "Turn right onto Quiet Street");
  assert.ok(leg.steps[1].metres > 400, String(leg.steps[1].metres));
});
