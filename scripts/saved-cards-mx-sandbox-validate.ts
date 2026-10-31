#!/usr/bin/env node
// Saved cards against the MX *sandbox* (refuses production): the browser-side
// vault saves a card without it reaching Corner Ops, the account lists it, a POS
// phone order charges it (only with the customer's OK), and removing it works.
// Database fixtures are rolled back; the sandbox charge is voided.
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const ROLLBACK = "rollback:saved-cards-validation";

async function main(): Promise<void> {
  if (process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production") throw new Error("MX sandbox only.");
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureCustomerOrderingSchema } = await import("../src/lib/customer-ordering-schema");
  const { customerSessionCookie, customerSessionHash } = await import("../src/lib/customer-ordering-session");
  const { createDraftOrderWithVariants } = await import("../src/lib/ordering-orders-with-variants");
  const { voidOrRefundMxPayment } = await import("../src/lib/mx-merchant");
  const { startCardSave, syncSavedCards, listSavedCards, removeSavedCard } = await import("../src/lib/mx-saved-cards");
  const cardsRoute = await import("../src/app/api/customer/account/cards/route");
  await ensureCustomerOrderingSchema();
  const results: Record<string, unknown> = {};
  let paymentReference = "";
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const customerId = randomUUID(), sessionId = randomUUID(), hash = customerSessionHash(sessionId);
      await sql`INSERT INTO ordering_customers(id,business,display_name,first_name,last_name) VALUES(${customerId},'Corner Deli','Saved Card Test','Saved','CardTest')`;
      await sql`INSERT INTO ordering_customer_web_sessions(session_hash,customer_id,authenticated_at,last_seen_at,expires_at) VALUES(${hash},${customerId},NOW(),NOW(),NOW()+INTERVAL '1 day')`;
      const cookie = customerSessionCookie({ sessionId, customerId, authenticatedAt: Date.now(), expiresAt: Date.now() + 86_400_000 }).split(";")[0];
      const post = async (body: Record<string, unknown>) => {
        const response = await cardsRoute.POST(new Request("http://localhost/api/customer/account/cards", { method: "POST", headers: { "content-type": "application/json", cookie, "cf-connecting-ip": "203.0.113.60" }, body: JSON.stringify(body) }));
        return { status: response.status, body: await response.json() as Record<string, any> };
      };
      // 1. Save: the card goes from the "browser" straight to MX's vault.
      const start = await post({ action: "start" });
      if (start.status !== 200 || !start.body.token) throw new Error(`start failed: ${JSON.stringify(start.body)}`);
      const vault = await fetch(`${start.body.vaultUrl}?token=${encodeURIComponent(start.body.token)}&customerid=${encodeURIComponent(start.body.mxCustomerId)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ number: "4111111111111111", expiryMonth: "12", expiryYear: "2029", avsZip: "13669" }) });
      if (!vault.ok) throw new Error(`MX vault refused the card (${vault.status}).`);
      const saved = await post({ action: "saved", source: "checkout" });
      const card = saved.body.cards?.[0];
      if (!card || card.last4 !== "1111") throw new Error(`Saved card not recorded: ${JSON.stringify(saved.body)}`);
      const stored = (await sql`SELECT provider_payment_method_reference ref, consent_source FROM ordering_customer_payment_methods WHERE id=${card.id}`)[0];
      if (/4111/.test(String(stored.ref)) || !String(stored.consent_source).startsWith("customer:")) throw new Error("Stored something other than MX's token, or no consent source.");
      results.savedFromBrowser = { brand: card.brand, last4: card.last4 };

      // 2. POS phone order charges it, only with the customer's OK.
      const item = (await sql`SELECT i.id FROM ordering_menu_items i WHERE i.business='Corner Deli' AND i.active AND i.available AND i.base_price_cents>0
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_variants v WHERE v.item_id=i.id AND v.active)
          AND NOT EXISTS(SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_modifier_groups g ON g.id=l.group_id AND g.active WHERE l.item_id=i.id AND g.min_selections>0)
          ORDER BY i.base_price_cents LIMIT 1`)[0];
      const order = await createDraftOrderWithVariants({ business: "Corner Deli", source: "pos", serviceType: "pickup", createdBy: "saved-card-test", customerId,
        customerFirstName: "Saved", callerPhone: "3155550182", items: [{ itemId: String(item.id), quantity: 1 }] });
      const replayId = Math.floor(Math.random() * 2e9);
      await sql`INSERT INTO ordering_mx_checkout_sessions(id,business,order_id,amount_cents,replay_id,client_mutation_id,created_by,expires_at) VALUES(${randomUUID()},'Corner Deli',${order.id},${Number(order.amount_due_cents)},${replayId},${randomUUID()},'saved-card-test',NOW()+INTERVAL '30 minutes')`;
      const { chargeSavedCard } = await import("../src/lib/mx-saved-cards");
      const charged = await chargeSavedCard({ customerId, paymentMethodId: card.id, amountCents: Number(order.amount_due_cents), replayId });
      paymentReference = String(charged.id || "");
      if (!/approve/i.test(String(charged.status))) throw new Error("Saved card charge was not approved.");
      results.savedCardCharged = { amountCents: Number(order.amount_due_cents) };

      // 3. Remove.
      const left = await removeSavedCard(customerId, card.id);
      const resynced = await syncSavedCards(customerId, "customer:check");
      if (left.length || resynced.length || (await listSavedCards(customerId)).length) throw new Error("Removed card is still offered.");
      results.removed = true;
      void startCardSave;
      throw new Error(ROLLBACK);
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error;
  } finally {
    if (paymentReference) { await voidOrRefundMxPayment(paymentReference).catch(() => undefined); results.sandboxChargeVoided = true; }
  }
  console.log(JSON.stringify(results, null, 2));
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
