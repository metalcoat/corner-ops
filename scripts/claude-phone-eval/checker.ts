#!/usr/bin/env node
// Proves the background Claude order checker (src/lib/ai-phone-order-checker.ts) on the logged dev Gemini
// calls: it must flag the four orders Gemini got wrong and stay quiet on the four it got right, stay quiet
// while an item is still being asked about, and fail closed (status error, no throw) on a bad key or timeout.
// Read-only on the dev database. Run: npx tsx scripts/claude-phone-eval/checker.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { localValidationEnv } from "../validation-env";

localValidationEnv();
const KEY_FILE = "/opt/corner-ops/config/anthropic-dev.env";
if (!process.env.ANTHROPIC_API_KEY && existsSync(KEY_FILE)) loadEnvFile(KEY_FILE);

const CALLS: Array<{ callId: string; wrong: boolean; what: string }> = [
  { callId: "27fc630a-b103-4082-8cc0-ed0177695be1", wrong: true, what: "Big Boss no tomato missing; 30 medium + 20 hot instead of 10 hot / 20 medium" },
  { callId: "af3c7c7f-fbce-4100-b478-0ee861779a01", wrong: true, what: "BBQ rejected: the 30 wings never got on the order" },
  { callId: "383d8c28-c91a-45b2-96fa-0541ee95b878", wrong: true, what: "BBQ rejected: chicken tender dinner never got on the order" },
  { callId: "27410b10-c3da-4665-9091-b934c2f317a3", wrong: true, what: "one half-jalapeno pizza became two pizzas" },
  { callId: "ff9e1d2b-8a46-41ba-bcfc-a580cf17dea8", wrong: false, what: "two jumbo pepperoni" },
  { callId: "3a17f287-1bd0-49b2-8d10-b400ab21b6b5", wrong: false, what: "pizza, BBQ wings, fries with nachos" },
  { callId: "4b3d92cb-cf06-4fe2-83d2-c0004077dea3", wrong: false, what: "poutine, burger, pizza, Pepsi, Big Boss" },
  { callId: "a18bfba9-2fd0-4098-985a-6c9b335c9811", wrong: false, what: "pizza and 20 medium wings" },
];

