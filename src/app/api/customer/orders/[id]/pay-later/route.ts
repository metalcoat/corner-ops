import { isoJson } from "@/lib/timestamp-values";
import { after } from "next/server";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { customerSessionHash, readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { submitDraftOrder, OrderConflictError } from "@/lib/ordering-order-lifecycle";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { sendCustomerOrderConfirmation } from "@/lib/customer-order-confirmation";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

/** Submits a customer's online cart to the kitchen unpaid; they pay at pickup or delivery. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: orderId } = await context.params;
    const session = readCustomerOrderingSession(request);
    if (!session?.customerId || !session.authenticatedAt) return unauthorized();
    await ensureCustomerOrderingSchema();
    const hash = customerSessionHash(session.sessionId), sql = getSql();
    const order = (
      await sql`SELECT orders.id,orders.status,orders.source,orders.service_type FROM ordering_customer_web_carts carts JOIN ordering_orders orders ON orders.id=carts.order_id WHERE carts.order_id=${orderId} AND carts.session_hash=${hash} AND carts.replaced_at IS NULL LIMIT 1`
    )[0];
    if (!order) return unauthorized();
    if (order.source !== "web" || !["pickup", "delivery"].includes(String(order.service_type)))
      throw new OrderConflictError("This order cannot be submitted online.");
    if (order.service_type === "delivery" && !(await sql`SELECT 1 FROM ordering_order_delivery_addresses WHERE order_id=${orderId} AND validation_status='validated' LIMIT 1`)[0])
      throw new OrderConflictError("Validate the delivery address before submitting the order.");
    if (order.status !== "draft") throw new OrderConflictError("This order is no longer awaiting submission.");
    const submitted = await submitDraftOrder(orderId, business, { id: `web:${hash.slice(0, 16)}`, name: "Online customer", type: "web" });
    await dispatchSubmittedOrderPrintJobs(orderId, business);
    after(async () => {
      await sendCustomerOrderConfirmation(orderId);
    });
    return isoJson({ order: submitted.order, paymentStatus: "unpaid", payLater: true }, { status: 201 });
  } catch (error) {
    if (error instanceof OrderConflictError) return isoJson({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
