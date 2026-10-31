import type { OrderingBusiness } from "@/lib/ordering-core";
import { OrderConflictError, submitDraftOrder } from "@/lib/ordering-order-lifecycle";
import type { OrderingActor } from "@/lib/ordering-route-auth";

/**
 * Sends a draft to the kitchen after its payment has already been committed.
 * The payment cannot be undone here, so a send rule (ordering hours, missing
 * delivery details) must not surface as a generic 500 that hides the fact the
 * customer was charged. Returns a 409 response explaining both facts, or null
 * when the order was sent.
 */
export async function submitPaidDraft(orderId: string, business: OrderingBusiness, actor: OrderingActor): Promise<Response | null> {
  try {
    await submitDraftOrder(orderId, business, actor);
    return null;
  } catch (error) {
    if (!(error instanceof OrderConflictError)) throw error;
    return Response.json(
      {
        error: `Payment was recorded, but the order was NOT sent to the kitchen: ${error.message} Open the order and send it (a manager can override ordering hours).`,
        paymentRecorded: true,
      },
      { status: 409 },
    );
  }
}
