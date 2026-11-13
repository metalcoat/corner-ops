import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { businessDateOf } from "@/lib/ordering-registers";
import { OrderSearchInputError, parseOrderSearch, searchOrders } from "@/lib/ordering-order-search";
import { orderSearchAllowed } from "@/lib/order-search-access";

export const runtime = "nodejs";

/** Managers and owners search past orders from the employee app (or the store POS). */
export async function GET(request: Request) {
  try {
    if (!(await orderSearchAllowed())) return isoJson({ error: "Manager access required." }, { status: 403 });
    const filters = parseOrderSearch(new URL(request.url).searchParams, businessDateOf(new Date()));
    return isoJson({ ...(await searchOrders(filters)), today: businessDateOf(new Date()) });
  } catch (error) {
    if (error instanceof OrderSearchInputError) return isoJson({ error: error.message }, { status: 400 });
    return apiError(error);
  }
}
