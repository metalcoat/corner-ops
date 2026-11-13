#!/usr/bin/env node
// Store rules for the AI phone line (db/migrations/0048, src/lib/ai-phone-store-rules.ts): saved rules reach the
// instructions a call starts with, off rules don't, size limits hold and every change is in the history. Runs inside a transaction that is rolled back.
// Run: npx tsx scripts/ai-phone-store-rules-validate.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
class Rollback extends Error {}

async function main() {
  const [{ getSql, withTransaction }, rules, prompt, config] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/ai-phone-store-rules"),
    import("../src/lib/openai-phone-prompt"),
    import("../src/lib/ordering-ai-phone-config"),
  ]);
  const business = `rules-test-${Date.now()}`;
  const checks: string[] = [];
  const check = (name: string, ok: unknown, detail?: unknown) => {
    assert.ok(ok, `${name}: ${JSON.stringify(detail ?? "")}`);
    checks.push(name);
    console.log(`PASS ${name}`);
  };
  try {
    await withTransaction(async () => {
      const sql = getSql();
      const migration = readFileSync(new URL("../db/migrations/0048_ai_phone_store_rules.sql", import.meta.url), "utf8")
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
      for (const statement of migration) await sql(Object.assign([statement], { raw: [statement] }) as unknown as TemplateStringsArray);

      check("no rules: no store rules block", (await rules.storeRulesInstructions(business)) === "");
      const nuggets = await rules.saveStoreRule({ title: "Nuggets", rule: "  “Chicken nuggets” is Chicken Nuggets (6, 10 or 20 piece).\n" }, "manager-1", business);
      const off = await rules.saveStoreRule({ title: "Drinks", rule: "Offer a 2 liter with every pizza.", active: false }, "manager-1", business);
      const block = await rules.storeRulesInstructions(business);
      check("an active rule reaches the instructions, trimmed", block.includes("- Nuggets: “Chicken nuggets” is Chicken Nuggets (6, 10 or 20 piece).") && block.startsWith("STORE RULES"), block);
      check("a rule that's off does not", !block.includes("2 liter"), block);
      const [settings, live] = await Promise.all([config.getAiPhoneSettings(), config.realtimeBusinessContext()]);
      const instructions = prompt.buildPhoneInstructions({ callId: "c", callerPhone: "", lineLabel: "TEST", settings, business: live, storeRules: block });
      check("the call instructions carry the store rules before the callId line", instructions.indexOf("STORE RULES") > instructions.indexOf("SECURE") && instructions.indexOf("STORE RULES") < instructions.indexOf("Current callId"), {});
      check("no store rules: instructions unchanged", !prompt.buildPhoneInstructions({ callId: "c", callerPhone: "", lineLabel: "TEST", settings, business: live }).includes("STORE RULES"));

      const edited = await rules.saveStoreRule({ id: nuggets.id, title: "Nuggets", rule: "Nuggets are Chicken Nuggets, never Popcorn Chicken." }, "manager-2", business);
      check("an edit keeps its place and records who changed it", edited.position === nuggets.position && edited.updatedBy === "manager-2");
      await assert.rejects(rules.saveStoreRule({ rule: "   " }, "m", business), /Write the rule/);
      check("an empty rule is refused", true);
      await assert.rejects(
        (async () => {
          for (let index = 0; index < 10; index++) await rules.saveStoreRule({ rule: "x".repeat(450) }, "m", business);
        })(),
        /characters/,
      );
      check("active rules are capped in size", true);
      for (const row of await rules.listStoreRules(business)) if (row.rule.startsWith("xxx")) await rules.deleteStoreRule(row.id, "m", business);
      const long = await rules.saveStoreRule({ rule: "z".repeat(900) }, "m", business);
      check("one rule is cut to its limit", long.rule.length === rules.STORE_RULE_LIMITS.ruleChars, long.rule.length);
      await rules.deleteStoreRule(off.id, "manager-1", business);
      const history = await rules.storeRuleHistory(business, 50);
      check("every change is in the history, newest first, with the text before it", history[0].action === "delete" && history[0].before?.rule.includes("2 liter") && history.some((row) => row.action === "update" && row.before?.rule.includes("6, 10 or 20")), history.slice(0, 3));
      await assert.rejects(rules.deleteStoreRule(off.id, "m", business), /no longer exists/);
      check("deleting twice is refused", true);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  console.log(JSON.stringify({ status: "passed", checks: checks.length }));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
