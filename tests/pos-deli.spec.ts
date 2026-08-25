import { loadEnvFile } from "node:process";
import { expect, test, type Page } from "@playwright/test";

loadEnvFile("/opt/corner-ops/.env");

async function signIn(page: Page) {
  const pin = process.env.POS_TEST_ACTIVE_PIN;
  if (!pin) throw new Error("POS_TEST_ACTIVE_PIN is required");
  await page.goto("/pos/deli");
  for (const digit of pin)
    await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(
    page.getByText("Corner Deli POS", { exact: true }),
  ).toBeVisible();
}

test("cashier configures, edits, and saves a backend-priced pizza draft", async ({
  page,
}) => {
  await signIn(page);

  await expect(
    page.getByText("Corner Deli POS", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("No-contact delivery", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Curbside", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Bar", { exact: true })).toHaveCount(0);

  await page
    .getByRole("button", { name: "Pizza and Wings", exact: true })
    .click();
  await page.getByRole("button", { name: /^Pizza From / }).click();

  const dialog = page.getByRole("dialog", { name: "Configure Pizza" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("Select a size", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "ADD TO ORDER" }),
  ).toHaveAttribute("aria-disabled", "true");
  await dialog
    .getByRole("button", { name: "ADD TO ORDER" })
    .dispatchEvent("click");
  await expect(
    dialog.getByText("Select a size", { exact: true }),
  ).toBeVisible();

  await dialog.getByText('Regular 14"', { exact: true }).click();
  await dialog
    .locator(".pizzaToppingPalette")
    .getByRole("button", { name: "Pepperoni" })
    .click();
  await expect(dialog.getByText("$14.00", { exact: true })).toBeVisible();
  await dialog.getByLabel("Item notes").fill("Test note");
  await dialog.getByRole("button", { name: /add to order/i }).click();

  const cartLine = page
    .getByRole("article")
    .filter({ has: page.getByText("1× Pizza", { exact: true }) });
  await expect(cartLine).toContainText('Size / form: Regular 14"');
  await expect(cartLine).toContainText("Note: Test note");
  await page.getByRole("button", { name: "Edit Pizza" }).click();
  await expect(
    page.getByRole("dialog", { name: "Configure Pizza" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /update item/i }).click();

  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/ordering/orders") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "HOLD", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as {
    order?: { total_cents?: number };
  };
  expect(payload.order?.total_cents).toBe(1400);
  await expect(page.getByText("Backend total")).toBeVisible();
  await expect(page.getByText("$14.00", { exact: true }).last()).toBeVisible();

  await page.screenshot({
    path: "/tmp/corner-ops-pos-deli.png",
    fullPage: true,
  });
});

test("pizza topping controls use semantic portion and amount and restore on edit", async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole("button", { name: "Pizza and Wings", exact: true })
    .click();
  await page.getByRole("button", { name: /^Pizza From / }).click();
  const dialog = page.getByRole("dialog", { name: "Configure Pizza" });
  await dialog.getByText('Regular 14"', { exact: true }).click();
  await expect(page.locator(".posCart")).toBeVisible();
  await expect(
    page.locator(".posModalBackdrop").filter({ has: dialog }),
  ).toHaveCount(0);
  const palette = dialog.locator(".pizzaToppingPalette button");
  expect(await palette.count()).toBeGreaterThanOrEqual(5);
  for (let index = 0; index < Math.min(5, await palette.count()); index++)
    await palette.nth(index).click();
  await expect(dialog.locator(".pizzaSelectedToppings article")).toHaveCount(5);
  const pepperoni = dialog
    .locator(".pizzaSelectedToppings article")
    .filter({ hasText: "Pepperoni" });
  await expect(pepperoni).toContainText("Whole · Regular");
  await dialog
    .locator(".pizzaPortionPicker")
    .getByRole("button", { name: "Right Half" })
    .click();
  await dialog
    .locator(".pizzaToppingPalette")
    .getByRole("button", { name: "Pepperoni" })
    .click();
  await dialog
    .locator(".pizzaPortionPicker")
    .getByRole("button", { name: "Left Half" })
    .click();
  await pepperoni.locator(".pizzaSelectedSummary").click();
  await pepperoni.getByRole("button", { name: "EXTRA", exact: true }).click();
  await dialog
    .locator(".pizzaPortionPicker")
    .getByRole("button", { name: "Right Half" })
    .click();
  await dialog
    .locator(".pizzaToppingPalette")
    .getByRole("button", { name: "Pepperoni" })
    .click();
  await expect(pepperoni).toContainText("Left Half Extra · Right Half Regular");
  await expect(dialog.getByLabel("Pepperoni quantity")).toHaveCount(0);
  await expect(dialog).not.toContainText("2× Pepperoni");
  await dialog.getByRole("button", { name: "ADD TO ORDER" }).click();
  const line = page
    .getByRole("article")
    .filter({ has: page.getByText("1× Pizza", { exact: true }) });
  await expect(line).toContainText("Left Half Extra Pepperoni");
  await expect(line).not.toContainText("2× Pepperoni");
  await page.getByRole("button", { name: "Edit Pizza" }).click();
  const editDialog = page.getByRole("dialog", { name: "Configure Pizza" });
  const editedPepperoni = editDialog
    .locator(".pizzaSelectedToppings article")
    .filter({ hasText: "Pepperoni" });
  await expect(editedPepperoni).toContainText(
    "Left Half Extra · Right Half Regular",
  );
  await editedPepperoni
    .getByRole("button", { name: "Decrease or remove Pepperoni" })
    .click();
  await expect(editedPepperoni).toContainText("Whole · Regular");
  await editedPepperoni
    .getByRole("button", { name: "Decrease or remove Pepperoni" })
    .click();
  await expect(
    editDialog
      .locator(".pizzaSelectedToppings article")
      .filter({ hasText: "Pepperoni" }),
  ).toHaveCount(0);
});

