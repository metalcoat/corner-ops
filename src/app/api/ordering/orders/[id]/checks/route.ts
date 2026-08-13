import { apiError, unauthorized } from "@/lib/http";
import { CheckConflictError, ensureInitialCheck, listChecks, splitCheck } from "@/lib/ordering-checks";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const { id } = await params;
    await ensureInitialCheck(id, "Corner Deli", actor);
    return Response.json({ checks: await listChecks(id, "Corner Deli") });
  } catch (error) {
    if (error instanceof CheckConflictError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const body = await request.json() as { fromCheckId?: unknown; lines?: Array<{ orderItemId?: unknown; quantity?: unknown }> };
    const { id } = await params;
    return Response.json(await splitCheck({ orderId: id, business: "Corner Deli", fromCheckId: String(body.fromCheckId || ""), lines: (body.lines || []).map((line) => ({ orderItemId: String(line.orderItemId || ""), quantity: Number(line.quantity) })), actor }), { status: 201 });
  } catch (error) {
    if (error instanceof CheckConflictError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
