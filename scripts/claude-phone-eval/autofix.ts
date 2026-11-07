#!/usr/bin/env node
// Proves Claude's own cart fixes (src/lib/ai-phone-order-fixer.ts, AI_PHONE_CLAUDE_AUTOFIX) on logged dev
// Gemini calls: a missing item or topping the caller clearly asked for gets added through the real price_order
// handler, and nothing is ever removed or reduced (the 2026-11-06 05:00 Turkey Big Boss garble must survive).
// Each replay runs the real Claude check, then applies its fixes inside a transaction that is rolled back.
// Run: npx tsx scripts/claude-phone-eval/autofix.ts
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { localValidationEnv } from "../validation-env";

localValidationEnv();
process.env.OPENAI_ORDERING_MCP_TOKEN = `autofix-${randomUUID()}`;
const KEY_FILE = "/opt/corner-ops/config/anthropic-dev.env";
if (!process.env.ANTHROPIC_API_KEY && existsSync(KEY_FILE)) loadEnvFile(KEY_FILE);

type Expect = "adds" | "nothing";
const REPLAYS: Array<{ callId: string; expect: Expect | "either"; what: string; untilAssistant?: RegExp; dropLines?: RegExp; dropModifiers?: RegExp; mustAdd?: RegExp }> = [
  // 2026-11-07 15:10: Gemini sent made-up group names, so the wings and dips never went on. Replayed at the
  // readback, before the caller noticed.
  { callId: "036f046f-34f0-4425-b7df-cad50396f543", expect: "adds", what: "15:10 readback: 30 mild wings with blue cheese and celery missing", untilAssistant: /^Okay, I have a jumbo pizza/, dropLines: /^Wings$/, mustAdd: /^Wings$/ },
  // Same call earlier: pepperoni rejected ("We don't have pepperoni on the menu"), the pizza went in plain.
  { callId: "036f046f-34f0-4425-b7df-cad50396f543", expect: "adds", what: "15:10 pepperoni missing on the jumbo pizza", untilAssistant: /^We don't have pepperoni/, dropLines: /^(?:Wings|Turkey)$/, dropModifiers: /^Pepperoni$/ },
  { callId: "b08100aa-0cbb-41f6-83ab-cb11107c784a", expect: "either", what: "05:00 garbled Turkey Big Boss: must not lose it" },
  // BBQ isn't on the menu: Claude may rightly leave these as a note for Gemini to ask about.
  { callId: "af3c7c7f-fbce-4100-b478-0ee861779a01", expect: "either", what: "BBQ rejected: the 30 wings never got on the order", mustAdd: /wings/i },
  { callId: "383d8c28-c91a-45b2-96fa-0541ee95b878", expect: "either", what: "BBQ rejected: chicken tender dinner never got on the order", mustAdd: /tender/i },
  { callId: "27fc630a-b103-4082-8cc0-ed0177695be1", expect: "either", what: "no tomato missing / wing counts wrong: removals stay notes" },
  { callId: "27410b10-c3da-4665-9091-b934c2f317a3", expect: "nothing", what: "half-jalapeno pizza split in two: removal stays a note" },
  { callId: "ff9e1d2b-8a46-41ba-bcfc-a580cf17dea8", expect: "nothing", what: "two jumbo pepperoni (right)" },
  { callId: "3a17f287-1bd0-49b2-8d10-b400ab21b6b5", expect: "nothing", what: "pizza, BBQ wings, fries with nachos (right)" },
  { callId: "4b3d92cb-cf06-4fe2-83d2-c0004077dea3", expect: "nothing", what: "poutine, burger, pizza, Pepsi, Big Boss (right)" },
  { callId: "a18bfba9-2fd0-4098-985a-6c9b335c9811", expect: "nothing", what: "pizza and 20 medium wings (right)" },
];

class Rollback extends Error {}

async function main() {
  const [checker, fixer, { getSql, withTransaction }] = await Promise.all([
    import("../../src/lib/ai-phone-order-checker"),
    import("../../src/lib/ai-phone-order-fixer"),
    import("../../src/lib/db"),
  ]);
  const failures: string[] = [];
  const fail = (what: string) => {
    failures.push(what);
    console.log(`FAIL ${what}`);
  };

  // Rules that need no model.
  const transcript = [
    { speaker: "customer" as const, text: "A jumbo pepperoni pizza." },
    { speaker: "assistant" as const, text: "Got it. Anything else?" },
    { speaker: "customer" as const, text: "And 20 hot wings." },
  ];
  const input = { stage: "cart" as const, serviceType: "pickup", transcript, cart: [{ lineId: "L1", name: "Pizza", variant: "Jumbo Thin 16\"", quantity: 1, modifiers: ["Classic Sauce"], lineTotalCents: 1500 }] };
  const pepperoni = { problem: "pepperoni missing", fix: "add Pepperoni", action: "add_to_line" as const, lineId: "L1", item: { name: "Pizza", variant: "", quantity: 1, modifiers: [{ name: "Pepperoni", group: "", placement: "" as const, portion: "" as const, amount: "" as const }] }, callerQuote: "jumbo pepperoni pizza", sure: true };
  const rules: Array<[string, boolean]> = [
    ["a sure, quoted topping on a line is applied", "arguments" in fixer.planFix(input, pepperoni)],
    ["the line keeps its own size and quantity", JSON.stringify(fixer.planFix(input, pepperoni)).includes('"quantity":1') && JSON.stringify(fixer.planFix(input, pepperoni)).includes("Jumbo Thin")],
    ["a note stays a note", !("arguments" in fixer.planFix(input, { ...pepperoni, action: "note" }))],
    ["not sure stays a note", !("arguments" in fixer.planFix(input, { ...pepperoni, sure: false }))],
    ["a quote the caller never said stays a note", !("arguments" in fixer.planFix(input, { ...pepperoni, callerQuote: "extra cheese please" }))],
    ["words Gemini hasn't answered yet stay a note", !("arguments" in fixer.planFix(input, { ...pepperoni, action: "add_item", lineId: "", callerQuote: "20 hot wings", item: { name: "Wings", variant: "20 Wings", quantity: 1, modifiers: [] } }))],
    ["an unknown line stays a note", !("arguments" in fixer.planFix(input, { ...pepperoni, lineId: "nope" }))],
    ["a big new quantity stays a note", !("arguments" in fixer.planFix(input, { ...pepperoni, action: "add_item", lineId: "", item: { ...pepperoni.item, quantity: 9 } }))],
    ["a changed cart is noticed", fixer.cartFingerprint(input.cart) !== fixer.cartFingerprint([{ ...input.cart[0], modifiers: ["Classic Sauce", "Pepperoni"] }])],
  ];
  for (const [name, ok] of rules) ok ? console.log(`PASS ${name}`) : fail(name);

  let cost = 0;
  for (const replay of REPLAYS) {
    let loaded = await checker.loadOrderCheckInput(replay.callId, "final");
    if (!loaded.orderId) {
      fail(`${replay.what}: no order on the call`);
      continue;
    }
    const box: { checked?: Awaited<ReturnType<typeof checker.checkOrder>>; outcome?: Awaited<ReturnType<typeof fixer.applyOrderFixes>> } = {};
    let after = loaded.cart;
    try {
      await withTransaction(async () => {
        const sql = getSql();
        await sql`UPDATE ordering_call_sessions SET state='ai',pending_item=NULL WHERE business='Corner Deli' AND three_cx_call_id=${replay.callId}`;
        // The cart as it was at that point of the call: lines Gemini added later are taken off.
        for (const line of loaded.cart.filter((row) => replay.dropLines?.test(row.name))) {
          await sql`DELETE FROM ordering_order_item_modifiers WHERE order_item_id IN (SELECT id FROM ordering_order_items WHERE order_id=${loaded.orderId} AND cart_line_id=${line.lineId})`;
          await sql`DELETE FROM ordering_order_items WHERE order_id=${loaded.orderId} AND cart_line_id=${line.lineId}`;
        }
        if (replay.dropModifiers)
          for (const row of await sql`SELECT m.id,m.option_name_snapshot FROM ordering_order_item_modifiers m JOIN ordering_order_items i ON i.id=m.order_item_id WHERE i.order_id=${loaded.orderId}`)
            if (replay.dropModifiers.test(String(row.option_name_snapshot))) await sql`DELETE FROM ordering_order_item_modifiers WHERE id=${row.id}`;
        loaded = await checker.loadOrderCheckInput(replay.callId, "final");
        let transcript = loaded.transcript;
        if (replay.untilAssistant) {
          const cut = transcript.findIndex((row) => row.speaker === "assistant" && replay.untilAssistant!.test(row.text));
          assert.ok(cut > 0, `${replay.what}: readback line not found`);
          transcript = transcript.slice(0, cut + 1);
        }
        const input = { ...loaded, transcript };
        box.checked = await checker.checkOrder(input);
        box.outcome = box.checked.status === "mismatch" ? await fixer.applyOrderFixes(replay.callId, input, box.checked) : box.checked;
        after = (await checker.loadOrderCheckInput(replay.callId, "final")).cart;
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    const { checked, outcome } = box;
    if (!checked || !outcome) continue;
    cost += checked.costUsd;
    if (checked.status === "error") {
      fail(`${replay.what}: check error ${checked.error}`);
      continue;
    }
    const fixed = outcome.fixed || [];
    const problems: string[] = [];
    for (const line of loaded.cart) {
      const now = after.find((row) => row.lineId === line.lineId);
      if (!now) problems.push(`removed ${line.name}`);
      else if (now.quantity < line.quantity) problems.push(`lowered ${line.name}`);
      else if (line.modifiers.some((modifier) => !now.modifiers.includes(modifier) && !/sauce|cooked/i.test(modifier)))
        problems.push(`dropped a modifier on ${line.name}: ${line.modifiers.filter((m) => !now.modifiers.includes(m)).join(", ")}`);
    }
    if (replay.expect === "adds" && !fixed.length) problems.push("nothing was fixed");
    if (replay.expect === "nothing" && fixed.length) problems.push(`fixed a right order: ${fixed.join("; ")}`);
    if (replay.mustAdd && fixed.length && !after.some((row) => !loaded.cart.some((line) => line.lineId === row.lineId) && replay.mustAdd!.test(row.name)) && !/added .+ to the/.test(fixed.join(" ")))
      problems.push(`expected item not added (${after.map((row) => row.name).join(", ")})`);
    const label = `${replay.what}: ${checked.status} -> ${outcome.status}${fixed.length ? ` [${fixed.join("; ")}]` : ""}${outcome.mismatches.length ? ` (${outcome.mismatches.length} left as note)` : ""}${outcome.skipped?.length ? ` skipped: ${outcome.skipped.join(", ")}` : ""}`;
    if (problems.length) fail(`${label} :: ${problems.join("; ")}`);
    else console.log(`PASS ${label}`);
    for (const row of outcome.mismatches) console.log(`      note: ${row.problem} (${row.action}${row.sure ? "" : ", not sure"})`);
  }
  console.log(JSON.stringify({ replays: REPLAYS.length, costUsd: Number(cost.toFixed(4)) }));
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
