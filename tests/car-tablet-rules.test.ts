import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { formatPairingCode, isOnline, normalizePairingCode, pairingCode, PAIRING_ALPHABET, parsePointBatch, snapCameras } from "../src/lib/car-tablet-rules.js";

test("pairing codes are 8 unambiguous characters and survive being typed back", () => {
  for (let index = 0; index < 200; index++) {
    const code = pairingCode((size) => randomBytes(size));
    assert.equal(code.length, 8);
    assert.ok([...code].every((character) => PAIRING_ALPHABET.includes(character)), code);
    assert.equal(normalizePairingCode(formatPairingCode(code).toLowerCase()), code);
  }
  assert.equal(normalizePairingCode(" abcd - efgh "), "ABCDEFGH");
});

test("a GPS batch keeps good points and drops bad ones without failing", () => {
  const now = new Date("2026-10-28T20:00:00Z");
  const { points, rejected } = parsePointBatch([
    { id: "pt-000001", capturedAt: "2026-10-28T19:59:55Z", latitude: 44.6942, longitude: -75.4863, accuracy: 6, speed: 13.2, heading: 271 },
    { id: "pt-000002", capturedAt: Date.parse("2026-10-28T19:59:50Z"), lat: 44.69, lng: -75.48, speed: -1, heading: 999 },
    { id: "pt-000003", capturedAt: "2026-10-29T03:00:00Z", latitude: 44.69, longitude: -75.48 }, // clock far ahead
    { id: "pt-000004", capturedAt: "2026-10-28T19:59:00Z", latitude: 0, longitude: 0 },
    { id: "short", capturedAt: "2026-10-28T19:59:00Z", latitude: 44.69, longitude: -75.48 },
    { id: "pt-000006", capturedAt: "nonsense", latitude: 44.69, longitude: -75.48 },
    { id: "pt-000007", capturedAt: "2026-10-28T19:59:00Z", latitude: 95, longitude: -75.48 },
  ], now);
  assert.equal(rejected, 5);
  assert.deepEqual(points.map((point) => point.id), ["pt-000001", "pt-000002"]);
  assert.equal(points[0].speed, 13.2);
  assert.equal(points[1].speed, null, "a negative speed is unknown, not zero");
  assert.equal(points[1].heading, null);
  assert.deepEqual(parsePointBatch("nope", now), { points: [], rejected: 0 });
});

test("a batch over 500 points is cut, and the rest counted as rejected", () => {
  const now = new Date("2026-10-28T20:00:00Z");
  const many = Array.from({ length: 520 }, (_, index) => ({ id: `pt-${String(index).padStart(6, "0")}`, capturedAt: now.toISOString(), latitude: 44.69, longitude: -75.48 }));
  const { points, rejected } = parsePointBatch(many, now);
  assert.equal(points.length, 500);
  assert.equal(rejected, 20);
});

test("online means a heartbeat or poll in the last 90 seconds", () => {
  const now = new Date("2026-10-28T20:00:00Z");
  assert.equal(isOnline("2026-10-28T19:58:45Z", now), true);
  assert.equal(isOnline("2026-10-28T19:58:00Z", now), false);
  assert.equal(isOnline(null, now), false);
});

test("snap requests name the cameras to fire", () => {
  assert.deepEqual(snapCameras("both"), ["cabin", "road"]);
  assert.deepEqual(snapCameras("road"), ["road"]);
  assert.deepEqual(snapCameras("selfie"), []);
});

test("GPS alone works out which house the car stopped at, and when it drove off", async () => {
  const { stopTransitions } = await import("../src/lib/car-tablet-rules.js");
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 29, 18, 0, seconds));
  const house = { latitude: 44.6950, longitude: -75.4900 };
  const deliveries = [
    { id: "jay", status: "EN_ROUTE", ...house, enRouteAt: at(0), arrivedAt: null },
    { id: "green", status: "EN_ROUTE", latitude: 44.7000, longitude: -75.5000, enRouteAt: at(0), arrivedAt: null },
  ];
  const point = (seconds: number, latitude: number, longitude: number, speed: number | null) =>
    ({ id: `p-${seconds}-xxxx`, capturedAt: at(seconds), latitude, longitude, accuracy: 5, speed, heading: null });
  const points = [
    point(60, 44.6948, -75.4900, 12), // driving past at 27 mph: not a stop
    point(70, 44.6951, -75.4901, 0.4), // stopped ~15 m from the door
    point(80, 44.6951, -75.4901, 0),
    point(130, 44.6980, -75.4900, 11), // ~330 m up the street
  ];
  assert.deepEqual(stopTransitions(deliveries, points).map(({ deliveryId, action }) => `${deliveryId}:${action}`), ["jay:arrived", "jay:delivered"]);
  // A quick pause (10 s) and away isn't a delivery.
  assert.deepEqual(stopTransitions(deliveries, [point(70, 44.6951, -75.4901, 0), point(78, 44.6980, -75.49, 11)]).map((t) => t.action), ["arrived"]);
  // Points from before the car left the store don't count (the store is not the customer).
  assert.deepEqual(stopTransitions([{ ...deliveries[0], enRouteAt: at(100) }], [point(70, 44.6951, -75.4901, 0)]), []);
});

test("the tablet goes quiet from 30 min after close until 30 min before opening", async () => {
  const { quietTime } = await import("../src/lib/car-tablet-rules.js");
  const week = [...Array(5).fill({ opens: "10:30", closes: "21:30" }), { opens: "10:30", closes: "22:30" }, { opens: "10:30", closes: "22:30" }];
  const hours = [week[0], week[1], week[2], week[3], week[4], week[5], week[6]]; // Sun..Sat
  // Thursday 2026-10-29 (EDT, UTC-4).
  const at = (utc: string) => quietTime(hours, new Date(utc));
  assert.deepEqual(at("2026-10-29T17:00:00Z"), { quiet: false, wakeInMinutes: 0 }); // 1:00 PM open
  assert.deepEqual(at("2026-10-30T01:45:00Z"), { quiet: false, wakeInMinutes: 0 }); // 9:45 PM, closed 15 min
  assert.deepEqual(at("2026-10-30T02:05:00Z"), { quiet: true, wakeInMinutes: 715 }); // 10:05 PM → wake 10:00 AM
  assert.deepEqual(at("2026-10-30T13:59:00Z"), { quiet: true, wakeInMinutes: 1 }); // 9:59 AM
  assert.deepEqual(at("2026-10-31T02:45:00Z"), { quiet: false, wakeInMinutes: 0 }); // Friday 10:45 PM, open till 10:30 + 30
  assert.equal(quietTime([], new Date()).quiet, false);
});
