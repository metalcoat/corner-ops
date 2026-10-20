import assert from "node:assert/strict";
import test from "node:test";
import { clockLabel, GREETER_HOURS, hoursRows } from "../src/lib/greeter-hours";

test("greeter hours: clock labels", () => {
  assert.equal(clockLabel("10:30"), "10:30 AM");
  assert.equal(clockLabel("21:30"), "9:30 PM");
  assert.equal(clockLabel("12:00"), "12 PM");
  assert.equal(clockLabel("00:15"), "12:15 AM");
});

test("greeter hours: Corner Deli's week groups the way the deli writes it", () => {
  assert.deepEqual(hoursRows(GREETER_HOURS).map(({ days, time }) => [days, time]), [
    ["Sunday – Thursday", "10:30 AM – 9:30 PM"],
    ["Friday – Saturday", "10:30 AM – 10:30 PM"],
  ]);
});

test("greeter hours: closed days and single days", () => {
  const week = [null, { opens: "07:00", closes: "19:00" }, { opens: "07:00", closes: "19:00" }, null, null, { opens: "08:00", closes: "15:00" }, null];
  assert.deepEqual(hoursRows(week).map(({ days, time }) => [days, time]), [
    ["Sunday", "Closed"], ["Monday – Tuesday", "7 AM – 7 PM"], ["Wednesday – Thursday", "Closed"], ["Friday", "8 AM – 3 PM"], ["Saturday", "Closed"],
  ]);
});
