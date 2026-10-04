// Driver tablet support: the order behind each delivery, dispatch settings
// (live tracking on the web order page, 3CX call links), and call logging.
import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import { ensureOrderingVariantSchema } from "@/lib/ordering-variant-schema";
import { ensureOrderingChannelSchema } from "@/lib/ordering-channel-schema";
import { ensureDriverDeliverySchema, type DriverActor } from "@/lib/ordering-driver-delivery";
import { callLink, DEFAULT_CALL_LINK_TEMPLATE, validCallLinkTemplate } from "@/lib/driver-call-link";

export type DispatchSettings = {
  /** Show the driver on the map on the customer's web order page while they head there. */
  showLiveDriver: boolean;
  /** How the tablet places calls; {phone} is replaced with the customer's digits. */
  callLinkTemplate: string;
};
const DEFAULTS: DispatchSettings = {
  showLiveDriver: false,
  callLinkTemplate: DEFAULT_CALL_LINK_TEMPLATE,
};

let schemaReady: Promise<void> | null = null;
export function ensureDriverOrdersSchema() {
  schemaReady ??= (async () => {
    await ensureDriverDeliverySchema();
    await ensureOrderingVariantSchema();
    await ensureOrderingChannelSchema();
  })().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

export async function getDispatchSettings(business: string): Promise<DispatchSettings> {
  await ensureDriverOrdersSchema();
  const row = (await getSql()`SELECT show_live_driver,call_link_template FROM ordering_driver_dispatch_settings WHERE business=${business}`)[0];
  if (!row) return { ...DEFAULTS };
  return {
    showLiveDriver: Boolean(row.show_live_driver),
    callLinkTemplate: validCallLinkTemplate(String(row.call_link_template || ""))
      ? String(row.call_link_template).trim()
      : DEFAULT_CALL_LINK_TEMPLATE,
  };
}

export async function saveDispatchSettings(actor: DriverActor, input: Partial<DispatchSettings>) {
  if (!actor.manager) throw new Error("Dispatcher access required.");
  const current = await getDispatchSettings(actor.business);
  const template = input.callLinkTemplate == null ? current.callLinkTemplate : String(input.callLinkTemplate).trim() || DEFAULT_CALL_LINK_TEMPLATE;
  if (!validCallLinkTemplate(template))
    throw new Error("Call link must start with tel:, callto:, sip:, or https:// and include {phone}.");
  const next: DispatchSettings = {
    showLiveDriver: input.showLiveDriver == null ? current.showLiveDriver : Boolean(input.showLiveDriver),
    callLinkTemplate: template,
  };
  await getSql()`INSERT INTO ordering_driver_dispatch_settings(business,show_live_driver,call_link_template,updated_by,updated_at)
    VALUES(${actor.business},${next.showLiveDriver},${next.callLinkTemplate},${actor.employeeId},NOW())
    ON CONFLICT(business) DO UPDATE SET show_live_driver=EXCLUDED.show_live_driver,
      call_link_template=EXCLUDED.call_link_template,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
  return next;
}

async function deliveryFor(actor: DriverActor, deliveryId: string) {
  const row = (await getSql()`SELECT d.id,d.order_id,d.driver_employee_id,d.status FROM ordering_delivery_assignments d WHERE d.id=${deliveryId} AND d.business=${actor.business}`)[0];
  if (!row || !(actor.manager || row.driver_employee_id === actor.employeeId))
    throw new Error("This delivery is not assigned to you.");
  return row;
}

export type DriverOrderItem = {
  id: string;
  name: string;
  variant: string;
  quantity: number;
  cancelledQuantity: number;
  lineTotalCents: number;
  instructions: string;
  combo: string;
  options: string[];
};
export type DriverOrderDetail = {
  deliveryId: string;
  orderId: string;
  displayNumber: string;
  customerName: string;
  phone: string;
  callUrl: string | null;
  address: string;
  unit: string;
  deliveryNotes: string;
  specialInstructions: string;
  serviceType: string;
  timingMode: string;
  scheduledFor: string | null;
  createdAt: string;
  paymentStatus: string;
  paymentPreference: string;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  paidCents: number;
  amountDueCents: number;
  trackingUrl: string | null;
  items: DriverOrderItem[];
};

/** Everything a driver needs about one order, for the tablet's order screen. */
export async function driverOrderDetail(actor: DriverActor, deliveryId: string, baseUrl: string): Promise<DriverOrderDetail> {
  await ensureDriverOrdersSchema();
  const delivery = await deliveryFor(actor, deliveryId), sql = getSql();
  const order = (await sql`SELECT o.id,o.display_number,COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),'Guest') customer_name,
      o.phone_snapshot,o.special_instructions,o.service_type,o.timing_mode,o.scheduled_for,o.created_at,o.payment_status,o.payment_preference,
      o.subtotal_cents,o.discount_cents,COALESCE(o.delivery_fee_cents,0) delivery_fee_cents,o.tax_cents,o.tip_cents,o.total_cents,o.paid_cents,o.amount_due_cents,
      a.formatted_address,a.line2,a.delivery_notes_snapshot
    FROM ordering_orders o JOIN ordering_order_delivery_addresses a ON a.order_id=o.id WHERE o.id=${delivery.order_id}`)[0];
  if (!order) throw new Error("Delivery not found.");
  const items = await sql`SELECT id,item_name_snapshot,variant_name_snapshot,quantity,COALESCE(cancelled_quantity,0) cancelled_quantity,line_total_cents,special_instructions,combo_name_snapshot
    FROM ordering_order_items WHERE order_id=${order.id} ORDER BY sort_order,created_at,id`;
  const ids = items.map((item) => String(item.id));
  const modifiers = ids.length ? await sql`SELECT order_item_id,group_name_snapshot,option_name_snapshot,quantity FROM ordering_order_item_modifiers WHERE order_item_id=ANY(${ids}::uuid[]) ORDER BY created_at` : [];
  const combos = ids.length ? await sql`SELECT order_item_id,group_name_snapshot,option_name_snapshot FROM ordering_order_item_combo_selections WHERE order_item_id=ANY(${ids}::uuid[]) ORDER BY created_at` : [];
  const token = (await sql`SELECT token_value FROM ordering_delivery_tracking_tokens WHERE delivery_id=${deliveryId} AND revoked_at IS NULL AND expires_at>NOW() AND token_value<>'' ORDER BY created_at DESC LIMIT 1`)[0];
  const settings = await getDispatchSettings(actor.business);
  const phone = String(order.phone_snapshot || "");
  return {
    deliveryId,
    orderId: String(order.id),
    displayNumber: String(order.display_number),
    customerName: String(order.customer_name),
    phone,
    callUrl: callLink(settings.callLinkTemplate, phone),
    address: String(order.formatted_address || ""),
    unit: String(order.line2 || ""),
    deliveryNotes: String(order.delivery_notes_snapshot || ""),
    specialInstructions: String(order.special_instructions || ""),
    serviceType: String(order.service_type),
    timingMode: String(order.timing_mode || "asap"),
    scheduledFor: order.scheduled_for ? new Date(order.scheduled_for).toISOString() : null,
    createdAt: new Date(order.created_at).toISOString(),
    paymentStatus: String(order.payment_status),
    paymentPreference: String(order.payment_preference || "unspecified"),
    subtotalCents: Number(order.subtotal_cents),
    discountCents: Number(order.discount_cents),
    deliveryFeeCents: Number(order.delivery_fee_cents),
    taxCents: Number(order.tax_cents),
    tipCents: Number(order.tip_cents),
    totalCents: Number(order.total_cents),
    paidCents: Number(order.paid_cents),
    amountDueCents: Number(order.amount_due_cents),
    trackingUrl: token ? `${baseUrl}/track/${token.token_value}` : null,
    items: items.map((item) => {
      const id = String(item.id);
      return {
        id,
        name: String(item.item_name_snapshot),
        variant: String(item.variant_name_snapshot || ""),
        quantity: Number(item.quantity),
        cancelledQuantity: Number(item.cancelled_quantity),
        lineTotalCents: Number(item.line_total_cents),
        instructions: String(item.special_instructions || ""),
        combo: String(item.combo_name_snapshot || ""),
        options: [
          ...combos.filter((row) => String(row.order_item_id) === id).map((row) => `${row.group_name_snapshot}: ${row.option_name_snapshot}`),
          ...modifiers.filter((row) => String(row.order_item_id) === id).map((row) => `${Number(row.quantity) > 1 ? `${row.quantity}× ` : ""}${row.option_name_snapshot}`),
        ],
      };
    }),
  };
}

/** Records that the driver or dispatcher called the customer, and returns the dial link. */
export async function logCustomerCall(actor: DriverActor, deliveryId: string) {
  await ensureDriverOrdersSchema();
  const delivery = await deliveryFor(actor, deliveryId), sql = getSql();
  const order = (await sql`SELECT phone_snapshot FROM ordering_orders WHERE id=${delivery.order_id}`)[0];
  const url = callLink((await getDispatchSettings(actor.business)).callLinkTemplate, String(order?.phone_snapshot || ""));
  if (!url) throw new Error("This order has no phone number.");
  await sql`INSERT INTO ordering_delivery_audit(id,delivery_id,order_id,employee_id,device_session_id,action,previous_status,new_status,details)
    VALUES(${randomUUID()},${deliveryId},${delivery.order_id},${actor.employeeId},${actor.deviceSessionId},'customer_called',${delivery.status},${delivery.status},${JSON.stringify({ via: url.split(":")[0] })}::jsonb)`;
  return { ok: true, url };
}
