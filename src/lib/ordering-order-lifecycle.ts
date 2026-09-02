import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { depleteInventoryForOrder } from "@/lib/ordering-inventory";
import { ensureOrderingInventorySchema } from "@/lib/ordering-inventory-schema";
import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { ensureOrderingAddressSchema } from "@/lib/ordering-address-schema";
import { ensureOrderingAccountSchema } from "@/lib/ordering-account-schema";
import { snapshotAndFormatOrder } from "@/lib/ordering-print-format";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";
import { pizzaToppingPriceCents } from "@/lib/ordering-pizza-toppings";
import { resolveOrderingAvailability } from "@/lib/ordering-availability";
import { canManagePos } from "@/lib/ordering-route-auth";
import {
  quoteDelivery,
  recordDeliveryMinimumResolution,
} from "@/lib/ordering-delivery";
import { assertMenuTargetsAvailable } from "@/lib/ordering-menu-availability";
import { applyPromotionsToOrder } from "@/lib/ordering-promotions";
import {
  earnLoyaltyForOrder,
  finalizeLoyaltyRedemptions,
} from "@/lib/ordering-loyalty";
import { kitchenTicketTimingLines } from "@/lib/ordering-kitchen-ticket";
import { compareKitchenItems } from "@/lib/ordering-line-format";
import { ensureRestaurantPlatformSchema } from "@/lib/restaurant-platform";
import { notifyPosStationsOfOnlineOrder } from "@/lib/push-notifications";

export type StoredOrderStatus =
  | "draft"
  | "confirmed"
  | "sent_to_kitchen"
  | "in_progress"
  | "ready"
  | "completed"
  | "cancelled";
export type KitchenOrderStatus =
  "sent_to_kitchen" | "in_progress" | "ready" | "completed" | "cancelled";

type OrderRow = Record<string, unknown> & {
  id: string;
  business: OrderingBusiness;
  status: StoredOrderStatus;
  version: number;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  paid_cents: number;
  first_name_snapshot: string;
  last_name_snapshot: string;
  phone_snapshot: string;
  timing_mode: "asap" | "future";
  scheduled_for: string | Date | null;
  promised_at: string | Date | null;
  quoted_lead_min_minutes: number;
  quoted_lead_max_minutes: number;
  kitchen_timing_label_snapshot: string;
  created_at: string | Date;
  service_type: string;
  delivery_fee_cents: number;
};

type ItemRow = {
  id: string;
  item_id: string;
  item_name_snapshot: string;
  variant_id: string | null;
  variant_name_snapshot: string;
  quantity: number;
  unit_price_cents: number;
  modifier_total_cents: number;
  combo_total_cents: number;
  line_total_cents: number;
};

type ModifierSnapshot = {
  group_id: string;
  option_id: string;
  quantity: number;
  unit_price_delta_cents: number;
  selection_state: string;
  pizza_topping_portion:
    import("@/lib/ordering-pizza-toppings").PizzaToppingPortion | null;
  pizza_topping_amount:
    import("@/lib/ordering-pizza-toppings").PizzaToppingAmount | null;
};

