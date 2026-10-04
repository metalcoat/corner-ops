import test from "node:test";
import assert from "node:assert/strict";
import {
  previousDaySpilloverCovers,
  sameDayWindowCovers,
  windowsCoverMinute,
} from "../src/lib/ordering-hours-math.js";

const at = (hour: number, minute = 0) => hour * 60 + minute;
const overnight = { open: at(18), close: at(2) };

test("an overnight window does not cover the early morning of its own date", () => {
  assert.equal(sameDayWindowCovers(overnight.open, overnight.close, at(1)), false);
  assert.equal(sameDayWindowCovers(overnight.open, overnight.close, at(17, 59)), false);
  assert.equal(sameDayWindowCovers(overnight.open, overnight.close, at(18)), true);
  assert.equal(sameDayWindowCovers(overnight.open, overnight.close, at(23, 59)), true);
});

test("the previous day's overnight window covers through its inclusive close", () => {
  assert.equal(previousDaySpilloverCovers(overnight.open, overnight.close, at(0)), true);
  assert.equal(previousDaySpilloverCovers(overnight.open, overnight.close, at(2)), true);
  assert.equal(previousDaySpilloverCovers(overnight.open, overnight.close, at(2, 1)), false);
  // A same-day window never spills into the next date.
  assert.equal(previousDaySpilloverCovers(at(9), at(21, 30), at(1)), false);
});

test("same-day windows keep the inclusive cutoff minute", () => {
  assert.equal(sameDayWindowCovers(at(9), at(21, 30), at(21, 30)), true);
  assert.equal(sameDayWindowCovers(at(9), at(21, 30), at(21, 31)), false);
  assert.equal(sameDayWindowCovers(at(9), at(21, 30), at(8, 59)), false);
});

test("1 a.m. is open only when yesterday had the overnight window", () => {
  assert.equal(windowsCoverMinute([overnight], [], at(1)), false);
  assert.equal(windowsCoverMinute([], [overnight], at(1)), true);
  assert.equal(windowsCoverMinute([overnight], [overnight], at(3)), false);
  assert.equal(windowsCoverMinute([overnight], [], at(19)), true);
});

