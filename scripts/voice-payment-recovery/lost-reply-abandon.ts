// Regression (failed before 2026-10-25 fix): MX approves but its reply is lost (timeout). The real AGI never retries the charge:
// on any error it calls abandon, so the approved MX sale is left with no record anywhere.
import { runRepro, errorText } from "./harness";
runRepro("lost-reply-then-abandon (real AGI sequence)", async (ctx) => {
  await ctx.openStore();
  const f = await ctx.make();
  ctx.mx.onSale = async (_body, approve) => { approve(); throw new DOMException("Simulated lost processor reply", "TimeoutError"); };
  const chargeError = await errorText(ctx.charge(f.sessionId));
  const afterCharge = await ctx.state(f);
  // voice-payment.py: any exception from the charge call -> abandon(code=provider_payment_failed) -> "employee-help".
  await ctx.voice.abandonVoicePayment(f.sessionId, "provider_payment_failed");
  const final = await ctx.state(f);
  const defects: string[] = [];
  if (ctx.mx.approvals.size === 1 && final.payments === 0 && !final.session.has_reference)
    defects.push("MX holds an approved sale but no payment transaction and no provider reference was recorded");
  if (ctx.mx.lookups === 0) defects.push("no MX lookup by replayId was made after the lost reply");
  if (afterCharge.session.failure_code === "provider_declined") defects.push("a lost reply (timeout) is recorded as failure_code=provider_declined");
  if (final.session.status === "failed" && !final.posAlert) defects.push("session ends 'failed' and the order is not on the POS alert list, so staff cannot see the charge");
  return { chargeError, mxApprovedSales: ctx.mx.approvals.size, mxLookups: ctx.mx.lookups, afterCharge, final, defects };
});
