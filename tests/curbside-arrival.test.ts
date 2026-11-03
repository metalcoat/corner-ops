import assert from "node:assert/strict";
import test from "node:test";
import { carLabel, parseCurbsideArrival } from "../src/lib/curbside-arrival-policy";

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
