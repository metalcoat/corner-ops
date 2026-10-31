import assert from "node:assert/strict";
import test from "node:test";
import { carLabel, newArrivals, parseCurbsideArrival } from "../src/lib/curbside-arrival-policy";

test("curbside: car choices are validated", () => {
  assert.deepEqual(parseCurbsideArrival({ carColor: "Silver", carType: "SUV" }), { carColor: "Silver", carType: "SUV" });
  assert.throws(() => parseCurbsideArrival({ carColor: "<b>", carType: "SUV" }), /color/);
  assert.throws(() => parseCurbsideArrival({ carColor: "Red" }), /type of car/);
});

test("curbside: car label", () => {
  assert.equal(carLabel("Silver", "SUV"), "Silver SUV");
  assert.equal(carLabel("Other", "Truck"), "Truck");
  assert.equal(carLabel("Red", "Other"), "Red");
  assert.equal(carLabel("Other", "Other"), "Car");
});

test("curbside: TV rings once per new arrival, not for ones already showing at load", () => {
  const state = { initialized: false, seen: new Set<number>() };
  assert.deepEqual(newArrivals(state, [4]), []);
  assert.deepEqual(newArrivals(state, [4, 5]), [5]);
  assert.deepEqual(newArrivals(state, [5]), []);
  assert.deepEqual(newArrivals(state, [5, 6, 7]), [6, 7]);
});
