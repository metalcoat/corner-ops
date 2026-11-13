import assert from "node:assert/strict";
import test from "node:test";
import { complexBuilding, unitNumber } from "../src/lib/complex-buildings.js";

test("finds the Belmont Courts building from the unit, however the address is written", () => {
  assert.equal(complexBuilding({ address: "436 Belmont Courts, Ogdensburg, NY 13669", unit: "Apt 153" })?.label, "Bldg 151–158 · Court 100");
  assert.equal(complexBuilding({ address: "Belmont Ct #244, Ogdensburg, NY", unit: "" })?.label, "Bldg 241–248 · Court 200");
  assert.equal(complexBuilding({ address: "Belmont Courts 312, Ogdensburg", unit: "" })?.label, "Bldg 311–318 · Court 300");
  assert.equal(complexBuilding({ address: "Plover Hill Ave, Ogdensburg", unit: "Apt 465", latitude: 44.6990, longitude: -75.4762 })?.label, "Bldg 461–468 · Court 400");
});

test("the complex's own street number (436) is not mistaken for a unit", () => {
  assert.equal(unitNumber("436 Belmont Courts, Ogdensburg, NY 13669", ""), null);
  assert.equal(complexBuilding({ address: "436 Belmont Courts, Ogdensburg, NY 13669", unit: "" }), null);
});

test("other addresses and unknown units are left alone", () => {
  assert.equal(complexBuilding({ address: "412 Jay Street, Ogdensburg", unit: "Apt 153", latitude: 44.6953, longitude: -75.4883 }), null);
  assert.equal(complexBuilding({ address: "Belmont Courts", unit: "Apt 999" }), null);
});
