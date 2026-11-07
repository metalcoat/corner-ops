// Regression (order #20006, fixed 2026-10-30): replaceAiDraft zeroed the delivery fee when a cart was repriced after the
// address was saved. The card was charged without it, Send added it back, and the order showed PAID with $4 due.
import { actor, runRepro } from "./harness";
runRepro("delivery-fee-before-charge", async (ctx) => {
  const defects: string[] = [];
  await ctx.openStore();
  const { replaceAiDraft } = await import("../../src/lib/ordering-ai-tools");
  const f = await ctx.make("delivery");
  await ctx.sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at,route_distance_miles,route_duration_seconds) VALUES(${f.orderId},'412 Jay St','412 Jay St, Ogdensburg, NY 13669','412 Jay St','Ogdensburg','NY','13669',44.69,-75.49,'test','validated',NOW(),0.44,120)`;
  await ctx.lifecycle.syncDraftTotals(f.orderId, "Corner Deli");
  const before = (await ctx.sql`SELECT version,delivery_fee_cents FROM ordering_orders WHERE id=${f.orderId}`)[0];
  const fee = Number(before.delivery_fee_cents);
  if (fee <= 0) defects.push("the saved address did not put a delivery fee on the draft");
  await replaceAiDraft({ business: "Corner Deli", actor, orderId: f.orderId, expectedVersion: Number(before.version), service: "delivery", items: [{ itemId: String((await ctx.sql`SELECT item_id FROM ordering_order_items WHERE order_id=${f.orderId} LIMIT 1`)[0].item_id), quantity: 6 }] as any, firstName: "Repro", callerPhone: "3155550100" });
  const repriced = (await ctx.sql`SELECT delivery_fee_cents,total_cents,amount_due_cents,subtotal_cents,tip_cents,tax_cents,discount_cents FROM ordering_orders WHERE id=${f.orderId}`)[0];
  if (Number(repriced.delivery_fee_cents) !== fee) defects.push(`repricing the cart changed the delivery fee from ${fee} to ${repriced.delivery_fee_cents}`);
  const expectedTotal = Number(repriced.subtotal_cents) - Number(repriced.discount_cents) + Number(repriced.tax_cents) + Number(repriced.tip_cents) + fee;
  if (Number(repriced.total_cents) !== expectedTotal) defects.push(`total ${repriced.total_cents} does not include the fee (expected ${expectedTotal})`);
  await ctx.sql`UPDATE ordering_voice_payment_sessions SET amount_cents=${Number(repriced.amount_due_cents)} WHERE id=${f.sessionId}`;
  await ctx.charge(f.sessionId);
  const s = await ctx.state(f);
  if (Number(s.order.amount_due_cents) !== 0 || s.order.payment_status !== "paid") defects.push(`after the charge: ${s.order.payment_status} with ${s.order.amount_due_cents} due`);
  // A fee that still lands after a payment must not read PAID.
  const late = await ctx.make("delivery");
  const lateDraft = (await ctx.sql`SELECT version FROM ordering_orders WHERE id=${late.orderId}`)[0];
  await replaceAiDraft({ business: "Corner Deli", actor, orderId: late.orderId, expectedVersion: Number(lateDraft.version), service: "delivery", items: [{ itemId: String((await ctx.sql`SELECT item_id FROM ordering_order_items WHERE order_id=${late.orderId} LIMIT 1`)[0].item_id), quantity: 6 }] as any, firstName: "Repro", callerPhone: "3155550100" });
  await ctx.sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at,route_distance_miles,route_duration_seconds) VALUES(${late.orderId},'412 Jay St','412 Jay St, Ogdensburg, NY 13669','412 Jay St','Ogdensburg','NY','13669',44.69,-75.49,'test','validated',NOW(),0.44,120)`;
  await ctx.sql`UPDATE ordering_orders SET paid_cents=total_cents,amount_due_cents=0,payment_status='paid' WHERE id=${late.orderId}`;
  await ctx.lifecycle.submitDraftOrder(late.orderId, "Corner Deli", actor);
  const after = (await ctx.sql`SELECT payment_status,amount_due_cents FROM ordering_orders WHERE id=${late.orderId}`)[0];
  if (Number(after.amount_due_cents) > 0 && after.payment_status === "paid") defects.push("order reads PAID with money still due");
  return { fee, repriced: { ...repriced }, order: s.order, lateFee: { ...after }, defects };
});
