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
