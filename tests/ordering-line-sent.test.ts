import assert from "node:assert/strict";
import test from "node:test";
import { orderLineWasSent } from "../src/lib/ordering-reopen-policy";

test("voids: a never-sent order has no sent lines", () => {
  assert.equal(orderLineWasSent({ submittedAt: null, itemId: "a" }), false);
  assert.equal(orderLineWasSent({ submittedAt: null, reopenedItemIds: ["a"], itemId: "a" }), false);
});

test("voids: on a sent order every line was sent, unless it was added after reopening", () => {
  assert.equal(orderLineWasSent({ submittedAt: "2026-10-30T10:00:00Z", itemId: "a" }), true);
  assert.equal(orderLineWasSent({ submittedAt: "2026-10-30T10:00:00Z", reopenedItemIds: ["a"], itemId: "a" }), true);
  assert.equal(orderLineWasSent({ submittedAt: "2026-10-30T10:00:00Z", reopenedItemIds: ["a"], itemId: "b" }), false);
});
