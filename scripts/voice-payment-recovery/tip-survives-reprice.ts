// Regression (fixed 2026-10-30): replaceAiDraft took tip_cents from the temporary draft (0), so a caller who tipped and then
// changed the order lost the tip. Same reprice as the delivery-fee bug in delivery-fee-before-charge.ts.
import { actor, runRepro } from "./harness";
runRepro("tip-survives-reprice", async (ctx) => {
  const defects: string[] = [];
  await ctx.openStore();
  const { replaceAiDraft } = await import("../../src/lib/ordering-ai-tools");
  const { setCheckoutTip } = await import("../../src/lib/ordering-payments");
  const f = await ctx.make("pickup");
  await setCheckoutTip({ orderId: f.orderId, business: "Corner Deli", tipCents: 500, actor } as any);
  const before = (await ctx.sql`SELECT version,tip_cents,total_cents FROM ordering_orders WHERE id=${f.orderId}`)[0];
  if (Number(before.tip_cents) !== 500) defects.push(`fixture tip did not save: ${before.tip_cents}`);
  const item = String((await ctx.sql`SELECT item_id FROM ordering_order_items WHERE order_id=${f.orderId} LIMIT 1`)[0].item_id);
  await replaceAiDraft({ business: "Corner Deli", actor, orderId: f.orderId, expectedVersion: Number(before.version), service: "pickup", items: [{ itemId: item, quantity: 2 }] as any, firstName: "Repro", callerPhone: "3155550100" });
  const after = (await ctx.sql`SELECT subtotal_cents,discount_cents,tax_cents,tip_cents,delivery_fee_cents,total_cents,amount_due_cents FROM ordering_orders WHERE id=${f.orderId}`)[0];
  if (Number(after.tip_cents) !== 500) defects.push(`repricing changed the tip from 500 to ${after.tip_cents}`);
  const expected = Number(after.subtotal_cents) - Number(after.discount_cents) + Number(after.tax_cents) + 500 + Number(after.delivery_fee_cents);
  if (Number(after.total_cents) !== expected || Number(after.amount_due_cents) !== expected) defects.push(`total ${after.total_cents} / due ${after.amount_due_cents}, expected ${expected}`);
  return { before: { ...before }, after: { ...after }, defects };
});
