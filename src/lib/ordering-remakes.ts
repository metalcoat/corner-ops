import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { getSession, canAccessBusiness } from "@/lib/auth";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import { ensureOrderingAddressSchema, saveOrderDeliveryAddress } from "@/lib/ordering-address-schema";
import { ensureDriverDeliverySchema } from "@/lib/ordering-driver-delivery";
import { ensureOrderingInventorySchema } from "@/lib/ordering-inventory-schema";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";
import { validateDeliveryAddress, routeDeliveryAddress } from "@/lib/ordering-address";
import { createDraftOrder } from "@/lib/ordering-orders";
import { snapshotAndFormatOrder } from "@/lib/ordering-print-format";
import { kitchenTicketTimingLines } from "@/lib/ordering-kitchen-ticket";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import { getOrderDetail, listOrders } from "@/lib/ordering-order-center";
import type { OrderingActor } from "@/lib/ordering-route-auth";

const BUSINESS = "Corner Deli" as const;

export async function remakeManager(): Promise<OrderingActor | null> {
  const session = await getSession();
  if (!session || !canAccessBusiness(session, BUSINESS) || !["Owner", "Co-Owner", "Manager"].includes(session.role)) return null;
  return { id: session.email, email: session.email, name: session.displayName, type: "employee", role: session.role === "Manager" ? "manager" : "owner" };
}

export async function remakeSearch(query: string) {
  const q = query.trim().slice(0, 100);
  if (q.length < 2) return [];
  return listOrders({ business: BUSINESS, query: q, searchDays: 365 });
}

export async function remakeOrderDetail(id: string) {
  return getOrderDetail(BUSINESS, id);
}

export type RemakeInput = {
  originalOrderId: string;
  clientMutationId: string;
  items: Array<{ orderItemId: string; quantity: number }>;
  specialItem: string;
  reason: string;
  serviceType: "pickup" | "delivery";
  customerName: string;
  phone: string;
  address: string;
  unit: string;
  deliveryNotes: string;
  scheduledFor: string | null;
};

export function validateRemakeInput(value: unknown): RemakeInput {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const items = Array.isArray(raw.items) ? raw.items.map((item) => ({ orderItemId: String(item?.orderItemId || ""), quantity: Number(item?.quantity) })) : [];
  const input: RemakeInput = {
    originalOrderId: String(raw.originalOrderId || ""),
    clientMutationId: String(raw.clientMutationId || ""),
    items,
    specialItem: String(raw.specialItem || "").trim().slice(0, 300),
    reason: String(raw.reason || "").trim().slice(0, 500),
    serviceType: raw.serviceType === "delivery" ? "delivery" : "pickup",
    customerName: String(raw.customerName || "").trim().slice(0, 120),
    phone: String(raw.phone || "").trim().slice(0, 40),
    address: String(raw.address || "").trim().slice(0, 240),
    unit: String(raw.unit || "").trim().slice(0, 120),
    deliveryNotes: String(raw.deliveryNotes || "").trim().slice(0, 300),
    scheduledFor: raw.scheduledFor ? String(raw.scheduledFor) : null,
  };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (raw.serviceType !== "pickup" && raw.serviceType !== "delivery") throw new Error("Choose pickup or delivery.");
  if (!uuid.test(input.originalOrderId) || !uuid.test(input.clientMutationId)) throw new Error("Choose an order and retry this request.");
  if (items.length > 20 || items.some((item) => !uuid.test(item.orderItemId) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 50) || new Set(items.map((item) => item.orderItemId)).size !== items.length) throw new Error("Choose valid remake quantities.");
  if (!items.length && !input.specialItem) throw new Error("Choose at least one item or enter a special item to make.");
  if (input.reason.length < 3) throw new Error("Describe the problem so the remake has an audit reason.");
  if (!input.customerName || !input.phone) throw new Error("Customer name and phone are required.");
  if (input.serviceType === "delivery" && input.address.length < 5) throw new Error("Enter a complete delivery address.");
  if (input.scheduledFor) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(input.scheduledFor)) throw new Error("Choose a valid scheduled time.");
    const due = new Date(input.scheduledFor).getTime();
    if (!Number.isFinite(due) || due < Date.now() + 60_000 || due > Date.now() + 30 * 86_400_000) throw new Error("Choose a pickup or delivery time between one minute and 30 days from now.");
  }
  return input;
}

