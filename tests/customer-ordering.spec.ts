import { expect, test } from "@playwright/test";
import { unwrapHelcimPayResponse } from "@/lib/helcim-pay-response";

test("Helcim approval callbacks unwrap both documented response shapes", () => {
  const transaction = {
    status: "APPROVED",
    transactionId: "123",
    amount: "7.50",
  };
  expect(
    unwrapHelcimPayResponse(
      JSON.stringify({ data: transaction, hash: "direct" }),
    ),
  ).toEqual({ data: transaction, hash: "direct" });
  expect(
    unwrapHelcimPayResponse(
      JSON.stringify({
        status: 200,
        data: { data: transaction, hash: "nested" },
      }),
    ),
  ).toEqual({ data: transaction, hash: "nested" });
});

test("customer catalog is public, customer-safe, and browsable while ordering is closed", async ({
  page,
  request,
}) => {
  const response = await request.get(
    "/api/customer/catalog?serviceType=pickup",
  );
  expect(response.ok()).toBeTruthy();
  const catalog = await response.json();
  expect(catalog.business).toBe("Corner Deli");
  expect(catalog.categories.length).toBeGreaterThan(0);
  const item = catalog.categories.flatMap((category: any) => category.items)[0];
  expect(item.displayName).toBeTruthy();
  expect(item).not.toHaveProperty("sku");
  expect(item).not.toHaveProperty("taxable");
  expect(catalog.customer.authenticated).toBe(false);
  expect(typeof catalog.checkout.paymentEnabled).toBe("boolean");

  await page.goto("/order");
  await expect(page.getByRole("button", { name: "START ORDER" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Order your favorites" }),
  ).toBeVisible();
  await expect(page.getByLabel("Search menu")).toBeVisible();
  await expect(page.locator(".menuItem").first()).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(HTMLInputElement.prototype, "showPicker", {
      configurable: true,
      value() {
        (
          window as typeof window & { futureCalendarOpened?: boolean }
        ).futureCalendarOpened = true;
      },
    });
  });
  const asap = page.getByRole("button", { name: "ASAP" });
  const future = page.getByRole("button", { name: "Future" });
  await expect(asap).toHaveAttribute("aria-pressed", "true");
  await expect(future).toHaveAttribute("aria-pressed", "false");
  await future.click();
  await expect(future).toHaveAttribute("aria-pressed", "true");
  const futureDate = page.getByLabel("Future order date");
  const today = await page.evaluate(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  });
  await expect(futureDate).toHaveValue(today);
  await futureDate.click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as typeof window & { futureCalendarOpened?: boolean })
            .futureCalendarOpened,
        ),
      ),
    )
    .toBe(true);
  await expect(
    page.getByText("Checkout and payments aren’t live yet."),
  ).toHaveCount(0);

  await page.goto("/menu");
  await page.getByRole("button", { name: "VIEW MENU" }).click();
  await expect(
    page.getByRole("heading", { name: "Order your favorites" }),
  ).toBeVisible();

  const quote = await request.post("/api/customer/delivery/quote", {
    data: { distanceMiles: 2, merchandiseSubtotalCents: 2500 },
  });
  expect(quote.status()).toBe(200);
  expect((await quote.json()).quote).toBeTruthy();
});

test("web cart pricing uses the authoritative backend and initializes secure Helcim checkout", async ({
  request,
}) => {
  const catalogResponse = await request.get(
    "/api/customer/catalog?serviceType=pickup",
  );
  const catalog = await catalogResponse.json();
  const item = catalog.categories
    .flatMap((category: any) => category.items)
    .find(
      (candidate: any) =>
        candidate.available &&
        candidate.modifiers.every((group: any) => group.minSelections === 0) &&
        candidate.variants.filter((variant: any) => variant.available).length <=
          1,
    );
  expect(item).toBeTruthy();
  const variant = item.variants.find((candidate: any) => candidate.available);
  const response = await request.post("/api/customer/cart", {
    data: {
      serviceType: "pickup",
      timingMode: "asap",
      scheduledFor: null,
      firstName: "Web",
      lastName: "Customer",
      phone: "3155551212",
      email: "web.customer@example.com",
      items: [
        {
          itemId: item.id,
          variantId: variant?.id || null,
          quantity: 1,
          modifierSelections: {},
          modifierDeclines: item.modifiers.map((group: any) => group.id),
          comboSelections: {},
        },
      ],
    },
  });
  expect(response.status()).toBe(201);
  const body = await response.json();
  expect(body.cart.status).toBe("draft");
  expect(body.cart.lines).toHaveLength(1);
  expect(body.cart.subtotalCents).toBeGreaterThan(0);
  expect(body.cart.paymentStatus).toBe("unpaid");
  expect(body.cart).not.toHaveProperty("email");
  if (catalog.checkout.paymentEnabled) {
    // Production marks the customer session Secure. Playwright will not retain
    // that cookie when this suite targets the local HTTP container, so forward
    // the signed cookie explicitly while preserving the production policy.
    const sessionCookie = response.headers()["set-cookie"]?.split(";", 1)[0];
    const payment = await request.post(
      `/api/customer/orders/${body.cart.id}/payments/helcim`,
      {
        data: { action: "initialize" },
        headers: sessionCookie ? { cookie: sessionCookie } : undefined,
      },
    );
    expect(payment.status()).toBe(200);
    const initialized = await payment.json();
    expect(initialized.checkoutToken).toBeTruthy();
    expect(initialized.secretToken).toBeTruthy();
  }
});

