import assert from "node:assert/strict";
import test from "node:test";
import { cashToRemoveCents, countsTotalCents, defaultTillResetCents, emptyCounts, parseDenominationCounts, planTillReset, tillLabel, tillResetCents } from "../src/lib/till-reset-rules";

test("till reset: front till keeps $100, back till is emptied", () => {
  assert.equal(defaultTillResetCents({ terminalKey: "upfront-register", name: "upfront-register" }), 10000);
  assert.equal(defaultTillResetCents({ terminalKey: "back-register", name: "back-register" }), 0);
  assert.equal(defaultTillResetCents({ terminalKey: "back", name: "Back" }), 0);
  assert.equal(defaultTillResetCents({ terminalKey: "front-till" }), 10000);
  assert.equal(defaultTillResetCents({ terminalKey: "backyard" }), 10000);
  assert.equal(tillLabel({ terminalKey: "back-register" }), "back till");
  assert.equal(tillLabel({ terminalKey: "upfront-register" }), "front till");
});

test("till reset: a manager-set amount wins over the default, including $0", () => {
  assert.equal(tillResetCents({ terminalKey: "upfront-register", resetCashCents: 15000 }), 15000);
  assert.equal(tillResetCents({ terminalKey: "upfront-register", resetCashCents: 0 }), 0);
  assert.equal(tillResetCents({ terminalKey: "back-register", resetCashCents: null }), 0);
  assert.equal(tillResetCents({ terminalKey: "upfront-register", resetCashCents: -5 }), 10000);
});

test("till reset: cash to pull for the deposit", () => {
  assert.equal(cashToRemoveCents(41250, 10000), 31250);
  assert.equal(cashToRemoveCents(8000, 10000), 0);
  assert.equal(cashToRemoveCents(5000, 0), 5000);
});

const drawer = (partial: Record<string, number>) => ({ ...emptyCounts(), ...partial });

test("till count: denominations total and validate", () => {
  assert.equal(countsTotalCents(drawer({ pennies: 3, quarters: 4, ones: 2, twenties: 1, hundreds: 1 })), 12303);
  assert.deepEqual(parseDenominationCounts({ ones: "5", fives: "" }), drawer({ ones: 5 }));
  assert.throws(() => parseDenominationCounts({ ones: 1.5 }), /\$1 bills must be a whole number/);
  assert.throws(() => parseDenominationCounts({ dimes: -1 }), /Dimes/);
});

test("till count: front float uses the preferred $100 make-up when the drawer has it", () => {
  const counted = drawer({ pennies: 80, nickels: 40, dimes: 40, quarters: 60, ones: 60, fives: 12, tens: 8, twenties: 10, fifties: 1, hundreds: 1 });
  const plan = planTillReset(counted, 10000);
  assert.deepEqual(plan.leave, drawer({ pennies: 50, nickels: 20, dimes: 25, quarters: 24, ones: 25, fives: 5, tens: 4 }));
  assert.equal(plan.leaveCents, 10000);
  assert.equal(plan.depositCents, countsTotalCents(counted) - 10000);
  assert.equal(plan.deposit.twenties, 10);
});

test("till count: tops up with small bills when short of the preferred make-up, every leave count is in the drawer", () => {
  const counted = drawer({ ones: 40, fives: 2, twenties: 6 });
  const plan = planTillReset(counted, 10000);
  assert.equal(plan.leaveCents, 10000);
  assert.equal(plan.shortCents, 0);
  assert.equal(plan.leave.ones, 30);
  assert.equal(plan.leave.fives, 2);
  assert.equal(plan.leave.twenties, 3);
  for (const [key, count] of Object.entries(plan.leave)) assert.ok(count <= counted[key as keyof typeof counted]);
});

test("till count: back till leaves nothing; a drawer that can't make $100 leaves what it can", () => {
  const counted = drawer({ ones: 12, twenties: 3 });
  assert.equal(planTillReset(counted, 0).leaveCents, 0);
  assert.equal(planTillReset(counted, 0).depositCents, 7200);
  const all = planTillReset(drawer({ ones: 30, fives: 4 }), 10000);
  assert.equal(all.leaveCents, 5000);
  assert.equal(all.shortCents, 5000);
  const gap = planTillReset(drawer({ twenties: 4, fifties: 1, quarters: 1 }), 10000);
  assert.deepEqual(gap.leave, drawer({ quarters: 1, twenties: 2, fifties: 1 }));
  assert.equal(gap.shortCents, 975);
});