const transitions: Record<KitchenOrderStatus, readonly KitchenOrderStatus[]> = {
  sent_to_kitchen: ["in_progress", "cancelled"],
  in_progress: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export class OrderConflictError extends Error {}

export async function reopenOrderForAdditions(
  orderId: string,
  business: OrderingBusiness,
  actor: OrderingActor,
) {
  await ensureOrderingPosSchema();
  return withTransaction(async () => {
    const sql = getSql();
    const rows =
      await sql`SELECT id,display_number,status,total_cents,paid_cents,amount_due_cents,service_type,timing_mode,scheduled_for,timing_message_snapshot,kitchen_timing_label_snapshot,delivery_fee_cents,version FROM ordering_orders WHERE id=${orderId} AND business=${business} FOR UPDATE`;
    const order = rows[0];
    if (!order) throw new OrderConflictError("Order was not found.");
    if (order.status === "draft")
      throw new OrderConflictError("This order is already open for editing.");
    if (
      !["sent_to_kitchen", "in_progress", "ready", "completed"].includes(
        String(order.status),
      )
    )
      throw new OrderConflictError("This order cannot be reopened.");
    const existingItems =
      await sql`SELECT id FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`;
    const updated = (
      await sql`UPDATE ordering_orders SET status='draft',locked_at=NULL,version=version+1,updated_at=NOW() WHERE id=${orderId} RETURNING *`
    )[0];
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details)VALUES(${randomUUID()},${orderId},${updated.version},'order_reopened_for_additions',${actor.type},${actor.id},${JSON.stringify({ previousStatus: order.status, previousTotalCents: Number(order.total_cents), previousPaidCents: Number(order.paid_cents), existingItemIds: existingItems.map((row) => String(row.id)), actorName: actor.name })}::jsonb)`;
    return {
      order: updated,
      orderItemIds: existingItems.map((row) => String(row.id)),
    };
  });
}

function number(value: unknown): number {
  return Number(value || 0);
}

async function revalidateDraft(order: OrderRow): Promise<void> {
  const sql = getSql();
  const items = (await sql`
    SELECT id, item_id, item_name_snapshot, variant_id, variant_name_snapshot, quantity,
           unit_price_cents, modifier_total_cents, combo_total_cents, line_total_cents
    FROM ordering_order_items
    WHERE order_id = ${order.id}
    ORDER BY sort_order, created_at, id
  `) as ItemRow[];
  if (!items.length)
    throw new OrderConflictError(
      "This draft has no items. Review the order before submitting.",
    );

  let subtotal = 0;
  const availabilityTargets: Array<{
    type: "item" | "variant" | "modifier_option";
    id: string;
    label: string;
  }> = [];
  for (const item of items) {
    availabilityTargets.push({
      type: "item",
      id: item.item_id,
      label: item.item_name_snapshot,
    });
    if (item.variant_id)
      availabilityTargets.push({
        type: "variant",
        id: item.variant_id,
        label: item.variant_name_snapshot || item.item_name_snapshot,
      });
    const currentItems = await sql`
      SELECT item.name, item.base_price_cents, item.available,
             variant.id AS variant_id, variant.name AS variant_name,
             variant.base_price_cents AS variant_price_cents, variant.available AS variant_available
      FROM ordering_menu_items item
      LEFT JOIN ordering_menu_item_variants variant
        ON variant.id = ${item.variant_id} AND variant.item_id = item.id AND variant.active = TRUE
      WHERE item.id = ${item.item_id} AND item.business = ${order.business} AND item.active = TRUE
      LIMIT 1
    `;
    const current = currentItems[0];
    if (!current || !current.available)
      throw new OrderConflictError(
        `${item.item_name_snapshot} is no longer available. Review the order before submitting.`,
      );
    if (
      item.variant_id &&
      (!current.variant_id || !current.variant_available)
    ) {
      throw new OrderConflictError(
        `${item.variant_name_snapshot || "The selected size/form"} is no longer available. Review the order before submitting.`,
      );
    }
    const currentBase = item.variant_id
      ? number(current.variant_price_cents)
      : number(current.base_price_cents);
    if (currentBase !== number(item.unit_price_cents)) {
      throw new OrderConflictError(
        `The price of ${item.item_name_snapshot} changed. Review and rebuild the order before submitting.`,
      );
    }

    const snapshots = (await sql`
      SELECT group_id, option_id, quantity, unit_price_delta_cents, selection_state, pizza_topping_portion, pizza_topping_amount
      FROM ordering_order_item_modifiers
      WHERE order_item_id = ${item.id}
    `) as ModifierSnapshot[];
    const selectedCounts = new Map<string, number>();
    const selectedOptions = new Map<string, Set<string>>();
    let modifierTotal = 0;
    for (const snapshot of snapshots) {
      if (
        snapshot.selection_state !== "selected" &&
        snapshot.selection_state !== "extra"
      )
        continue;
      availabilityTargets.push({
        type: "modifier_option",
        id: snapshot.option_id,
        label: `A modifier on ${item.item_name_snapshot}`,
      });
      const options = await sql`
        SELECT grp.name AS group_name, grp.allow_option_quantity, opt.name AS option_name,
               opt.available AS option_available,
               COALESCE(variant_override.available, TRUE) AS variant_available,
               COALESCE(variant_override.price_delta_cents, def.price_delta_override_cents, opt.price_delta_cents) AS current_price_cents,
               COALESCE(p.included_choice_count,0) included_choice_count
        FROM ordering_menu_item_modifier_groups link
        JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.active = TRUE
        JOIN ordering_modifier_options opt ON opt.id = ${snapshot.option_id} AND opt.group_id = grp.id AND opt.active = TRUE
        LEFT JOIN ordering_menu_item_modifier_defaults def
          ON def.item_id = link.item_id AND def.option_id = opt.id AND def.active = TRUE
        LEFT JOIN ordering_menu_variant_modifier_prices variant_override
          ON variant_override.variant_id = ${item.variant_id} AND variant_override.option_id = opt.id AND variant_override.active = TRUE
        LEFT JOIN ordering_modifier_presentation_overrides p ON p.item_id=link.item_id AND p.group_id=grp.id
        WHERE link.item_id = ${item.item_id} AND grp.id = ${snapshot.group_id}
        LIMIT 1
      `;
      const option = options[0];
      if (!option || !option.option_available || !option.variant_available) {
        throw new OrderConflictError(
          `A modifier on ${item.item_name_snapshot} is no longer available. Review the order before submitting.`,
        );
      }
      const quantity = option.allow_option_quantity
        ? number(snapshot.quantity)
        : 1;
      if (quantity < 1 || quantity > 99)
        throw new OrderConflictError(
          `A modifier quantity on ${item.item_name_snapshot} is invalid.`,
        );
      const currentCharge =
        snapshot.pizza_topping_portion && snapshot.pizza_topping_amount
          ? pizzaToppingPriceCents(
              number(option.current_price_cents),
              snapshot.pizza_topping_portion,
              snapshot.pizza_topping_amount,
            )
          : number(option.current_price_cents);
      const allowedIncluded =
        number(option.included_choice_count) > 0 &&
        (selectedCounts.get(snapshot.group_id) || 0) <
          number(option.included_choice_count) &&
        number(snapshot.unit_price_delta_cents) === 0;
      if (
        currentCharge !== number(snapshot.unit_price_delta_cents) &&
        !allowedIncluded
      ) {
        throw new OrderConflictError(
          `A modifier price on ${item.item_name_snapshot} changed. Review and rebuild the order before submitting.`,
        );
      }
      selectedCounts.set(
        snapshot.group_id,
        (selectedCounts.get(snapshot.group_id) || 0) + 1,
      );
      if (!selectedOptions.has(snapshot.group_id))
        selectedOptions.set(snapshot.group_id, new Set());
      selectedOptions.get(snapshot.group_id)!.add(snapshot.option_id);
      modifierTotal += number(snapshot.unit_price_delta_cents) * quantity;
    }

    const groups = await sql`
      SELECT grp.id, grp.name, grp.min_selections, grp.max_selections,
             COALESCE(p.context,'ordinary') context,COALESCE(p.behavior,'standard') behavior,p.parent_group_id,p.parent_option_ids
      FROM ordering_menu_item_modifier_groups link
      JOIN ordering_modifier_groups grp ON grp.id = link.group_id AND grp.active = TRUE
      LEFT JOIN ordering_modifier_presentation_overrides p ON p.item_id=link.item_id AND p.group_id=link.group_id
      WHERE link.item_id = ${item.item_id}
    `;
    for (const group of groups) {
      const count = selectedCounts.get(String(group.id)) || 0;
      if (String(group.behavior) === "pizza_topping") continue;
      const context = String(group.context);
      const parentSelected =
        selectedOptions.get(String(group.parent_group_id || "")) ||
        new Set<string>();
      const active =
        context === "ordinary" ||
        (context === "combo_trigger" && count > 0) ||
        (context === "dependent" &&
          (group.parent_option_ids || []).some((id: string) =>
            parentSelected.has(id),
          ));
      if (!active) {
        if (count)
          throw new OrderConflictError(
            `A modifier is no longer valid for the selected combo component on ${item.item_name_snapshot}.`,
          );
        continue;
      }
      if (
        count < number(group.min_selections) ||
        count > number(group.max_selections)
      ) {
        throw new OrderConflictError(
          `Required modifier choices changed for ${item.item_name_snapshot}: ${group.name}. Review the order before submitting.`,
        );
      }
    }
    if (modifierTotal !== number(item.modifier_total_cents)) {
      throw new OrderConflictError(
        `Modifier pricing changed for ${item.item_name_snapshot}. Review and rebuild the order before submitting.`,
      );
    }

    const lineTotal =
      number(item.quantity) *
      (currentBase + modifierTotal + number(item.combo_total_cents));
    if (lineTotal !== number(item.line_total_cents)) {
      throw new OrderConflictError(
        `The total for ${item.item_name_snapshot} changed. Review and rebuild the order before submitting.`,
      );
    }
    subtotal += lineTotal;
  }

  await assertMenuTargetsAvailable({
    business: order.business,
    at:
      order.timing_mode === "future" && order.scheduled_for
        ? new Date(order.scheduled_for)
        : new Date(),
    targets: availabilityTargets,
  });

  const total = Math.max(
    0,
    subtotal -
      number(order.discount_cents) +
      number(order.tax_cents) +
      number(order.tip_cents) +
      number(order.delivery_fee_cents),
  );
  if (
    subtotal !== number(order.subtotal_cents) ||
    total !== number(order.total_cents)
  ) {
    throw new OrderConflictError(
      "The order total changed. Review and rebuild the order before submitting.",
    );
  }
}

export async function submitDraftOrder(
  orderId: string,
  business: OrderingBusiness,
  actor: OrderingActor,
  override?: { approved: boolean; reason: string },
) {
  await ensureOrderingPosSchema();
  await ensureOrderingAddressSchema();
  await ensureOrderingMenuOverrideSchema();
  await ensureOrderingAccountSchema();
  await ensureRestaurantPlatformSchema();
  await ensureOrderingInventorySchema();
  const result = await withTransaction(async () => {
    // Draft pricing follows current promotion configuration until Send locks it.
    await applyPromotionsToOrder(orderId);
    const sql = getSql();
    const rows = (await sql`
      SELECT id, business, source, display_number, status, payment_status, service_type, version,
             subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, paid_cents, amount_due_cents,
             first_name_snapshot, last_name_snapshot, phone_snapshot,
             timing_mode, scheduled_for, promised_at, quoted_lead_min_minutes, quoted_lead_max_minutes,
             kitchen_timing_label_snapshot, delivery_fee_cents, special_instructions, created_at, updated_at, submitted_at, started_at, ready_at, completed_at, cancelled_at
      FROM ordering_orders WHERE id = ${orderId} AND business = ${business} FOR UPDATE
    `) as OrderRow[];
    const order = rows[0];
    if (!order) throw new OrderConflictError("Draft order was not found.");
    if (order.status === "sent_to_kitchen")
      return { order, alreadySubmitted: true };
    if (order.status !== "draft")
      throw new OrderConflictError("Only a draft order can be submitted.");
    const availabilityAt =
      order.timing_mode === "future" && order.scheduled_for
        ? new Date(order.scheduled_for)
        : new Date();
    const availability = await resolveOrderingAvailability({
      business,
      serviceType: order.service_type,
      at: availabilityAt,
      orderEntryStartedAt:
        order.timing_mode === "asap" ? new Date(order.created_at) : null,
    });
    if (availability.sourceRule !== "unconfigured" && !availability.orderable) {
      const reason = String(override?.reason || "").trim();
      if (!override?.approved || !canManagePos(actor) || !reason) {
        throw new OrderConflictError(
          `${availability.reason} Manager or owner override with a reason is required.`,
        );
      }
      await sql`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details) VALUES(${randomUUID()},${business},${actor.id},${actor.role || "manager"},'ordering_hours_overridden','order',${orderId},${reason},${JSON.stringify({ sourceRule: availability.sourceRule, at: availabilityAt.toISOString() })}::jsonb)`;
    }
    const customerName =
      `${order.first_name_snapshot || ""} ${order.last_name_snapshot || ""}`.trim();
    if (business === "Corner Deli" && !customerName)
      throw new OrderConflictError("Customer name is required.");
    if (
      business === "Corner Deli" &&
      (order.service_type === "pickup" ||
        order.service_type === "delivery" ||
        order.service_type === "no_contact_delivery") &&
      !String(order.phone_snapshot || "").trim()
    ) {
      throw new OrderConflictError(
        order.service_type === "pickup"
          ? "Phone number is required for pickup orders."
          : "Phone number is required for delivery orders.",
      );
    }
    let deliveryAddress = "";
    let deliveryUnit = "";
    if (
      order.service_type === "delivery" ||
      order.service_type === "no_contact_delivery"
    ) {
      const addresses =
        await sql`SELECT validation_status,route_distance_miles,formatted_address,line1,city,state,postal_code,line2 FROM ordering_order_delivery_addresses WHERE order_id = ${orderId} LIMIT 1`;
      if (addresses[0]?.validation_status !== "validated")
        throw new OrderConflictError("Delivery address is required.");
      if (addresses[0]?.route_distance_miles == null)
        throw new OrderConflictError(
          "Driving distance is required before this delivery order can be sent.",
        );
      deliveryAddress = String(
        addresses[0].formatted_address ||
          [
            addresses[0].line1,
            addresses[0].city,
            addresses[0].state,
            addresses[0].postal_code,
          ]
            .filter(Boolean)
            .join(", "),
      );
      deliveryUnit = String(addresses[0].line2 || "");
      const delivery = await quoteDelivery({
        business,
        distanceMiles: Number(addresses[0].route_distance_miles),
        merchandiseSubtotalCents: number(order.subtotal_cents),
        managerBypassApproved: Boolean(
          override?.approved && canManagePos(actor),
        ),
      });
      if (
        delivery.minimum.shortfallCents > 0 &&
        delivery.minimum.resolution !== "manager_bypass_approved"
      ) {
        throw new OrderConflictError(
          `Delivery minimum is $${(delivery.minimum.minimumOrderCents / 100).toFixed(2)}. Order is $${(delivery.minimum.shortfallCents / 100).toFixed(2)} short.${delivery.settings.allowManagerBypass ? " Manager or owner override with a reason is required." : ""}`,
        );
      }
      if (delivery.minimum.resolution === "manager_bypass_approved") {
        const reason = String(override?.reason || "").trim();
        if (!reason)
          throw new OrderConflictError(
            "A manager reason is required to override the delivery minimum.",
          );
        await recordDeliveryMinimumResolution({
          orderId,
          business,
          minimumOrderCents: delivery.minimum.minimumOrderCents,
          merchandiseSubtotalCents: delivery.minimum.merchandiseSubtotalCents,
          shortfallCents: delivery.minimum.shortfallCents,
          resolutionType: "bypass",
          adjustmentFeeCents: 0,
          upsellOffered: true,
          customerDeclinedUpsell: true,
          actorType: "employee",
          actorId: actor.id,
          approvedBy: actor.id,
          reason,
        });
      }
      await sql`UPDATE ordering_orders SET delivery_fee_cents=${delivery.deliveryFeeCents},total_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${delivery.deliveryFeeCents}),amount_due_cents=GREATEST(0,subtotal_cents-discount_cents+tax_cents+tip_cents+${delivery.deliveryFeeCents}-paid_cents),updated_at=NOW() WHERE id=${orderId}`;
      order.delivery_fee_cents = delivery.deliveryFeeCents;
      order.total_cents = Math.max(
        0,
        number(order.subtotal_cents) -
          number(order.discount_cents) +
          number(order.tax_cents) +
          number(order.tip_cents) +
          delivery.deliveryFeeCents,
      );
    }
    await revalidateDraft(order);
    const reopenRows =
      await sql`SELECT details FROM ordering_order_events WHERE order_id=${orderId} AND event_type='order_reopened_for_additions' AND NOT EXISTS(SELECT 1 FROM ordering_order_events later WHERE later.order_id=${orderId} AND later.event_type='order_addition_submitted' AND later.created_at>ordering_order_events.created_at) ORDER BY created_at DESC LIMIT 1`;
    const reopenDetails = reopenRows[0]?.details as
      { existingItemIds?: string[]; previousTotalCents?: number } | undefined;
    const existingIds = new Set(
      (reopenDetails?.existingItemIds || []).map(String),
    );
    const currentIds =
      await sql`SELECT id FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`;
    const addedItemIds = reopenDetails
      ? currentIds
          .map((row) => String(row.id))
          .filter((id) => !existingIds.has(id))
      : [];
    if (reopenDetails && !addedItemIds.length)
      throw new OrderConflictError(
        "Add at least one item before sending this order again.",
      );
    const ticketLines = await snapshotAndFormatOrder(
      orderId,
      reopenDetails ? addedItemIds : undefined,
    );

    const updated = await sql`
      UPDATE ordering_orders
      SET status = 'sent_to_kitchen', submitted_at = NOW(), locked_at = NOW(),
          version = version + 1, updated_at = NOW()
      WHERE id = ${orderId} AND business = ${business} AND status = 'draft' AND version = ${order.version}
      RETURNING id, business, source, display_number, status, payment_status, service_type, version,
                subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, paid_cents, amount_due_cents,
                first_name_snapshot, last_name_snapshot,
                delivery_fee_cents, special_instructions, created_at, updated_at, submitted_at, started_at, ready_at, completed_at, cancelled_at
    `;
    if (!updated.length)
      throw new OrderConflictError(
        "This order changed while it was being submitted. Refresh and review it.",
      );
    await sql`UPDATE restaurant_table_sessions SET status='sent',updated_at=NOW() WHERE order_id=${orderId} AND status IN('open','ordering')`;
    await finalizeLoyaltyRedemptions(orderId);
    await earnLoyaltyForOrder(orderId, actor);
    await sql`
      INSERT INTO ordering_order_events (id, order_id, order_version, event_type, actor_type, actor_id, details)
      VALUES (${randomUUID()}, ${orderId}, ${updated[0].version}, 'status_changed', ${actor.type}, ${actor.id},
              CAST(${JSON.stringify({ from: "draft", to: "sent_to_kitchen", actorName: actor.name })} AS jsonb))
    `;
    await sql`
      INSERT INTO ordering_print_jobs (
        id, business, order_id, purpose, event_subtype, status, is_reprint, actor_type, actor_id, error_message, payload
      ) VALUES (
        ${randomUUID()}, ${business}, ${orderId}, 'kitchen_production', ${reopenDetails ? "order_addition" : "initial_send"}, 'not_configured', ${Boolean(reopenDetails)},
        ${actor.type}, ${actor.id}, 'Kitchen printer not configured.',
        CAST(${JSON.stringify({
          heading: reopenDetails ? "ORDER ADDITION" : "KITCHEN ORDER",
          orderNumber: String(order.display_number),
          customerName,
          phone: String(order.phone_snapshot || ""),
          serviceType: String(order.service_type),
          deliveryAddress,
          deliveryUnit,
          orderInstructions: String(order.special_instructions || ""),
          timingLines: kitchenTicketTimingLines({
            timingMode: order.timing_mode,
            serviceType:
              order.service_type as import("@/lib/ordering-core").ServiceType,
            scheduledFor: order.scheduled_for
              ? new Date(order.scheduled_for)
              : null,
            promisedFor: order.promised_at ? new Date(order.promised_at) : null,
            quotedLeadMinMinutes: number(order.quoted_lead_min_minutes),
            quotedLeadMaxMinutes: number(order.quoted_lead_max_minutes),
            snapshotLabel: order.kitchen_timing_label_snapshot,
          }),
          paymentLabel: reopenDetails
            ? `NEW ORDER TOTAL: $${(number(updated[0].total_cents) / 100).toFixed(2)} · ${number(updated[0].amount_due_cents) <= 0 ? "PAID" : `AMOUNT DUE: $${(number(updated[0].amount_due_cents) / 100).toFixed(2)}`}`
            : number(updated[0].amount_due_cents) <= 0
              ? "PAID"
              : `AMOUNT DUE: $${(number(updated[0].amount_due_cents) / 100).toFixed(2)}`,
          cashier: actor.name,
          lines: ticketLines,
        })} AS jsonb)
      )
      ON CONFLICT DO NOTHING
    `;
    if (reopenDetails)
      await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details)VALUES(${randomUUID()},${orderId},${updated[0].version},'order_addition_submitted',${actor.type},${actor.id},${JSON.stringify({ addedItemIds, previousTotalCents: Number(reopenDetails.previousTotalCents || 0), newTotalCents: Number(updated[0].total_cents), additionalAmountDueCents: Number(updated[0].amount_due_cents), actorName: actor.name })}::jsonb)`;
    await depleteInventoryForOrder(orderId, business, actor);
    return { order: updated[0], alreadySubmitted: false };
  });
  const source = String(result.order.source || "").toLowerCase();
  if (
    !result.alreadySubmitted &&
    ["web", "online", "customer_web", "kiosk", "ai_phone"].includes(source)
  ) {
    await notifyPosStationsOfOnlineOrder({
      business,
      orderId: String(result.order.id),
      displayNumber: String(result.order.display_number),
      source,
      serviceType: String(result.order.service_type || "online"),
      customerName:
        `${String(result.order.first_name_snapshot || "")} ${String(result.order.last_name_snapshot || "")}`.trim(),
    }).catch(() => undefined);
  }
  return result;
}