test("successful online payment redirects to a dedicated confirmation", async ({
  page,
}) => {
  await page.route("**/api/customer/orders/order-123", async (route) =>
    route.fulfill({
      contentType: "application/json",
      json: {
        order: {
          id: "order-123",
          display_number: 417,
          first_name_snapshot: "Jamie",
          email_snapshot: "jamie@example.com",
          email_delivery_configured: true,
          timing_message_snapshot: "Pickup today at 5:30 PM",
          paid_cents: 1899,
          total_cents: 1899,
          payment_status: "paid",
          lines: [
            {
              quantity: 1,
              variant_name: "Large",
              name: "Cheese Pizza",
              line_total_cents: 1899,
            },
          ],
        },
      },
    }),
  );
  await page.goto("/order/confirmation?orderId=order-123");
  await expect(
    page.getByRole("heading", { name: "Thank you, Jamie!" }),
  ).toBeVisible();
  await expect(
    page.getByText("Order confirmed", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("jamie@example.com")).toBeVisible();
  await expect(page.getByText("Total paid")).toBeVisible();
});

test("customer can choose and review a half-pizza topping", async ({
  page,
}) => {
  await page.route("**/api/customer/cart", async (route) =>
    route.fulfill({
      contentType: "application/json",
      status: 201,
      json: {
        cart: {
          id: "test-cart",
          lines: [{ quantity: 1, name: "Pizza", lineTotalCents: 1100 }],
          promotions: [],
          totalCents: 1100,
          timingMessage: "Pickup as soon as possible",
          delivery: null,
        },
      },
    }),
  );
  await page.route(
    "**/api/customer/catalog*",
    async (route) =>
      await route.fulfill({
        contentType: "application/json",
        json: {
          availability: {
            open: true,
            orderable: true,
            reason: "",
            nextAvailableAt: null,
            timezone: "America/New_York",
          },
          categories: [
            {
              id: "pizza",
              displayName: "Pizza",
              items: [
                {
                  id: "pizza-item",
                  displayName: "Pizza",
                  description: "Build your pizza.",
                  basePriceCents: 1000,
                  available: true,
                  imageUrl: null,
                  imageAlt: "",
                  variants: [
                    {
                      id: "small",
                      name: 'Small 12"',
                      basePriceCents: 1000,
                      defaultVariant: true,
                      available: true,
                      modifierPrices: [
                        {
                          optionId: "pepperoni",
                          priceDeltaCents: 200,
                          available: true,
                        },
                      ],
                    },
                  ],
                  modifiers: [
                    {
                      id: "cook",
                      name: "Pizza Duration Cooked",
                      prompt: "Pizza Duration Cooked",
                      minSelections: 1,
                      maxSelections: 1,
                      presentationBehavior: "standard",
                      options: [
                        {
                          id: "regular-cook",
                          name: "Regular Cook",
                          priceDeltaCents: 0,
                          available: true,
                          defaultSelected: true,
                        },
                      ],
                    },
                    {
                      id: "sauce",
                      name: "Pizza Sauce",
                      prompt: "Pizza Sauce",
                      minSelections: 1,
                      maxSelections: 1,
                      presentationBehavior: "standard",
                      options: [
                        {
                          id: "classic-sauce",
                          name: "Classic Sauce",
                          priceDeltaCents: 0,
                          available: true,
                          defaultSelected: true,
                        },
                      ],
                    },
                    {
                      id: "toppings",
                      name: "Pizza Toppings",
                      prompt: "Pizza Toppings",
                      minSelections: 0,
                      maxSelections: 20,
                      presentationBehavior: "pizza_topping",
                      options: [
                        {
                          id: "pepperoni",
                          name: "Pepperoni",
                          priceDeltaCents: 200,
                          available: true,
                          defaultSelected: false,
                        },
                      ],
                    },
                  ],
                  combos: [],
                },
              ],
            },
          ],
          featuredItems: [],
          promotions: [],
          delivery: {
            enabled: false,
            minimumOrderCents: 0,
            maxDistanceMiles: null,
            feeBands: [],
          },
          customer: {
            authenticated: true,
            profile: {
              firstName: "Chris",
              lastName: "Customer",
              email: "chris@example.com",
              phone: "5705550199",
            },
            loyaltyAvailableAfterSignIn: true,
            giftCardsAcceptedAtPayment: true,
          },
          checkout: { paymentEnabled: true },
        },
      }),
  );

  await page.goto("/order");
  await expect(page.getByRole("button", { name: "ASAP" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "VIEW MENU" }).click();
  await page.locator(".menuItem").click();
  const dialog = page.getByRole("dialog");
  await dialog
    .locator(".pizzaPortionPicker")
    .getByRole("button", { name: "Left Half" })
    .click();
  await dialog
    .locator(".pizzaToppingPalette")
    .getByRole("button", { name: "Pepperoni" })
    .click();
  await dialog.getByRole("button", { name: "Add to order" }).click();

  await expect(page.getByLabel("Saved contact")).toContainText(
    "Chris Customer",
  );
  await expect(page.getByLabel("Phone number")).toHaveCount(0);
  await expect(page.locator(".orderCart")).toContainText("Left Half Pepperoni");
  await expect(page.locator(".orderCart")).not.toContainText("Regular Cook");
  await expect(page.locator(".orderCart")).not.toContainText("Classic Sauce");
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  const card = page.getByRole("button", { name: "Credit or debit" });
  const pickup = page.getByRole("button", { name: "Pay at pickup" });
  await expect(card).toHaveAttribute("aria-pressed", "false");
  await expect(pickup).toHaveAttribute("aria-pressed", "false");
  await expect(
    page.getByRole("button", { name: "Choose a payment method" }),
  ).toBeDisabled();
  const [cardBox, pickupBox] = await Promise.all([
    card.boundingBox(),
    pickup.boundingBox(),
  ]);
  expect(cardBox?.y).toBe(pickupBox?.y);
});
