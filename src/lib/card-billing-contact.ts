import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";

/** The name and billing address MX checks a keyed card against (AVS street and ZIP). */
export type CardBillingContact = { contactName: string; street1: string; postalCode: string };

/**
 * Billing contact for a keyed card payment: the validated delivery address for
 * delivery orders, otherwise the customer's primary saved address.
 */
export async function cardBillingContactForOrder(orderId: string, business: OrderingBusiness): Promise<CardBillingContact | undefined> {
  const row = (
    await getSql()`SELECT orders.first_name_snapshot,orders.last_name_snapshot,
    CASE WHEN orders.service_type IN ('delivery','no_contact_delivery') AND delivery.validation_status='validated' THEN delivery.line1 ELSE saved.line1 END line1,
    CASE WHEN orders.service_type IN ('delivery','no_contact_delivery') AND delivery.validation_status='validated' THEN delivery.postal_code ELSE saved.postal_code END postal_code
    FROM ordering_orders orders
    LEFT JOIN ordering_order_delivery_addresses delivery ON delivery.order_id=orders.id
    LEFT JOIN LATERAL (SELECT line1,postal_code FROM ordering_customer_addresses WHERE customer_id=orders.customer_id AND active=TRUE ORDER BY is_primary DESC,last_used_at DESC NULLS LAST,created_at DESC LIMIT 1) saved ON TRUE
    WHERE orders.id=${orderId} AND orders.business=${business} LIMIT 1`
  )[0];
  const contactName = `${row?.first_name_snapshot || ""} ${row?.last_name_snapshot || ""}`.trim();
  if (!contactName || !row?.line1 || !row?.postal_code) return undefined;
  return { contactName, street1: String(row.line1), postalCode: String(row.postal_code) };
}
