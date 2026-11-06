import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { listWaitingOnlineOrders } from "@/lib/ordering-online-alerts";
import { orderingActor } from "@/lib/ordering-route-auth";
import { listWebPaymentsNeedingReview } from "@/lib/customer-payment-review";

export const runtime = "nodejs";

// Lives under /api/ordering/orders so the proxy's existing Deli POS API policy
// already covers it (a /api/ordering/kitchen/* sub-path would be rejected).
export async function GET(request: Request) {
  try {
    const value = new URL(request.url).searchParams.get("business");
    if (value !== "Corner Deli" && value !== "Tiki") throw new Error("Unknown business.");
    const business: OrderingBusiness = value;
    if (!await orderingActor(business)) return unauthorized();
    const [orders, paymentReviews] = await Promise.all([listWaitingOnlineOrders(business), listWebPaymentsNeedingReview(business)]);
    return isoJson({ business, orders, paymentReviews });
  } catch (error) {
    return apiError(error);
  }
}
