import { canAccessBusiness, getSession } from "@/lib/auth";
import { normalizePosition, roleGroupForPosition } from "@/lib/business-positions";
import { apiError, unauthorized } from "@/lib/http";
import { createManualTimeEntry } from "@/lib/manual-time-entry";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const position = normalizePosition(business, body.position);
    return Response.json(await createManualTimeEntry({
      business,
      employeeId: String(body.employeeId || ""),
      position,
      roleGroup: roleGroupForPosition(business, position),
      clockIn: String(body.clockIn || ""),
      clockOut: String(body.clockOut || ""),
      note: String(body.note || ""),
      actor: session.displayName,
    }), { status: 201 });
  } catch (error) {
    const candidate = error as { code?: unknown };
    if (candidate?.code) return apiError(error);
    return Response.json({ error: error instanceof Error ? error.message : "The missing shift could not be created." }, { status: 400 });
  }
}
