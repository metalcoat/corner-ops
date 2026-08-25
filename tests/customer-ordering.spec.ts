import { expect, test } from "@playwright/test";

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
  expect(catalog.checkout.paymentEnabled).toBe(false);

  await page.goto("/order");
  await expect(
    page.getByRole("heading", { name: "What sounds good?" }),
  ).toBeVisible();
  await expect(page.getByLabel("Search menu")).toBeVisible();
  await expect(page.locator(".menuItem").first()).toBeVisible();
  await expect(
    page.getByText("Checkout and payments aren’t live yet."),
  ).toHaveCount(0);

  await page.goto("/menu");
  await expect(
    page.getByRole("heading", { name: "What sounds good?" }),
  ).toBeVisible();

  const quote = await request.post("/api/customer/delivery/quote", {
    data: { distanceMiles: 2, merchandiseSubtotalCents: 2500 },
  });
  expect(quote.status()).toBe(200);
  expect((await quote.json()).quote).toBeTruthy();
});

test("web cart pricing uses the authoritative backend and remains a non-payable draft", async ({
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
  expect(body.cart.paymentStatus).toBe("unavailable");
});

test("customer can choose and review a half-pizza topping", async ({
  page,
}) => {
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
            authenticated: false,
            loyaltyAvailableAfterSignIn: true,
            giftCardsAcceptedAtPayment: true,
          },
          checkout: { paymentEnabled: false },
        },
      }),
  );

  await page.goto("/order");
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

  await expect(page.locator(".orderCart")).toContainText("Left Half Pepperoni");
  await expect(page.locator(".orderCart")).not.toContainText("Regular Cook");
  await expect(page.locator(".orderCart")).not.toContainText("Classic Sauce");
});
