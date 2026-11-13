// Regression (failed before 2026-10-25 fix): chargeVoicePayment only runs assertOrderReadyForCheckout (name/phone/address present),
// not preflightDraftSubmit, so a draft that cannot be sent is charged first.
import { runRepro, errorText } from "./harness";
runRepro("charge-before-send-rules", async (ctx) => {
  const defects: string[] = [];
  const cases: Record<string, unknown> = {};
  await ctx.openStore();
  // Case 1: delivery address validated but outside the delivery area.
  {
    const f = await ctx.make("delivery");
    await ctx.sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at,route_distance_miles) VALUES(${f.orderId},'1 Far Away Rd','1 Far Away Rd, Nowhere, NY 10001','1 Far Away Rd','Nowhere','NY','10001',40.0,-74.0,'repro','validated',NOW(),999)`;
    const preflight = await errorText(ctx.lifecycle.preflightDraftSubmit(f.orderId, "Corner Deli", { id: "repro", name: "Repro", type: "employee" } as any));
    const before = ctx.mx.sales;
    const chargeError = await errorText(ctx.charge(f.sessionId));
    const s = await ctx.state(f);
    cases.outOfAreaDelivery = { preflightError: preflight, mxSalesAttempted: ctx.mx.sales - before, chargeError, ...s };
    if (preflight && ctx.mx.sales > before) defects.push(`delivery outside area was charged before the send rule ran (preflight says: ${preflight})`);
  }
  // Case 2: an item went unavailable after pricing (sold out).
  {
    const f = await ctx.make("pickup");
    await ctx.sql`UPDATE ordering_menu_items SET available=FALSE WHERE id IN (SELECT item_id FROM ordering_order_items WHERE order_id=${f.orderId})`;
    const preflight = await errorText(ctx.lifecycle.preflightDraftSubmit(f.orderId, "Corner Deli", { id: "repro", name: "Repro", type: "employee" } as any));
    const before = ctx.mx.sales;
    const chargeError = await errorText(ctx.charge(f.sessionId));
    const s = await ctx.state(f);
    cases.soldOutItem = { preflightError: preflight, mxSalesAttempted: ctx.mx.sales - before, chargeError, ...s };
    if (preflight && ctx.mx.sales > before) defects.push(`sold-out item was charged before the send rule ran (preflight says: ${preflight})`);
    if (s.payments === 1 && s.session.status === "approved_unapplied")
      defects.push("tender WAS applied (1 payment row, order paid) but the session is labelled approved_unapplied/order_commit_failed and the caller is told it needs review");
  }
  return { cases, defects };
});
