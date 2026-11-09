import { expect, test, type Page } from "@playwright/test";

function menuFixture() {
  return {
    availability: { open: true, orderable: true, reason: "", opensAt: null, nextAvailableAt: null, timezone: "America/New_York" },
    categories: [{ id: "pizza", displayName: "Pizza", items: [{ id: "pizza-item", displayName: "Test Pizza", description: "Choose your extras.", basePriceCents: 1000, available: true, imageUrl: null, imageAlt: "", variants: [{ id: "large", name: "Large", basePriceCents: 1000, defaultVariant: true, available: true, modifierPrices: [{ optionId: "cheese", priceDeltaCents: 150, available: true }] }], modifiers: [
      { id: "extras", name: "Extras", prompt: "Extras", minSelections: 0, maxSelections: 4, allowOptionQuantity: true, presentationBehavior: "standard", options: [{ id: "cheese", name: "Extra cheese", priceDeltaCents: 100, available: true, defaultSelected: false }] },
      { id: "included", name: "Included dip", prompt: "Included dip", minSelections: 0, maxSelections: 1, includedChoiceCount: 1, presentationBehavior: "standard", options: [{ id: "dip", name: "Ranch", priceDeltaCents: 100, available: true, defaultSelected: true }] },
    ], combos: [{ id: "meal", name: "Make a meal", prompt: "Make a meal", basePriceDeltaCents: 200, groups: [{ id: "drink", name: "Drink", minSelections: 1, maxSelections: 1, options: [{ id: "shake", name: "Shake", priceDeltaCents: 300, available: true }] }] }] }] }],
    featuredItems: [], promotions: [], delivery: { enabled: true, minimumOrderCents: 0, maxDistanceMiles: 10, feeBands: [] },
    customer: { authenticated: true, profile: { firstName: "Test", lastName: "Customer", phone: "3155550198", email: "test@example.com" }, loyalty: [{ programId: "jumbo-program", name: "Jumbo pizza", progress: 10, quantityRequired: 10, rewardsAvailable: 1 }], points: { active: true, balance: 100, rewards: [{ id: "pizza-reward", label: "Pizza reward", points: 50, kind: "item", itemIds: ["pizza-item"], variantIds: [], optionIds: [] }] }, addresses: [], loyaltyAvailableAfterSignIn: true, giftCardsAcceptedAtPayment: true },
    checkout: { paymentEnabled: true, provider: "mx_merchant" },
  };
}

async function setup(page: Page, customize?: (fixture: ReturnType<typeof menuFixture>) => void) {
  const fixture = menuFixture();
  customize?.(fixture);
  await page.route("**/api/customer/catalog*", (route) => route.fulfill({ json: fixture }));
  await page.route("**/api/customer/account/cards", (route) => route.fulfill({ json: { cards: [] } }));
  await page.goto("/order");
  await page.getByRole("button", { name: "START ORDER", exact: true }).click();
  await page.locator(".menuItem").first().click();
  return fixture;
}

test("web quantity and combo estimates match the configuration sent for pricing", async ({ page }) => {
  await setup(page);
  let submitted: any;
  await page.route("**/api/customer/cart", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { cart: { id: "cart-one", subtotalCents: 1800, totalCents: 1800, discountCents: 0, timingMessage: "Pickup in 30 minutes" } } });
  });
  const dialog = page.getByRole("dialog", { name: "Test Pizza" });
  await dialog.getByRole("button", { name: /Extra cheese/ }).click();
  await dialog.getByLabel("Extra cheese quantity").getByRole("button", { name: "+", exact: true }).click();
  await dialog.getByLabel("Make a meal").check();
  await dialog.getByLabel("Shake").check();
  await dialog.getByRole("button", { name: "Add to order" }).click();
  await expect(page.getByLabel("Order total")).toContainText("$18.00");
  await page.getByRole("button", { name: "Pay at pickup", exact: true }).click();
  await page.getByRole("button", { name: "Review order", exact: true }).click();
  await expect.poll(() => submitted?.items?.[0]?.modifierQuantities?.cheese).toBe(2);
  expect(submitted.items[0].comboSelections).toEqual({ drink: ["shake"] });
});

