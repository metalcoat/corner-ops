import { expect, test, type Page, type Route } from "@playwright/test";
import type { OrderLoyaltyCard, LoyaltyCardEvent } from "../src/lib/ordering-loyalty-card";

const orderId = "loyalty-card-order";
const orderNumber = "1042";
const cardPath = `/api/ordering/orders/${orderId}/loyalty-card`;

function activity(id: string, amount: number, type: string, description: string, extra: Partial<LoyaltyCardEvent> = {}): LoyaltyCardEvent {
  return { id, amount, type, description, reason: "", createdAt: "2026-11-06T18:00:00.000Z", orderId, orderNumber, programName: null, ...extra };
}

function cardFixture(): OrderLoyaltyCard {
  return {
    order: { id: orderId, displayNumber: orderNumber, status: "completed", paymentStatus: "paid", paidCents: 2500, totalCents: 2500, amountDueCents: 0 },
    customer: { id: "loyalty-customer", name: "Jordan Cardholder", active: true },
    points: { active: true, balance: 140, expired: false, rewards: [{ id: "points-reward", label: "Free sub", points: 100, kind: "item" }] },
    programs: [{ id: "jumbo-card", name: "Jumbo Pizza Club", units: 17, progress: 7, quantityRequired: 10, rewardsAvailable: 1 }],
    thisOrder: {
      points: [
        activity("points-earned", 40, "earn", "Order points"),
        activity("points-used", -50, "redeem", "Drink reward"),
        activity("points-returned", 50, "reversal", "Drink reward", { reason: "Reward removed when the drink was cancelled" }),
      ],
      loyalty: [
        activity("jumbo-earned", 2, "earn", "Jumbo pizzas purchased", { programName: "Jumbo Pizza Club" }),
        activity("jumbo-used", -10, "redeem", "Free Jumbo pizza", { programName: "Jumbo Pizza Club" }),
        activity("jumbo-returned", 10, "redemption_reversal", "Free Jumbo pizza", { programName: "Jumbo Pizza Club", reason: "Free pizza was cancelled" }),
      ],
    },
    history: {
      points: [activity("older-points", 25, "earn", "Order points (lunch bonus)", { orderId: "older-order", orderNumber: "1031", createdAt: "2026-11-05T17:00:00.000Z" })],
      loyalty: [activity("older-punch", 1, "earn", "Jumbo pizza purchased", { programName: "Jumbo Pizza Club", orderId: "older-order", orderNumber: "1031", createdAt: "2026-11-05T17:00:00.000Z" })],
    },
    notes: [],
  };
}

async function setup(page: Page, respond: (route: Route) => Promise<void>, linked = true) {
  const mutations: string[] = [];
  const order = {
    id: orderId, display_number: orderNumber, customer_id: linked ? "loyalty-customer" : null,
    customer_name: linked ? "Jordan Cardholder" : "Guest", customer_phone: "", status: "completed", payment_status: "paid",
    service_type: "pickup", source: "pos", order_origin: "walk_in", total_cents: 2500, paid_cents: 2500, amount_due_cents: 0,
    created_at: "2026-11-06T18:00:00.000Z", scheduled_for: null, delivery_address: null, delivery_unit: null, items: [], events: [], trail: [],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      mutations.push(`${route.request().method()} ${path}`);
      await route.fulfill({ status: 405, json: { error: "Read-only test" } });
    } else if (path === cardPath) await respond(route);
    else if (path === "/api/pos/session") await route.fulfill({ json: { authenticated: true, session: { employeeId: "card-test-staff", business: "Corner Deli", name: "Card Test Staff", position: "Cashier", posRole: "employee", clockInRequired: false, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 } } });
    else if (path === "/api/ordering/order-center") await route.fulfill({ json: { orders: [order] } });
    else if (path === `/api/ordering/order-center/${orderId}`) await route.fulfill({ json: { order } });
    else if (path === "/api/ordering/order-center/void-money") await route.fulfill({ json: { orders: [] } });
    else if (path === "/api/ordering/menu") await route.fulfill({ json: { categories: [], availability: { open: true, orderable: true } } });
    else if (path === "/api/ordering/online-alerts") await route.fulfill({ json: { orders: [], paymentReviews: [] } });
    else if (path === "/api/ordering/curbside") await route.fulfill({ json: { arrivals: [] } });
    else await route.fulfill({ status: 404, json: { error: "Unused test endpoint" } });
  });
  await page.goto("/pos/deli/orders");
  await page.locator(".ocOrder").filter({ hasText: `#${orderNumber}` }).click();
  await expect(page.getByRole("button", { name: "POINTS & JUMBO CARD", exact: true })).toBeVisible();
  return mutations;
}

