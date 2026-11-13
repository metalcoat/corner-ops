import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { employeeDrinkPriceCents } from "@/lib/ordering-employee-drink-rules";
import { ensureEmployeeMealSchema } from "@/lib/ordering-employee-meals";
import { createDraftOrderWithVariants } from "@/lib/ordering-orders-with-variants";
import { submitDraftOrder } from "@/lib/ordering-order-lifecycle";
import { dispatchSubmittedOrderPrintJobs } from "@/lib/ordering-auto-print";
import type { OrderingActor } from "@/lib/ordering-route-auth";

type Business = "Corner Deli";
type PriceRow = { size_key: string; label: string; category_name: string; cost_cents: number; deposit_cents: number; updated_by: string; updated_at: string };

async function taxRateBps(business: Business): Promise<number> {
  const row = (await getSql()`SELECT tax_rate_bps, prices_include_tax FROM ordering_business_tax_settings WHERE business = ${business} LIMIT 1`)[0];
  // Employee prices are tax-inclusive like the rest of the menu; with tax added on top the rounding would be off.
  if (row && row.prices_include_tax === false) throw new Error("Employee drink pricing expects tax-included menu prices.");
  return Number(row?.tax_rate_bps || 0);
}

/** Sizes with today's employee price and the drinks in each size's menu category. */
export async function employeeDrinkMenu(business: Business) {
  const sql = getSql();
  const [rows, rate] = await Promise.all([
    sql`SELECT size_key, label, category_name, cost_cents, deposit_cents, updated_by, updated_at FROM ordering_employee_drink_prices WHERE business = ${business} ORDER BY cost_cents` as unknown as Promise<PriceRow[]>,
    taxRateBps(business),
  ]);
  const items = await sql`
    SELECT i.id item_id, i.name, c.name category_name, i.base_price_cents,
      (SELECT v.id FROM ordering_menu_item_variants v WHERE v.item_id = i.id AND v.active AND v.default_variant LIMIT 1) variant_id
    FROM ordering_menu_items i JOIN ordering_menu_categories c ON c.id = i.category_id
    WHERE i.business = ${business} AND i.active = TRUE AND c.name = ANY(${rows.map((row) => row.category_name)})
    ORDER BY i.name
  ` as unknown as Array<{ item_id: string; name: string; category_name: string; base_price_cents: number; variant_id: string | null }>;
  return {
    taxRateBps: rate,
    sizes: rows.map((row) => ({
      key: row.size_key,
      label: row.label,
      categoryName: row.category_name,
      costCents: Number(row.cost_cents),
      depositCents: Number(row.deposit_cents),
      priceCents: employeeDrinkPriceCents(Number(row.cost_cents), Number(row.deposit_cents), rate),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      items: items.filter((item) => item.category_name === row.category_name).map((item) => ({ itemId: item.item_id, variantId: item.variant_id, name: item.name, menuPriceCents: Number(item.base_price_cents) })),
    })),
  };
}

/** Manager: today's cost and deposit per size (the price follows automatically). */
export async function saveEmployeeDrinkCosts(business: Business, input: Array<{ key: unknown; costCents: unknown; depositCents: unknown }>, actor: OrderingActor) {
  for (const row of input.slice(0, 10)) {
    const cost = Math.round(Number(row.costCents)), deposit = Math.round(Number(row.depositCents));
    if (!Number.isFinite(cost) || cost < 0 || cost > 5000 || !Number.isFinite(deposit) || deposit < 0 || deposit > 100) throw new Error("Enter a cost between $0 and $50 and a deposit between $0 and $1.");
    await getSql()`UPDATE ordering_employee_drink_prices SET cost_cents = ${cost}, deposit_cents = ${deposit}, updated_by = ${actor.name}, updated_at = NOW() WHERE business = ${business} AND size_key = ${String(row.key)}`;
  }
  await getSql()`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details) VALUES(${randomUUID()},${business},${actor.id},${actor.role || "manager"},'employee_drink_costs_saved','employee_drink_prices',${business},'',${JSON.stringify({ rows: input })}::jsonb)`;
  return employeeDrinkMenu(business);
}