test("verification rebuilds a guest card review before switching to pay at pickup", async ({ page }) => {
  const fixture = await setup(page, (menu) => { menu.customer.authenticated = false; });
  const carts: string[] = [], submitted: string[] = [];
  await page.route("**/api/customer/cart", async (route) => {
    const id = `review-${carts.length + 1}`; carts.push(id);
    await route.fulfill({ status: 201, json: { cart: { id, subtotalCents: 1000, totalCents: 1000, discountCents: 0 } } });
  });
  await page.route("**/api/customer/auth/phone", async (route) => {
    if (route.request().postDataJSON().action === "request") await route.fulfill({ json: { testCode: "654321" } });
    else { fixture.customer.authenticated = true; await route.fulfill({ json: { authenticated: true } }); }
  });
  await page.route("**/api/customer/orders/*/pay-later", async (route) => {
    submitted.push(route.request().url().split("/").at(-2)!);
    await route.fulfill({ status: 409, json: { error: "Submission captured" } });
  });
  await page.getByRole("dialog", { name: "Test Pizza" }).getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Credit or debit", exact: true }).click();
  await page.getByRole("button", { name: "Review order", exact: true }).click();
  await expect.poll(() => carts.length).toBe(1);
  await page.getByRole("button", { name: "Pay at pickup", exact: true }).click();
  await page.getByRole("button", { name: "Place order — pay at pickup", exact: true }).click();
  await page.getByRole("button", { name: "TEXT ME A CODE" }).click();
  await page.getByRole("button", { name: "VERIFY & REVIEW ORDER" }).click();
  await expect.poll(() => carts.length).toBe(2);
  expect(submitted).toEqual([]);
  await page.getByRole("button", { name: "Place order — pay at pickup", exact: true }).click();
  await expect.poll(() => submitted).toEqual(["review-2"]);
});

test("a delayed price response cannot restore a review after the contact details change", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  await page.route("**/api/customer/cart", async (route) => {
    started = true; await pending;
    await route.fulfill({ status: 201, json: { cart: { id: "stale-review", subtotalCents: 1000, totalCents: 1000, discountCents: 0 } } });
  });
  await page.getByRole("dialog", { name: "Test Pizza" }).getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Pay at pickup", exact: true }).click();
  await page.getByRole("button", { name: "Review order", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByLabel("First name", { exact: true }).fill("Updated");
  release();
  await expect(page.getByRole("button", { name: "Review order", exact: true })).toBeEnabled();
  await expect(page.locator(".serverReview")).toHaveCount(0);
});

for (const reward of ["loyalty", "points"]) {
  test(`a delayed ${reward} response cannot restore a discarded review`, async ({ page }) => {
    await setup(page);
    await page.route("**/api/customer/cart", (route) => route.fulfill({ status: 201, json: { cart: { id: "old-reward-cart", subtotalCents: 1000, totalCents: 1000, discountCents: 0 } } }));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    await page.route(`**/api/customer/orders/old-reward-cart/${reward}`, async (route) => {
      started = true; await pending;
      await route.fulfill({ json: { order: { discount_cents: 800, total_cents: 200 }, redemptions: [] } });
    });
    await page.getByRole("dialog", { name: "Test Pizza" }).getByRole("button", { name: "Add to order" }).click();
    await page.getByRole("button", { name: "Pay at pickup", exact: true }).click();
    await page.getByRole("button", { name: "Review order", exact: true }).click();
    await page.getByRole("button", { name: reward === "loyalty" ? "Apply free pizza" : "Use 50 points: Pizza reward", exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page.getByLabel("First name", { exact: true }).fill("Updated");
    release();
    await expect(page.getByRole("button", { name: "Review order", exact: true })).toBeEnabled();
    await expect(page.locator(".serverReview")).toHaveCount(0);
    await expect(page.getByLabel("Order total")).toContainText("$10.00");
  });
}

test("single-choice groups allow extra portions and explain variant prices, included portions and the group fee", async ({ page }) => {
  await setup(page, (menu) => {
    menu.categories[0].items[0].modifiers[0].maxSelections = 1;
    Object.assign(menu.categories[0].items[0].modifiers[0], { includedChoiceCount: 1, selectionChargeCents: 25 });
  });
  let submitted: any;
  await page.route("**/api/customer/cart", async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { cart: { id: "portion-review", subtotalCents: 1175, totalCents: 1175, discountCents: 0 } } });
  });
  const dialog = page.getByRole("dialog", { name: "Test Pizza" });
  await expect(dialog.getByRole("button", { name: /Extra cheese/ }).first()).toContainText("$1.50");
  await expect(dialog).toContainText("$0.25 added once");
  await dialog.getByRole("button", { name: /Extra cheese/ }).first().click();
  await expect(dialog.getByRole("button", { name: /Extra cheese/ }).first()).toContainText("Included");
  await dialog.getByLabel("Extra cheese quantity").getByRole("button", { name: "+", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /Extra cheese/ }).first()).toContainText("1 included · +$1.50");
  await dialog.getByRole("button", { name: "Add to order" }).click();
  await expect(page.getByLabel("Order total")).toContainText("$11.75");
  await expect(page.locator(".cartLine")).toContainText("2 × Extra cheese");
  await page.getByRole("button", { name: "Pay at pickup", exact: true }).click();
  await page.getByRole("button", { name: "Review order", exact: true }).click();
  await expect.poll(() => submitted?.items?.[0]?.modifierQuantities?.cheese).toBe(2);
  expect(submitted.items[0].modifierSelections.extras).toEqual(["cheese"]);
});

