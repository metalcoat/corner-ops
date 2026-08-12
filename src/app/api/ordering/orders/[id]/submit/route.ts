import { canAccessBusiness, getSession } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { OrderConflictError, submitDraftOrder } from "@/lib/ordering-order-lifecycle";
import type { OrderingBusiness } from "@/lib/ordering-core";

export const runtime = "nodejs";

function businessFrom(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    const body = await request.json() as { business?: unknown };
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    const { id } = await context.params;
    const result = await submitDraftOrder(id, business, session.email);
    return Response.json(result);
  } catch (error) {
    if (error instanceof OrderConflictError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
