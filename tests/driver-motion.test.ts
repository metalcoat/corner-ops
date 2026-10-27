import assert from "node:assert/strict";
import test from "node:test";
import { driverMotion } from "../src/lib/driver-motion.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 27, 12, 0, seconds)).toISOString();

test("uses the heading and speed the phone reported", () => {
  assert.deepEqual(driverMotion({ driver_reported_heading: 91.4, driver_reported_speed: 13.4, driver_latitude: 44.69, driver_longitude: -75.49 }), { driver_heading: 91, driver_speed_mph: 30 });
});

test("works out heading and speed from the previous point when the phone doesn't say", () => {
  // ~0.0045 degrees of latitude north in 20 s: about 500 m, heading north, ~56 mph.
  const motion = driverMotion({ driver_latitude: 44.6945, driver_longitude: -75.49, driver_location_captured_at: at(20), driver_previous_latitude: 44.69, driver_previous_longitude: -75.49, driver_previous_captured_at: at(0) });
  assert.equal(motion.driver_heading, 0);
  assert.ok(motion.driver_speed_mph! > 50 && motion.driver_speed_mph! < 60, String(motion.driver_speed_mph));
});

test("a parked phone shows no arrow", () => {
  assert.deepEqual(driverMotion({ driver_reported_heading: 200, driver_reported_speed: 0.3, driver_latitude: 44.69, driver_longitude: -75.49 }), { driver_heading: null, driver_speed_mph: 0 });
});
