// Regression (failed before 2026-10-25 fix): voice-payment.py waits 25 s for the charge call, but the server may spend 12 s (token)
// + 20 s (sale) at MX. The AGI then abandons while the server is still charging. The server's
// later status writes have no status guard, so the session/call end in contradictory states.
import { runRepro, errorText } from "./harness";
import { readFileSync } from "node:fs";
runRepro("agi-timeout-vs-server-charge", async (ctx) => {
  const defects: string[] = [];
  const agi = readFileSync(`${process.cwd()}/asterisk/voice-payment.py`, "utf8"), mx = readFileSync(`${process.cwd()}/src/lib/mx-merchant.ts`, "utf8");
  const agiTimeout = Number(agi.match(/urlopen\(request,timeout=(\d+)\)/)?.[1]);
  const serverWorst = Number(mx.match(/function mxFetch[\s\S]*?AbortSignal\.timeout\((\d+)\)/)?.[1]) / 1000 + Number(mx.match(/submitMxVoicePayment[\s\S]*?AbortSignal\.timeout\(([\d_]+)\)/)?.[1].replace(/_/g, "")) / 1000;
  if (serverWorst > agiTimeout) defects.push(`AGI charge timeout ${agiTimeout}s < server worst case ${serverWorst}s at MX`);
  await ctx.openStore();
  // Case A: MX approves after the AGI has already abandoned.
  {
    const f = await ctx.make();
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    ctx.mx.onSale = async (_b, approve) => { await gate; return approve(); };
    const charging = errorText(ctx.charge(f.sessionId));
    await new Promise((r) => setTimeout(r, 200));
    await ctx.voice.abandonVoicePayment(f.sessionId, "provider_payment_failed"); // AGI timed out, tells caller to wait for an employee
    const afterAbandon = await ctx.state(f);
    release();
    const chargeError = await charging;
    const final = await ctx.state(f);
    if (afterAbandon.session.status === "failed" && final.payments === 1)
      defects.push(`caller was told payment failed (session 'failed', call handoff_reason '${afterAbandon.call.handoff_reason}') yet the card was charged and the order recorded paid (final session '${final.session.status}')`);
    (globalThis as any).caseA = { afterAbandon, chargeError, final };
  }
  // Case B: MX reply lost after the AGI abandoned -> failure path rewrites a 'failed' session back to 'collecting'.
  {
    const f = await ctx.make();
    let release!: () => void; const gate = new Promise<void>((r) => (release = r));
    ctx.mx.onSale = async (_b, approve) => { await gate; approve(); throw new DOMException("lost reply", "TimeoutError"); };
    const charging = errorText(ctx.charge(f.sessionId));
    await new Promise((r) => setTimeout(r, 200));
    await ctx.voice.abandonVoicePayment(f.sessionId, "provider_payment_failed");
    release();
    const chargeError = await charging;
    const final = await ctx.state(f);
    if (final.session.status === "collecting") defects.push("an abandoned ('failed') session was rewritten to 'collecting' by the late provider-failure branch");
    (globalThis as any).caseB = { chargeError, final };
  }
  return { agiTimeoutSeconds: agiTimeout, serverWorstCaseSeconds: serverWorst, caseA: (globalThis as any).caseA, caseB: (globalThis as any).caseB, defects };
});
