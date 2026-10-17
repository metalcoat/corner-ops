// Sales tax collected, for the manager report and NY sales tax filing.
//
// Menu prices include tax, so the POS never adds tax on top and orders keep
// tax_cents at 0 (every total formula adds tax_cents, so storing the included
// tax there would overcharge). Instead the tax inside each sale is backed out
// here: taxable amount × rate ÷ (1 + rate), using the rate in effect when the
// order was placed.
import { getSql } from "@/lib/db";
import { ensureOrderingDeliverySchema } from "@/lib/ordering-delivery-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";

let historyReady: Promise<void> | null = null;
/** Every tax rate the store has used, so old orders keep their old rate. */
export function ensureTaxRateHistory(): Promise<void> {
  historyReady ??= (async () => {
    await ensureOrderingDeliverySchema();
    const sql = getSql();
    await sql`CREATE TABLE IF NOT EXISTS ordering_tax_rate_history(
      id BIGSERIAL PRIMARY KEY,
      business TEXT NOT NULL CHECK (business IN ('Corner Deli','Tiki')),
      tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
      prices_include_tax BOOLEAN NOT NULL,
      delivery_fee_taxable BOOLEAN NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      changed_by TEXT NOT NULL DEFAULT '')`;
    await sql`CREATE INDEX IF NOT EXISTS ordering_tax_rate_history_idx ON ordering_tax_rate_history(business, effective_at DESC)`;
    // Seed with today's settings as the rate for all earlier orders.
    await sql`INSERT INTO ordering_tax_rate_history(business,tax_rate_bps,prices_include_tax,delivery_fee_taxable,effective_at,changed_by)
      SELECT business,tax_rate_bps,prices_include_tax,delivery_fee_taxable,'1970-01-01','initial settings' FROM ordering_business_tax_settings s
      WHERE NOT EXISTS (SELECT 1 FROM ordering_tax_rate_history h WHERE h.business = s.business)`;
  })().catch((error) => {
    historyReady = null;
    throw error;
  });
  return historyReady;
}

/** Called after tax settings are saved; records a new rate only when something changed. */
export async function recordTaxRateChange(business: OrderingBusiness, changedBy: string) {
  await ensureTaxRateHistory();
  await getSql()`INSERT INTO ordering_tax_rate_history(business,tax_rate_bps,prices_include_tax,delivery_fee_taxable,changed_by)
    SELECT s.business,s.tax_rate_bps,s.prices_include_tax,s.delivery_fee_taxable,${changedBy} FROM ordering_business_tax_settings s
    WHERE s.business=${business} AND NOT EXISTS (
      SELECT 1 FROM (SELECT * FROM ordering_tax_rate_history WHERE business=${business} ORDER BY effective_at DESC, id DESC LIMIT 1) last
      WHERE last.tax_rate_bps=s.tax_rate_bps AND last.prices_include_tax=s.prices_include_tax AND last.delivery_fee_taxable=s.delivery_fee_taxable)`;
}

/** Tax included in a tax-inclusive amount, rounded to the cent. */
export function includedTax(grossCents: number, rateBps: number) {
  if (grossCents <= 0 || rateBps <= 0) return 0;
  return Math.round((grossCents * rateBps) / (10_000 + rateBps));
}

export type SalesTaxDay = {
  date: string;
  orders: number;
  /** What customers paid for food and delivery, tax included, tips excluded. */
  grossSalesCents: number;
  taxableSalesCents: number;
  nonTaxableSalesCents: number;
  taxCents: number;
  tipsCents: number;
};
export type SalesTaxReport = {
  rateBps: number;
  pricesIncludeTax: boolean;
  days: SalesTaxDay[];
  refunds: { refundCents: number; taxCents: number };
  totals: SalesTaxDay & { netTaxCents: number; taxableSalesExTaxCents: number };
  warnings: string[];
};

/**
 * Sales tax by business day (4am–4am Eastern). Discounts reduce taxable sales
 * proportionally; tips are not taxable; delivery fees follow the store setting.
 * Refunds in the range reduce the tax owed by their taxable share.
 */