export async function transitionKitchenOrder(input: {
  orderId: string;
  business: OrderingBusiness;
  expectedStatus: KitchenOrderStatus;
  nextStatus: KitchenOrderStatus;
  actor: OrderingActor;
}) {
  await ensureOrderingPosSchema();
  if (!transitions[input.expectedStatus]?.includes(input.nextStatus)) {
    throw new OrderConflictError(
      `Invalid order transition: ${input.expectedStatus} to ${input.nextStatus}.`,
    );
  }
  return withTransaction(async () => {
    const sql = getSql();
    const timestampColumn =
      input.nextStatus === "in_progress"
        ? "started_at"
        : input.nextStatus === "ready"
          ? "ready_at"
          : input.nextStatus === "completed"
            ? "completed_at"
            : "cancelled_at";
    const rows =
      timestampColumn === "started_at"
        ? await sql`
      UPDATE ordering_orders SET status = ${input.nextStatus}, started_at = NOW(), version = version + 1, updated_at = NOW()
      WHERE id = ${input.orderId} AND business = ${input.business} AND status = ${input.expectedStatus}
      RETURNING id, display_number, status, version
    `
        : timestampColumn === "ready_at"
          ? await sql`
      UPDATE ordering_orders SET status = ${input.nextStatus}, ready_at = NOW(), version = version + 1, updated_at = NOW()
      WHERE id = ${input.orderId} AND business = ${input.business} AND status = ${input.expectedStatus}
      RETURNING id, display_number, status, version
    `
          : timestampColumn === "completed_at"
            ? await sql`
      UPDATE ordering_orders SET status = ${input.nextStatus}, completed_at = NOW(), closed_at = NOW(), version = version + 1, updated_at = NOW()
      WHERE id = ${input.orderId} AND business = ${input.business} AND status = ${input.expectedStatus}
      RETURNING id, display_number, status, version
    `
            : await sql`
      UPDATE ordering_orders SET status = ${input.nextStatus}, cancelled_at = NOW(), closed_at = NOW(), version = version + 1, updated_at = NOW()
      WHERE id = ${input.orderId} AND business = ${input.business} AND status = ${input.expectedStatus}
      RETURNING id, display_number, status, version
    `;
    if (!rows.length)
      throw new OrderConflictError(
        "This order changed on another screen. Refresh the kitchen queue.",
      );
    await sql`
      INSERT INTO ordering_order_events (id, order_id, order_version, event_type, actor_type, actor_id, details)
      VALUES (${randomUUID()}, ${input.orderId}, ${rows[0].version}, 'status_changed', ${input.actor.type}, ${input.actor.id},
              CAST(${JSON.stringify({ from: input.expectedStatus, to: input.nextStatus, actorName: input.actor.name })} AS jsonb))
    `;
    if (
      input.nextStatus === "sent_to_kitchen" ||
      input.nextStatus === "completed"
    )
      await earnLoyaltyForOrder(input.orderId, input.actor);
    return rows[0];
  });
}

