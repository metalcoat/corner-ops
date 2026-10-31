import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

// A free Jumbo Thin reward redeemed on a Jumbo Thick takes off only the Thin price.
loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("Loyalty cap validation requires private local PostgreSQL.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

async function main() {
  const { getSql } = await import("../src/lib/db");
  const { ensureOrderingLoyaltySchema } = await import("../src/lib/ordering-loyalty-schema");
  const { adjustLoyalty, loyaltyStatus, requestLoyaltyRedemption } = await import("../src/lib/ordering-loyalty");
  await ensureOrderingLoyaltySchema();
  const sql = getSql();
  const manager = { id: "loyalty-cap-manager", name: "Loyalty Manager", type: "employee" as const, role: "manager" as const };
  const variants = await sql`SELECT variant.id,variant.name,variant.base_price_cents,item.id item_id FROM ordering_menu_item_variants variant JOIN ordering_menu_items item ON item.id=variant.item_id WHERE item.business='Corner Deli' AND item.name='Pizza' AND variant.active=TRUE AND variant.name IN ('Jumbo Thin 16"','Jumbo Thick 16"')`;
  const thin = variants.find((row) => String(row.name).includes("Thin")), thick = variants.find((row) => String(row.name).includes("Thick"));
  if (!thin || !thick) throw new Error("Jumbo Thin and Jumbo Thick pizza variants are required.");
  const thinCents = Number(thin.base_price_cents), thickCents = Number(thick.base_price_cents);
  const programId = randomUUID(), customerId = randomUUID(), thickOrder = randomUUID(), thinOrder = randomUUID(), thickLine = randomUUID(), thinLine = randomUUID();
  try {
    await sql`INSERT INTO ordering_customers(id,business,display_name,first_name) VALUES(${customerId},'Corner Deli','Loyalty Cap','Loyalty')`;
    await sql`INSERT INTO ordering_loyalty_programs(id,business,name,customer_name,qualifying_rule,reward_rule,active,version,priority,stackable,updated_by) VALUES(${programId},'Corner Deli',${`Loyalty cap validator ${programId}`},'Cap Validator',${JSON.stringify({ variantIds: [thin.id, thick.id], quantityRequired: 10, discountedItemsQualify: false })}::jsonb,${JSON.stringify({ variantIds: [thin.id, thick.id], quantity: 1, modifierAllowances: [], capVariantId: thin.id })}::jsonb,TRUE,1,10000,FALSE,'validator')`;
    await adjustLoyalty({ customerId, programId, deltaUnits: 20, reason: "Cap validation balance", actor: manager });
    const status = (await loyaltyStatus(customerId)).find((row) => row.programId === programId)!;
    if (status.rewardsAvailable !== 2) throw new Error("Expected two rewards available.");
    if (status.upgrades.length !== 1 || status.upgrades[0].extraCents !== thickCents - thinCents) throw new Error(`Upgrade hint is wrong: ${JSON.stringify(status.upgrades)}`);
    for (const [orderId, lineId, variant, cents] of [[thickOrder, thickLine, thick, thickCents], [thinOrder, thinLine, thin, thinCents]] as const) {
      await sql`INSERT INTO ordering_orders(id,business,source,customer_id,status,payment_status,service_type,display_number,created_by,subtotal_cents,total_cents,amount_due_cents,gross_base_merchandise_cents,net_merchandise_cents) VALUES(${orderId},'Corner Deli','pos',${customerId},'draft','unpaid','pickup',${`LOY-CAP-${orderId.slice(0, 8)}`},'validator',${cents},${cents},${cents},${cents},${cents})`;
      await sql`INSERT INTO ordering_order_items(id,order_id,item_id,variant_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents,sort_order) VALUES(${lineId},${orderId},${variant.item_id},${variant.id},'Reward pizza',1,${cents},${cents},0)`;
    }
    const thickApplied = await requestLoyaltyRedemption({ orderId: thickOrder, orderItemId: thickLine, programId, actor: manager });
    if (Number(thickApplied[0]?.discount_cents) !== thinCents) throw new Error(`Thick reward should take off the Thin price: ${thickApplied[0]?.discount_cents}`);
    const thickTotal = Number((await sql`SELECT total_cents FROM ordering_orders WHERE id=${thickOrder}`)[0].total_cents);
    if (thickTotal !== thickCents - thinCents) throw new Error(`Thick upgrade should cost the difference, got ${thickTotal}`);
    const thinApplied = await requestLoyaltyRedemption({ orderId: thinOrder, orderItemId: thinLine, programId, actor: manager });
    if (Number(thinApplied[0]?.discount_cents) !== thinCents) throw new Error("Thin reward should be free.");
    console.log(JSON.stringify({ thinCents, thickCents, thickRewardDiscount: thinCents, thickCustomerPays: thickTotal, thinRewardFree: true, upgradeHint: status.upgrades[0] }, null, 2));
  } finally {
    await sql`DELETE FROM ordering_order_loyalty_applications WHERE program_id=${programId}`;
    await sql`DELETE FROM ordering_loyalty_ledger WHERE program_id=${programId}`;
    await sql`DELETE FROM ordering_orders WHERE id IN(${thickOrder},${thinOrder})`;
    await sql`DELETE FROM ordering_customers WHERE id=${customerId}`;
    await sql`DELETE FROM ordering_loyalty_programs WHERE id=${programId}`;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
