import { expect, test } from "@playwright/test";

test("half-pizza amount changes keep the other half and price intact", async ({ page }) => {
  await page.route("**/api/customer/catalog*", (route) => route.fulfill({ json: {
    availability: { open: true, orderable: true, reason: "", nextAvailableAt: null, timezone: "America/New_York" },
    categories: [{ id: "pizza", displayName: "Pizza", items: [{
      id: "pizza-item", displayName: "Pizza", description: "Build your pizza.", basePriceCents: 1000, available: true, imageUrl: null, imageAlt: "",
      variants: [{ id: "small", name: 'Small 12"', basePriceCents: 1000, defaultVariant: true, available: true, modifierPrices: [{ optionId: "pepperoni", priceDeltaCents: 200, available: true }] }],
      modifiers: [{ id: "toppings", name: "Pizza Toppings", prompt: "Pizza Toppings", minSelections: 0, maxSelections: 20, presentationBehavior: "pizza_topping", options: [{ id: "pepperoni", name: "Pepperoni", priceDeltaCents: 200, available: true, defaultSelected: false }] }],
      combos: [],
    }] }],
    featuredItems: [], promotions: [], delivery: { enabled: false, minimumOrderCents: 0, maxDistanceMiles: null, feeBands: [] },
    customer: { authenticated: true, profile: { firstName: "Test", lastName: "Customer", email: "test@example.com", phone: "3155550199" }, loyaltyAvailableAfterSignIn: true, giftCardsAcceptedAtPayment: true },
    checkout: { paymentEnabled: false },
  } }));
  await page.goto("/order");
  await page.getByRole("button", { name: "VIEW MENU" }).click();
  await page.locator(".menuItem").click();
  const dialog = page.getByRole("dialog");
  const palette = dialog.locator(".pizzaToppingPalette");
  const portion = dialog.locator(".pizzaPortionPicker");
  const selected = dialog.locator(".pizzaSelectedToppings");
  await palette.getByRole("button", { name: "Pepperoni" }).click();
  await portion.getByRole("button", { name: "Left Half", exact: true }).click();
  await selected.getByRole("button", { name: "Increase Pepperoni", exact: true }).click();
  await expect(selected).toContainText("Left Half Extra");
  await expect(selected).toContainText("Right Half Regular");

  await portion.getByRole("button", { name: "Right Half", exact: true }).click();
  await selected.getByRole("button", { name: "Increase Pepperoni", exact: true }).click();
  await expect(selected).toContainText("Whole · Extra");

  await portion.getByRole("button", { name: "Left Half", exact: true }).click();
  await selected.getByRole("button", { name: "Decrease or remove Pepperoni", exact: true }).click();
  await expect(selected).toContainText("Left Half Regular");
  await expect(selected).toContainText("Right Half Extra");
  await selected.getByRole("button", { name: "Decrease or remove Pepperoni", exact: true }).click();
  await expect(selected).toContainText("Right Half · Extra");
  await expect(selected).not.toContainText("Left Half");
  await dialog.getByRole("button", { name: "Add to order" }).click();
  await expect(page.locator(".orderCart")).toContainText("Right Half Extra Pepperoni");
  await expect(page.locator(".orderCart")).toContainText("$12.00");
});