test("review exposes pizza and points rewards before a pay-later order is sent", async ({ page }) => {
  await setup(page);
  let sends = 0;
  await page.route("**/api/customer/cart", (route) => route.fulfill({ status: 201, json: { cart: { id: "reward-cart", subtotalCents: 1000, totalCents: 1000, discountCents: 0, timingMessage: "Pickup in 30 minutes" } } }));
  await page.route("**/api/customer/orders/reward-cart/loyalty", (route) => route.fulfill({ json: { order: { discount_cents: 800, total_cents: 200 } } }));
  await page.route("**/api/customer/orders/reward-cart/pay-later", async (route) => { sends += 1; await route.fulfill({ status: 409, json: { error: "Test submission intercepted" } }); });
  await page.getByRole("dialog", { name: "Test Pizza" }).getByRole("button", { name: "Add to order" }).click();
  await page.getByRole("button", { name: "Pay at pickup", exact: true }).click();
  await page.getByRole("button", { name: "Review order", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply free pizza", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Use 50 points: Pizza reward", exact: true })).toBeVisible();
  expect(sends).toBe(0);
  await page.getByRole("button", { name: "Apply free pizza", exact: true }).click();
  await expect(page.getByLabel("Order total")).toContainText("$2.00");
  await page.getByRole("button", { name: "Place order — pay at pickup", exact: true }).click();
  await expect.poll(() => sends).toBe(1);
});

test("future selections reload the catalog for fulfillment time and clear on service change", async ({ page }) => {
  const fixture = menuFixture();
  const scheduledFor = "2026-12-10T17:00:00.000Z";
  const requestedTimes: string[] = [];
  await page.route("**/api/customer/catalog*", async (route) => { requestedTimes.push(new URL(route.request().url()).searchParams.get("scheduledFor") || ""); await route.fulfill({ json: fixture }); });
  await page.route("**/api/customer/account/cards", (route) => route.fulfill({ json: { cards: [] } }));
  await page.route("**/api/customer/availability*", (route) => route.fulfill({ json: { slots: [scheduledFor] } }));
  await page.goto("/order");
  await page.getByRole("button", { name: "Future", exact: true }).click();
  await page.getByLabel("Future order date").fill("2026-12-10");
  await expect(page.getByLabel("Future order time").locator("option")).toHaveCount(2);
  await page.getByLabel("Future order time").selectOption(scheduledFor);
  await expect.poll(() => requestedTimes.includes(scheduledFor)).toBe(true);
  await page.getByRole("button", { name: "Curbside", exact: true }).click();
  await expect(page.getByLabel("Future order time")).toHaveValue("");
});

test("paid drafts are shown as awaiting staff help rather than kitchen confirmation", async ({ page }) => {
  await page.route("**/api/customer/orders/paid-draft", (route) => route.fulfill({ json: { order: { id: "paid-draft", display_number: 42, status: "draft", payment_status: "paid", service_type: "pickup", first_name_snapshot: "Test", email_snapshot: "test@example.com", total_cents: 1000, paid_cents: 1000, lines: [], receipt_rows: [] }, delivery: null, store: null } }));
  await page.goto("/order/confirmation?orderId=paid-draft");
  await expect(page.getByRole("heading", { name: "Your paid order needs a store check" })).toBeVisible();
  await expect(page.locator(".trackerSteps")).toHaveCount(0);
  await expect(page.getByText(/Please don't pay again/)).toBeVisible();
});

test("menu and featured cards advertise the cheapest available size rather than a zero base price", async ({ page }) => {
  const base = menuFixture();
  const item = base.categories[0].items[0];
  item.basePriceCents = 0;
  item.variants.push({ ...item.variants[0], id: "unavailable", basePriceCents: 50, available: false });
  const fixture = { ...base, featuredItems: [item] };
  await page.route("**/api/customer/catalog*", (route) => route.fulfill({ json: fixture }));
  await page.route("**/api/customer/account/cards", (route) => route.fulfill({ json: { cards: [] } }));
  await page.goto("/order");
  await expect(page.locator(".menuItem")).toContainText("From $10.00");
  await expect(page.locator(".featuredItem")).toContainText("From $10.00");
});
