// Explicit opt-in: real MX sandbox, disposable DB, no printers or messages.
// Run against a separately started app using the same isolated configuration.
import assert from "node:assert/strict";
import { chromium, expect, type BrowserContext } from "@playwright/test";
import { randomInt } from "node:crypto";

async function main() {
  assert.equal(process.env.RUN_MX_SANDBOX_BROWSER, "1");
  assert.equal(process.env.MX_ENVIRONMENT, "sandbox");
  assert.equal(process.env.VALIDATION_DISABLE_OUTBOUND, "1");
  assert.equal(process.env.ORDERING_AUDIT_DATABASE, "1");
  assert.ok(/test|regression/.test(new URL(process.env.DATABASE_URL || "").pathname));
  assert.ok(!process.env.MX_TEST_API_BASE_URL, "Use the actual MX sandbox for this walkthrough.");
  const baseURL = process.env.POS_BASE_URL || "";
  assert.equal(new URL(baseURL).hostname, "127.0.0.1");
  assert.notEqual(new URL(baseURL).port, "3000", "Use a separate isolated app.");
  const { getSql } = await import("../src/lib/db");
  const { findMxPaymentByReplayId, voidOrRefundMxPayment, getMxPayment } = await import("../src/lib/mx-merchant");
  const sql = getSql();
  assert.equal(Number((await sql`SELECT count(*) n FROM ordering_hardware_devices WHERE active=TRUE`)[0].n), 0);
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const replays = new Set<number>(), results: Record<string, unknown>[] = [];
  const trackedOrders = new Set<string>(), savedCardCustomers = new Set<string>();
  let savedAccount: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
  const cleanupErrors: string[] = [];
  try {
    for (const scenario of ["pickup-card", "pickup-pay-later", "curbside-card", "delivery-card", "pickup-save-card", "pickup-saved-card"] as const) {
      const context = await browser.newContext({ baseURL, storageState: scenario.includes("save") ? savedAccount : undefined, viewport: scenario === "curbside-card" ? { width: 390, height: 844 } : { width: 1440, height: 1000 } });
      context.setDefaultTimeout(30_000);
      const page = await context.newPage();
      console.log(`Starting ${scenario}`);
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", async (response) => {
        if (new URL(response.url()).pathname === "/api/customer/cart" && response.ok()) {
          const payload = await response.json().catch(() => null);
          if (payload?.cart?.id) trackedOrders.add(String(payload.cart.id));
        }
      });
      await page.goto("/order");
      if (scenario === "curbside-card") await page.getByRole("button", { name: "Curbside", exact: true }).click();
      if (scenario === "delivery-card") {
        await page.getByRole("button", { name: "⌂ Delivery", exact: true }).click();
        await page.getByLabel("Delivery address", { exact: true }).fill("Walmart");
        await page.locator(".addressSuggestions button").filter({ hasText: "3000 Ford Street Extension" }).first().click();
        await expect(page.locator(".validatedAddress")).toContainText("3000", { timeout: 30_000 });
      }
      await page.getByRole("button", { name: "START ORDER", exact: true }).click();
      await page.locator(".menuItem").filter({ hasText: "Small French Fries" }).first().click();
      const itemDialog = page.getByRole("dialog", { name: "Small French Fries", exact: true });
      if (scenario === "delivery-card") {
        const catalog = await page.evaluate(() => fetch("/api/customer/catalog").then((response) => response.json()));
        const quantity = Math.max(1, Math.ceil(Number(catalog.delivery.minimumOrderCents) / 300));
        assert.ok(quantity <= 99);
        for (let count = 1; count < quantity; count++) await itemDialog.getByRole("button", { name: "+", exact: true }).click();
      }
      await itemDialog.getByRole("button", { name: "Add to order", exact: true }).click();
      await page.getByLabel("First name", { exact: true }).fill("Launch Test");
      await page.getByLabel("Last name", { exact: true }).fill(scenario);
      await page.getByLabel("Phone number", { exact: true }).fill(`315555${randomInt(1000, 9999)}`);
      await page.getByLabel("Email address", { exact: true }).fill(`launch-${randomInt(100000, 999999)}@example.invalid`);
      if (scenario === "pickup-pay-later") {
        await page.getByRole("button", { name: "Pay at pickup", exact: true }).click();
        await page.getByRole("button", { name: "Review order", exact: true }).click();
        await page.getByRole("button", { name: "TEXT ME A CODE" }).click();
        await expect(page.getByText("Test mode:", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "VERIFY & REVIEW ORDER" }).click();
        await page.getByRole("button", { name: "Place order — pay at pickup", exact: true }).click();
      } else if (scenario === "pickup-saved-card") {
        await page.getByRole("button", { name: /····1111/ }).click();
        await page.getByRole("button", { name: "Review order", exact: true }).click();
        await page.getByRole("button", { name: "Place order and pay", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Credit or debit", exact: true }).click();
        await page.getByRole("button", { name: "Review order", exact: true }).click();
        const initialization = page.waitForResponse((response) => response.url().includes("/payments/mx") && response.request().postDataJSON()?.action === "initialize");
        await page.getByRole("button", { name: "Place order and pay", exact: true }).click();
        const response = await initialization;
        assert.equal(response.status(), 200, `Initialize failed for ${scenario}`);
        const payment = await response.json(); replays.add(Number(payment.replayId));
        assert.equal(new URL(payment.paymentUrl).hostname, "sandbox.api.mxmerchant.com");
        const dialog = page.getByRole("dialog", { name: "Secure card payment" });
        await dialog.getByLabel("Card number", { exact: true }).fill("4111111111111111");
        await dialog.getByLabel("Expiration", { exact: true }).fill("1229");
        await dialog.getByLabel("Security code", { exact: true }).fill("123");
        if (await dialog.getByLabel("Billing ZIP code").count()) await dialog.getByLabel("Billing ZIP code").fill("13669");
        if (await dialog.getByLabel("Billing street address").count()) await dialog.getByLabel("Billing street address").fill("828 Morris St");
        if (scenario === "pickup-save-card") await dialog.getByLabel("Save this card for next time", { exact: true }).check();
        await dialog.getByRole("button", { name: "PAY", exact: true }).click();
      }
      await page.waitForURL(/\/order\/confirmation\?orderId=/, { timeout: 45_000 });
      const id = new URL(page.url()).searchParams.get("orderId")!;
      await expect(page.locator(".confirmationCard .eyebrow")).toContainText("Order #", { timeout: 30_000 });
      await expect(page.locator(".confirmationLines")).toContainText("Small French Fries");
      await expect(page.locator(".confirmationDue span")).toHaveText(scenario === "pickup-pay-later" ? "Due at pickup" : "Paid");
      await expect(page.getByRole("link", { name: "Start another order" })).toBeVisible();
      // Keep authenticated API checks inside Chromium: its loopback Secure
      // cookie handling matches the customer UI, unlike Playwright's API client.
      const confirmation = await page.evaluate((orderId) => fetch(`/api/customer/orders/${orderId}`).then((response) => response.json()), id);
      assert.ok(confirmation.order, "The browser must be able to read its order confirmation.");
      if (confirmation.order.waiting_for_open) {
        await expect(page.getByRole("heading", { name: "Your order is queued for opening" })).toBeVisible();
        await expect(page.locator(".trackerSteps [aria-current=step]")).toHaveText("Order placed");
        await expect(page.locator(".curbsideCheckIn")).toHaveCount(0);
      }
      const [order] = await sql`SELECT id,customer_id,status,payment_status,service_type,total_cents,paid_cents,amount_due_cents FROM ordering_orders WHERE id=${id}`;
      assert.equal(order.status, "sent_to_kitchen");
      assert.equal(order.service_type, scenario === "curbside-card" ? "curbside" : scenario === "delivery-card" ? "delivery" : "pickup");
      if (scenario === "delivery-card") {
        const [delivery] = await sql`SELECT o.delivery_fee_cents, a.formatted_address FROM ordering_orders o JOIN ordering_order_delivery_addresses a ON a.order_id=o.id WHERE o.id=${id}`;
        assert.ok(Number(delivery.delivery_fee_cents) > 0);
        assert.match(String(delivery.formatted_address), /3000/);
      }
      const payments = await sql`SELECT id,amount_cents FROM ordering_payment_transactions WHERE order_id=${id} AND transaction_type='payment' AND status='approved'`;
      if (scenario === "pickup-pay-later") {
        assert.equal(payments.length, 0); assert.equal(order.payment_status, "unpaid");
        assert.equal(Number(order.amount_due_cents), Number(order.total_cents));
        assert.equal(Number((await sql`SELECT count(*) n FROM ordering_points_ledger WHERE order_id=${id} AND entry_type='earn'`)[0].n), 0);
        savedAccount = await context.storageState();
        assert.ok(order.customer_id);
        savedCardCustomers.add(String(order.customer_id));
      } else {
        assert.equal(payments.length, 1); assert.equal(order.payment_status, "paid");
        assert.equal(Number(order.amount_due_cents), 0);
        assert.equal(Number(payments[0].amount_cents), Number(order.total_cents));
        const [checkout] = await sql`SELECT replay_id FROM ordering_mx_checkout_sessions WHERE order_id=${id} AND status='completed' ORDER BY created_at DESC LIMIT 1`;
        assert.ok(checkout);
        const replayId = Number(checkout.replay_id); replays.add(replayId);
        const retryStatus = await page.evaluate(async ({ orderId, replayId }) => {
          const response = await fetch(`/api/customer/orders/${orderId}/payments/mx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "confirm", replayId }) });
          return response.status;
        }, { orderId: id, replayId });
        assert.ok(retryStatus >= 200 && retryStatus < 300, `Repeated confirmation failed (${retryStatus}).`);
        assert.equal(Number((await sql`SELECT count(*) n FROM ordering_payment_transactions WHERE order_id=${id} AND transaction_type='payment'`)[0].n), 1);
      }
      if (scenario === "pickup-save-card") {
        const saved = await page.evaluate(() => fetch("/api/customer/account/cards").then((response) => response.json()));
        assert.equal(saved.cards.length, 1);
        assert.equal(saved.cards[0].last4, "1111");
      }
      if (scenario === "pickup-saved-card") {
        await page.goto("/account");
        await expect(page.getByRole("heading", { name: "Saved payment methods" })).toBeVisible();
        const card = page.locator(".accountContactRow").filter({ hasText: /1111/ });
        await card.getByRole("button", { name: "REMOVE", exact: true }).click();
        await expect(page.getByText("Card removed.", { exact: true })).toBeVisible();
        assert.deepEqual((await page.evaluate(() => fetch("/api/customer/account/cards").then((response) => response.json()))).cards, []);
      }
      assert.deepEqual(errors, []);
      if (process.env.WALKTHROUGH_OUTPUT_DIR) await page.screenshot({ path: `${process.env.WALKTHROUGH_OUTPUT_DIR}/${scenario}.png`, fullPage: true });
      results.push({ scenario, orderId: id, totalCents: Number(order.total_cents), paymentStatus: order.payment_status, passed: true });
      await context.close();
    }
  } finally {
    await browser.close().catch((error) => cleanupErrors.push(`Browser cleanup: ${String(error)}`));
    try {
      if (trackedOrders.size) {
        for (const row of await sql`SELECT replay_id FROM ordering_mx_checkout_sessions WHERE order_id=ANY(${[...trackedOrders]}::uuid[])`) replays.add(Number(row.replay_id));
      }
    } catch (error) { cleanupErrors.push(`Payment lookup for cleanup: ${String(error)}`); }
    for (const replayId of replays) {
      try {
        const payment = await findMxPaymentByReplayId(replayId);
        if (payment && /approved|settled/i.test(String(payment.status))) {
          await voidOrRefundMxPayment(String(payment.id));
          assert.match(String((await getMxPayment(String(payment.id))).status), /void/i);
        }
      } catch (error) { cleanupErrors.push(`Replay ${replayId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const { listSavedCards, removeSavedCard } = await import("../src/lib/mx-saved-cards");
    for (const customerId of savedCardCustomers) {
      try {
        for (const card of await listSavedCards(customerId)) await removeSavedCard(customerId, card.id);
        assert.deepEqual(await listSavedCards(customerId), []);
      } catch (error) { cleanupErrors.push(`Saved card cleanup: ${error instanceof Error ? error.message : String(error)}`); }
    }
    console.log(JSON.stringify({ results, sandboxPaymentsReversed: cleanupErrors.length === 0, cleanupErrors }, null, 2));
    assert.deepEqual(cleanupErrors, [], "Every approved sandbox payment must be reversed and verified.");
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