let schemaPromise: Promise<void> | null = null;
async function ensureRemakeSchema() {
  if (!schemaPromise) schemaPromise = (async () => {
    await ensureOrderingPosSchema();
    await ensureOrderingAddressSchema();
    await ensureDriverDeliverySchema();
    await ensureOrderingInventorySchema();
    await ensureOrderingMenuOverrideSchema();
    await getSql()`CREATE TABLE IF NOT EXISTS ordering_manager_remakes (
      id UUID PRIMARY KEY, original_order_id UUID NOT NULL REFERENCES ordering_orders(id),
      remake_order_id UUID NOT NULL UNIQUE REFERENCES ordering_orders(id),
      client_mutation_id UUID NOT NULL UNIQUE, reason TEXT NOT NULL,
      special_item TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  })().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

async function recordRemakeInventory(orderId: string, actor: OrderingActor) {
  const sql = getSql();
  await sql`INSERT INTO ordering_inventory_movements(id,business,inventory_item_id,location_id,delta_quantity,unit,reason,order_id,order_item_id,inventory_link_id,employee_id,estimated_unit_cost_cents,note,source,created_by,details)
    SELECT gen_random_uuid(),${BUSINESS},link.inventory_item_id,location.location_id,-(link.quantity_used*line.quantity),link.unit,'comp',line.order_id,line.id,link.id,NULL,inventory.estimated_unit_cost_cents,line.item_name_snapshot,'manager_remake',${actor.id},jsonb_build_object('menuItemId',line.item_id)
    FROM ordering_order_items line JOIN ordering_menu_inventory_links link ON link.business=${BUSINESS} AND link.menu_item_id=line.item_id AND link.active=TRUE JOIN ordering_inventory_items inventory ON inventory.id=link.inventory_item_id AND inventory.active=TRUE
    LEFT JOIN LATERAL(SELECT location_id FROM ordering_inventory_item_locations WHERE inventory_item_id=inventory.id AND active=TRUE ORDER BY is_default DESC,created_at LIMIT 1)location ON TRUE WHERE line.order_id=${orderId} ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO ordering_inventory_movements(id,business,inventory_item_id,location_id,delta_quantity,unit,reason,order_id,order_item_id,inventory_link_id,employee_id,estimated_unit_cost_cents,note,source,created_by,details)
    SELECT gen_random_uuid(),${BUSINESS},link.inventory_item_id,location.location_id,-(link.quantity_used*modifier.quantity*line.quantity),link.unit,'comp',line.order_id,line.id,link.id,NULL,inventory.estimated_unit_cost_cents,modifier.option_name_snapshot,'manager_remake',${actor.id},jsonb_build_object('modifierOptionId',modifier.option_id)
    FROM ordering_order_items line JOIN ordering_order_item_modifiers modifier ON modifier.order_item_id=line.id AND modifier.selection_state IN('selected','extra') JOIN ordering_menu_inventory_links link ON link.business=${BUSINESS} AND link.modifier_option_id=modifier.option_id AND link.active=TRUE JOIN ordering_inventory_items inventory ON inventory.id=link.inventory_item_id AND inventory.active=TRUE
    LEFT JOIN LATERAL(SELECT location_id FROM ordering_inventory_item_locations WHERE inventory_item_id=inventory.id AND active=TRUE ORDER BY is_default DESC,created_at LIMIT 1)location ON TRUE WHERE line.order_id=${orderId} ON CONFLICT DO NOTHING`;
}

export async function createManagerRemake(value: unknown, actor: OrderingActor) {
  if (actor.role !== "manager" && actor.role !== "owner") throw new Error("Manager access required.");
  const input = validateRemakeInput(value);
  await ensureRemakeSchema();
  const sql = getSql();
  const existing = (await sql`SELECT remake_order_id FROM ordering_manager_remakes WHERE client_mutation_id=${input.clientMutationId}`)[0];
  if (existing) return remakeResult(String(existing.remake_order_id), true);
  const original = (await sql`SELECT o.*,a.entered_address,a.formatted_address,a.line1,a.line2,a.city,a.state,a.postal_code,a.country,a.latitude,a.longitude,a.provider,a.provider_reference_id,a.validated_at,a.route_distance_miles,a.route_duration_seconds,a.route_provider,a.route_calculated_at FROM ordering_orders o LEFT JOIN ordering_order_delivery_addresses a ON a.order_id=o.id WHERE o.id=${input.originalOrderId} AND o.business=${BUSINESS}`)[0];
  if (!original || original.status === "draft") throw new Error("Choose an existing submitted Corner Deli order.");

  let address = null;
  let route = null;
  if (input.serviceType === "delivery") {
    if (String(original.formatted_address || "").trim() === input.address && original.latitude != null && original.route_distance_miles != null) {
      address = { enteredAddress: String(original.entered_address), formattedAddress: String(original.formatted_address), line1: String(original.line1), city: String(original.city), state: String(original.state), postalCode: String(original.postal_code), country: String(original.country), latitude: Number(original.latitude), longitude: Number(original.longitude), provider: "google" as const, providerReferenceId: String(original.provider_reference_id || ""), validatedAt: new Date(original.validated_at).toISOString() };
      route = { distanceMiles: Number(original.route_distance_miles), durationSeconds: Number(original.route_duration_seconds || 0), provider: String(original.route_provider || "google"), calculatedAt: new Date(original.route_calculated_at || Date.now()).toISOString() };
    } else {
      address = await validateDeliveryAddress({ enteredAddress: input.address, sessionToken: randomUUID() });
      route = await routeDeliveryAddress(address);
    }
  }

  const created = await withTransaction(async () => {
    const tx = getSql();
    await tx`SELECT pg_advisory_xact_lock(hashtext(${input.clientMutationId}))`;
    const prior = (await tx`SELECT remake_order_id FROM ordering_manager_remakes WHERE client_mutation_id=${input.clientMutationId}`)[0];
    if (prior) return { orderId: String(prior.remake_order_id), alreadyCreated: true };
    const originalItems = await tx`SELECT * FROM ordering_order_items WHERE order_id=${input.originalOrderId}`;
    for (const item of input.items) {
      const line = originalItems.find((row) => String(row.id) === item.orderItemId);
      if (!line || item.quantity > Number(line.quantity) - Number(line.cancelled_quantity || 0)) throw new Error("A selected item is no longer available in that quantity. Refresh the order.");
    }
    const nameParts = input.customerName.split(/\s+/);
    const order = await createDraftOrder({ business: BUSINESS, source: "pos", serviceType: input.serviceType, createdBy: actor.id, createdByName: actor.name, customerId: original.customer_id || undefined, customerFirstName: nameParts[0], customerLastName: nameParts.slice(1).join(" "), callerPhone: input.phone, orderOrigin: "complaint_remake" });
    let sortOrder = 0;
    for (const selected of input.items) {
      const line = originalItems.find((row) => String(row.id) === selected.orderItemId)!;
      const newId = randomUUID();
      await tx`INSERT INTO ordering_order_items (id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,modifier_total_cents,line_total_cents,special_instructions,sort_order,variant_id,variant_name_snapshot,variant_sku_snapshot,category_name_snapshot,item_print_name_snapshot)
        VALUES (${newId},${order.id},${line.item_id},${line.item_name_snapshot},${selected.quantity},0,0,0,${line.special_instructions || ""},${sortOrder++},${line.variant_id || null},${line.variant_name_snapshot || ""},${line.variant_sku_snapshot || ""},${line.category_name_snapshot || ""},${line.item_print_name_snapshot || ""})`;
      await tx`INSERT INTO ordering_order_item_modifiers (id,order_item_id,group_id,option_id,group_name_snapshot,option_name_snapshot,quantity,unit_price_delta_cents,selection_state,pizza_topping_portion,pizza_topping_amount,amount,was_default_selected_snapshot,default_amount_snapshot,print_on_ticket,option_print_name_snapshot,print_order_snapshot,header_modifier_snapshot)
        SELECT gen_random_uuid(),${newId},group_id,option_id,group_name_snapshot,option_name_snapshot,quantity,0,selection_state,pizza_topping_portion,pizza_topping_amount,amount,was_default_selected_snapshot,default_amount_snapshot,print_on_ticket,option_print_name_snapshot,print_order_snapshot,header_modifier_snapshot FROM ordering_order_item_modifiers WHERE order_item_id=${line.id}`;
    }
    if (address && route) await saveOrderDeliveryAddress({ orderId: order.id, address, line2: input.unit, route });
    const notes = ["MANAGER REMAKE", `Original order #${original.display_number}`, input.specialItem ? `SPECIAL MAKE: ${input.specialItem}` : "", input.deliveryNotes].filter(Boolean).join(" · ");
    await tx`UPDATE ordering_orders SET status='sent_to_kitchen',payment_status='paid',timing_mode=${input.scheduledFor ? "future" : "asap"},scheduled_for=${input.scheduledFor ? new Date(input.scheduledFor) : null},submitted_at=NOW(),locked_at=NOW(),special_instructions=${notes},version=version+1,updated_at=NOW() WHERE id=${order.id}`;
    await tx`INSERT INTO ordering_order_links(id,original_order_id,related_order_id,relation_type,notes,created_by) VALUES(${randomUUID()},${input.originalOrderId},${order.id},'complaint_remake',${input.reason},${actor.id})`;
    await tx`INSERT INTO ordering_manager_remakes(id,original_order_id,remake_order_id,client_mutation_id,reason,special_item,created_by) VALUES(${randomUUID()},${input.originalOrderId},${order.id},${input.clientMutationId},${input.reason},${input.specialItem},${actor.id})`;
    const detail = { remakeOrderId: order.id, remakeNumber: order.display_number, reason: input.reason, specialItem: input.specialItem, actorName: actor.name };
    await tx`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) VALUES(${randomUUID()},${input.originalOrderId},${original.version},'complaint_remake_created',${actor.type},${actor.id},${JSON.stringify(detail)}::jsonb)`;
    await tx`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) VALUES(${randomUUID()},${order.id},2,'complaint_remake_submitted',${actor.type},${actor.id},${JSON.stringify({ originalOrderId: input.originalOrderId, originalNumber: original.display_number, reason: input.reason, actorName: actor.name })}::jsonb)`;
    if (input.serviceType === "delivery") await tx`INSERT INTO ordering_delivery_assignments(id,order_id,business,status,assigned_by,notes) VALUES(${randomUUID()},${order.id},${BUSINESS},'ASSIGNED',${actor.id},${`Complaint remake for #${original.display_number}`})`;
    const lines = input.items.length ? await snapshotAndFormatOrder(order.id) : [];
    if (input.specialItem) lines.push(`SPECIAL MAKE: ${input.specialItem.toUpperCase()}`);
    const timingLines = kitchenTicketTimingLines({ timingMode: input.scheduledFor ? "future" : "asap", serviceType: input.serviceType, scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null, quotedLeadMinMinutes: 0, quotedLeadMaxMinutes: 0 });
    const payload = { heading: "*** MANAGER REMAKE ***", orderNumber: order.display_number, customerName: input.customerName, phone: input.phone, serviceType: input.serviceType, deliveryAddress: address?.formattedAddress || "", deliveryUnit: input.unit, orderInstructions: notes, timingLines, paymentLabel: "NO CHARGE · COMPLAINT REMAKE", cashier: actor.name, lines: [`ORIGINAL ORDER #${original.display_number}`, ...lines, `REASON: ${input.reason}`] };
    await tx`INSERT INTO ordering_print_jobs(id,business,order_id,purpose,event_subtype,status,is_reprint,actor_type,actor_id,error_message,payload) VALUES(${randomUUID()},${BUSINESS},${order.id},'kitchen_production','complaint_remake','not_configured',FALSE,${actor.type},${actor.id},'Kitchen printer not configured.',${JSON.stringify(payload)}::jsonb)`;
    await recordRemakeInventory(order.id, actor);
    return { orderId: order.id, alreadyCreated: false };
  });
  if (!created.alreadyCreated) await dispatchSubmittedOrderPrintJobs(created.orderId, BUSINESS);
  return remakeResult(created.orderId, created.alreadyCreated);
}

async function remakeResult(orderId: string, alreadyCreated: boolean) {
  const sql = getSql();
  const order = (await sql`SELECT display_number FROM ordering_orders WHERE id=${orderId} AND business=${BUSINESS}`)[0];
  const job = (await sql`SELECT status,error_message FROM ordering_print_jobs WHERE order_id=${orderId} AND purpose='kitchen_production' ORDER BY created_at DESC LIMIT 1`)[0];
  return { orderId, orderNumber: String(order?.display_number || ""), alreadyCreated, printStatus: String(job?.status || "not_configured"), printMessage: String(job?.error_message || "") };
}
