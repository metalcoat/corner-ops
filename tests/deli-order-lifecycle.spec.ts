import { loadEnvFile } from "node:process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

loadEnvFile("/opt/corner-ops/.env");

async function signIn(page: Page) {
  const pin = process.env.POS_TEST_ACTIVE_PIN;
  if (!pin) throw new Error("POS_TEST_ACTIVE_PIN is required");
  await page.goto("/pos/deli");
  for (const digit of pin) await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.getByText("Corner Deli POS", { exact: true })).toBeVisible();
}

test("cashier submits a real pizza and kitchen completes it", async ({ page }) => {
  const note = `Playwright kitchen acceptance ${Date.now()}`;
  await signIn(page);
  const suffix = String(Date.now()).slice(-7);
  const phone = `31566${suffix}`.slice(0, 10);
  const customerId = randomUUID();
  execFileSync("docker", ["exec", "corner-ops-postgres", "psql", "-U", "cornerops", "-d", "cornerops", "-v", "ON_ERROR_STOP=1", "-c", `INSERT INTO ordering_customers(id,business,display_name,first_name,last_name) VALUES('${customerId}','Corner Deli','Kitchen Acceptance','Kitchen','Acceptance'); INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,is_primary) VALUES('${randomUUID()}','${customerId}','+1${phone}','${phone}',TRUE)`]);
  await page.getByRole("button", { name: /CUSTOMER/ }).click();
  await page.getByPlaceholder("3155551212 or Sarah Smith").fill(phone);
  await page.getByRole("button", { name: /Kitchen Acceptance/ }).click();
  await page.getByRole("button", { name: "Pizza and Wings", exact: true }).click();
  await page.getByRole("button", { name: /^Pizza From / }).click();

  const dialog = page.getByRole("dialog", { name: "Configure Pizza" });
  await dialog.getByText('Jumbo Thin 16"', { exact: true }).click();
  await dialog.locator(".pizzaToppingPalette").getByRole("button", { name: "Pepperoni" }).click();
  await dialog.locator(".pizzaToppingPalette").getByRole("button", { name: "Mushrooms" }).click();
  await dialog.getByLabel("Item notes").fill(note);
  await expect(dialog.getByText("$18.50", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: /add to order/i }).click();

  const draftResponse = page.waitForResponse((response) => response.url().endsWith("/api/ordering/orders") && response.request().method() === "POST");
  await page.getByRole("button", { name: "HOLD", exact: true }).click();
  expect((await draftResponse).status()).toBe(201);
  await expect(page.getByText("Backend total")).toBeVisible();
  await expect(page.getByText("$18.50", { exact: true }).last()).toBeVisible();

  const submitResponse = page.waitForResponse((response) => response.url().includes("/api/ordering/orders/") && response.url().endsWith("/submit"));
  await page.getByRole("button", { name: "SEND", exact: true }).click();
  const response = await submitResponse;
  expect(response.status()).toBe(200);
  const payload = await response.json() as { order: { display_number: string; total_cents: number } };
  const orderNumber = payload.order.display_number;
  expect(payload.order.total_cents).toBe(1850);
  await expect(page.getByRole("status").filter({ hasText: `Order #${orderNumber}` })).toContainText(`submitted to kitchen`);
  await expect(page.getByText("Tap a menu item to start the order.")).toBeVisible();

  await page.goto("/pos/deli/kitchen");
  const ticket = page.getByRole("article", { name: `Order ${orderNumber}` });
  await expect(ticket).toBeVisible();
  await expect(ticket).toContainText("SUBMITTED");
  await expect(ticket).toContainText("PICKUP");
  await expect(ticket).toContainText('Jumbo Thin 16"');
  await expect(ticket).toContainText("PEPPERONI");
  await expect(ticket).toContainText("MUSHROOMS");
  await expect(ticket).toContainText(`NOTE: ${note}`);
  await expect(ticket).toContainText("UNPAID");

  await ticket.getByRole("button", { name: "START" }).click();
  await expect(ticket).toContainText("IN PROGRESS");
  await ticket.getByRole("button", { name: "READY" }).click();
  await expect(ticket).toContainText("READY");
  await page.screenshot({ path: "/tmp/corner-ops-deli-kitchen.png", fullPage: true });
  await ticket.getByRole("button", { name: "COMPLETE" }).click();
  await expect(ticket).toHaveCount(0);
  execFileSync("docker", ["exec", "corner-ops-postgres", "psql", "-U", "cornerops", "-d", "cornerops", "-v", "ON_ERROR_STOP=1", "-c", `UPDATE ordering_orders SET customer_id=NULL WHERE customer_id='${customerId}'; DELETE FROM ordering_customers WHERE id='${customerId}' AND first_name='Kitchen' AND last_name='Acceptance'`]);
});
