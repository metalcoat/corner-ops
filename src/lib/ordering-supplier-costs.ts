// Supplier cost analysis and the employee stock sheet.
//
// Managers keep each supplier's terms (minimum, fee, truck days, order-by time)
// and case prices; usage comes from the inventory ledger (sales, waste, and the
// corrections that employee counts post), and employees add counts ("what we
// have") and requests ("what we need") from a tablet or phone.
import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { ensureOrderingInventorySchema } from "@/lib/ordering-inventory-schema";
import { parseGuide } from "@/lib/supplier-order-guide";
import { analyzeSuppliers, convertUnits, nextDelivery, unitCostCents, type Offer, type PlanItem, type SupplierTerms } from "@/lib/supplier-plan";

const BUSINESS = "Corner Deli";
/** The suppliers the deli compares, added once so they're ready to fill in. */
const STARTER_SUPPLIERS: Array<{ name: string; shipsInDays: number | null }> = [
  { name: "Sysco", shipsInDays: null },
  { name: "US Foods", shipsInDays: null },
  { name: "Performance Foodservice", shipsInDays: null },
  { name: "WebstaurantStore", shipsInDays: 4 },
];
/** Ledger reasons that are stock leaving the building (usage). Receiving and transfers are not. */
const NOT_USAGE = ["received", "transfer_in", "transfer_out"];

export class SupplierCostError extends Error {}

