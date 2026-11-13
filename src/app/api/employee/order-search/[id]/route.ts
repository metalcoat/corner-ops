import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { orderSearchDetail } from "@/lib/ordering-order-search";
import { orderSearchAllowed } from "@/lib/order-search-access";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!(await orderSearchAllowed())) return isoJson({ error: "Manager access required." }, { status: 403 });
    const order = await orderSearchDetail((await context.params).id);
    if (!order) return isoJson({ error: "Order not found." }, { status: 404 });
    return isoJson(order);
  } catch (error) {
    return apiError(error);
  }
}
