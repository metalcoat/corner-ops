import { getSql } from "@/lib/db";
import type { HelcimCheckoutCustomer } from "@/lib/helcim";
import type { OrderingBusiness } from "@/lib/ordering-core";

export async function helcimCustomerForOrder(orderId: string, business: OrderingBusiness): Promise<HelcimCheckoutCustomer | undefined> {
  const row = (await getSql()`SELECT orders.service_type,orders.first_name_snapshot,orders.last_name_snapshot,orders.phone_snapshot,address.line1,address.line2,address.city,address.state,address.postal_code,address.country,address.validation_status FROM ordering_orders orders LEFT JOIN ordering_order_delivery_addresses address ON address.order_id=orders.id WHERE orders.id=${orderId} AND orders.business=${business} LIMIT 1`)[0];
  const contactName = `${row?.first_name_snapshot || ""} ${row?.last_name_snapshot || ""}`.trim();
  const phone = String(row?.phone_snapshot || "").replace(/\D/g, "");
  if (!["delivery", "no_contact_delivery"].includes(String(row?.service_type)) || row?.validation_status !== "validated" || !contactName || !row?.line1 || !row?.postal_code) return undefined;
  const address = {
    name: contactName,
    street1: String(row.line1),
    ...(row.line2 ? { street2: String(row.line2) } : {}),
    ...(row.city ? { city: String(row.city) } : {}),
    ...(row.state ? { province: String(row.state) } : {}),
    country: String(row.country || "US").toUpperCase() === "US" ? "USA" : String(row.country),
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