test("Pizza Sub does not fabricate a Wrap variant", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Subs/Wraps" }).click();
  await page.getByRole("button", { name: /^Pizza Sub From / }).click();

  const dialog = page.getByRole("dialog", { name: "Configure Pizza Sub" });
  await expect(dialog.getByText("Full Sub", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1/2 Sub", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Wraps", { exact: true })).toHaveCount(0);
});

test("real subs and wings add, update, and explain incomplete choices", async ({
  page,
}) => {
  await signIn(page);
  const search = page.getByLabel("Search menu");

  await search.fill("Turkey Big Boss");
  await page.getByRole("button", { name: /^Turkey Big Boss From / }).click();
  let dialog = page.getByRole("dialog", { name: "Configure Turkey Big Boss" });
  await dialog.getByText("Wraps", { exact: true }).click();
  await dialog.getByLabel("Item notes").fill("Toast wrap");
  await dialog.getByRole("button", { name: "ADD TO ORDER" }).click();
  let line = page.getByRole("article").filter({ hasText: "Turkey Big Boss" });
  await expect(line).toContainText("$10.25");
  await expect(line).toContainText("Wraps");
  await page.getByRole("button", { name: "Edit Turkey Big Boss" }).click();
  dialog = page.getByRole("dialog", { name: "Configure Turkey Big Boss" });
  await dialog.getByLabel("Item notes").fill("Updated wrap");
  await dialog.getByRole("button", { name: "UPDATE ITEM" }).click();
  await expect(line).toContainText("Updated wrap");

  await search.fill("Turkey");
  await page.getByRole("button", { name: /^Turkey From / }).click();
  dialog = page.getByRole("dialog", { name: "Configure Turkey" });
  await dialog.getByText("Wraps", { exact: true }).click();
  await expect(
    dialog.getByText("Choose 1 Free Cheese", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "ADD TO ORDER" }),
  ).toHaveAttribute("aria-disabled", "true");
  await dialog
    .getByRole("button", { name: "ADD TO ORDER" })
    .dispatchEvent("click");
  await expect(dialog).toBeVisible();
  await dialog.getByText("American", { exact: true }).click();
  await dialog.getByRole("button", { name: "ADD TO ORDER" }).click();
  await expect(
    page
      .getByRole("article")
      .filter({ has: page.getByText("1× Turkey", { exact: true }) }),
  ).toContainText("$9.00");

  await search.fill("Wings");
  await page.getByRole("button", { name: /^Wings From / }).click();
  dialog = page.getByRole("dialog", { name: "Configure Wings" });
  await dialog.getByText("10 Wings", { exact: true }).click();
  await dialog.getByText("Mild", { exact: true }).click();
  await dialog.getByText("Flats/Wings", { exact: true }).click();
  await dialog.getByRole("button", { name: "ADD TO ORDER" }).click();
  await expect(
    page.getByRole("article").filter({ hasText: "1× Wings" }),
  ).toContainText("$13.50");
});

test("top categories, subcategories, and search use the imported hierarchy", async ({
  page,
}) => {
  await signIn(page);
  const top = page.getByRole("navigation", { name: "Menu categories" });
  await expect(
    top.getByRole("button", { name: "Appetizers and Sides", exact: true }),
  ).toBeVisible();
  await top
    .getByRole("button", { name: "Appetizers and Sides", exact: true })
    .click();
  await expect(
    page
      .getByLabel("Appetizers and Sides subcategories")
      .getByRole("button", { name: "Appetizers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Side Dishes", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Side Dishes" }),
  ).toBeVisible();
  await top.getByRole("button", { name: "Candy Bars", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Candy Bars" })).toBeVisible();
  await page.getByLabel("Search menu").fill("Turkey Big Boss");
  await expect(
    page.getByRole("button", { name: /^Turkey Big Boss From / }),
  ).toBeVisible();
});

test("Delivery preserves the cart and requires provider validation", async ({
  page,
}) => {
  await signIn(page);
  await page.getByLabel("Search menu").fill("Pizza Logs");
  await page.getByRole("button", { name: /^Pizza Logs / }).click();
  await page
    .getByRole("dialog", { name: "Configure Pizza Logs" })
    .getByRole("button", { name: "ADD TO ORDER" })
    .click();
  await page.getByRole("button", { name: "Delivery", exact: true }).click();
  await expect(page.getByLabel("Street address")).toBeVisible();
  await page.getByLabel("Street address").fill("41");
  await expect(
    page.getByRole("button", { name: "Validate", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("article").filter({ hasText: "Pizza Logs" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "HOLD", exact: true }).click();
  await expect(page.getByText(/Held order #/)).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: "Pizza Logs" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "SEND", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Customer name and phone required"),
  ).toBeVisible();
  await expect(
    page.getByRole("article").filter({ hasText: "Pizza Logs" }),
  ).toBeVisible();
});
