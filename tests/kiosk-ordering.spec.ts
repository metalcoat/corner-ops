import { expect, test } from "@playwright/test";

test("in-store kiosk loads the customer-safe menu and starts a cart", async ({ page }) => {
  await page.goto("/kiosk/deli");
  await expect(page.getByText("CORNER DELI SELF-SERVICE", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Search menu")).toBeVisible();
  await page.getByRole("button", { name: "START ORDER", exact: true }).click();
  const firstItem = page.locator(".menuItem:not(:disabled)").first();
  await expect(firstItem).toBeVisible();
  await firstItem.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("button", { name: /Add to order/i })).toBeVisible();
});

test("kiosk cart lists the customer's selected modifiers", async ({ page }) => {
  await page.route("**/api/customer/catalog*", (route) => route.fulfill({ json: {
    availability: { open: true, orderable: true, reason: "", opensAt: null, nextAvailableAt: null, timezone: "America/New_York" },
    categories: [{ id: "sandwich", displayName: "Sandwiches", items: [{ id: "test-sandwich", displayName: "Kiosk Sandwich", description: "Choose your toppings", basePriceCents: 600, available: true, imageUrl: null, imageAlt: "", variants: [], combos: [], modifiers: [{ id: "toppings", name: "Toppings", prompt: "Toppings", minSelections: 0, maxSelections: 2, presentationBehavior: "standard", options: [{ id: "tomato", name: "Tomato", priceDeltaCents: 0, available: true, defaultSelected: false }] }] }] }],
    featuredItems: [], promotions: [], delivery: { enabled: false, minimumOrderCents: 0, maxDistanceMiles: null, feeBands: [] },
    customer: { authenticated: false, loyaltyAvailableAfterSignIn: true, giftCardsAcceptedAtPayment: true }, checkout: { paymentEnabled: true },
  } }));
  await page.goto("/kiosk/deli");
  await page.getByRole("button", { name: "START ORDER", exact: true }).click();
  await page.getByLabel("Search menu").fill("Kiosk Sandwich");
  await page.locator(".menuItem", { hasText: "Kiosk Sandwich" }).click();
  await page.getByRole("dialog", { name: "Kiosk Sandwich" }).getByRole("button", { name: "Tomato", exact: true }).click();
  await page.getByRole("button", { name: /Add to order/i }).click();
  await expect(page.locator(".orderCart")).toContainText("Toppings: Tomato");
});
