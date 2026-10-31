import { isoJson } from "@/lib/timestamp-values";
import { after } from "next/server";
import { getSql, withTransaction } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { ensureCustomerOrderingSchema } from "@/lib/customer-ordering-schema";
import { customerSessionHash, readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { submitDraftOrder, OrderConflictError } from "@/lib/ordering-order-lifecycle";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { sendCustomerOrderConfirmation } from "@/lib/customer-order-confirmation";
import { smsCodeRequired } from "@/lib/online-order-verification";
import { smsVerificationBypassUntil } from "@/lib/sms-verification-bypass";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

/** Submits a customer's online cart to the kitchen unpaid; they pay at pickup or delivery. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: orderId } = await context.params;
    const session = readCustomerOrderingSession(request);
    if (!session) return unauthorized();
    await ensureCustomerOrderingSchema();
    const signedIn = Boolean(session.customerId && session.authenticatedAt);
    if (smsCodeRequired({ payment: "pay_later", signedIn, bypassUntil: await smsVerificationBypassUntil(business) }))
      return isoJson({ error: "Verify your mobile number to pay at pickup or delivery, or pay by card.", code: "sms_verification_required" }, { status: 403 });
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
    // Owner rule (2026-10-24): at most 2 pay-at-pickup/delivery orders per customer
    // or phone number in 20 minutes; card orders aren't limited. Count and send under
    // per-customer and per-phone locks so two tabs can't both slip in a third order.
    const submitted = await withTransaction(async () => {
      const tx = getSql(); // the transaction's connection: the locks hold until commit
      const who = (await tx`SELECT customer_id, regexp_replace(COALESCE(phone_snapshot,''),'\\D','','g') phone FROM ordering_orders WHERE id=${orderId}`)[0];
      if (who?.customer_id) await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay-later:customer:${who.customer_id}`}))`;
      if (who?.phone) await tx`SELECT pg_advisory_xact_lock(hashtext(${`pay-later:phone:${who.phone}`}))`;
      const recentUnpaid = (await tx`
        SELECT COUNT(*)::int count FROM ordering_orders recent, ordering_orders this_order
        WHERE this_order.id=${orderId} AND recent.business='Corner Deli' AND recent.source='web' AND recent.id<>this_order.id
          AND recent.status NOT IN ('draft','cancelled') AND recent.paid_cents=0 AND recent.submitted_at>NOW()-INTERVAL '20 minutes'
          AND ((this_order.customer_id IS NOT NULL AND recent.customer_id=this_order.customer_id)
            OR (COALESCE(this_order.phone_snapshot,'')<>'' AND regexp_replace(recent.phone_snapshot,'\\D','','g')=regexp_replace(this_order.phone_snapshot,'\\D','','g')))`)[0];
      if (Number(recentUnpaid?.count || 0) >= 2)
        throw new OrderConflictError("You've placed 2 pay-at-pickup orders in the last 20 minutes. Please pay by card for this one, or call the store at (315) 393-2271.");
      return submitDraftOrder(orderId, business, { id: `web:${hash.slice(0, 16)}`, name: "Online customer", type: "web" });
    });
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
