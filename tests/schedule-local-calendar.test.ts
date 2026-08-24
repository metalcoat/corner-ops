import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newYorkDateKey, newYorkDateTime, newYorkTimeValue } from "../src/lib/schedule-meal-compliance.js";

test("midnight UTC belongs to the prior New York calendar date during EDT", () => {
  assert.equal(newYorkDateKey("2026-08-28T00:00:00.000Z"), "2026-08-27");
});

test("moving a shift to Friday preserves its New York clock time", () => {
  const original = new Date("2026-08-28T00:00:00.000Z");
  const localTime = newYorkTimeValue(original);
  assert.equal(localTime, "20:00");
  assert.equal(newYorkDateTime("2026-08-28", localTime).toISOString(), "2026-08-29T00:00:00.000Z");
});

test("manager schedule board groups and moves shifts using New York calendar dates", () => {
  const source = readFileSync(join(process.cwd(), "src/app/ops/workforce/schedule-board.tsx"), "utf8");
  assert.match(source, /function dateKey\([\s\S]*return newYorkDateKey\(value\)/);
  assert.match(source, /const targetDate = newYorkDateKey\(targetDay\)/);
  assert.match(source, /newYorkDateTime\(targetDate, originalLocalTime\)/);
  assert.match(source, /const key = newYorkDateKey\(shift\.startsAt\)/);
  assert.match(source, /employee-preview\?business=/);
});
