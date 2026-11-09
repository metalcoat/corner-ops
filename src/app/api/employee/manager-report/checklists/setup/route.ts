import { isoJson } from "@/lib/timestamp-values";
import { checklistManager } from "@/lib/store-checklist-access";
import { checklistSetup, moveSetupEntry, saveCountPlan, saveSetupEntry, type SetupKind } from "@/lib/store-checklists";

export const runtime = "nodejs";

// Managers add, rename, reorder and switch off checklists, their items, the deli salads and the fryers.
// Switching something off keeps its history; nothing is deleted from here.
const denied = () => isoJson({ error: "Manager access required." }, { status: 403 });
const fail = (error: unknown) => isoJson({ error: error instanceof Error ? error.message : "Could not save." }, { status: 400 });

export async function GET() {
  if (!(await checklistManager())) return denied();
  return isoJson(await checklistSetup());
}

/** Add (no id) or change one list, item, salad or fryer, or a count's make-today plan. */
export async function PUT(request: Request) {
  const actor = await checklistManager();
  if (!actor) return denied();
  try {
    const body = (await request.json()) as Record<string, unknown>;
    // kind "plan": a counted thing's make-today minimums by size (pizza dough).
    if (body.kind === "plan") await saveCountPlan(String(body.countKey || ""), { minimums: body.minimums, leftoverSize: body.leftoverSize }, actor.name);
    else await saveSetupEntry(body, actor.name);
    return isoJson(await checklistSetup());
  } catch (error) {
    return fail(error);
  }
}

/** { kind, id, direction: "up" | "down" } moves one entry a place. */
export async function PATCH(request: Request) {
  const actor = await checklistManager();
  if (!actor) return denied();
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const kind = body.kind as SetupKind;
    if (!["list", "item", "salad", "fryer"].includes(kind) || (body.direction !== "up" && body.direction !== "down")) throw new Error("Bad move.");
    await moveSetupEntry(kind, String(body.id || ""), body.direction, actor.name);
    return isoJson(await checklistSetup());
  } catch (error) {
    return fail(error);
  }
}
