import assert from "node:assert/strict";
import test from "node:test";
import { orderTrail } from "../src/lib/ordering-order-trail";

const at = (minute: number) => `2026-10-31T14:${String(minute).padStart(2, "0")}:00.000Z`;

test("the trail shows who did each step, in order", () => {
  const trail = orderTrail({
    createdAt: at(5), takenBy: "Sam",
    events: [
      { event_type: "order_created", created_at: at(5), details: { orderStartedAt: at(1) } },
      { event_type: "status_changed", created_at: at(6), actor_name: "Sam", details: { to: "sent_to_kitchen" } },
      { event_type: "status_changed", created_at: at(20), actor_name: "Pat", details: { to: "sent_to_kitchen" } },
    ],
    payments: [{ created_at: at(10), transaction_type: "payment", tender_type: "card", amount_cents: 1250, brand: "Visa", last4: "1111", taken_by: "Pat" }],
  });
  assert.deepEqual(trail.map((row) => [row.at, row.label, row.who]), [
    [at(1), "Order started", "Sam"],
    [at(6), "Sent to kitchen", "Sam"],
    [at(10), "Payment taken $12.50", "Pat"],
    [at(20), "Sent to kitchen again", "Pat"],
  ]);
  assert.equal(trail[2].detail, "Visa ····1111");
});

test("orders from before the start time was kept say when they were saved", () => {
  const [first] = orderTrail({ createdAt: at(5), takenBy: "Online", events: [{ event_type: "order_created", created_at: at(5), details: {} }], payments: [] });
  assert.equal(first.label, "Order saved");
  assert.equal(first.at, at(5));
});
