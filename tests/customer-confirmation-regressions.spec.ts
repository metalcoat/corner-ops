import { expect, test, type Page } from "@playwright/test";

function orderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "confirmation-test", display_number: 42, status: "sent_to_kitchen", payment_status: "paid",
    service_type: "pickup", first_name_snapshot: "Test", email_snapshot: "test@example.com",
    total_cents: 1000, paid_cents: 1000, amount_due_cents: 0, refunded_cents: 0,
    held_until_prep: false, lines: [], receipt_rows: [], ...overrides,
  };
}

async function showOrder(page: Page, order: ReturnType<typeof orderFixture>) {
  await page.route("**/api/customer/orders/confirmation-test", (route) => route.fulfill({ json: { order, delivery: null, store: null } }));
  await page.goto("/order/confirmation?orderId=confirmation-test");
}

test("a scheduled order stays on Order placed until kitchen prep begins", async ({ page }) => {
  await showOrder(page, orderFixture({
    timing_mode: "future", held_until_prep: true,
    scheduled_for: "2026-12-10T23:00:00Z", kitchen_release_at: "2026-12-10T22:25:00Z",
    timing_message_snapshot: "Pickup Thu, Dec 10 at 6:00 PM",
  }));
  await expect(page.getByRole("heading", { name: "Your order is scheduled" })).toBeVisible();
  await expect(page.locator(".trackerSteps [aria-current=step]")).toHaveText("Order placed");
  await expect(page.getByText("Pickup Thu, Dec 10 at 6:00 PM")).toBeVisible();
  await expect(page.getByText("We'll start making it closer to your scheduled time.")).toBeVisible();
});

test("a released scheduled order advances to Making it", async ({ page }) => {
  await showOrder(page, orderFixture({ timing_mode: "future", held_until_prep: false }));
  await expect(page.getByRole("heading", { name: "We're making it" })).toBeVisible();
  await expect(page.locator(".trackerSteps [aria-current=step]")).toHaveText("Making it");
});

test("an ASAP curbside preorder queues for opening and hides early check-in", async ({ page }) => {
  await showOrder(page, orderFixture({ service_type: "curbside", timing_mode: "asap", waiting_for_open: true,
    timing_message_snapshot: "ASAP for the next opening. We open Mon 10:30 AM; Give us 30 minutes for pickup." }));
  await expect(page.getByRole("heading", { name: "Your order is queued for opening" })).toBeVisible();
  await expect(page.locator(".trackerSteps [aria-current=step]")).toHaveText("Order placed");
  await expect(page.locator(".curbsideCheckIn")).toHaveCount(0);
  await expect(page.locator(".confirmationTiming")).toContainText("Mon 10:30 AM");
});

test("curbside check-in appears after opening and remains hidden during a future prep hold", async ({ page }) => {
  await showOrder(page, orderFixture({ service_type: "curbside", timing_mode: "asap", waiting_for_open: false }));
  await expect(page.getByRole("heading", { name: "We're making it" })).toBeVisible();
  await expect(page.locator(".curbsideCheckIn")).toBeVisible();
  await page.unroute("**/api/customer/orders/confirmation-test");
  await showOrder(page, orderFixture({ service_type: "curbside", timing_mode: "future", held_until_prep: true }));
  await expect(page.getByRole("heading", { name: "Your order is scheduled" })).toBeVisible();
  await expect(page.locator(".curbsideCheckIn")).toHaveCount(0);
});

for (const scenario of [
  { name: "full refund", status: "completed", payment_status: "refunded", paid_cents: 0, refunded_cents: 1000, label: "Refunded", amount: "$10.00" },
  { name: "partial refund", status: "ready", payment_status: "partially_refunded", paid_cents: 700, refunded_cents: 300, label: "Partially refunded", amount: "$3.00" },
  { name: "legacy refund with unpaid status", status: "ready", payment_status: "unpaid", paid_cents: 0, refunded_cents: 1000, label: "Refunded", amount: "$10.00" },
  { name: "cancelled refunded order", status: "cancelled", payment_status: "refunded", paid_cents: 0, refunded_cents: 1000, label: "Refunded", amount: "$10.00" },
  { name: "cancelled unpaid order", status: "cancelled", payment_status: "unpaid", paid_cents: 0, refunded_cents: 0, label: "No payment due", amount: "$0.00" },
]) {
  test(`${scenario.name} never asks the customer to pay again`, async ({ page }) => {
    await showOrder(page, orderFixture({ ...scenario, amount_due_cents: 1000 - scenario.paid_cents }));
    await expect(page.locator(".confirmationDue")).toHaveText(`${scenario.label}${scenario.amount}`);
    await expect(page.locator(".confirmationDue")).not.toContainText("Due at");
    if (scenario.status === "cancelled") {
      await expect(page.getByRole("heading", { name: "Order cancelled" })).toBeVisible();
      await expect(page.getByText("This order has been cancelled.")).toBeVisible();
    }
  });
}

test("an unpaid accepted order still shows its balance at pickup", async ({ page }) => {
  await showOrder(page, orderFixture({ payment_status: "unpaid", paid_cents: 0, amount_due_cents: 1000 }));
  await expect(page.locator(".confirmationDue")).toHaveText("Due at pickup$10.00");
});

test("a repaid order shows paid even when its history contains a reversal", async ({ page }) => {
  await showOrder(page, orderFixture({ refunded_cents: 1000 }));
  await expect(page.locator(".confirmationDue")).toHaveText("Paid$10.00");
});
