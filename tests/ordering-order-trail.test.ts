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

test("the trail also shows kitchen steps, add-ons, tips, credit, reprints and AI pickup/delivery switches", () => {
  const trail = orderTrail({
    createdAt: at(1), takenBy: "AI phone",
    events: [
      { event_type: "draft_service_changed", created_at: at(2), actor_id: "openai:call-1", details: { from: "pickup", to: "delivery" } },
      { event_type: "status_changed", created_at: at(3), actor_id: "openai:call-1", details: { to: "sent_to_kitchen" } },
      { event_type: "kitchen_released", created_at: at(4), actor_id: "kitchen-release", details: {} },
      { event_type: "status_changed", created_at: at(5), actor_name: "Kim", details: { from: "sent_to_kitchen", to: "ready" } },
      { event_type: "tip_updated", created_at: at(6), actor_name: "Pat", details: { orderTipCents: 300, previousTipCents: 0 } },
      { event_type: "store_credit_applied", created_at: at(7), actor_name: "Pat", details: { amountCents: 500 } },
      { event_type: "order_addition_submitted", created_at: at(8), actor_name: "Pat", details: { additionalAmountDueCents: 250 } },
      { event_type: "payment_receipt_reprinted", created_at: at(9), actor_name: "Pat", details: { reason: "Customer asked" } },
      { event_type: "status_changed", created_at: at(10), actor_name: "Kim", details: { from: "ready", to: "completed" } },
    ],
    payments: [],
  });
  assert.deepEqual(trail.slice(1).map((row) => [row.label, row.who]), [
    ["Changed pickup to delivery", "AI phone"],
    ["Sent to kitchen", "AI phone"],
    ["Released to kitchen (scheduled order)", "System"],
    ["Marked ready", "Kim"],
    ["Tip set to $3.00", "Pat"],
    ["Store credit used $5.00", "Pat"],
    ["Add-on sent to kitchen", "Pat"],
    ["Receipt reprinted", "Pat"],
    ["Completed", "Kim"],
  ]);
});