let ready: Promise<void> | null = null;
export function ensureSupplierCostSchema() {
  ready ??= (async () => {
    await ensureOrderingInventorySchema();
    const sql = getSql();
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS free_delivery_over_cents INTEGER`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS delivery_days SMALLINT[] NOT NULL DEFAULT '{}'`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS cutoff_time TEXT NOT NULL DEFAULT '16:00'`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS cutoff_days_before SMALLINT NOT NULL DEFAULT 1`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS ships_in_days SMALLINT`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS account_number TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS minimum_cases INTEGER NOT NULL DEFAULT 0`;
    // Result of the daily price job that signs in to the supplier's website.
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_at TIMESTAMPTZ`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_status TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_message TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_products INTEGER`;
    // A one-time sign-in code typed in by a manager, and "Sync now" requests, both picked up by the price job.
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_code TEXT`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_code_at TIMESTAMPTZ`;
    await sql`ALTER TABLE ordering_inventory_suppliers ADD COLUMN IF NOT EXISTS price_sync_requested_at TIMESTAMPTZ`;
    await sql`ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS weekly_usage_override NUMERIC(14,3)`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_inventory_requests(
      id UUID PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      inventory_item_id UUID REFERENCES ordering_inventory_items(id) ON DELETE SET NULL,
      item_text TEXT NOT NULL DEFAULT '',
      quantity NUMERIC(14,3),
      unit TEXT NOT NULL DEFAULT '',
      urgency TEXT NOT NULL DEFAULT 'low' CHECK (urgency IN ('low','out')),
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','ordered','dismissed')),
      requested_by UUID REFERENCES employees(id),
      requested_by_name TEXT NOT NULL DEFAULT '',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_by TEXT NOT NULL DEFAULT '',
      resolved_at TIMESTAMPTZ,
      CHECK (inventory_item_id IS NOT NULL OR item_text <> ''))`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_inventory_requests_open_idx ON ordering_inventory_requests(business,status,requested_at DESC)`;
    // Everything a supplier sells (from pasted order guides or the daily price job),
    // so new products can be found that meet an item's specs, and price history.
    await sql`CREATE TABLE IF NOT EXISTS ordering_supplier_catalog(
      id UUID PRIMARY KEY,
      supplier_id UUID NOT NULL REFERENCES ordering_inventory_suppliers(id) ON DELETE CASCADE,
      product_key TEXT NOT NULL,
      vendor_sku TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      pack_quantity NUMERIC(14,3) NOT NULL CHECK (pack_quantity > 0),
      pack_unit TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      source TEXT NOT NULL DEFAULT 'paste',
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (supplier_id, product_key))`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_supplier_price_history(
      id BIGSERIAL PRIMARY KEY,
      catalog_id UUID NOT NULL REFERENCES ordering_supplier_catalog(id) ON DELETE CASCADE,
      price_cents INTEGER NOT NULL,
      pack_quantity NUMERIC(14,3) NOT NULL,
      pack_unit TEXT NOT NULL,
      seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_supplier_price_history_idx ON ordering_supplier_price_history(catalog_id,seen_at DESC)`;
    // What an item has to be: words it must match ("tender, breaded"), a top price per unit, and a pack size range.
    await sql`ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS spec_keywords TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS spec_max_unit_cost_cents NUMERIC(14,4)`;
    await sql`ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS spec_min_pack NUMERIC(14,3)`;
    await sql`ALTER TABLE ordering_inventory_items ADD COLUMN IF NOT EXISTS spec_max_pack NUMERIC(14,3)`;
    await sql`CREATE TABLE IF NOT EXISTS ordering_inventory_settings(business TEXT PRIMARY KEY, suppliers_seeded_at TIMESTAMPTZ)`;
    await sql`ALTER TABLE ordering_inventory_settings ADD COLUMN IF NOT EXISTS case_minimums_set_at TIMESTAMPTZ`;
    const seeded = await sql`INSERT INTO ordering_inventory_settings(business,suppliers_seeded_at) VALUES(${BUSINESS},NOW()) ON CONFLICT(business) DO NOTHING RETURNING business`;
    if (seeded.length)
      for (const supplier of STARTER_SUPPLIERS)
        await sql`INSERT INTO ordering_inventory_suppliers(id,business,name,ships_in_days,cutoff_days_before)
          SELECT ${randomUUID()},${BUSINESS},${supplier.name},${supplier.shipsInDays},${supplier.shipsInDays == null ? 1 : 0}
          WHERE NOT EXISTS (SELECT 1 FROM ordering_inventory_suppliers WHERE business=${BUSINESS} AND lower(name)=lower(${supplier.name}))`;
    // Once: the broadliners' minimum is 20 cases, with no dollar minimum.
    const caseMinimums = await sql`UPDATE ordering_inventory_settings SET case_minimums_set_at=NOW() WHERE business=${BUSINESS} AND case_minimums_set_at IS NULL RETURNING business`;
    if (caseMinimums.length)
      await sql`UPDATE ordering_inventory_suppliers SET minimum_cases=20,minimum_order_cents=0,updated_at=NOW()
        WHERE business=${BUSINESS} AND lower(name) IN ('sysco','us foods','performance foodservice')`;
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

const num = (value: unknown) => (value == null || value === "" ? null : Number(value));
const cents = (value: unknown, label: string) => {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) throw new SupplierCostError(`${label} can't be negative.`);
  return Math.round(n);
};
const required = (value: unknown, label: string) => {
  const text = String(value ?? "").trim();
  if (!text) throw new SupplierCostError(`${label} is required.`);
  return text;
};

type ItemRow = { id: string; name: string; category: string; base_unit: string; on_hand: number; par_quantity: number | null; weekly_usage_override: number | null; case_pack_quantity: number | null };

async function stockItems() {
  const sql = getSql();
  const items = (await sql`SELECT i.id,i.name,i.category,i.base_unit,i.par_quantity::float8 par_quantity,i.weekly_usage_override::float8 weekly_usage_override,i.case_pack_quantity::float8 case_pack_quantity,
      COALESCE((SELECT SUM(delta_quantity) FROM ordering_inventory_movements m WHERE m.inventory_item_id=i.id),0)::float8 on_hand,
      (SELECT MAX(counted_at) FROM ordering_inventory_counts c WHERE c.inventory_item_id=i.id) last_counted_at
    FROM ordering_inventory_items i WHERE i.business=${BUSINESS} AND i.active=TRUE ORDER BY i.category,i.name`) as unknown as Array<ItemRow & { last_counted_at: Date | null }>;
  return items;
}

/**
 * Average weekly usage per item in its own unit, from the last four weeks of the
 * ledger: sales, waste and meals, plus the corrections that physical counts post
 * (so items without recipes still get usage once they're counted regularly).
 */
async function weeklyUsage(items: ItemRow[]) {
  const sql = getSql();
  const rows = await sql`SELECT inventory_item_id,unit,-SUM(delta_quantity)::float8 used,MIN(created_at) first_at
    FROM ordering_inventory_movements WHERE business=${BUSINESS} AND created_at>NOW()-INTERVAL '28 days' AND NOT (reason = ANY(${NOT_USAGE}::text[]))
    GROUP BY inventory_item_id,unit`;
  const firstSeen = await sql`SELECT inventory_item_id,MIN(created_at) first_at FROM ordering_inventory_movements WHERE business=${BUSINESS} GROUP BY inventory_item_id`;
  const first = new Map(firstSeen.map((row) => [String(row.inventory_item_id), new Date(row.first_at).getTime()]));
  const units = new Map(items.map((item) => [item.id, item.base_unit]));
  const used = new Map<string, number>();
  for (const row of rows) {
    const id = String(row.inventory_item_id), base = units.get(id);
    if (!base) continue;
    const converted = convertUnits(Number(row.used), String(row.unit), base);
    if (converted != null) used.set(id, (used.get(id) ?? 0) + converted);
  }
  const result = new Map<string, { perWeek: number | null; source: "set" | "history" | "none" }>();
  for (const item of items) {
    if (item.weekly_usage_override != null) {
      result.set(item.id, { perWeek: item.weekly_usage_override, source: "set" });
      continue;
    }
    const since = first.get(item.id);
    const days = since ? Math.min(28, (Date.now() - since) / 86_400_000) : 0;
    const total = used.get(item.id);
    result.set(item.id, days >= 7 && total != null ? { perWeek: Math.max(0, (total / days) * 7), source: "history" } : { perWeek: null, source: "none" });
  }
  return result;
}

function supplierTerms(row: Record<string, unknown>): SupplierTerms {
  return {
    id: String(row.id),
    name: String(row.name),
    minimumOrderCents: Number(row.minimum_order_cents || 0),
    minimumCases: Number(row.minimum_cases || 0),
    deliveryFeeCents: Number(row.delivery_fee_cents || 0),
    freeDeliveryOverCents: num(row.free_delivery_over_cents),
    deliveryDays: Array.isArray(row.delivery_days) ? (row.delivery_days as unknown[]).map(Number) : [],
    cutoffTime: String(row.cutoff_time || "16:00"),
    cutoffDaysBefore: Number(row.cutoff_days_before ?? 1),
    shipsInDays: num(row.ships_in_days),
  };
}

export type CostMode = "week" | "order";

/** Everything the Supplier costs page shows. */
export async function supplierCostDashboard(mode: CostMode = "week") {
  await ensureSupplierCostSchema();
  const sql = getSql();
  const [items, supplierRows, offerRows, requests] = await Promise.all([
    stockItems(),
    sql`SELECT * FROM ordering_inventory_suppliers WHERE business=${BUSINESS} AND active=TRUE ORDER BY name`,
    sql`SELECT si.*,s.name supplier_name FROM ordering_inventory_supplier_items si JOIN ordering_inventory_suppliers s ON s.id=si.supplier_id WHERE s.business=${BUSINESS} AND si.active=TRUE`,
    sql`SELECT r.*,i.name item_name,i.base_unit FROM ordering_inventory_requests r LEFT JOIN ordering_inventory_items i ON i.id=r.inventory_item_id
      WHERE r.business=${BUSINESS} AND (r.status='open' OR r.resolved_at>NOW()-INTERVAL '3 days') ORDER BY r.status='open' DESC,r.urgency='out' DESC,r.requested_at DESC LIMIT 200`,
  ]);
  const usage = await weeklyUsage(items);
  const suppliers = supplierRows.map(supplierTerms);
  const offers: Offer[] = offerRows.map((row) => ({
    supplierId: String(row.supplier_id),
    itemId: String(row.inventory_item_id),
    caseQuantity: Number(row.case_quantity),
    caseUnit: String(row.case_unit),
    casePriceCents: Number(row.case_price_cents),
  }));
  const openRequests = new Map<string, Array<Record<string, unknown>>>();
  for (const request of requests)
    if (request.status === "open" && request.inventory_item_id)
      openRequests.set(String(request.inventory_item_id), [...(openRequests.get(String(request.inventory_item_id)) ?? []), request]);

  const planItems: PlanItem[] = [];
  const rows = items.map((item) => {
    const use = usage.get(item.id)!;
    const daily = use.perWeek ? use.perWeek / 7 : 0;
    const runOutDate = daily > 0 ? new Date(Date.now() + Math.max(0, item.on_hand / daily) * 86_400_000).toISOString().slice(0, 10) : null;
    // "Order now": fill up to par (or ~1.5 weeks of usage), at least what someone asked for.
    const target = item.par_quantity ?? (use.perWeek != null ? use.perWeek * 1.5 : 0);
    const requested = (openRequests.get(item.id) ?? []).reduce((sum, r) => sum + (Number(r.quantity) || 0), 0);
    let need = mode === "week" ? use.perWeek ?? 0 : Math.max(0, target - Math.max(0, item.on_hand));
    if (mode === "order") need = Math.max(need, requested);
    if (mode === "order" && need === 0 && openRequests.has(item.id)) need = item.case_pack_quantity || 1;
    planItems.push({ id: item.id, name: item.name, baseUnit: item.base_unit, need, runOutDate: mode === "order" ? runOutDate : null });
    const prices = Object.fromEntries(
      offers
        .filter((offer) => offer.itemId === item.id)
        .map((offer) => {
          const row = offerRows.find((r) => String(r.supplier_id) === offer.supplierId && String(r.inventory_item_id) === item.id)!;
          return [offer.supplierId, { ...offer, vendorSku: String(row.vendor_sku || ""), quotedAt: row.last_quoted_at, unitCostCents: unitCostCents(offer, item.base_unit) }];
        }),
    );
    const costs = Object.values(prices).map((p) => p.unitCostCents).filter((c): c is number => c != null);
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      baseUnit: item.base_unit,
      onHand: item.on_hand,
      par: item.par_quantity,
      lastCountedAt: item.last_counted_at,
      weeklyUsage: use.perWeek,
      usageSource: use.source,
      runOutDate,
      need,
      requests: (openRequests.get(item.id) ?? []).length,
      prices,
      bestUnitCostCents: costs.length ? Math.min(...costs) : null,
      // What a week of this item costs at the cheapest vs the priciest supplier.
      weeklySpreadCents: costs.length > 1 && use.perWeek ? Math.round((Math.max(...costs) - Math.min(...costs)) * use.perWeek) : 0,
    };
  });
  const analysis = analyzeSuppliers(planItems, offers, suppliers);
  const [specRows, priceChanges] = await Promise.all([
    sql`SELECT id,spec_keywords,spec_max_unit_cost_cents::float8 max_unit,spec_min_pack::float8 min_pack,spec_max_pack::float8 max_pack FROM ordering_inventory_items WHERE business=${BUSINESS} AND active=TRUE`,
    recentPriceChanges(),
  ]);
  const specs = new Map(specRows.map((row) => [String(row.id), { keywords: String(row.spec_keywords || ""), maxUnitCostCents: row.max_unit == null ? null : Number(row.max_unit), minPack: row.min_pack == null ? null : Number(row.min_pack), maxPack: row.max_pack == null ? null : Number(row.max_pack) }]));
  const matches = await specMatches(items, specs, offerRows);
  return {
    specs: Object.fromEntries(specs),
    matches,
    priceChanges,
    catalogSize: Number((await sql`SELECT COUNT(*) n FROM ordering_supplier_catalog c JOIN ordering_inventory_suppliers s ON s.id=c.supplier_id WHERE s.business=${BUSINESS}`)[0].n),
    mode,
    suppliers: supplierRows.map((row) => ({ ...supplierTerms(row), contactName: row.contact_name, email: row.email, phone: row.phone, accountNumber: row.account_number, notes: row.notes, next: nextDelivery(supplierTerms(row)),
      priceSync: row.price_sync_at ? { at: row.price_sync_at, status: String(row.price_sync_status), message: String(row.price_sync_message), products: row.price_sync_products == null ? null : Number(row.price_sync_products) } : null,
      syncRequestedAt: row.price_sync_requested_at ?? null,
      codeSentAt: row.price_sync_code_at ?? null })),
    items: rows,
    analysis,
    requests,
    unpriced: rows.filter((row) => row.need > 0 && !Object.keys(row.prices).length).map((row) => row.name),
    noUsage: rows.filter((row) => row.weeklyUsage == null).length,
  };
}

/** Manager edits on the Supplier costs page. */
export async function supplierCostAction(body: Record<string, unknown>, actorName: string) {
  await ensureSupplierCostSchema();
  const sql = getSql(), action = String(body.action || "");
  if (action === "save_supplier") {
    const days = Array.isArray(body.deliveryDays) ? [...new Set(body.deliveryDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [];
    const cutoff = String(body.cutoffTime || "16:00");
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(cutoff)) throw new SupplierCostError("Order-by time must look like 16:00.");
    const id = String(body.id || randomUUID()), name = required(body.name, "Supplier name");
    const ships = num(body.shipsInDays);
    const rows = await sql`INSERT INTO ordering_inventory_suppliers(id,business,name,contact_name,email,phone,minimum_order_cents,minimum_cases,delivery_fee_cents,free_delivery_over_cents,delivery_days,cutoff_time,cutoff_days_before,ships_in_days,account_number,notes)
      VALUES(${id},${BUSINESS},${name},${String(body.contactName || "")},${String(body.email || "")},${String(body.phone || "")},${cents(body.minimumOrderCents, "Minimum")},${Math.max(0, Math.min(500, Math.round(Number(body.minimumCases) || 0)))},${cents(body.deliveryFeeCents, "Delivery fee")},
        ${body.freeDeliveryOverCents == null || body.freeDeliveryOverCents === "" ? null : cents(body.freeDeliveryOverCents, "Free delivery amount")},${days}::smallint[],${cutoff},${Math.max(0, Math.min(14, Number(body.cutoffDaysBefore ?? 1) || 0))},
        ${ships == null || !Number.isFinite(ships) ? null : Math.max(0, Math.min(30, Math.round(ships)))},${String(body.accountNumber || "")},${String(body.notes || "")})
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,contact_name=EXCLUDED.contact_name,email=EXCLUDED.email,phone=EXCLUDED.phone,minimum_order_cents=EXCLUDED.minimum_order_cents,minimum_cases=EXCLUDED.minimum_cases,
        delivery_fee_cents=EXCLUDED.delivery_fee_cents,free_delivery_over_cents=EXCLUDED.free_delivery_over_cents,delivery_days=EXCLUDED.delivery_days,cutoff_time=EXCLUDED.cutoff_time,
        cutoff_days_before=EXCLUDED.cutoff_days_before,ships_in_days=EXCLUDED.ships_in_days,account_number=EXCLUDED.account_number,notes=EXCLUDED.notes,updated_at=NOW()
      RETURNING id`;
    return { id: rows[0].id };
  }
  if (action === "sync_now") {
    // The store server checks for these every few minutes and starts the website price job.
    const id = String(body.supplierId || "");
    await sql`UPDATE ordering_inventory_suppliers SET price_sync_requested_at=NOW() WHERE business=${BUSINESS} AND (${id}='' OR id::text=${id})`;
    return { ok: true };
  }
  if (action === "sync_code") {
    const code = String(body.code || "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9-]{4,12}$/.test(code)) throw new SupplierCostError("Enter the code exactly as it was sent.");
    const rows = await sql`UPDATE ordering_inventory_suppliers SET price_sync_code=${code},price_sync_code_at=NOW(),price_sync_message='Code entered; signing in…' WHERE id=${required(body.supplierId, "Supplier")} AND business=${BUSINESS} RETURNING id`;
    if (!rows.length) throw new SupplierCostError("Supplier not found.");
    return { ok: true };
  }
  if (action === "save_price") {
    const supplierId = required(body.supplierId, "Supplier"), itemId = required(body.itemId, "Item");
    if (body.remove === true) {
      await sql`UPDATE ordering_inventory_supplier_items SET active=FALSE,updated_at=NOW() WHERE supplier_id=${supplierId} AND inventory_item_id=${itemId}`;
      return { ok: true };
    }
    const caseQuantity = Number(body.caseQuantity), price = cents(body.casePriceCents, "Case price");
    if (!Number.isFinite(caseQuantity) || caseQuantity <= 0) throw new SupplierCostError("Pack size must be more than zero.");
    const unit = required(body.caseUnit, "Pack unit");
    const base = String((await sql`SELECT base_unit FROM ordering_inventory_items WHERE id=${itemId} AND business=${BUSINESS}`)[0]?.base_unit || "");
    if (!base) throw new SupplierCostError("Item not found.");
    if (convertUnits(1, unit, base) == null) throw new SupplierCostError(`A pack in "${unit}" can't be compared with an item counted in "${base}". Use ${base} (or a unit of the same kind).`);
    await sql`INSERT INTO ordering_inventory_supplier_items(id,supplier_id,inventory_item_id,vendor_sku,case_quantity,case_unit,case_price_cents,last_quoted_at,active)
      VALUES(${randomUUID()},${supplierId},${itemId},${String(body.vendorSku || "")},${caseQuantity},${unit},${price},NOW(),TRUE)
      ON CONFLICT(supplier_id,inventory_item_id) DO UPDATE SET vendor_sku=EXCLUDED.vendor_sku,case_quantity=EXCLUDED.case_quantity,case_unit=EXCLUDED.case_unit,
        case_price_cents=EXCLUDED.case_price_cents,last_quoted_at=NOW(),active=TRUE,updated_at=NOW()`;
    return { ok: true };
  }
  if (action === "save_usage") {
    const itemId = required(body.itemId, "Item"), value = body.weeklyUsage === "" || body.weeklyUsage == null ? null : Number(body.weeklyUsage);
    const par = body.par === undefined ? undefined : body.par === "" || body.par == null ? null : Number(body.par);
    if ((value != null && (!Number.isFinite(value) || value < 0)) || (par != null && (!Number.isFinite(par) || par < 0))) throw new SupplierCostError("Use a number of zero or more.");
    await sql`UPDATE ordering_inventory_items SET weekly_usage_override=${value},par_quantity=CASE WHEN ${par !== undefined} THEN ${par ?? null}::numeric ELSE par_quantity END,updated_at=NOW() WHERE id=${itemId} AND business=${BUSINESS}`;
    return { ok: true };
  }
  if (action === "import_prices") return importPrices(String(body.supplierId || ""), String(body.text || ""));
  if (action === "save_spec") {
    const itemId = required(body.itemId, "Item");
    const n = (value: unknown) => (value === "" || value == null ? null : Number(value));
    const maxUnit = n(body.maxUnitCostCents), minPack = n(body.minPack), maxPack = n(body.maxPack);
    for (const value of [maxUnit, minPack, maxPack]) if (value != null && (!Number.isFinite(value) || value < 0)) throw new SupplierCostError("Use numbers of zero or more.");
    await sql`UPDATE ordering_inventory_items SET spec_keywords=${String(body.keywords || "").slice(0, 200)},spec_max_unit_cost_cents=${maxUnit},spec_min_pack=${minPack},spec_max_pack=${maxPack},updated_at=NOW() WHERE id=${itemId} AND business=${BUSINESS}`;
    return { ok: true };
  }
  if (action === "use_product") {
    // Buy this item as a catalog product from now on (replaces that supplier's current product for it).
    const itemId = required(body.itemId, "Item"), catalogId = required(body.catalogId, "Product");
    const product = (await sql`SELECT c.* FROM ordering_supplier_catalog c JOIN ordering_inventory_suppliers s ON s.id=c.supplier_id WHERE c.id=${catalogId} AND s.business=${BUSINESS}`)[0];
    const item = (await sql`SELECT base_unit FROM ordering_inventory_items WHERE id=${itemId} AND business=${BUSINESS}`)[0];
    if (!product || !item) throw new SupplierCostError("Product or item not found.");
    if (convertUnits(1, String(product.pack_unit), String(item.base_unit)) == null) throw new SupplierCostError(`That product is sold by ${product.pack_unit}; this item is counted in ${item.base_unit}.`);
    await sql`INSERT INTO ordering_inventory_supplier_items(id,supplier_id,inventory_item_id,vendor_sku,case_quantity,case_unit,case_price_cents,last_quoted_at,active)
      VALUES(${randomUUID()},${product.supplier_id},${itemId},${product.vendor_sku || product.product_key},${product.pack_quantity},${product.pack_unit},${product.price_cents},${product.last_seen_at},TRUE)
      ON CONFLICT(supplier_id,inventory_item_id) DO UPDATE SET vendor_sku=EXCLUDED.vendor_sku,case_quantity=EXCLUDED.case_quantity,case_unit=EXCLUDED.case_unit,case_price_cents=EXCLUDED.case_price_cents,last_quoted_at=EXCLUDED.last_quoted_at,active=TRUE,updated_at=NOW()`;
    return { ok: true };
  }
  if (action === "search_catalog") return { results: await searchCatalog(String(body.query || ""), String(body.unit || "")) };
  if (action === "resolve_request") {
    const status = String(body.status);
    if (!["ordered", "dismissed", "open"].includes(status)) throw new SupplierCostError("Unknown request status.");
    await sql`UPDATE ordering_inventory_requests SET status=${status},resolved_by=${status === "open" ? "" : actorName},resolved_at=${status === "open" ? null : new Date()} WHERE id=${required(body.id, "Request")} AND business=${BUSINESS}`;
    return { ok: true };
  }
  if (action === "create_orders") {
    // Turn the recommended split into draft purchase orders, one per supplier.
    const plan = (await supplierCostDashboard(body.mode === "week" ? "week" : "order")).analysis.best;
    if (!plan?.orders.length) throw new SupplierCostError("There is nothing to order yet.");
    return withTransaction(async () => {
      const ids: string[] = [];
      for (const order of plan.orders) {
        const id = randomUUID();
        ids.push(id);
        await sql`INSERT INTO ordering_inventory_purchase_orders(id,business,supplier_id,status,created_by,notes)
          VALUES(${id},${BUSINESS},${order.supplierId},'draft',${actorName},${`From supplier cost plan${order.delivery ? ` for ${order.delivery.deliveryDate}` : ""}`})`;
        for (const line of order.lines) {
          const offer = (await sql`SELECT case_quantity,case_unit FROM ordering_inventory_supplier_items WHERE supplier_id=${order.supplierId} AND inventory_item_id=${line.itemId}`)[0];
          await sql`INSERT INTO ordering_inventory_purchase_order_lines(id,purchase_order_id,inventory_item_id,quantity_cases,case_quantity,case_unit,case_price_cents)
            VALUES(${randomUUID()},${id},${line.itemId},${line.cases},${offer.case_quantity},${offer.case_unit},${line.casePriceCents})`;
        }
      }
      await sql`UPDATE ordering_inventory_requests SET status='ordered',resolved_by=${actorName},resolved_at=NOW()
        WHERE business=${BUSINESS} AND status='open' AND inventory_item_id=ANY(${plan.orders.flatMap((o) => o.lines.map((l) => l.itemId))}::uuid[])`;
      return { ok: true, purchaseOrders: ids.length };
    });
  }
  throw new SupplierCostError("Unknown action.");
}

export type CatalogProduct = { sku?: string; description: string; brand?: string; category?: string; packQuantity: number; packUnit: string; priceCents: number };

/**
 * Records a supplier's current products and prices (from a pasted order guide or
 * the daily price job). Products already bought for an item get their price
 * updated; every price change is kept for history.
 */
export async function ingestCatalog(supplierId: string, products: CatalogProduct[], source: string) {
  await ensureSupplierCostSchema();
  const sql = getSql();
  if (!(await sql`SELECT 1 FROM ordering_inventory_suppliers WHERE id=${supplierId} AND business=${BUSINESS}`).length) throw new SupplierCostError("Supplier not found.");
  let seen = 0, changed = 0, offersUpdated = 0;
  const rejected: string[] = [];
  for (const product of products.slice(0, 20_000)) {
    const description = String(product.description || "").trim().slice(0, 300), sku = String(product.sku || "").trim().slice(0, 60);
    const pack = Number(product.packQuantity), unit = String(product.packUnit || "").trim().toLowerCase().slice(0, 20), price = Math.round(Number(product.priceCents));
    if (!description || !(pack > 0) || !unit || !(price > 0)) {
      rejected.push(description || sku || "(blank)");
      continue;
    }
    const key = sku ? `sku:${sku.toLowerCase()}` : `name:${description.toLowerCase()}`;
    const row = (await sql`INSERT INTO ordering_supplier_catalog(id,supplier_id,product_key,vendor_sku,description,brand,category,pack_quantity,pack_unit,price_cents,source)
      VALUES(${randomUUID()},${supplierId},${key},${sku},${description},${String(product.brand || "").slice(0, 80)},${String(product.category || "").slice(0, 80)},${pack},${unit},${price},${source})
      ON CONFLICT(supplier_id,product_key) DO UPDATE SET description=EXCLUDED.description,brand=CASE WHEN EXCLUDED.brand='' THEN ordering_supplier_catalog.brand ELSE EXCLUDED.brand END,
        category=CASE WHEN EXCLUDED.category='' THEN ordering_supplier_catalog.category ELSE EXCLUDED.category END,pack_quantity=EXCLUDED.pack_quantity,pack_unit=EXCLUDED.pack_unit,
        price_cents=EXCLUDED.price_cents,source=EXCLUDED.source,last_seen_at=NOW()
      RETURNING id,(xmax=0) inserted,(SELECT price_cents FROM ordering_supplier_price_history h WHERE h.catalog_id=ordering_supplier_catalog.id ORDER BY seen_at DESC,id DESC LIMIT 1) last_price`)[0];
    seen++;
    if (row.last_price == null || Number(row.last_price) !== price) {
      await sql`INSERT INTO ordering_supplier_price_history(catalog_id,price_cents,pack_quantity,pack_unit) VALUES(${row.id},${price},${pack},${unit})`;
      if (row.last_price != null) changed++;
    }
    const updated = await sql`UPDATE ordering_inventory_supplier_items SET case_price_cents=${price},case_quantity=${pack},case_unit=${unit},last_quoted_at=NOW(),updated_at=NOW()
      WHERE supplier_id=${supplierId} AND active=TRUE AND lower(vendor_sku)=lower(${sku || key}) AND (case_price_cents<>${price} OR case_quantity<>${pack} OR case_unit<>${unit}) RETURNING id`;
    offersUpdated += updated.length;
  }
  return { seen, priceChanges: changed, offersUpdated, rejected: rejected.slice(0, 20), rejectedCount: rejected.length };
}

/**
 * Paste a supplier's order guide. Every line goes into that supplier's catalog;
 * lines whose name matches a stock item set that item's price from this
 * supplier, and names we don't stock yet are added as items.
 */
export async function importPrices(supplierId: string, text: string) {
  if (!supplierId) throw new SupplierCostError("Choose a supplier.");
  const { products, skipped, fullExport } = parseGuide(text);
  if (!products.length) throw new SupplierCostError(skipped.length ? `Couldn't read those lines. Expected: name, pack size, pack unit, case price. First one: ${skipped[0]}` : "Paste at least one line.");
  if (products.length > 20_000) throw new SupplierCostError("That file is too big; split it into parts under 20,000 lines.");
  const sql = getSql();
  let saved = 0, created = 0, catalog = { seen: 0, priceChanges: 0, offersUpdated: 0 };
  await withTransaction(async () => {
    catalog = await ingestCatalog(supplierId, products, fullExport ? "export" : "paste");
    for (const product of products) {
      let item = (await sql`SELECT id,base_unit FROM ordering_inventory_items WHERE business=${BUSINESS} AND lower(name)=lower(${product.description})`)[0];
      // A whole export only refreshes the catalog and the products we already buy;
      // use "Find products" to pick new ones from it.
      if (!item && fullExport) continue;
      if (!item) {
        item = (await sql`INSERT INTO ordering_inventory_items(id,business,name,base_unit,case_pack_quantity) VALUES(${randomUUID()},${BUSINESS},${product.description},${product.packUnit.toLowerCase()},${product.packQuantity}) RETURNING id,base_unit`)[0];
        created++;
      }
      if (convertUnits(1, product.packUnit, String(item.base_unit)) == null) {
        skipped.push(`${product.description}: "${product.packUnit}" doesn't convert to ${item.base_unit}`);
        continue;
      }
      const sku = product.sku ? product.sku : `name:${product.description.toLowerCase()}`;
      await sql`INSERT INTO ordering_inventory_supplier_items(id,supplier_id,inventory_item_id,vendor_sku,case_quantity,case_unit,case_price_cents,last_quoted_at,active)
        VALUES(${randomUUID()},${supplierId},${item.id},${sku},${product.packQuantity},${product.packUnit.toLowerCase()},${product.priceCents},NOW(),TRUE)
        ON CONFLICT(supplier_id,inventory_item_id) DO UPDATE SET vendor_sku=EXCLUDED.vendor_sku,case_quantity=EXCLUDED.case_quantity,case_unit=EXCLUDED.case_unit,case_price_cents=EXCLUDED.case_price_cents,last_quoted_at=NOW(),active=TRUE,updated_at=NOW()`;
      saved++;
    }
  });
  return { saved, created, skipped, catalog: catalog.seen, priceChanges: catalog.priceChanges, offersUpdated: catalog.offersUpdated };
}

const words = (keywords: string) =>
  keywords
    .split(/[,;]+/)
    .map((group) => group.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Products in any supplier's catalog that fit an item's specs and aren't what we
 * buy now: every keyword in the description, under the price ceiling per unit,
 * pack size in range, seen in the last 30 days. Cheapest per unit first.
 */
async function specMatches(items: ItemRow[], specs: Map<string, { keywords: string; maxUnitCostCents: number | null; minPack: number | null; maxPack: number | null }>, offerRows: Array<Record<string, unknown>>) {
  const sql = getSql();
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const item of items) {
    const spec = specs.get(item.id);
    const terms = words(spec?.keywords || "");
    if (!spec || !terms.length) continue;
    const patterns = terms.map((term) => `%${likeEscape(term)}%`);
    const rows = await sql`SELECT c.id,c.supplier_id,s.name supplier_name,c.vendor_sku,c.product_key,c.description,c.brand,c.pack_quantity::float8 pack_quantity,c.pack_unit,c.price_cents,c.last_seen_at,c.first_seen_at
      FROM ordering_supplier_catalog c JOIN ordering_inventory_suppliers s ON s.id=c.supplier_id
      WHERE s.business=${BUSINESS} AND s.active=TRUE AND c.last_seen_at>NOW()-INTERVAL '30 days' AND lower(c.description) LIKE ALL(${patterns}::text[])
      ORDER BY c.price_cents LIMIT 200`;
    const current = new Set(offerRows.filter((o) => String(o.inventory_item_id) === item.id).map((o) => `${o.supplier_id}:${String(o.vendor_sku).toLowerCase()}`));
    const fits = (rows as unknown as Array<Record<string, unknown>>)
      .map((row): (Record<string, unknown> & { packInItemUnit: number; unitCostCents: number; isNew: boolean }) | null => {
        const pack = convertUnits(Number(row.pack_quantity), String(row.pack_unit), item.base_unit);
        return pack ? { ...row, packInItemUnit: pack, unitCostCents: Number(row.price_cents) / pack, isNew: Date.now() - new Date(row.first_seen_at as string).getTime() < 14 * 86_400_000 } : null;
      })
      .filter((row) => row !== null)
      .filter((row) => !current.has(`${row.supplier_id}:${String(row.vendor_sku || row.product_key).toLowerCase()}`))
      .filter((row) => spec.maxUnitCostCents == null || row.unitCostCents <= spec.maxUnitCostCents)
      .filter((row) => (spec.minPack == null || row.packInItemUnit >= spec.minPack) && (spec.maxPack == null || row.packInItemUnit <= spec.maxPack))
      .sort((a, b) => a.unitCostCents - b.unitCostCents)
      .slice(0, 6);
    if (fits.length) out[item.id] = fits;
  }
  return out;
}

/** Search every supplier's catalog, with price per unit when a unit is given (e.g. "lb"). */
export async function searchCatalog(query: string, unit: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];
  await ensureSupplierCostSchema();
  const rows = await getSql()`SELECT c.id,s.name supplier_name,c.vendor_sku,c.description,c.brand,c.pack_quantity::float8 pack_quantity,c.pack_unit,c.price_cents,c.last_seen_at
    FROM ordering_supplier_catalog c JOIN ordering_inventory_suppliers s ON s.id=c.supplier_id
    WHERE s.business=${BUSINESS} AND s.active=TRUE AND lower(c.description||' '||c.brand||' '||c.vendor_sku) LIKE ALL(${terms.map((t) => `%${likeEscape(t)}%`)}::text[])
    ORDER BY c.last_seen_at DESC LIMIT 100`;
  return rows
    .map((row) => {
      const pack = unit ? convertUnits(Number(row.pack_quantity), String(row.pack_unit), unit) : null;
      return { ...row, unitCostCents: pack ? Number(row.price_cents) / pack : null };
    })
    .sort((a, b) => (a.unitCostCents ?? Infinity) - (b.unitCostCents ?? Infinity));
}

/** Price changes on products we buy, last 14 days, biggest first. */
async function recentPriceChanges() {
  return getSql()`WITH h AS (
      SELECT h.catalog_id,h.price_cents,h.seen_at,LAG(h.price_cents) OVER (PARTITION BY h.catalog_id ORDER BY h.seen_at,h.id) previous
      FROM ordering_supplier_price_history h)
    SELECT DISTINCT ON (c.id) c.id,s.name supplier_name,c.description,h.previous,h.price_cents,h.seen_at,i.name item_name
    FROM h JOIN ordering_supplier_catalog c ON c.id=h.catalog_id JOIN ordering_inventory_suppliers s ON s.id=c.supplier_id
    JOIN ordering_inventory_supplier_items si ON si.supplier_id=c.supplier_id AND si.active=TRUE AND lower(si.vendor_sku)=lower(COALESCE(NULLIF(c.vendor_sku,''),c.product_key))
    JOIN ordering_inventory_items i ON i.id=si.inventory_item_id
    WHERE s.business=${BUSINESS} AND h.previous IS NOT NULL AND h.previous<>h.price_cents AND h.seen_at>NOW()-INTERVAL '14 days'
    ORDER BY c.id,h.seen_at DESC`;
}

// ---------- Employee stock sheet ----------

export type StockEmployee = { employeeId: string; name: string };

export async function stockSheet() {
  await ensureSupplierCostSchema();
  const sql = getSql();
  const [items, requests] = await Promise.all([
    stockItems(),
    sql`SELECT r.id,r.item_text,r.quantity::float8 quantity,r.unit,r.urgency,r.note,r.status,r.requested_by_name,r.requested_at,i.name item_name
      FROM ordering_inventory_requests r LEFT JOIN ordering_inventory_items i ON i.id=r.inventory_item_id
      WHERE r.business=${BUSINESS} AND (r.status='open' OR r.resolved_at>NOW()-INTERVAL '2 days') ORDER BY r.status='open' DESC,r.requested_at DESC LIMIT 100`,
  ]);
  return {
    items: items.map((item) => ({ id: item.id, name: item.name, category: item.category || "Other", unit: item.base_unit, casePack: item.case_pack_quantity, onHand: item.on_hand, par: item.par_quantity, lastCountedAt: item.last_counted_at })),
    requests,
  };
}

/** Saves a whole count sheet at once; each item's ledger is corrected to what was counted. */
export async function saveStockCount(employee: StockEmployee, counts: Array<{ itemId: string; quantity: number }>) {
  await ensureSupplierCostSchema();
  const clean = counts.filter((count) => count.itemId && Number.isFinite(Number(count.quantity)) && Number(count.quantity) >= 0).slice(0, 500);
  if (!clean.length) throw new SupplierCostError("Enter at least one count.");
  return withTransaction(async () => {
    const sql = getSql();
    let changed = 0;
    for (const count of clean) {
      const counted = Math.round(Number(count.quantity) * 1000) / 1000;
      const item = (await sql`SELECT id,base_unit FROM ordering_inventory_items WHERE id=${count.itemId} AND business=${BUSINESS} AND active=TRUE FOR UPDATE`)[0];
      if (!item) continue;
      const expected = Number((await sql`SELECT COALESCE(SUM(delta_quantity),0)::float8 q FROM ordering_inventory_movements WHERE inventory_item_id=${item.id}`)[0].q);
      const variance = Math.round((counted - expected) * 1000) / 1000;
      let movementId: string | null = null;
      if (variance !== 0) {
        movementId = randomUUID();
        await sql`INSERT INTO ordering_inventory_movements(id,business,inventory_item_id,delta_quantity,unit,reason,employee_id,note,source,created_by,details)
          VALUES(${movementId},${BUSINESS},${item.id},${variance},${item.base_unit},'count_correction',${employee.employeeId},'Stock sheet count','stock_sheet',${employee.name},${JSON.stringify({ expected, counted })}::jsonb)`;
        changed++;
      }
      await sql`INSERT INTO ordering_inventory_counts(id,business,inventory_item_id,expected_quantity,counted_quantity,variance_quantity,adjustment_movement_id,counted_by,note)
        VALUES(${randomUUID()},${BUSINESS},${item.id},${expected},${counted},${variance},${movementId},${employee.name},'Stock sheet')`;
    }
    return { ok: true, counted: clean.length, changed };
  });
}

export async function addStockRequest(employee: StockEmployee, input: { itemId?: string; itemText?: string; quantity?: number | null; unit?: string; urgency?: string; note?: string }) {
  await ensureSupplierCostSchema();
  const sql = getSql();
  const itemId = input.itemId ? String(input.itemId) : null;
  const text = String(input.itemText || "").trim().slice(0, 120);
  if (!itemId && !text) throw new SupplierCostError("Pick an item or type what we need.");
  if (itemId && !(await sql`SELECT 1 FROM ordering_inventory_items WHERE id=${itemId} AND business=${BUSINESS}`).length) throw new SupplierCostError("Item not found.");
  const quantity = input.quantity == null || input.quantity === ("" as unknown) ? null : Number(input.quantity);
  if (quantity != null && (!Number.isFinite(quantity) || quantity <= 0)) throw new SupplierCostError("Amount must be more than zero.");
  // Asking twice for the same thing updates the open request instead of adding another.
  const existing = itemId ? (await sql`SELECT id FROM ordering_inventory_requests WHERE business=${BUSINESS} AND status='open' AND inventory_item_id=${itemId} LIMIT 1`)[0] : null;
  const urgency = input.urgency === "out" ? "out" : "low";
  if (existing) {
    await sql`UPDATE ordering_inventory_requests SET quantity=COALESCE(${quantity},quantity),urgency=CASE WHEN ${urgency}='out' THEN 'out' ELSE urgency END,
      note=CASE WHEN ${String(input.note || "")}='' THEN note ELSE ${String(input.note || "").slice(0, 300)} END,requested_by=${employee.employeeId},requested_by_name=${employee.name},requested_at=NOW() WHERE id=${existing.id}`;
    return { ok: true, id: existing.id, updated: true };
  }
  const id = randomUUID();
  await sql`INSERT INTO ordering_inventory_requests(id,business,inventory_item_id,item_text,quantity,unit,urgency,note,requested_by,requested_by_name)
    VALUES(${id},${BUSINESS},${itemId},${text},${quantity},${String(input.unit || "").slice(0, 20)},${urgency},${String(input.note || "").slice(0, 300)},${employee.employeeId},${employee.name})`;
  return { ok: true, id };
}

/** Records how the daily website price job went for a supplier, for the Supplier costs page. */
export async function recordPriceSync(supplierId: string, result: { status: "ok" | "needs_login" | "needs_code" | "no_products" | "failed"; message: string; products?: number | null }) {
  await ensureSupplierCostSchema();
  await getSql()`UPDATE ordering_inventory_suppliers SET price_sync_at=NOW(),price_sync_status=${result.status},price_sync_message=${String(result.message || "").slice(0, 500)},
    price_sync_products=${result.products ?? null} WHERE id=${supplierId} AND business=${BUSINESS}`;
}

/** The sign-in code a manager entered in the last 15 minutes (used once). */
export async function takeSyncCode(supplierName: string) {
  await ensureSupplierCostSchema();
  const row = (await getSql()`UPDATE ordering_inventory_suppliers s SET price_sync_code=NULL
    FROM (SELECT id,price_sync_code FROM ordering_inventory_suppliers WHERE business=${BUSINESS} AND lower(name)=lower(${supplierName})
      AND price_sync_code IS NOT NULL AND price_sync_code_at>NOW()-INTERVAL '15 minutes' FOR UPDATE) old
    WHERE s.id=old.id RETURNING old.price_sync_code code`)[0];
  return row ? String(row.code) : null;
}

/** Suppliers someone pressed "Sync now" for (cleared once handed out). */
export async function takeSyncRequests() {
  await ensureSupplierCostSchema();
  const rows = await getSql()`UPDATE ordering_inventory_suppliers SET price_sync_requested_at=NULL
    WHERE business=${BUSINESS} AND price_sync_requested_at IS NOT NULL AND price_sync_requested_at>NOW()-INTERVAL '2 hours' RETURNING name`;
  return rows.map((row) => String(row.name));
}
