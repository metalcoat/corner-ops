import test from "node:test";
import assert from "node:assert/strict";
import { businessDayBoundary } from "../src/lib/business-day.js";

const iso = (value: string, end = false) => businessDayBoundary(value, end).toISOString();

test("summer business days start at 4 AM EDT", () => {
  assert.equal(iso("2026-07-15"), "2026-07-15T08:00:00.000Z");
  assert.equal(iso("2026-07-15", true), "2026-07-16T08:00:00.000Z");
});

test("winter business days start at 4 AM EST, not the day before", () => {
  assert.equal(iso("2026-12-15"), "2026-12-15T09:00:00.000Z");
  assert.equal(iso("2026-12-15", true), "2026-12-16T09:00:00.000Z");
});

test("the business day spanning fall-back (Oct 31 2026) is 25 hours long", () => {
  assert.equal(iso("2026-10-31"), "2026-10-31T08:00:00.000Z");
  assert.equal(iso("2026-10-31", true), "2026-11-01T09:00:00.000Z");
  assert.equal(iso("2026-11-01"), "2026-11-01T09:00:00.000Z");
});

test("the business day spanning spring-forward (Mar 13 2027) is 23 hours long", () => {
  assert.equal(iso("2027-03-13"), "2027-03-13T09:00:00.000Z");
  assert.equal(iso("2027-03-13", true), "2027-03-14T08:00:00.000Z");
});

test("bad dates are rejected", () => {
  assert.throws(() => businessDayBoundary("12/15/2026"));
});
