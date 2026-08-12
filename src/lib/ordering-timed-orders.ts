import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { OrderingBusiness, OrderSource, ServiceType } from "@/lib/ordering-core";
import { createDraftOrderWithVariants, type VariantConfiguredOrderItemInput } from "@/lib/ordering-orders-with-variants";
import type { OrderTimingMode } from "@/lib/ordering-timing-core";
import { quoteTimingForOrder } from "@/lib/ordering-timing";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";

export type CreateTimedDraftOrderInput = {
  business: OrderingBusiness;
  source: OrderSource;
  serviceType: ServiceType;
  customerId?: string | null;
  callerPhone?: string;
  createdBy: string;
  createdByName?: string;
  items?: VariantConfiguredOrderItemInput[];
  timingMode?: OrderTimingMode;
  requestedFor?: Date | null;
};

type TimedOrderRow = {
  id: string;
  business: OrderingBusiness;
  display_number: string;
  status: string;
  payment_status: string;
  service_type: ServiceType;
  timing_mode: OrderTimingMode;
  scheduled_for: string | Date | null;
  promised_at: string | Date | null;
  quoted_lead_min_minutes: number;
  quoted_lead_max_minutes: number;
  timing_message_snapshot: string;
  kitchen_timing_label_snapshot: string;
  version: number;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
  paid_cents: number;
  amount_due_cents: number;
  created_at: string | Date;
  updated_at: string | Date;
};

export async function createTimedDraftOrder(input: CreateTimedDraftOrderInput): Promise<TimedOrderRow> {
  await ensureOrderingTimingSchema();
  const mode = input.timingMode ?? "asap";
  const quote = await quoteTimingForOrder({
    business: input.business,
    serviceType: input.serviceType,
    mode,
    requestedFor: input.requestedFor ?? null,
  });
  if (!quote.accepted) throw new Error(quote.customerMessage || "The requested order time is not available.");

  const base = await createDraftOrderWithVariants({
    business: input.business,
    source: input.source,
    serviceType: input.serviceType,
    customerId: input.customerId,
    callerPhone: input.callerPhone,
    createdBy: input.createdBy,
    createdByName: input.createdByName,
    items: input.items,
  });

  const sql = getSql();
  await sql`
    UPDATE ordering_orders
    SET timing_mode = ${mode},
        scheduled_for = ${quote.requestedFor ? quote.requestedFor.toISOString() : null},
        promised_at = ${quote.promisedFor ? quote.promisedFor.toISOString() : null},
        quoted_lead_min_minutes = ${quote.minMinutes},
        quoted_lead_max_minutes = ${quote.maxMinutes},
        timing_message_snapshot = ${quote.customerMessage},
        kitchen_timing_label_snapshot = ${quote.kitchenLabel},
        version = version + 1,
        updated_at = NOW()
    WHERE id = ${base.id}
  `;

  await sql`
    INSERT INTO ordering_order_events (
      id, order_id, order_version, event_type, actor_type, actor_id, details
    )
    SELECT
      ${randomUUID()}, id, version, 'order_timing_set',
      ${input.source === "pos" ? "employee" : input.source === "web" ? "web" : input.source === "ai_phone" ? "ai" : "system"},
      ${input.createdBy},
      CAST(${JSON.stringify({
        timingMode: mode,
        requestedFor: quote.requestedFor?.toISOString() || null,
        promisedFor: quote.promisedFor?.toISOString() || null,
        minMinutes: quote.minMinutes,
        maxMinutes: quote.maxMinutes,
        isBusy: quote.isBusy,
        kitchenLabel: quote.kitchenLabel,
        actorName: input.createdByName || null,
      })} AS jsonb)
    FROM ordering_orders
    WHERE id = ${base.id}
  `;

  const rows = (await sql`
    SELECT id, business, display_number, status, payment_status, service_type,
           timing_mode, scheduled_for, promised_at, quoted_lead_min_minutes,
           quoted_lead_max_minutes, timing_message_snapshot,
           kitchen_timing_label_snapshot, version, subtotal_cents, discount_cents,
           tax_cents, tip_cents, total_cents, paid_cents, amount_due_cents,
           created_at, updated_at
    FROM ordering_orders
    WHERE id = ${base.id}
    LIMIT 1
  `) as TimedOrderRow[];

  return rows[0];
}
