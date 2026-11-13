// The Ogdensburg Bowl (1121 Paterson St) is delivered with no fee on every channel; the address decides it, not the caller.
import { actor, runRepro } from "./harness";
runRepro("fee-free-address", async (ctx) => {
  const defects: string[] = [];
  await ctx.openStore();
  const f = await ctx.make("delivery");
  await ctx.sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at,route_distance_miles,route_duration_seconds) VALUES(${f.orderId},'1121 paterson street','1121 Paterson St, Ogdensburg, NY 13669, USA','1121 Paterson St','Ogdensburg','NY','13669',44.70,-75.47,'test','validated',NOW(),1.8,300)`;
  // A fee left on the draft from before (another address) must come off.
  await ctx.sql`UPDATE ordering_orders SET delivery_fee_cents=400,total_cents=total_cents+400,amount_due_cents=amount_due_cents+400 WHERE id=${f.orderId}`;
  await ctx.lifecycle.syncDraftTotals(f.orderId, "Corner Deli");
  const synced = (await ctx.sql`SELECT delivery_fee_cents FROM ordering_orders WHERE id=${f.orderId}`)[0];
  if (Number(synced.delivery_fee_cents) !== 0) defects.push(`draft for the bowl kept a ${synced.delivery_fee_cents}¢ delivery fee`);
  // No fee, but the delivery minimum still applies.
  let blocked = false;
  try { await ctx.lifecycle.submitDraftOrder(f.orderId, "Corner Deli", actor); } catch (error) { blocked = /minimum/i.test(String((error as Error).message)); }
  if (!blocked) defects.push("a bowl order under the delivery minimum was sent");
  const { replaceAiDraft } = await import("../../src/lib/ordering-ai-tools");
  const draft = (await ctx.sql`SELECT version FROM ordering_orders WHERE id=${f.orderId}`)[0];
  await replaceAiDraft({ business: "Corner Deli", actor, orderId: f.orderId, expectedVersion: Number(draft.version), service: "delivery", items: [{ itemId: String((await ctx.sql`SELECT item_id FROM ordering_order_items WHERE order_id=${f.orderId} LIMIT 1`)[0].item_id), quantity: 6 }] as any, firstName: "Repro", callerPhone: "3155550100" });
  await ctx.lifecycle.submitDraftOrder(f.orderId, "Corner Deli", actor);
  const sent = (await ctx.sql`SELECT status,delivery_fee_cents,total_cents,subtotal_cents,discount_cents,tax_cents,tip_cents FROM ordering_orders WHERE id=${f.orderId}`)[0];
  if (Number(sent.delivery_fee_cents) !== 0) defects.push(`sent bowl order charged a ${sent.delivery_fee_cents}¢ delivery fee`);
  const expected = Number(sent.subtotal_cents) - Number(sent.discount_cents) + Number(sent.tax_cents) + Number(sent.tip_cents);
  if (Number(sent.total_cents) !== expected) defects.push(`bowl total ${sent.total_cents} is not the food total ${expected}`);
  // Next door still pays.
  const g = await ctx.make("delivery");
  await ctx.sql`INSERT INTO ordering_order_delivery_addresses(order_id,entered_address,formatted_address,line1,city,state,postal_code,latitude,longitude,provider,validation_status,validated_at,route_distance_miles,route_duration_seconds) VALUES(${g.orderId},'1120 Paterson St','1120 Paterson St, Ogdensburg, NY 13669, USA','1120 Paterson St','Ogdensburg','NY','13669',44.70,-75.47,'test','validated',NOW(),1.8,300)`;
  await ctx.lifecycle.syncDraftTotals(g.orderId, "Corner Deli");
  const neighbor = (await ctx.sql`SELECT delivery_fee_cents FROM ordering_orders WHERE id=${g.orderId}`)[0];
  if (Number(neighbor.delivery_fee_cents) <= 0) defects.push("1120 Paterson St got no delivery fee");
  return { minimumStillApplies: blocked, bowl: { ...sent }, neighborFee: Number(neighbor.delivery_fee_cents), defects };
});
