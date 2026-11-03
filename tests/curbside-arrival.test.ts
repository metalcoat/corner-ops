import assert from "node:assert/strict";
import test from "node:test";
import { carLabel, parseCurbsideArrival } from "../src/lib/curbside-arrival-policy";
import { orderTrail } from "../src/lib/ordering-order-trail";

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

test("curbside: delivered to car shows in who did what", () => {
  const trail = orderTrail({
    createdAt: "2026-11-03T14:00:00.000Z",
    takenBy: "Online",
    events: [{ event_type: "curbside_delivered", created_at: "2026-11-03T14:20:00.000Z", actor_name: "Pat", details: { carColor: "Red", carType: "SUV" } }],
    payments: [],
  });
  assert.deepEqual(trail.at(-1), { at: "2026-11-03T14:20:00.000Z", label: "Delivered to car (curbside)", who: "Pat", detail: "Red SUV" });
});
