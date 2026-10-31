import test from "node:test";
import assert from "node:assert/strict";
import { smsCodeRequired } from "../src/lib/online-order-verification.js";

const now = new Date("2026-10-26T15:00:00Z");
const later = new Date("2026-10-26T16:00:00Z");
const earlier = new Date("2026-10-26T14:00:00Z");

test("only a guest paying cash at pickup or delivery needs the texted code", () => {
  assert.equal(smsCodeRequired({ payment: "pay_later", signedIn: false, bypassUntil: null, now }), true);
  assert.equal(smsCodeRequired({ payment: "card", signedIn: false, bypassUntil: null, now }), false);
  assert.equal(smsCodeRequired({ payment: "saved_card", signedIn: true, bypassUntil: null, now }), false);
  assert.equal(smsCodeRequired({ payment: "pay_later", signedIn: true, bypassUntil: null, now }), false);
});

test("a manager's skip lasts until its end time, then the code is back", () => {
  assert.equal(smsCodeRequired({ payment: "pay_later", signedIn: false, bypassUntil: later, now }), false);
  assert.equal(smsCodeRequired({ payment: "pay_later", signedIn: false, bypassUntil: earlier, now }), true);
});