test("staff opens the selected order's current rewards, earnings, redemptions and reversals without changing the account", async ({ page }) => {
  let requests = 0;
  const mutations = await setup(page, async (route) => { requests += 1; await route.fulfill({ json: cardFixture() }); });
  expect(requests).toBe(0);
  await page.getByRole("button", { name: "POINTS & JUMBO CARD", exact: true }).click();
  const card = page.getByRole("dialog", { name: "Points & Jumbo Card", exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByText("Order #1042", { exact: true })).toBeVisible();
  await expect(card.getByText("Jordan Cardholder", { exact: true })).toBeVisible();
  const balances = card.getByRole("region", { name: "Current rewards" });
  await expect(balances).toContainText("140 points");
  await expect(balances).toContainText("1 free pizza available");
  await expect(balances).toContainText("7 / 10 punches toward the next free pizza");
  await expect(balances.getByRole("progressbar", { name: "Jumbo Pizza Club progress" })).toHaveAttribute("value", "7");
  await expect(balances.getByRole("progressbar")).toHaveAttribute("max", "10");
  await expect(balances).toContainText("100 points · Available");
  const current = card.getByRole("region", { name: "This order's loyalty activity" });
  await expect(current).toContainText("Points change: +40");
  await expect(current).toContainText("Jumbo Pizza Club change: +2 punches");
  await expect(current).toContainText("Earned · Order points");
  await expect(current).toContainText("−50 points");
  await expect(current).toContainText("Reversed · Drink reward");
  await expect(current).toContainText("Reward removed when the drink was cancelled");
  await expect(current).toContainText("Reward returned · Free Jumbo pizza");
  await expect(current).toContainText("+10 punches");
  await expect(current.locator("time").first()).toHaveAttribute("datetime", "2026-11-06T18:00:00.000Z");
  await expect(current).toContainText("Nov 6, 2026");
  await expect(current).not.toContainText("#1031");
  const history = card.getByRole("region", { name: "Recent loyalty activity" });
  await expect(history).toContainText("Order #1031");
  await expect(history).toContainText("Order points (lunch bonus)");
  await expect(history).toContainText("+25 points");
  expect(requests).toBe(1);
  expect(mutations).toEqual([]);
});

test("staff can retry a failed loyalty card request", async ({ page }) => {
  let requests = 0;
  await setup(page, async (route) => {
    requests += 1;
    await route.fulfill(requests === 1 ? { status: 503, json: { error: "Loyalty service is temporarily unavailable." } } : { json: cardFixture() });
  });
  await page.getByRole("button", { name: "POINTS & JUMBO CARD", exact: true }).click();
  const card = page.getByRole("dialog", { name: "Points & Jumbo Card", exact: true });
  await expect(card.getByRole("alert")).toHaveText("Loyalty service is temporarily unavailable.");
  await expect(card.getByRole("region", { name: "Current rewards" })).toHaveCount(0);
  await card.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(card.getByRole("region", { name: "Current rewards" })).toContainText("140 points");
  await expect(card.getByRole("alert")).toHaveCount(0);
  expect(requests).toBe(2);
});

test("an order without a linked customer still explains why no loyalty card can be shown", async ({ page }) => {
  const response = cardFixture();
  response.customer = null;
  response.points = { active: false, balance: 0, expired: false, rewards: [] };
  response.programs = [];
  response.thisOrder = { points: [], loyalty: [] };
  response.history = { points: [], loyalty: [] };
  response.notes = [{ code: "no_customer", message: "No customer account is linked to this order." }];
  const mutations = await setup(page, (route) => route.fulfill({ json: response }), false);
  await page.getByRole("button", { name: "POINTS & JUMBO CARD", exact: true }).click();
  const card = page.getByRole("dialog", { name: "Points & Jumbo Card", exact: true });
  await expect(card.getByText("No customer account is linked to this order.", { exact: true })).toBeVisible();
  await expect(card.getByRole("region", { name: "Current rewards" })).toHaveCount(0);
  await expect(card.getByRole("heading", { name: /This order/ })).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test("closing by keyboard returns focus and reopening refreshes balances", async ({ page }) => {
  let requests = 0;
  await setup(page, async (route) => {
    const response = cardFixture();
    response.points.balance = requests++ === 0 ? 140 : 90;
    await route.fulfill({ json: response });
  });
  const trigger = page.getByRole("button", { name: "POINTS & JUMBO CARD", exact: true });
  await trigger.click();
  const card = page.getByRole("dialog", { name: "Points & Jumbo Card", exact: true });
  await expect(card.getByRole("region", { name: "Current rewards" })).toContainText("140 points");
  await page.keyboard.press("Escape");
  await expect(card).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(card.getByRole("region", { name: "Current rewards" })).toContainText("90 points");
  await expect(card.getByRole("region", { name: "Current rewards" })).not.toContainText("140 points");
  await card.getByRole("button", { name: "Close loyalty card", exact: true }).click();
  await expect(card).not.toBeVisible();
  expect(requests).toBe(2);
});

test("negative punch balances explain the adjustment and missing historical dates remain readable", async ({ page }) => {
  const response = cardFixture();
  response.programs[0] = { ...response.programs[0], units: -3, progress: 0, rewardsAvailable: 0 };
  response.thisOrder = { points: [], loyalty: [] };
  response.history.points[0].createdAt = "";
  await setup(page, (route) => route.fulfill({ json: response }));
  await page.getByRole("button", { name: "POINTS & JUMBO CARD", exact: true }).click();
  const card = page.getByRole("dialog", { name: "Points & Jumbo Card", exact: true });
  const balances = card.getByRole("region", { name: "Current rewards" });
  await expect(balances).toContainText("0 free pizzas available");
  await expect(balances).toContainText("Punch balance: −3. New qualifying punches first cover this adjustment");
  await expect(card.getByRole("region", { name: "This order's loyalty activity" })).toContainText("No points or Jumbo punches have been earned, used, or returned on this order.");
  await expect(card.getByRole("region", { name: "Recent loyalty activity" })).toContainText("Date unavailable");
});
