import { loadEnvFile } from "node:process";
import { expect, test, type Page } from "@playwright/test";

loadEnvFile("/opt/corner-ops/.env");

async function signIn(page: Page) {
  const email = process.env.APP_EMAIL || "crfrary@gmail.com";
  const password = process.env.APP_PASSWORD;

  if (!password) {
    throw new Error("APP_PASSWORD is required for the local POS browser test");
  }

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL(/\/(?:ops|pos\/deli)/),
    page.getByRole("button", { name: /sign in/i }).click(),
  ]);
}

test("cashier configures, edits, and saves a backend-priced pizza draft", async ({ page }) => {
  await signIn(page);
  await page.goto("/pos/deli");

  await expect(page.getByText("Corner Deli POS", { exact: true })).toBeVisible();
  await expect(page.getByText("No-contact delivery", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Curbside", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Bar", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Pizza and Wings", exact: true }).click();
  await page.getByRole("button", { name: /^Pizza From / }).click();

  const dialog = page.getByRole("dialog", { name: "Configure Pizza" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /choose size \/ form/i })).toBeDisabled();

  await dialog.getByText('Regular 14"', { exact: true }).click();
  await dialog.getByText("Pepperoni", { exact: true }).first().click();
  await expect(dialog.getByText("$14.00", { exact: true })).toBeVisible();
  await dialog.getByLabel("Item notes").fill("Test note");
  await dialog.getByRole("button", { name: /add to order/i }).click();

  const cartLine = page.getByRole("article").filter({ has: page.getByText("1× Pizza", { exact: true }) });
  await expect(cartLine).toContainText('Size / form: Regular 14"');
  await expect(cartLine).toContainText("Note: Test note");
  await page.getByRole("button", { name: "Edit Pizza" }).click();
  await expect(page.getByRole("dialog", { name: "Configure Pizza" })).toBeVisible();
  await page.getByRole("button", { name: /update item/i }).click();

  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith("/api/ordering/orders") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Save ASAP Draft/i }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as { order?: { total_cents?: number } };
  expect(payload.order?.total_cents).toBe(1400);
  await expect(page.getByText("Backend total")).toBeVisible();
  await expect(page.getByText("$14.00", { exact: true }).last()).toBeVisible();

  await page.screenshot({ path: "/tmp/corner-ops-pos-deli.png", fullPage: true });
});

test("Pizza Sub does not fabricate a Wrap variant", async ({ page }) => {
  await signIn(page);
  await page.goto("/pos/deli");
  await page.getByRole("button", { name: "Subs/Wraps" }).click();
  await page.getByRole("button", { name: /^Pizza Sub From / }).click();

  const dialog = page.getByRole("dialog", { name: "Configure Pizza Sub" });
  await expect(dialog.getByText("Full Sub", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1/2 Sub", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Wraps", { exact: true })).toHaveCount(0);
});
