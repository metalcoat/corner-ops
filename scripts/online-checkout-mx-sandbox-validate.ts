#!/usr/bin/env node
// Online card checkout against the MX *sandbox* (refuses production): one payment
// attempt per order, and a charge for an order that changed meanwhile is voided at
// MX instead of recorded. Calls the real route handler in-process; database
// fixtures are rolled back and outbound texts/email/push are disabled.
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:online-checkout-mx-sandbox-validation";

async function main(): Promise<void> {
  if (process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production") throw new Error("MX sandbox only.");
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureCustomerOrderingSchema } = await import("../src/lib/customer-ordering-schema");
  const { customerSessionCookie, customerSessionHash } = await import("../src/lib/customer-ordering-session");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { findMxPaymentByReplayId } = await import("../src/lib/mx-merchant");
  const { POST } = await import("../src/app/api/customer/orders/[id]/payments/mx/route");
  await ensureCustomerOrderingSchema();
  const results: Record<string, unknown> = {};
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const item = (await sql`
        SELECT i.id FROM ordering_menu_items i
        WHERE i.business='Corner Deli' AND i.active AND i.available AND i.base_price_cents>0
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_variants v WHERE v.item_id=i.id AND v.active)
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_modifier_groups g ON g.id=l.group_id AND g.active WHERE l.item_id=i.id AND g.min_selections>0)
        ORDER BY i.base_price_cents LIMIT 1`)[0];
      const customerId = randomUUID(), sessionId = randomUUID(), hash = customerSessionHash(sessionId);
      await sql`INSERT INTO ordering_customers(id,business,display_name) VALUES(${customerId},'Corner Deli','MX Sandbox Test')`;
      await sql`INSERT INTO ordering_customer_web_sessions(session_hash,customer_id,authenticated_at,last_seen_at,expires_at) VALUES(${hash},${customerId},NOW(),NOW(),NOW()+INTERVAL '1 day')`;
      const cookie = customerSessionCookie({ sessionId, customerId, authenticatedAt: Date.now(), expiresAt: Date.now() + 86_400_000 }).split(";")[0];
      const newOrder = async () => {
        const order = await createDraftOrderWithVariants({ business: "Corner Deli", source: "web", serviceType: "pickup", createdBy: "web:sandbox", customerId,
          customerFirstName: "Sandbox", callerPhone: "3155550181", items: [{ itemId: String(item.id), quantity: 1 }] });
        await sql`INSERT INTO ordering_customer_web_carts(order_id,session_hash) VALUES(${order.id},${hash})`;
        return String(order.id);
      };
      const call = async (orderId: string, body: Record<string, unknown>) => {
        const response = await POST(new Request(`http://localhost/api/customer/orders/${orderId}/payments/mx`, {
          method: "POST", headers: { "content-type": "application/json", cookie, "cf-connecting-ip": "203.0.113.50" }, body: JSON.stringify(body) }),
          { params: Promise.resolve({ id: orderId }) });
        return { status: response.status, body: await response.json() as Record<string, any> };
      };
      const chargeAtMx = async (init: Record<string, any>) => {
        const response = await fetch(`${init.paymentUrl}?token=${encodeURIComponent(init.token)}&echo=true`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ merchantId: init.merchantId, tenderType: "Card", paymentType: "Sale", amount: init.amount, replayId: init.replayId, source: "API",
            cardAccount: { number: "4111111111111111", expiryMonth: "12", expiryYear: "2029", cvv: "123", avsZip: "13669", avsStreet: "828 Morris St" } }) });
        return await response.json() as Record<string, any>;
      };

      // 1. A second tab / reload gets the same attempt (same replayId).
      const first = await newOrder();
      const a = await call(first, { action: "initialize" });
      const b = await call(first, { action: "initialize" });
      if (a.status !== 200 || b.status !== 200) throw new Error(`initialize failed: ${JSON.stringify([a.body, b.body])}`);
      if (a.body.replayId !== b.body.replayId) throw new Error("A second initialize started a second payment attempt.");
      const afterDecline = await call(first, { action: "initialize", retryAfterDecline: true });
      if (afterDecline.body.replayId === a.body.replayId) throw new Error("A retry after a decline reused the declined attempt.");
      results.oneAttemptPerOrder = true;

      // 2. The order changes after the payment starts: the charge is voided at MX, not recorded.
      const second = await newOrder();
      const init = await call(second, { action: "initialize" });
      const charged = await chargeAtMx(init.body);
      if (!String(charged.status || "").toLowerCase().includes("approve")) throw new Error(`Sandbox charge failed: ${JSON.stringify(charged).slice(0, 200)}`);
      await sql`UPDATE ordering_orders SET total_cents=total_cents+100, amount_due_cents=amount_due_cents+100 WHERE id=${second}`;
      const confirm = await call(second, { action: "confirm", replayId: init.body.replayId });
      const atMx = await findMxPaymentByReplayId(Number(init.body.replayId));
      const paid = Number((await sql`SELECT paid_cents FROM ordering_orders WHERE id=${second}`)[0].paid_cents);
      if (confirm.status !== 409 || !/changed/i.test(String(confirm.body.error)) || paid !== 0 || !/void/i.test(String(atMx?.status)))
        throw new Error(`Changed-order charge was not voided: ${JSON.stringify({ confirm, paid, mx: atMx?.status })}`);
      results.changedOrderChargeVoided = true;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  }
  console.log(JSON.stringify(results, null, 2));
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