export async function salesTaxReport(input: { business: OrderingBusiness; start: Date; end: Date }): Promise<SalesTaxReport> {
  await ensureTaxRateHistory();
  const sql = getSql();
  const settings = (await sql`SELECT tax_rate_bps,prices_include_tax,tax_rate_configured FROM ordering_business_tax_settings WHERE business=${input.business}`)[0];
  const orders = await sql`
    WITH lines AS (
      SELECT item.order_id,
        COALESCE(SUM(item.line_total_cents::numeric * (item.quantity - item.cancelled_quantity) / NULLIF(item.quantity,0)),0) line_cents,
        COALESCE(SUM(item.line_total_cents::numeric * (item.quantity - item.cancelled_quantity) / NULLIF(item.quantity,0)) FILTER (WHERE COALESCE(menu.taxable,TRUE)),0) taxable_line_cents
      FROM ordering_order_items item
      JOIN ordering_orders o ON o.id = item.order_id
      LEFT JOIN ordering_menu_items menu ON menu.id = item.item_id
      WHERE o.business=${input.business} AND o.created_at>=${input.start.toISOString()} AND o.created_at<${input.end.toISOString()}
      GROUP BY item.order_id)
    SELECT o.id,
      to_char((o.created_at AT TIME ZONE 'America/New_York') - INTERVAL '4 hours','YYYY-MM-DD') business_day,
      COALESCE(lines.line_cents,0)::float8 line_cents, COALESCE(lines.taxable_line_cents,0)::float8 taxable_line_cents,
      o.discount_cents, o.tip_cents, COALESCE(o.delivery_fee_cents,0) delivery_fee_cents,
      rate.tax_rate_bps, rate.delivery_fee_taxable
    FROM ordering_orders o
    LEFT JOIN lines ON lines.order_id = o.id
    LEFT JOIN LATERAL (SELECT tax_rate_bps,delivery_fee_taxable FROM ordering_tax_rate_history h
      WHERE h.business=o.business AND h.effective_at<=o.created_at ORDER BY h.effective_at DESC, h.id DESC LIMIT 1) rate ON TRUE
    WHERE o.business=${input.business} AND o.created_at>=${input.start.toISOString()} AND o.created_at<${input.end.toISOString()}
      AND o.status NOT IN ('draft','cancelled') AND o.voided_at IS NULL
    ORDER BY o.created_at`;
  const refunds = await sql`
    SELECT t.amount_cents, o.total_cents, o.tip_cents, COALESCE(o.delivery_fee_cents,0) delivery_fee_cents, o.discount_cents,
      COALESCE(lines.line_cents,0)::float8 line_cents, COALESCE(lines.taxable_line_cents,0)::float8 taxable_line_cents,
      rate.tax_rate_bps, rate.delivery_fee_taxable
    FROM ordering_payment_transactions t
    JOIN ordering_orders o ON o.id = t.order_id
    LEFT JOIN LATERAL (SELECT SUM(i.line_total_cents::numeric*(i.quantity-i.cancelled_quantity)/NULLIF(i.quantity,0)) line_cents,
        SUM(i.line_total_cents::numeric*(i.quantity-i.cancelled_quantity)/NULLIF(i.quantity,0)) FILTER (WHERE COALESCE(m.taxable,TRUE)) taxable_line_cents
      FROM ordering_order_items i LEFT JOIN ordering_menu_items m ON m.id=i.item_id WHERE i.order_id=o.id) lines ON TRUE
    LEFT JOIN LATERAL (SELECT tax_rate_bps,delivery_fee_taxable FROM ordering_tax_rate_history h
      WHERE h.business=o.business AND h.effective_at<=o.created_at ORDER BY h.effective_at DESC, h.id DESC LIMIT 1) rate ON TRUE
    WHERE t.business=${input.business} AND t.transaction_type IN ('refund','void') AND t.status='approved'
      AND t.created_at>=${input.start.toISOString()} AND t.created_at<${input.end.toISOString()}
      AND o.voided_at IS NULL AND o.status<>'cancelled'`;

  const split = (row: Record<string, unknown>) => {
    const lineCents = Number(row.line_cents), taxableLines = Number(row.taxable_line_cents);
    const discount = Math.min(Number(row.discount_cents || 0), lineCents);
    const share = lineCents > 0 ? taxableLines / lineCents : 0;
    const fee = Number(row.delivery_fee_cents || 0);
    const gross = Math.round(lineCents - discount + fee);
    const taxable = Math.round(taxableLines - discount * share + (row.delivery_fee_taxable === false ? 0 : fee));
    return { gross, taxable: Math.min(taxable, gross), rate: Number(row.tax_rate_bps || 0) };
  };

  const byDay = new Map<string, SalesTaxDay>();
  for (const row of orders) {
    const date = String(row.business_day);
    const day = byDay.get(date) ?? { date, orders: 0, grossSalesCents: 0, taxableSalesCents: 0, nonTaxableSalesCents: 0, taxCents: 0, tipsCents: 0 };
    const { gross, taxable, rate } = split(row);
    day.orders += 1;
    day.grossSalesCents += gross;
    day.taxableSalesCents += taxable;
    day.nonTaxableSalesCents += gross - taxable;
    day.taxCents += includedTax(taxable, rate);
    day.tipsCents += Number(row.tip_cents || 0);
    byDay.set(date, day);
  }
  let refundCents = 0, refundTax = 0;
  for (const row of refunds) {
    const amount = Number(row.amount_cents), total = Number(row.total_cents);
    const { taxable, rate } = split(row);
    refundCents += amount;
    // A refund gives back tax in proportion to the taxable part of what was paid.
    if (total > 0) refundTax += includedTax(Math.round((amount * taxable) / total), rate);
  }
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const sum = (key: keyof SalesTaxDay) => days.reduce((total, day) => total + Number(day[key]), 0);
  const taxCents = sum("taxCents"), taxableSalesCents = sum("taxableSalesCents");
  const rateBps = Number(settings?.tax_rate_bps || 0), pricesIncludeTax = settings?.prices_include_tax !== false;
  const warnings: string[] = [];
  if (!settings?.tax_rate_configured || rateBps === 0)
    warnings.push("No sales tax rate is set, so tax shows as $0. Set it under POS settings → Delivery, minimums, and tax (Ogdensburg is 8%).");
  if (!pricesIncludeTax)
    warnings.push("“Menu prices include tax” is turned off, but the POS does not add tax on top of prices. Turn it back on, or tax is being undercharged.");
  return {
    rateBps,
    pricesIncludeTax,
    days,
    refunds: { refundCents, taxCents: refundTax },
    totals: {
      date: "total",
      orders: sum("orders"),
      grossSalesCents: sum("grossSalesCents"),
      taxableSalesCents,
      nonTaxableSalesCents: sum("nonTaxableSalesCents"),
      taxCents,
      tipsCents: sum("tipsCents"),
      netTaxCents: taxCents - refundTax,
      taxableSalesExTaxCents: taxableSalesCents - taxCents,
    },
    warnings,
  };
}
