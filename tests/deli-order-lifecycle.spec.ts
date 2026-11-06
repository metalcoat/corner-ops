import { loadEnvFile } from "node:process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test, type Page } from "@playwright/test";

if (process.env.POS_TEST_ENV_FILE) loadEnvFile(process.env.POS_TEST_ENV_FILE);

function isolatedDatabase() {
  const connectionString = process.env.VALIDATION_DATABASE_URL;
  if (!connectionString) throw new Error("VALIDATION_DATABASE_URL must point to the isolated browser-test database.");
  const database = new URL(connectionString);
  if (!/test|regression/.test(database.pathname) && !(process.env.ORDERING_AUDIT_DATABASE === "1" && process.env.CI === "true")) {
    throw new Error("Kitchen lifecycle fixtures require a disposable test database.");
  }
  if (process.env.VALIDATION_DISABLE_OUTBOUND !== "1") throw new Error("Run the test app with outbound notifications disabled.");
  return new Client({ connectionString });
}

async function chooseFuturePickup(page: Page) {
  await page.getByRole("button", { name: "Future Choose time", exact: true }).click();
  const date = page.getByLabel("Future order date");
  const firstDay = await date.inputValue();
  for (let offset = 1; offset <= 7; offset++) {
    const day = new Date(`${firstDay}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + offset);
    const businessDate = day.toISOString().slice(0, 10);
    const response = await page.request.get(`/api/ordering/availability?serviceType=pickup&date=${businessDate}`);
    expect(response.ok()).toBeTruthy();
    const { slots } = await response.json() as { slots: string[] };
    if (!slots.length) continue;
    await date.fill(businessDate);
    const time = page.getByLabel("Future order time");
    await expect(time).toBeEnabled();
    await time.selectOption(slots[0]);
    return;
  }
  throw new Error("The test store must have an available pickup time within seven days.");
}

async function signIn(page: Page) {
  const pin = process.env.POS_TEST_ACTIVE_PIN;
  if (!pin) throw new Error("POS_TEST_ACTIVE_PIN is required");
  await page.goto("/pos/deli");
  for (const digit of pin) await page.getByRole("button", { name: digit, exact: true }).click();
  await expect(page.getByText("Corner Deli POS", { exact: true })).toBeVisible();
}

test("cashier submits a real pizza and kitchen completes it", async ({ page }) => {
  test.setTimeout(60_000);
  const db = isolatedDatabase();
  await db.connect();
  const note = `Playwright kitchen acceptance ${Date.now()}`;
  const suffix = String(Date.now()).slice(-7);
  const phone = `31566${suffix}`.slice(0, 10);
  const customerId = randomUUID();
  try {
  await db.query("INSERT INTO ordering_customers(id,business,display_name,first_name,last_name) VALUES($1,'Corner Deli','Kitchen Acceptance','Kitchen','Acceptance')", [customerId]);
  await db.query("INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,is_primary) VALUES($1,$2,$3,$4,TRUE)", [randomUUID(), customerId, `+1${phone}`, phone]);
  await signIn(page);
  await chooseFuturePickup(page);
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
  await expect(page.getByText(/Held order #/)).toBeVisible();
  await expect(page.getByText("$18.50", { exact: true }).last()).toBeVisible();

  const submitResponse = page.waitForResponse((response) => response.url().includes("/api/ordering/orders/") && response.url().endsWith("/submit"));
  await page.getByRole("button", { name: "SEND", exact: true }).click();
  const response = await submitResponse;
  expect(response.status()).toBe(200);
  const payload = await response.json() as { order: { id: string; display_number: string; total_cents: number } };
  const orderNumber = payload.order.display_number;
  expect(payload.order.total_cents).toBe(1850);
  await expect(page.getByRole("status").filter({ hasText: `Order #${orderNumber}` })).toContainText(`submitted to kitchen`);
  await expect(page.getByText("Tap a menu item to start the order.")).toBeVisible();

  // Simulate the scheduled prep window in the disposable database, then exercise
  // the real kitchen status APIs and UI without waiting for tomorrow's opening.
  await db.query("UPDATE ordering_orders SET kitchen_release_at=NOW()-INTERVAL '1 minute' WHERE id=$1 AND customer_id=$2", [payload.order.id, customerId]);
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
  const completed = await db.query("SELECT status,started_at,ready_at,completed_at FROM ordering_orders WHERE id=$1", [payload.order.id]);
  expect(completed.rows[0]).toMatchObject({ status: "completed" });
  for (const key of ["started_at", "ready_at", "completed_at"]) expect(completed.rows[0][key]).toBeTruthy();
  } finally {
    try {
      await db.query("BEGIN");
      for (const table of ["ordering_print_jobs", "ordering_inventory_movements", "ordering_loyalty_ledger", "ordering_points_ledger", "ordering_pos_audit_events"]) {
        await db.query(`DELETE FROM ${table} WHERE order_id IN (SELECT id FROM ordering_orders WHERE customer_id=$1)`, [customerId]);
      }
      await db.query("DELETE FROM ordering_orders WHERE customer_id=$1", [customerId]);
      await db.query("DELETE FROM ordering_customers WHERE id=$1", [customerId]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally { await db.end(); }
  }
});