export async function listKitchenOrders(
  business: OrderingBusiness,
  includeRecent = false,
) {
  await ensureOrderingPosSchema();
  await ensureOrderingAccountSchema();
  await ensureOrderingCustomerSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT id, business, source, display_number, status, payment_status, service_type, version,
           subtotal_cents, total_cents, special_instructions, created_at, submitted_at, started_at,
           ready_at, completed_at, cancelled_at, voided_at, voided_by, void_reason, pre_void_status, pre_void_payment_status, NOW() AS server_now
    FROM ordering_orders
    WHERE business = ${business}
      AND (${includeRecent} OR (
        status IN ('sent_to_kitchen', 'in_progress', 'ready')
        AND (payment_status <> 'paid' OR source IN ('web','online','customer_web','kiosk','ai_phone') OR order_origin='employee_meal')
        AND NOT EXISTS (
          SELECT 1 FROM ordering_delivery_assignments delivery
          WHERE delivery.order_id=ordering_orders.id AND delivery.status='DELIVERED'
        )
      ))
      AND (status IN ('sent_to_kitchen', 'in_progress', 'ready') OR COALESCE(completed_at, cancelled_at, updated_at) > NOW() - INTERVAL '8 hours')
    ORDER BY CASE status WHEN 'ready' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'sent_to_kitchen' THEN 3 ELSE 4 END,
             submitted_at, created_at
  `;
  const result = [];
  for (const order of rows) {
    const items = await sql`
      SELECT line.id, line.item_id, line.item_name_snapshot, line.item_print_name_snapshot, line.variant_id, line.variant_name_snapshot, line.variant_sku_snapshot,
             quantity-cancelled_quantity quantity, cancelled_quantity, unit_price_cents, modifier_total_cents, combo_name_snapshot, combo_total_cents,
             line_total_cents, special_instructions, line.sort_order,COALESCE(category.display_name,category.name,'') category_name
      FROM ordering_order_items line
      LEFT JOIN ordering_menu_items menu ON menu.id=line.item_id
      LEFT JOIN ordering_menu_categories category ON category.id=menu.category_id
      WHERE line.order_id = ${order.id} AND line.quantity>line.cancelled_quantity
      ORDER BY line.sort_order, line.created_at, line.id
    `;
    items.sort((left, right) =>
      compareKitchenItems(
        left as {
          item_name_snapshot: string;
          category_name?: string;
          sort_order?: number;
        },
        right as {
          item_name_snapshot: string;
          category_name?: string;
          sort_order?: number;
        },
      ),
    );
    for (const item of items) {
      item.modifiers = await sql`
        SELECT group_id, option_id, group_name_snapshot, option_name_snapshot, quantity,
               unit_price_delta_cents, selection_state, pizza_topping_portion, pizza_topping_amount,
               amount,was_default_selected_snapshot,default_amount_snapshot,print_on_ticket,print_order_snapshot,header_modifier_snapshot
        FROM ordering_order_item_modifiers WHERE order_item_id = ${item.id}
        ORDER BY created_at, id
      `;
      item.combo_selections = await sql`
        SELECT combo_id, group_id, option_id, combo_name_snapshot, group_name_snapshot,
               option_name_snapshot, price_delta_cents
        FROM ordering_order_item_combo_selections WHERE order_item_id = ${item.id}
        ORDER BY created_at, id
      `;
    }
    result.push({ ...order, items });
  }
  return result;
}

export const allowedKitchenTransitions = transitions;
