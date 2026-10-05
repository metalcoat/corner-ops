import { apiError } from "@/lib/http";
import { isAuthorizationResponse, orderingManagerActor } from "@/lib/ordering-route-auth";
import { SupplierCostError, supplierCostAction, supplierCostDashboard } from "@/lib/ordering-supplier-costs";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  try {
    const mode = new URL(request.url).searchParams.get("mode") === "order" ? "order" : "week";
    return Response.json(await supplierCostDashboard(mode));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const actor = await orderingManagerActor("Corner Deli");
  if (isAuthorizationResponse(actor)) return actor;
  try {
    return Response.json(await supplierCostAction(await request.json(), actor.name));
  } catch (error) {
    if (error instanceof SupplierCostError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
