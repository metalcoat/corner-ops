import { getSql } from "@/lib/db";
import type { HelcimCheckoutCustomer } from "@/lib/helcim";
import type { OrderingBusiness } from "@/lib/ordering-core";

export async function helcimCustomerForOrder(
  orderId: string,
  business: OrderingBusiness,
): Promise<HelcimCheckoutCustomer | undefined> {
  const row = (
    await getSql()`SELECT orders.service_type,orders.first_name_snapshot,orders.last_name_snapshot,orders.phone_snapshot,
    CASE WHEN orders.service_type IN ('delivery','no_contact_delivery') AND delivery.validation_status='validated' THEN delivery.line1 ELSE saved.line1 END line1,
    CASE WHEN orders.service_type IN ('delivery','no_contact_delivery') AND delivery.validation_status='validated' THEN delivery.line2 ELSE saved.line2 END line2,
    CASE WHEN orders.service_type IN ('delivery','no_contact_delivery') AND delivery.validation_status='validated' THEN delivery.city ELSE saved.city END city,
    CASE WHEN orders.service_type IN ('delivery','no_contact_delivery') AND delivery.validation_status='validated' THEN delivery.state ELSE saved.state END state,
    CASE WHEN orders.service_type IN ('delivery','no_contact_delivery') AND delivery.validation_status='validated' THEN delivery.postal_code ELSE saved.postal_code END postal_code,
    CASE WHEN orders.service_type IN ('delivery','no_contact_delivery') AND delivery.validation_status='validated' THEN delivery.country ELSE 'US' END country
    FROM ordering_orders orders
    LEFT JOIN ordering_order_delivery_addresses delivery ON delivery.order_id=orders.id
    LEFT JOIN LATERAL (SELECT line1,line2,city,state,postal_code FROM ordering_customer_addresses WHERE customer_id=orders.customer_id AND active=TRUE ORDER BY is_primary DESC,last_used_at DESC NULLS LAST,created_at DESC LIMIT 1) saved ON TRUE
    WHERE orders.id=${orderId} AND orders.business=${business} LIMIT 1`
  )[0];
  const contactName =
    `${row?.first_name_snapshot || ""} ${row?.last_name_snapshot || ""}`.trim();
  const phone = String(row?.phone_snapshot || "").replace(/\D/g, "");
  if (!contactName || !row?.line1 || !row?.postal_code) return undefined;
  const address = {
    name: contactName,
    street1: String(row.line1),
    ...(row.line2 ? { street2: String(row.line2) } : {}),
    ...(row.city ? { city: String(row.city) } : {}),
    ...(row.state ? { province: String(row.state) } : {}),
    country:
      String(row.country || "US").toUpperCase() === "US"
        ? "USA"
        : String(row.country),
    postalCode: String(row.postal_code),
    ...(phone.length >= 10 && phone.length <= 16 ? { phone } : {}),
  };
  return {
    contactName,
    ...(phone.length >= 10 && phone.length <= 16 ? { cellPhone: phone } : {}),
    billingAddress: address,
    shippingAddress: address,
  };
}