/**
 * The signed-in POS employee buys drinks at the employee price. Like the employee meal: the order
 * goes in at menu price (stock comes off on submit), then the difference becomes a discount and
 * checkout opens for the employee's own payment.
 */
export async function recordEmployeeDrinks(input: { business: Business; lines: Array<{ itemId: unknown; quantity: unknown }>; actor: OrderingActor }) {
  await ensureEmployeeMealSchema();
  const menu = await employeeDrinkMenu(input.business);
  const byItem = new Map(menu.sizes.flatMap((size) => size.items.map((item) => [item.itemId, { ...item, size }] as const)));
  const lines = input.lines.map((line) => ({ item: byItem.get(String(line.itemId)), quantity: Math.floor(Number(line.quantity)) })).filter((line) => line.quantity > 0);
  if (!lines.length) throw new Error("Choose at least one drink.");
  if (lines.some((line) => !line.item)) throw new Error("Only 20 oz and 2 liter drinks are sold at the employee price.");
  if (lines.reduce((sum, line) => sum + line.quantity, 0) > 6) throw new Error("Up to 6 employee drinks at a time.");
  const employeeTotalCents = lines.reduce((sum, line) => sum + line.item!.size.priceCents * line.quantity, 0);
  const result = await withTransaction(async () => {
    const sql = getSql();
    const employee = (await sql`SELECT id FROM employees WHERE id = ${input.actor.id} AND business = ${input.business} AND active = TRUE`)[0];
    if (!employee) throw new Error("The signed-in employee was not found.");
    const order = await createDraftOrderWithVariants({
      business: input.business, source: "pos", serviceType: "dine_in", customerFirstName: input.actor.name, orderOrigin: "pos",
      createdBy: input.actor.id, createdByName: input.actor.name,
      items: lines.map((line) => ({ itemId: line.item!.itemId, variantId: line.item!.variantId || undefined, quantity: line.quantity })),
    });
    await sql`UPDATE ordering_orders SET special_instructions = ${`EMPLOYEE DRINK · ${input.actor.name}`}, updated_at = NOW() WHERE id = ${order.id}`;
    await submitDraftOrder(String(order.id), input.business, input.actor);
    await sql`UPDATE ordering_inventory_movements SET source = 'employee_drink' WHERE order_id = ${order.id} AND reason = 'sale'`;
    const [priced] = await sql`SELECT subtotal_cents, tax_cents FROM ordering_orders WHERE id = ${order.id}`;
    const menuTotalCents = Number(priced.subtotal_cents) + Number(priced.tax_cents);
    await sql`UPDATE ordering_orders SET discount_cents = GREATEST(0, subtotal_cents + tax_cents - ${employeeTotalCents}), total_cents = ${employeeTotalCents}, paid_cents = 0, amount_due_cents = ${employeeTotalCents}, payment_status = 'unpaid', updated_at = NOW() WHERE id = ${order.id}`;
    const details = { menuTotalCents, employeeTotalCents, actorName: input.actor.name, lines: lines.map((line) => ({ name: line.item!.name, size: line.item!.size.key, quantity: line.quantity, unitCents: line.item!.size.priceCents, costCents: line.item!.size.costCents, depositCents: line.item!.size.depositCents })) };
    await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) SELECT ${randomUUID()},id,version,'employee_drink_priced',${input.actor.type},${input.actor.id},${JSON.stringify(details)}::jsonb FROM ordering_orders WHERE id=${order.id}`;
    await sql`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details) VALUES(${randomUUID()},${input.business},${input.actor.id},${input.actor.role || "employee"},'employee_drink_sold','order',${order.id},'',${JSON.stringify(details)}::jsonb)`;
    return { orderId: String(order.id), displayNumber: String(order.display_number), employeeName: input.actor.name, menuTotalCents, employeeTotalCents };
  });
  await dispatchSubmittedOrderPrintJobs(result.orderId, input.business);
  return result;
}
