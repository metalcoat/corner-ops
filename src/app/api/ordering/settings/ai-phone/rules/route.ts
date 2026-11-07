import { isoJson } from "@/lib/timestamp-values";
import { orderingManagerActor, isAuthorizationResponse } from "@/lib/ordering-route-auth";
import { deleteStoreRule, listStoreRules, saveStoreRule, storeRuleHistory, STORE_RULE_LIMITS } from "@/lib/ai-phone-store-rules";

export const runtime = "nodejs";

// Store rules for the AI phone line (managers only). A change applies from the next call.
export async function GET() {
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  const [rules, history] = await Promise.all([listStoreRules(), storeRuleHistory()]);
  return isoJson({ rules, history, limits: STORE_RULE_LIMITS });
}

export async function PUT(request: Request) {
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const rule = await saveStoreRule({ id: body.id ? String(body.id) : undefined, title: body.title, rule: body.rule, active: body.active, position: body.position }, actor.id);
    return isoJson({ rule, rules: await listStoreRules() });
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Could not save the rule." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    await deleteStoreRule(id, actor.id);
    return isoJson({ rules: await listStoreRules() });
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Could not delete the rule." }, { status: 400 });
  }
}
