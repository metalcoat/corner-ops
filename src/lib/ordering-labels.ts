// The label station: every sub and pizza on an open order becomes one label to
// print. Tapping an item prints it and takes it off the list; printed labels
// stay in a "recently printed" tray for reprints.
import { getSql } from "@/lib/db";
import { ensureOrderingHardwareSchema } from "@/lib/ordering-hardware-schema";
import { ensureOrderingAddressSchema } from "@/lib/ordering-address-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { normalizeLabelConfig, sendLabel, type ItemLabel } from "@/lib/ordering-label-print";
import { ConflictError } from "@/lib/http";

/** Without a chosen category list, anything that sounds like a sub or pizza gets a label. */
export const DEFAULT_LABEL_CATEGORY = /\b(subs?|pizzas?|wraps?|calzones?|strombolis?|hoagies?|grinders?|sandwich(es)?|paninis?|melts?)\b/i;

let ready: Promise<void> | null = null;
function ensureSchema() {
  ready ??= (async () => {
    await ensureOrderingHardwareSchema();
    await ensureOrderingAddressSchema();
    await getSql()`CREATE TABLE IF NOT EXISTS ordering_item_labels(
      order_item_id UUID NOT NULL REFERENCES ordering_order_items(id) ON DELETE CASCADE,
      unit_index INTEGER NOT NULL CHECK (unit_index >= 0),
      business TEXT NOT NULL,
      order_id UUID NOT NULL REFERENCES ordering_orders(id) ON DELETE CASCADE,
      printer_id UUID REFERENCES ordering_hardware_devices(id),
      print_count INTEGER NOT NULL DEFAULT 1,
      first_printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      printed_by TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (order_item_id, unit_index))`;
    await getSql()`CREATE INDEX IF NOT EXISTS ordering_item_labels_recent_idx ON ordering_item_labels(business, last_printed_at DESC)`;
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

export type LabelUnit = ItemLabel & {
  orderId: string;
  orderItemId: string;
  unitIndex: number;
  printed: boolean;
  printCount: number;
  lastPrintedAt: string | null;
};

export async function labelPrinters(business: OrderingBusiness) {
  await ensureSchema();
  const rows = await getSql()`SELECT id,name,adapter_config,reported_status FROM ordering_hardware_devices WHERE business=${business} AND role='label_printer' AND active=TRUE ORDER BY name`;
  return rows.map((row) => ({ id: String(row.id), name: String(row.name), status: String(row.reported_status), config: row.adapter_config || {} }));
}

const clock = (value: string | Date) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(value));

/** Every label-worthy unit on open orders (or one order item), with its label text. */
async function loadUnits(business: OrderingBusiness, printer: { config: Record<string, unknown> }, filter: { orderItemId?: string; recentOnly?: boolean } = {}) {
  const categoryIds = normalizeLabelConfig(printer.config).labelCategoryIds;
  const sql = getSql();
  const itemId = filter.orderItemId || null;
  const rows = await sql`
    SELECT o.id order_id,o.display_number,o.service_type,o.timing_mode,o.scheduled_for,o.created_at,o.status order_status,
      COALESCE(NULLIF(trim(o.first_name_snapshot||' '||o.last_name_snapshot),''),'Guest') customer,
      a.formatted_address,a.line2,
      i.id order_item_id,i.item_name_snapshot,i.variant_name_snapshot,i.quantity,COALESCE(i.cancelled_quantity,0) cancelled_quantity,
      i.special_instructions,i.sort_order,i.created_at item_created_at,
      COALESCE(c.id::text,'') category_id,COALESCE(c.name,i.category_name_snapshot,'') category_name,
      COALESCE((SELECT string_agg(CASE WHEN m.quantity>1 THEN m.quantity||'x '||m.option_name_snapshot ELSE m.option_name_snapshot END, '|' ORDER BY m.created_at) FROM ordering_order_item_modifiers m WHERE m.order_item_id=i.id),'') modifiers,
      COALESCE((SELECT string_agg(s.option_name_snapshot, '|' ORDER BY s.created_at) FROM ordering_order_item_combo_selections s WHERE s.order_item_id=i.id),'') combos
    FROM ordering_orders o
    JOIN ordering_order_items i ON i.order_id=o.id
    LEFT JOIN ordering_menu_items mi ON mi.id=i.item_id
    LEFT JOIN ordering_menu_categories c ON c.id=mi.category_id
    LEFT JOIN ordering_order_delivery_addresses a ON a.order_id=o.id
    WHERE o.business=${business}
      AND (${itemId}::uuid IS NOT NULL OR (o.status IN ('confirmed','sent_to_kitchen','in_progress','ready') AND o.created_at>NOW()-INTERVAL '18 hours'
        AND NOT (o.timing_mode='future' AND o.scheduled_for>NOW()+INTERVAL '45 minutes' AND o.status='confirmed')))
      AND (${itemId}::uuid IS NULL OR o.id=(SELECT order_id FROM ordering_order_items WHERE id=${itemId}::uuid))
    ORDER BY o.created_at, i.sort_order, i.created_at, i.id`;
  const printed = new Map<string, { count: number; at: string }>();
  const ids = [...new Set(rows.map((row) => String(row.order_item_id)))];
  if (ids.length)
    for (const row of await sql`SELECT order_item_id,unit_index,print_count,last_printed_at FROM ordering_item_labels WHERE order_item_id=ANY(${ids}::uuid[])`)
      printed.set(`${row.order_item_id}:${row.unit_index}`, { count: Number(row.print_count), at: new Date(row.last_printed_at).toISOString() });

  const wanted = (row: Record<string, unknown>) =>
    categoryIds.length ? categoryIds.includes(String(row.category_id)) : DEFAULT_LABEL_CATEGORY.test(`${row.category_name} ${row.item_name_snapshot}`);
  const byOrder = new Map<string, LabelUnit[]>();
  const unitOrderNumber = new Map<string, string>();
  for (const row of rows.filter(wanted)) {
    unitOrderNumber.set(String(row.order_id), String(row.display_number));
    const quantity = Math.max(0, Number(row.quantity) - Number(row.cancelled_quantity));
    const service = String(row.service_type);
    const destination =
      service === "delivery" || service === "no_contact_delivery"
        ? `DELIVERY: ${[row.formatted_address, row.line2].filter(Boolean).join(", ") || "address on ticket"}`
        : service === "curbside" ? "CURBSIDE PICKUP" : service === "dine_in" ? "DINE IN" : "PICKUP";
    const when = row.timing_mode === "future" && row.scheduled_for ? `DUE ${clock(row.scheduled_for as string)}` : `ASAP · ordered ${clock(row.created_at as string)}`;
    const units = byOrder.get(String(row.order_id)) ?? [];
    for (let unitIndex = 0; unitIndex < quantity; unitIndex++) {
      const mark = printed.get(`${row.order_item_id}:${unitIndex}`);
      units.push({
        orderId: String(row.order_id),
        orderItemId: String(row.order_item_id),
        unitIndex,
        code: "",
        count: "",
        customer: String(row.customer),
        item: `${row.variant_name_snapshot ? `${row.variant_name_snapshot} ` : ""}${row.item_name_snapshot}`,
        options: [...String(row.combos || "").split("|"), ...String(row.modifiers || "").split("|")].filter(Boolean),
        note: String(row.special_instructions || ""),
        destination,
        footer: when,
        printed: Boolean(mark),
        printCount: mark?.count ?? 0,
        lastPrintedAt: mark?.at ?? null,
      });
    }
    byOrder.set(String(row.order_id), units);
  }
  for (const units of byOrder.values()) {
    // Codes and counts are per order: #1042-A, #1042-B ... with "2/3".
    units.forEach((unit, index) => {
      unit.code = `#${String(unitOrderNumber.get(unit.orderId))}-${String.fromCharCode(65 + (index % 26))}${index >= 26 ? Math.floor(index / 26) : ""}`;
      unit.count = units.length > 1 ? `${index + 1}/${units.length}` : "";
    });
    markDifferences(units);
  }
  return byOrder;
}

/**
 * Several of the same item in one order (three turkey subs): each label gets
 * what sets it apart from the others (its own toppings or note), or says it is
 * the same as another one.
 */
function markDifferences(units: LabelUnit[]) {
  const groups = Map.groupBy(units, (unit) => unit.item.trim().toLowerCase());
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const traits = group.map((unit) => [...unit.options, ...(unit.note ? [unit.note] : [])]);
    const shared = traits.reduce((common, list) => common.filter((trait) => list.includes(trait)));
    group.forEach((unit, index) => {
      const own = traits[index].filter((trait) => !shared.includes(trait));
      if (own.length) unit.differences = own;
      else {
        const twin = group.find((other, otherIndex) => otherIndex !== index && traits[otherIndex].length === traits[index].length && traits[otherIndex].every((trait) => traits[index].includes(trait)));
        if (twin) unit.sameAs = twin.code;
      }
    });
  }
}

export async function labelQueue(business: OrderingBusiness, printerId: string) {
  const printers = await labelPrinters(business);
  const printer = printers.find((row) => row.id === printerId) ?? null;
  if (!printer) return { printers: printers.map(({ id, name, status }) => ({ id, name, status })), printer: null, orders: [], recent: [] };
  const byOrder = await loadUnits(business, printer);
  const orders = [...byOrder.values()].filter((units) => units.some((unit) => !unit.printed)).map((units) => ({
    orderId: units[0].orderId,
    code: units[0].code.replace(/-[A-Z]\d*$/, ""),
    customer: units[0].customer,
    destination: units[0].destination,
    footer: units[0].footer,
    units,
  }));
  const recent = [...byOrder.values()].flat().filter((unit) => unit.printed)
    .sort((a, b) => String(b.lastPrintedAt).localeCompare(String(a.lastPrintedAt))).slice(0, 40);
  return { printers: printers.map(({ id, name, status }) => ({ id, name, status })), printer: { id: printer.id, name: printer.name, status: printer.status }, orders, recent };
}

/** Prints one label. A first print of an already-printed label is skipped, so double taps never double print. */
export async function printItemLabel(input: { business: OrderingBusiness; printerId: string; orderItemId: string; unitIndex: number; reprint: boolean; actor: OrderingActor }) {
  const printers = await labelPrinters(input.business);
  const printer = printers.find((row) => row.id === input.printerId);
  if (!printer) throw new ConflictError("That label printer is not set up. Choose another printer.");
  const units = [...(await loadUnits(input.business, printer, { orderItemId: input.orderItemId })).values()].flat();
  const unit = units.find((row) => row.orderItemId === input.orderItemId && row.unitIndex === input.unitIndex);
  if (!unit) throw new ConflictError("That item is no longer on an open order.");
  if (unit.printed && !input.reprint) return { printed: false, alreadyPrinted: true };
  const sql = getSql();
  try {
    await sendLabel(printer.config, unit);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Label print failed.";
    await sql`UPDATE ordering_hardware_devices SET reported_status='offline',last_seen_at=NOW(),status_message=${reason},updated_at=NOW() WHERE id=${printer.id}`;
    throw new ConflictError(`${printer.name} did not print: ${reason.replace(/^connect /, "could not connect ")}. Check that it is on, has labels, and is on the network.`);
  }
  await sql`UPDATE ordering_hardware_devices SET reported_status='online',last_seen_at=NOW(),status_message='Last label printed.',updated_at=NOW() WHERE id=${printer.id}`;
  await sql`INSERT INTO ordering_item_labels(order_item_id,unit_index,business,order_id,printer_id,printed_by)
    VALUES(${unit.orderItemId},${unit.unitIndex},${input.business},${unit.orderId},${printer.id},${input.actor.name})
    ON CONFLICT(order_item_id,unit_index) DO UPDATE SET print_count=ordering_item_labels.print_count+1,last_printed_at=NOW(),printer_id=EXCLUDED.printer_id,printed_by=EXCLUDED.printed_by`;
  return { printed: true, alreadyPrinted: false };
}
