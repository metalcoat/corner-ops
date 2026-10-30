import assert from "node:assert/strict";
import test from "node:test";
import { cashToRemoveCents, defaultTillResetCents, tillLabel, tillResetCents } from "../src/lib/till-reset-rules";

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
