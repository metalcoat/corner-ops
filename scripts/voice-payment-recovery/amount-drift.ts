// Regression (failed before 2026-10-25 fix): the voice session amount is fixed at prepare time and never compared with the order's
// amount due before charging (online checkout compares and voids at MX; voice does neither).
import { runRepro, errorText } from "./harness";
runRepro("amount-drift-between-prepare-and-charge", async (ctx) => {
  const defects: string[] = [];
  await ctx.openStore();
  // Case 1: amount due dropped (e.g. tip removed / promo applied) -> card tender exceeds balance.
  const lower = await ctx.make();
  await ctx.sql`UPDATE ordering_orders SET tip_cents=0,total_cents=total_cents-100,amount_due_cents=amount_due_cents-100 WHERE id=${lower.orderId}`;
  const lowerError = await errorText(ctx.charge(lower.sessionId));
  const lowerState = await ctx.state(lower);
  if (ctx.mx.approvals.size >= 1 && lowerState.payments === 0 && !lowerState.posAlert)
    defects.push("over-amount charge approved at MX, commit refused, session approved_unapplied: not voided and not on any staff-visible list");
  // Case 2: amount due rose -> partial tender; order stays an unsent draft while the caller hears 'approved'.
  const higher = await ctx.make();
  await ctx.sql`UPDATE ordering_orders SET total_cents=total_cents+100,amount_due_cents=amount_due_cents+100 WHERE id=${higher.orderId}`;
  let higherResult: unknown = null;
  const higherError = await errorText((async () => { higherResult = await ctx.charge(higher.sessionId); })());
  const higherState = await ctx.state(higher);
  if ((higherResult as any)?.approved && higherState.order.status === "draft")
    defects.push("charge returned approved:true (AGI plays 'approved', call ended) but the order is a partially-paid unsent draft");
  return { lower: { chargeError: lowerError, ...lowerState }, higher: { chargeError: higherError, result: higherResult, ...higherState }, defects };
});
