import assert from "node:assert/strict";
import test from "node:test";
import { BACK_TILL_BAG, FRONT_TILL_FLOAT, countsTotalCents, defaultTillSettings, emptyCounts, parseDenominationCounts, parseTillSettings, planCloseout, planFloat, planTotalCents, tillLabel, tillSettings } from "../src/lib/till-reset-rules";

const drawer = (partial: Record<string, number>) => ({ ...emptyCounts(), ...partial });

test("till settings: front till floats $100, back till is emptied and keeps a $60 bag", () => {
  assert.equal(planTotalCents(FRONT_TILL_FLOAT), 10000);
  assert.equal(planTotalCents(BACK_TILL_BAG), 6000);
  assert.deepEqual(defaultTillSettings({ terminalKey: "upfront-register" }), { float: FRONT_TILL_FLOAT, bag: null });
  assert.deepEqual(defaultTillSettings({ terminalKey: "back-register" }), { float: [], bag: BACK_TILL_BAG });
  assert.equal(tillLabel({ terminalKey: "back-register" }), "back till");
  assert.equal(tillLabel({ terminalKey: "upfront-register" }), "front till");
  assert.equal(tillLabel({ terminalKey: "backyard" }), "front till");
});

test("till settings: validated when a manager saves them", () => {
  const saved = parseTillSettings({ float: [{ key: "tens", targetCents: 5000, minCents: 0, maxCents: 6000 }, { key: "ones", targetCents: 5000, minCents: 2000, maxCents: 6000 }], bag: [] });
  assert.deepEqual(saved.float.map((i) => i.key), ["ones", "tens"]);
  assert.equal(saved.bag, null);
  assert.throws(() => parseTillSettings({ float: [{ key: "quarters", targetCents: 510, minCents: 0, maxCents: 1000 }] }), /multiple of \$0\.25/);
  assert.throws(() => parseTillSettings({ float: [{ key: "ones", targetCents: 500, minCents: 1000, maxCents: 2000 }] }), /minimum ≤ target ≤ limit/);
  assert.throws(() => parseTillSettings({ float: [{ key: "ones", targetCents: 100, minCents: 0, maxCents: 100 }, { key: "ones", targetCents: 100, minCents: 0, maxCents: 100 }] }), /listed twice/);
  assert.equal(tillSettings({ terminalKey: "upfront-register", settings: { float: "junk" } }).float.length, 4);
});

test("till count: denominations total and validate", () => {
  assert.equal(countsTotalCents(drawer({ pennies: 3, quarters: 4, ones: 2, twenties: 1, hundreds: 1 })), 12303);
  assert.deepEqual(parseDenominationCounts({ ones: "5", fives: "" }), drawer({ ones: 5 }));
  assert.throws(() => parseDenominationCounts({ ones: 1.5 }), /\$1 bills must be a whole number/);
  assert.throws(() => parseDenominationCounts({ dimes: -1 }), /Dimes/);
});

test("front float: the target make-up when the drawer has it, never small coin or $20+", () => {
  const counted = drawer({ pennies: 80, nickels: 40, dimes: 40, quarters: 60, ones: 60, fives: 12, tens: 8, twenties: 10, fifties: 1, hundreds: 1 });
  const plan = planFloat(counted, FRONT_TILL_FLOAT, "Till");
  assert.deepEqual(plan.leave, drawer({ quarters: 20, ones: 25, fives: 6, tens: 4 }));
  assert.equal(plan.leaveCents, 10000);
  assert.deepEqual(plan.flags, []);
});

test("front float: short of tens is made up from the next sizes within the limits, and flagged", () => {
  const plan = planFloat(drawer({ quarters: 100, ones: 60, fives: 20, tens: 1, twenties: 5 }), FRONT_TILL_FLOAT, "Till");
  assert.equal(plan.leaveCents, 10000);
  assert.equal(plan.leave.twenties, 0);
  assert.ok(plan.leave.quarters <= 40 && plan.leave.ones <= 40 && plan.leave.fives <= 9);
  assert.match(plan.flags.join(" "), /\$10\.00 in \$10 bills instead of \$40\.00/);
});

test("front float: under a minimum or short overall is flagged, not filled with $20s", () => {
  const plan = planFloat(drawer({ quarters: 8, ones: 10, twenties: 5 }), FRONT_TILL_FLOAT, "Till");
  assert.equal(plan.leaveCents, 1200);
  assert.equal(plan.shortCents, 8800);
  assert.match(plan.flags.join(" "), /only \$2\.00 in Quarters \(minimum \$5\.00\)/);
  assert.match(plan.flags.join(" "), /short \$88\.00/);
});

test("back till: drawer goes to $0, the bag is trimmed or topped up to $60 and flagged", () => {
  const settings = defaultTillSettings({ terminalKey: "back-register" });
  const exact = planCloseout(drawer({ ones: 20, twenties: 3 }), drawer({ quarters: 8, ones: 28, fives: 6 }), settings);
  assert.equal(exact.leaveCents, 0);
  assert.equal(exact.bag?.leaveCents, 6000);
  assert.deepEqual(exact.bag?.flags, []);
  assert.equal(exact.depositCents, 8000);
  const short = planCloseout(drawer({ ones: 20, fives: 2, twenties: 3 }), drawer({ quarters: 8, ones: 18, fives: 6 }), settings);
  assert.equal(short.bag?.leaveCents, 6000);
  assert.equal(short.bag?.leave.ones, 28);
  assert.match(short.bag?.flags[0] || "", /Change bag counted \$50\.00, should be \$60\.00 \(topped up from the drawer\)/);
  assert.equal(short.depositCents, 9000 - 1000);
  const over = planCloseout(drawer({}), drawer({ quarters: 8, ones: 33, fives: 6 }), settings);
  assert.equal(over.depositCents, 500);
  assert.match(over.bag?.flags[0] || "", /extra goes in the deposit/);
});

test("front till closeout: deposit is everything but the float", () => {
  const counted = drawer({ quarters: 40, ones: 40, fives: 10, tens: 6, twenties: 4 });
  const plan = planCloseout(counted, null, defaultTillSettings({ terminalKey: "upfront-register" }));
  assert.equal(plan.bag, null);
  assert.equal(plan.leaveCents, 10000);
  assert.equal(plan.depositCents, countsTotalCents(counted) - 10000);
});
