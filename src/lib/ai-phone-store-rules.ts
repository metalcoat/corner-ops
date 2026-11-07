import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";

// Store rules for the AI phone line, edited by managers in POS Settings (db/migrations/0048). The active rules
// go into the AI's instructions when each call starts, so a change applies from the next call with no deploy.
// They are the store's own wording and menu habits; the ordering system still checks every item and price.
// Every rule is re-read on every turn of a call, so the size is capped.

export const STORE_RULE_LIMITS = { rules: 30, ruleChars: 500, titleChars: 80, totalChars: 4000 };

export type StoreRule = { id: string; position: number; title: string; rule: string; active: boolean; updatedAt: string; updatedBy: string };

const clean = (value: unknown, max: number) =>
  String(value ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

function toRule(row: Record<string, any>): StoreRule {
  return {
    id: String(row.id),
    position: Number(row.position),
    title: String(row.title || ""),
    rule: String(row.rule),
    active: Boolean(row.active),
    updatedAt: new Date(row.updated_at).toISOString(),
    updatedBy: String(row.updated_by || ""),
  };
}

export async function listStoreRules(business = "Corner Deli"): Promise<StoreRule[]> {
  const rows = await getSql()`SELECT id,position,title,rule,active,updated_at,updated_by FROM ordering_ai_phone_rules WHERE business=${business} ORDER BY position,created_at`;
  return rows.map(toRule);
}

/** The active rules as one instructions block, or "" when there are none. Never throws: a call must still start. */
export async function storeRulesInstructions(business = "Corner Deli") {
  try {
    const rules = (await listStoreRules(business)).filter((rule) => rule.active);
    return storeRulesBlock(rules);
  } catch {
    return "";
  }
}

export function storeRulesBlock(rules: Array<Pick<StoreRule, "title" | "rule">>) {
  if (!rules.length) return "";
  const lines = rules.map((rule) => `- ${rule.title ? `${rule.title}: ` : ""}${rule.rule}`);
  return `STORE RULES (set by the store; where one conflicts with the general rules above, follow the store rule. Every item, modifier and price still goes through PRICE_ORDER, and the payment, safety and hand-off rules always apply):\n${lines.join("\n")}`;
}

function validate(rules: Array<Pick<StoreRule, "title" | "rule" | "active">>) {
  if (rules.length > STORE_RULE_LIMITS.rules) throw new Error(`At most ${STORE_RULE_LIMITS.rules} rules.`);
  const total = rules.filter((rule) => rule.active).reduce((sum, rule) => sum + rule.title.length + rule.rule.length, 0);
  if (total > STORE_RULE_LIMITS.totalChars)
    throw new Error(`Active rules are ${total} characters; keep them under ${STORE_RULE_LIMITS.totalChars} (the AI re-reads them every turn).`);
}

export async function saveStoreRule(
  input: { id?: string; title?: unknown; rule?: unknown; active?: unknown; position?: unknown },
  actorId: string,
  business = "Corner Deli",
): Promise<StoreRule> {
  const rule = clean(input.rule, STORE_RULE_LIMITS.ruleChars);
  if (!rule) throw new Error("Write the rule first.");
  const title = clean(input.title, STORE_RULE_LIMITS.titleChars);
  const active = input.active === undefined ? true : Boolean(input.active);
  return withTransaction(async () => {
    const sql = getSql();
    const existing = input.id ? (await sql`SELECT * FROM ordering_ai_phone_rules WHERE id=${input.id} AND business=${business} FOR UPDATE`)[0] : undefined;
    if (input.id && !existing) throw new Error("That rule no longer exists.");
    const others = (await listStoreRules(business)).filter((row) => row.id !== input.id);
    validate([...others, { title, rule, active }]);
    const position = Number.isInteger(Number(input.position)) && input.position !== undefined && input.position !== null && input.position !== ""
      ? Number(input.position)
      : existing ? Number(existing.position) : others.reduce((max, row) => Math.max(max, row.position), 0) + 10;
    const id = existing ? String(existing.id) : randomUUID();
    const saved = existing
      ? (await sql`UPDATE ordering_ai_phone_rules SET title=${title},rule=${rule},active=${active},position=${position},updated_by=${actorId},updated_at=NOW() WHERE id=${id} RETURNING *`)[0]
      : (await sql`INSERT INTO ordering_ai_phone_rules(id,business,position,title,rule,active,created_by,updated_by) VALUES(${id},${business},${position},${title},${rule},${active},${actorId},${actorId}) RETURNING *`)[0];
    await sql`INSERT INTO ordering_ai_phone_rule_history(rule_id,business,action,before,after,actor_id) VALUES(${id},${business},${existing ? "update" : "create"},${existing ? JSON.stringify(toRule(existing)) : null}::jsonb,${JSON.stringify(toRule(saved))}::jsonb,${actorId})`;
    return toRule(saved);
  });
}

export async function deleteStoreRule(id: string, actorId: string, business = "Corner Deli") {
  return withTransaction(async () => {
    const sql = getSql();
    const existing = (await sql`DELETE FROM ordering_ai_phone_rules WHERE id=${id} AND business=${business} RETURNING *`)[0];
    if (!existing) throw new Error("That rule no longer exists.");
    await sql`INSERT INTO ordering_ai_phone_rule_history(rule_id,business,action,before,after,actor_id) VALUES(${id},${business},'delete',${JSON.stringify(toRule(existing))}::jsonb,NULL,${actorId})`;
  });
}

export async function storeRuleHistory(business = "Corner Deli", limit = 30) {
  const rows = await getSql()`SELECT rule_id,action,before,after,actor_id,created_at FROM ordering_ai_phone_rule_history WHERE business=${business} ORDER BY created_at DESC,id DESC LIMIT ${limit}`;
  return rows.map((row: any) => ({
    ruleId: String(row.rule_id),
    action: String(row.action),
    before: typeof row.before === "string" ? JSON.parse(row.before) : row.before,
    after: typeof row.after === "string" ? JSON.parse(row.after) : row.after,
    actorId: String(row.actor_id || ""),
    at: new Date(row.created_at).toISOString(),
  }));
}
