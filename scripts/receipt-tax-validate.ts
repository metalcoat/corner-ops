import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

// Customer receipts show the sales tax inside tax-included prices on its own line:
// the emailed/online confirmation data and the printed receipt layout, against the dev database.
loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("Receipt tax validation requires private local PostgreSQL.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

function check(condition: unknown, message: string) { if (!condition) throw new Error(message); }

async function main() {
  const { getSql } = await import("../src/lib/db");
  const { orderIncludedTax } = await import("../src/lib/ordering-sales-tax");
  const { customerOrderConfirmation } = await import("../src/lib/customer-order-confirmation");
  const { printPayloadLines } = await import("../src/lib/ordering-hardware");
  const sql = getSql();
  const [rate] = await sql`SELECT tax_rate_bps FROM ordering_tax_rate_history WHERE business='Corner Deli' ORDER BY effective_at DESC,id DESC LIMIT 1`;
  const rateBps = Number(rate?.tax_rate_bps || 0);
  check(rateBps > 0, "Corner Deli needs a tax rate.");
  const [taxable] = await sql`SELECT id FROM ordering_menu_items WHERE business='Corner Deli' AND active AND taxable LIMIT 1`;
  const orderId = randomUUID();
  try {
    // $21.60 of taxable food, a $2.16 discount and a $3.00 delivery fee: taxable $22.44 incl. tax.
    await sql`INSERT INTO ordering_orders(id,business,source,order_origin,status,payment_status,service_type,display_number,created_by,subtotal_cents,discount_cents,delivery_fee_cents,total_cents,amount_due_cents,caller_phone) VALUES(${orderId},'Corner Deli','web','web','sent_to_kitchen','unpaid','delivery',${`TAX-${orderId.slice(0, 8)}`},'validator',2160,216,300,2244,2244,'')`;
    await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents,sort_order) VALUES(${randomUUID()},${orderId},${taxable.id},'Tax fixture',2,1080,2160,0)`;
    const tax = await orderIncludedTax(orderId);
    const expected = Math.round((2244 * rateBps) / (10000 + rateBps));
    check(tax.taxCents === expected, `Included tax should be ${expected}, got ${tax.taxCents}`);
    const confirmation = await customerOrderConfirmation(orderId);
    check(confirmation.sales_tax_included_cents === expected && confirmation.total_cents === 2244, "Online confirmation should carry the included tax without changing the total.");
    const printed = printPayloadLines({ heading: "PAID RECEIPT", orderNumber: "1", orderTotalCents: 2244, salesTaxIncludedCents: expected, totalPaidCents: 2244, remainingDueCents: 0 });
    check(printed.includes("ORDER TOTAL (TAX INCLUDED): $22.44") && printed.includes(`SALES TAX INCLUDED: $${(expected / 100).toFixed(2)}`), `Printed receipt lines are missing the tax: ${printed.join(" | ")}`);
    const kitchen = printPayloadLines({ heading: "PAYMENT UPDATE", orderNumber: "1", totalPaidCents: 100 });
    check(!kitchen.some((line) => line.includes("SALES TAX")), "Payloads without an order total don't print a tax line.");
    console.log(JSON.stringify({ rateBps, orderTotalCents: 2244, salesTaxIncludedCents: expected, printed: printed.slice(-5) }, null, 2));
  } finally {
    await sql`DELETE FROM ordering_orders WHERE id=${orderId}`;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
