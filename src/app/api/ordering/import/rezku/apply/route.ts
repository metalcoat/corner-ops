import { getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { applyMenuImportRun } from "@/lib/ordering-menu-import";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    if (session.role !== "Owner" && session.role !== "Co-Owner") {
      return Response.json({ error: "Only an owner or co-owner can apply a menu import." }, { status: 403 });
    }

    const body = await request.json() as Record<string, unknown>;
    const runId = String(body.runId || "").trim();
    if (!runId) return Response.json({ error: "runId is required." }, { status: 400 });

    const result = await applyMenuImportRun({
      runId,
      approvedBy: session.email,
      allowWarnings: body.confirmWarnings === true,
    });
    return Response.json(result);
  } catch (error) {
    return apiError(error);
  }
}