async function main() {
  const checker = await import("../../src/lib/ai-phone-order-checker");
  assert.ok(process.env.ANTHROPIC_API_KEY, `ANTHROPIC_API_KEY (env or ${KEY_FILE}) is required`);
  let cost = 0;
  const ms: number[] = [];
  const failures: string[] = [];

  for (const row of CALLS) {
    const input = await checker.loadOrderCheckInput(row.callId, "final");
    const result = await checker.checkOrder(input);
    cost += result.costUsd;
    ms.push(result.ms);
    const flagged = result.status === "mismatch";
    const ok = result.status !== "error" && flagged === row.wrong;
    if (!ok) failures.push(`${row.callId.slice(0, 8)} (${row.what}): ${result.status} ${result.error || ""}`);
    console.log(`${ok ? "PASS" : "FAIL"} ${row.wrong ? "catch " : "quiet "} ${row.what}: ${result.status} ${result.ms} ms $${result.costUsd.toFixed(4)}`);
    for (const mismatch of result.mismatches) console.log(`      - ${mismatch.problem} | fix: ${mismatch.fix}`);
  }

  // Mid-order: wings asked for, sauce question still open, not in the cart yet. Must not flag.
  const midOrder = await checker.checkOrder({
    stage: "cart",
    serviceType: "delivery",
    transcript: [
      { speaker: "assistant", text: "Thanks for calling Corner Deli, is this going to be pickup or delivery?" },
      { speaker: "customer", text: "Delivery." },
      { speaker: "assistant", text: "What can I get for you?" },
      { speaker: "customer", text: "A jumbo pepperoni pizza and 20 wings." },
      { speaker: "assistant", text: "You got it! What sauce would you like on the wings?" },
    ],
    cart: [{ lineId: "a", name: "Pizza", variant: 'Jumbo Thin 16"', quantity: 1, modifiers: ["Regular Cooked", "Classic Sauce", "Pepperoni"], lineTotalCents: 1700 }],
  });
  cost += midOrder.costUsd;
  ms.push(midOrder.ms);
  console.log(`${midOrder.status === "ok" ? "PASS" : "FAIL"} quiet  open sauce question mid-order: ${midOrder.status} ${midOrder.ms} ms`);
  if (midOrder.status !== "ok") failures.push(`mid-order open question: ${midOrder.status} ${JSON.stringify(midOrder.mismatches)}`);

  // Dev call 2026-11-06 (b08100aa): "Turkey Big Boss" came through speech-to-text as Hindi noise; the checker
  // told Gemini to remove the correct sub. A garbled request must never be flagged as "not asked for".
  const garbled = await checker.checkOrder({
    stage: "cart",
    serviceType: "delivery",
    transcript: [
      { speaker: "assistant", text: "Excellent! So, what would you like to order today?" },
      { speaker: "customer", text: "सही जवाब होता है। आपके लिए एक बार" },
    ],
    cart: [{ lineId: "b", name: "Turkey Big Boss", variant: "Full Sub", quantity: 1, modifiers: [], lineTotalCents: 1225 }],
  });
  cost += garbled.costUsd;
  ms.push(garbled.ms);
  console.log(`${garbled.status === "ok" ? "PASS" : "FAIL"} quiet  garbled speech, item in cart: ${garbled.status}`);
  if (garbled.status !== "ok") failures.push(`garbled request flagged: ${JSON.stringify(garbled.mismatches)}`);

  // Chris 2026-11-06: mashed on a hot meat meal always gets gravy on top; gravy may go on the meal's fries.
  const gravy = await checker.checkOrder({
    stage: "final",
    serviceType: "pickup",
    transcript: [
      { speaker: "customer", text: "Can I get a hot turkey with Italian, and mashed potatoes. And a hot roast beef with ranch and fries with gravy on top." },
      { speaker: "assistant", text: "Here's your order: a hot turkey with Italian and mashed potatoes, and a hot roast beef with ranch and fries with gravy on them. Does that sound right?" },
    ],
    cart: [
      { lineId: "t", name: "Hot Turkey", variant: "", quantity: 1, modifiers: ["SM Tossed Sal", "Italian (On Salad)", "Small Mashed", "Gravy"], lineTotalCents: 1250 },
      { lineId: "r", name: "Hot Roast Beef", variant: "", quantity: 1, modifiers: ["SM Tossed Sal", "Ranch (On Salad)", "Small French Fries", "Gravy on Fries"], lineTotalCents: 1325 },
    ],
  });
  cost += gravy.costUsd;
  ms.push(gravy.ms);
  console.log(`${gravy.status === "ok" ? "PASS" : "FAIL"} quiet  gravy on meal mashed and fries: ${gravy.status}`);
  if (gravy.status !== "ok") failures.push(`meal gravy flagged: ${JSON.stringify(gravy.mismatches)}`);

  // Failure paths: a timeout comes back as status error and a missing key as disabled, never a throw.
  const realKey = process.env.ANTHROPIC_API_KEY;
  const sample = await checker.loadOrderCheckInput(CALLS[4].callId, "final");
  const timedOut = await checker.checkOrder(sample, 1);
  console.log(`${timedOut.status === "error" ? "PASS" : "FAIL"} timeout -> ${timedOut.status} (${timedOut.error}) ${timedOut.ms} ms`);
  if (timedOut.status !== "error") failures.push("timeout did not return error");
  delete process.env.ANTHROPIC_API_KEY;
  const noKey = await checker.checkOrder(sample);
  process.env.ANTHROPIC_API_KEY = realKey;
  console.log(`${noKey.status === "disabled" ? "PASS" : "FAIL"} no key -> ${noKey.status}`);
  if (noKey.status !== "disabled") failures.push("missing key did not return disabled");

  const sorted = [...ms].sort((a, b) => a - b);
  console.log(JSON.stringify({ checks: ms.length, costUsd: Number(cost.toFixed(4)), perCheckUsd: Number((cost / ms.length).toFixed(4)), p50Ms: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) }));
  if (failures.length) {
    console.error(`FAILURES:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
