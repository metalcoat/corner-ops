import { isoJson } from "@/lib/timestamp-values";
import { checklistManager } from "@/lib/store-checklist-access";
import { checklistSetup, moveSetupEntry, saveSetupEntry, type SetupKind } from "@/lib/store-checklists";

export const runtime = "nodejs";

// Managers add, rename, reorder and switch off checklists, their items and the deli salads.
// Switching something off keeps its history; nothing is deleted from here.
const denied = () => isoJson({ error: "Manager access required." }, { status: 403 });
const fail = (error: unknown) => isoJson({ error: error instanceof Error ? error.message : "Could not save." }, { status: 400 });

export async function GET() {
  if (!(await checklistManager())) return denied();
  return isoJson(await checklistSetup());
}

/** Add (no id) or change one list, item or salad. */
export async function PUT(request: Request) {
  const actor = await checklistManager();
  if (!actor) return denied();
  try {
    await saveSetupEntry((await request.json()) as Record<string, unknown>, actor.name);
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
    if (!["list", "item", "salad"].includes(kind) || (body.direction !== "up" && body.direction !== "down")) throw new Error("Bad move.");
    await moveSetupEntry(kind, String(body.id || ""), body.direction, actor.name);
    return isoJson(await checklistSetup());
  } catch (error) {
    return fail(error);
  }
}
