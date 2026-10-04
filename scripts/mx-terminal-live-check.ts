#!/usr/bin/env node
// Live check of the MX terminal against the MX *sandbox* account in /opt/corner-ops/.env.
//
//   npm run mx:terminal-check                      list the terminals registered in MX
//   npm run mx:terminal-check -- --sale <GUID>     the POS flow: authorize $0.01, wait for the card,
//                                                  complete it with a $0.01 tip, then void the charge
//
// Refuses to run against production. Nothing is written to the POS database.
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
if (process.env.MX_ENVIRONMENT?.trim().toLowerCase() === "production") {
  console.error("MX_ENVIRONMENT is production. This check only runs against the MX sandbox.");
  process.exit(2);
}

async function main() {
  const { listMxTerminals, sendMxTerminalSale, getMxTerminalTransaction, newTerminalReplayId, normalizeMxTerminalId } = await import("../src/lib/mx-terminal");
  const { completeMxAuthorization, newReplayId, retrieveMxPayment, voidOrRefundMxPayment } = await import("../src/lib/mx-merchant");
  const terminals = await listMxTerminals();
  console.log(`MX sandbox terminals (${terminals.length}):`);
  for (const t of terminals) console.log(`  ${t.id}  ${t.name || "(unnamed)"}  provider=${t.providerKey || "?"}  ${t.enabled ? "enabled" : "DISABLED"}`);

  const flag = process.argv.indexOf("--sale");
  if (flag < 0) return;
  const terminalId = normalizeMxTerminalId(process.argv[flag + 1]);
  if (!terminalId) throw new Error("Pass the terminal's GUID after --sale (from the list above).");
  const replayId = newTerminalReplayId();
  console.log(`\nSending a $0.01 authorization to ${terminalId} (replayId ${replayId})…`);
  const sent = await sendMxTerminalSale({ terminalId, amountCents: 1, replayId, type: "Authorization" });
  console.log(`  MX: ${sent.status} (terminal payment ${sent.terminalPaymentId}). Tap, insert, or swipe a test card now.`);
  const deadline = Date.now() + 150_000;
  let last = "";
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await getMxTerminalTransaction(sent.terminalPaymentId);
    if (status.status !== last) console.log(`  status: ${status.status || "(blank)"}${status.message ? ` — ${status.message}` : ""}`);
    last = status.status;
    if (status.state === "approved") break;
    if (status.state !== "pending") throw new Error(`Terminal sale ended as ${status.state}.`);
    if (Date.now() > deadline) throw new Error("No answer from the terminal after 2.5 minutes. Cancel the prompt on the terminal.");
  }
  const auth = await retrieveMxPayment(replayId);
  const card = (auth.cardAccount || {}) as Record<string, unknown>;
  console.log(`  authorized: payment ${auth.id}, $${auth.amount}, ${card.cardType || "card"} …${card.last4 || "????"}, entry ${card.entryMode || "?"}, card token ${auth.paymentToken ? "returned" : "MISSING"}, auth code ${auth.authCode || "MISSING"}`);
  if (!auth.paymentToken || !auth.authCode) throw new Error("MX did not return the card token and auth code the POS needs to add the tip. Ask Dharma how to complete terminal authorizations.");
  // The tip step: complete the authorization for $0.01 + a $0.01 tip.
  const completed = await completeMxAuthorization({ paymentToken: String(auth.paymentToken), authCode: String(auth.authCode), amountCents: 2, tipCents: 1, replayId: newReplayId() });
  console.log(`  completed with tip: payment ${completed.id}, $${completed.amount} (tip $${completed.tip ?? "?"}), status ${completed.status}`);
  const reversal = await voidOrRefundMxPayment(String(completed.id));
  console.log(`  reversed with a ${reversal.kind} (status ${reversal.payment.status}). Check in MX Merchant that the $0.01 authorization (${auth.id}) is not still held.\nTerminal check passed.`);
}

main().catch((error) => { console.error(`Terminal check failed: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; });
