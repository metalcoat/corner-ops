import { isoJson } from "@/lib/timestamp-values";
import { authenticateDeliPosPin } from "@/lib/pos-auth";
import { pinAttemptKeys } from "@/lib/pos-access-guard";
import { currentScreen, screenSigner } from "@/lib/screen-auth";
import {
  checkItems, checklistScreen, confirmWorker, logSaladBatch, uncheckItem, updateSaladBatch, voidSaladBatch, workerFromPass, workerPass,
} from "@/lib/store-checklists";

export const runtime = "nodejs";

// The in-store checklist screen (/pos/checklists). The screen itself keeps an always-on pass; each tick or salad
// batch is recorded as whoever last typed their PIN on it (a short pass that lapses after a few idle minutes).
const screenAllowed = async () => Boolean((await currentScreen("checklists")) || (await screenSigner()));
const fail = (error: unknown, status = 400) => isoJson({ error: error instanceof Error ? error.message : "Something went wrong." }, { status });

export async function GET() {
  if (!(await screenAllowed())) return isoJson({ error: "Sign this screen in first." }, { status: 401 });
  try {
    return isoJson(await checklistScreen());
  } catch (error) {
    return fail(error, 500);
  }
}

export async function POST(request: Request) {
  if (!(await screenAllowed())) return isoJson({ error: "Sign this screen in first." }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(new Error("Bad request."));
  }
  if (body.action === "signin") {
    try {
      // Checks the PIN with the usual attempt limits but signs nobody into the POS.
      const session = await authenticateDeliPosPin(body.pin, pinAttemptKeys(request.headers));
      return isoJson(workerPass({ employeeId: session.employeeId, name: session.name, role: session.posRole }));
    } catch (error) {
      return fail(error, 401);
    }
  }
  const pass = workerFromPass(body.token);
  if (!pass) return isoJson({ error: "Type your PIN.", signedOut: true }, { status: 401 });
  try {
    const worker = await confirmWorker(pass);
    let batch = null;
    if (body.action === "check") await checkItems(Array.isArray(body.itemIds) ? body.itemIds.map(String) : [], worker, body.bulk === true);
    else if (body.action === "uncheck") await uncheckItem(String(body.itemId || ""), worker, body.reason);
    else if (body.action === "salad") batch = await logSaladBatch(String(body.saladId || ""), worker, { batchSize: body.batchSize, notes: body.notes });
    else if (body.action === "batch") batch = await updateSaladBatch(Number(body.id), { batchSize: body.batchSize, notes: body.notes });
    else if (body.action === "void-batch") await voidSaladBatch(Number(body.id), worker, body.reason);
    else return fail(new Error("Unknown action."));
    // Every tap keeps the same person signed in for another few minutes.
    return isoJson({ ...workerPass({ employeeId: worker.employeeId, name: worker.name, role: worker.role }), batch, screen: await checklistScreen() });
  } catch (error) {
    return fail(error);
  }
}
