import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

// Points rewards against the local dev database: earning by channel, the lunch bonus,
// caller-ID-only phone earning, discounted lines, the texted code gate for staff,
// spending, voids and expiry. Everything it creates is removed afterwards.
loadEnvFile("/opt/corner-ops/.env");
const address = execFileSync("docker", ["inspect", "corner-ops-postgres", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"], { encoding: "utf8" }).trim();
if (process.env.LOCAL_DEVELOPMENT?.toLowerCase() !== "true" || !process.env.POSTGRES_PASSWORD || !/^172\.|^10\.|^192\.168\./.test(address)) throw new Error("Points validation requires private local PostgreSQL.");
process.env.DATABASE_DRIVER = "postgres";
process.env.DATABASE_URL = `postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;
process.env.VALIDATION_DISABLE_OUTBOUND = "1";
process.env.POINTS_REDEEM_CODES_ON_SCREEN = "true";
delete process.env.TELNYX_API_KEY;

function check(condition: unknown, message: string) { if (!condition) throw new Error(message); }

async function main() {
  const { getSql } = await import("../src/lib/db");
  const points = await import("../src/lib/ordering-points");
  const sql = getSql();
  const staff = { id: "points-validator", name: "Points Validator", type: "employee" as const, role: "manager" as const };
  const [before] = await sql`SELECT * FROM ordering_points_settings WHERE business='Corner Deli'`;
  const [fries] = await sql`SELECT id,base_price_cents FROM ordering_menu_items WHERE business='Corner Deli' AND active AND name='Small French Fries' LIMIT 1`;
  const [friesReward] = await sql`SELECT id,points FROM ordering_points_rewards WHERE business='Corner Deli' AND reward_key='small-fries'`;
  check(fries && friesReward, "Small French Fries and its reward are required.");
  const customerId = randomUUID(), phone = "+13155550142", orders: string[] = [];
  async function order(input: { source: string; origin: string; cents: number; status?: string; paid?: boolean; caller?: string; at: string; promoted?: boolean }) {
    const id = randomUUID(), line = randomUUID();
    orders.push(id);
    await sql`INSERT INTO ordering_orders(id,business,source,order_origin,customer_id,status,payment_status,service_type,display_number,created_by,subtotal_cents,total_cents,amount_due_cents,caller_phone,scheduled_for,created_at) VALUES(${id},'Corner Deli',${input.source},${input.origin},${customerId},${input.status || "sent_to_kitchen"},${input.paid ? "paid" : "unpaid"},'pickup',${`PTS-${id.slice(0, 8)}`},'validator',${input.cents},${input.cents},${input.cents},${input.caller || ""},${input.at},${input.at})`;
    await sql`INSERT INTO ordering_order_items(id,order_id,item_id,item_name_snapshot,quantity,unit_price_cents,line_total_cents,sort_order) VALUES(${line},${id},${fries.id},'Points fixture',1,${input.cents},${input.cents},0)`;
    if (input.promoted) {
      const app = randomUUID();
      const [promotion] = await sql`SELECT id FROM ordering_promotions WHERE business='Corner Deli' LIMIT 1`;
      await sql`INSERT INTO ordering_order_promotion_applications(id,order_id,promotion_id,promotion_version,application_sequence,label_snapshot,configuration_snapshot,normal_base_subtotal_cents,resulting_base_subtotal_cents,discount_cents) VALUES(${app},${id},${promotion.id},1,1,'Fixture promo','{}'::jsonb,${input.cents},${input.cents - 100},100)`;
      await sql`INSERT INTO ordering_order_promotion_allocations(id,application_id,order_item_id,consumed_quantity,normal_base_cents,discount_cents) VALUES(${randomUUID()},${app},${line},1,${input.cents},100)`;
    }
    return { id, line };
  }
  const earned = async (orderId: string) => Number((await sql`SELECT COALESCE(SUM(points),0) points FROM ordering_points_ledger WHERE order_id=${orderId} AND entry_type='earn'`)[0].points);
  const wednesday = "2026-11-04T17:00:00Z", mondayLunch = "2026-11-02T16:00:00Z";
  const result: Record<string, unknown> = {};
  try {
    await sql`UPDATE ordering_points_settings SET active=TRUE,online_rate=1.1,store_rate=1,staff_phone_orders_earn=TRUE,bonus_multiplier=2,bonus_days='{1,2}',bonus_start='10:30',bonus_end='14:00',expiry_months=12 WHERE business='Corner Deli'`;
    await sql`INSERT INTO ordering_customers(id,business,display_name,first_name) VALUES(${customerId},'Corner Deli','Points Validator','Points')`;
    await sql`INSERT INTO ordering_customer_phones(id,customer_id,normalized_phone,display_phone,label,is_primary) VALUES(${randomUUID()},${customerId},${phone},'(315) 555-0142','Mobile',TRUE)`;

    const web = await order({ source: "web", origin: "web", cents: 2000, at: wednesday });
    await points.earnPointsForOrder(web.id, staff); await points.earnPointsForOrder(web.id, staff);
    check((await earned(web.id)) === 22, `Online $20 should earn 22 points once, got ${await earned(web.id)}`);
    const lunch = await order({ source: "web", origin: "web", cents: 2000, at: mondayLunch });
    await points.earnPointsForOrder(lunch.id, staff);
    check((await earned(lunch.id)) === 44, "Monday lunch should double online points to 44.");
    const counter = await order({ source: "pos", origin: "pos", cents: 1000, at: wednesday });
    await points.earnPointsForOrder(counter.id, staff);
    check((await earned(counter.id)) === 10, "In-store $10 should earn 10 points.");
    const aiMatch = await order({ source: "ai_phone", origin: "ai", cents: 1000, caller: phone, at: wednesday });
    const aiOther = await order({ source: "ai_phone", origin: "ai", cents: 1000, caller: "+13155550999", at: wednesday });
    const aiBlocked = await order({ source: "ai_phone", origin: "ai", cents: 1000, at: wednesday });
    for (const row of [aiMatch, aiOther, aiBlocked]) await points.earnPointsForOrder(row.id, staff);
    check((await earned(aiMatch.id)) === 10 && (await earned(aiOther.id)) === 0 && (await earned(aiBlocked.id)) === 0, "AI phone should earn only for the caller-ID account.");
    const staffPhone = await order({ source: "pos", origin: "phone", cents: 1000, at: wednesday });
    await points.earnPointsForOrder(staffPhone.id, staff);
    check((await earned(staffPhone.id)) === 0, "Unpaid staff phone order must not earn.");
    await sql`UPDATE ordering_orders SET payment_status='paid',status='completed' WHERE id=${staffPhone.id}`;
    await points.earnPointsForOrder(staffPhone.id, staff);
    check((await earned(staffPhone.id)) === 10, "Paid staff phone order should earn.");
    const promoted = await order({ source: "web", origin: "web", cents: 1500, at: wednesday, promoted: true });
    await points.earnPointsForOrder(promoted.id, staff);
    check((await earned(promoted.id)) === 0, "Discounted lines must not earn.");
    const balance = await points.pointsBalance(customerId);
    check(balance === 96, `Balance should be 96, got ${balance}`);
    result.earning = { online20: 22, mondayLunchOnline20: 44, inStore10: 10, aiCallerMatch: 10, aiOtherCaller: 0, aiBlocked: 0, staffPhoneUnpaid: 0, staffPhonePaid: 10, discounted: 0, balance };

    const draft = await order({ source: "pos", origin: "phone", cents: Number(fries.base_price_cents), status: "draft", at: wednesday });
    let blocked = false;
    try { await points.requestPointsRedemption({ orderId: draft.id, rewardId: String(friesReward.id), actor: staff, channel: "pos" }); } catch { blocked = true; }
    check(blocked, "Staff must not spend points without the texted code.");
    const sent = await points.requestPointsRedeemCode(draft.id, staff);
    check(sent.last4 === "0142" && sent.testCode, "Code should go to the account phone.");
    let wrong = false;
    try { await points.verifyPointsRedeemCode(draft.id, sent.testCode === "000000" ? "111111" : "000000", staff); } catch { wrong = true; }
    check(wrong, "A wrong code must be rejected.");
    await points.verifyPointsRedeemCode(draft.id, String(sent.testCode), staff);
    await points.requestPointsRedemption({ orderId: draft.id, rewardId: String(friesReward.id), actor: staff, channel: "pos" });
    const [priced] = await sql`SELECT total_cents,loyalty_discount_cents FROM ordering_orders WHERE id=${draft.id}`;
    check(Number(priced.loyalty_discount_cents) === Number(fries.base_price_cents) && Number(priced.total_cents) === 0, "Free fries should take the whole price off.");
    await sql`UPDATE ordering_orders SET status='sent_to_kitchen' WHERE id=${draft.id}`;
    await points.finalizePointsRedemptions(draft.id); await points.finalizePointsRedemptions(draft.id);
    check((await points.pointsBalance(customerId)) === 96 - Number(friesReward.points), "Spending should take the reward's points once.");
    await points.reversePointsForOrder(web.id, staff, "Validator void"); await points.reversePointsForOrder(web.id, staff, "Validator void again");
    await points.reversePointsForOrder(draft.id, staff, "Validator void");
    check((await points.pointsBalance(customerId)) === 96 - 22, "Voids should take back earned points and return spent ones, once.");
    result.spending = { codeRequired: true, wrongCodeRejected: true, freeFriesDiscountCents: Number(fries.base_price_cents), pointsSpent: Number(friesReward.points), voidsReversed: true };

    await sql`UPDATE ordering_points_ledger SET created_at=NOW()-INTERVAL '13 months' WHERE customer_id=${customerId}`;
    check((await points.pointsBalance(customerId)) === 0, "Points should expire after 12 months with no orders.");
    result.expiry = { after13MonthsIdle: 0 };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await sql`DELETE FROM ordering_points_redeem_codes WHERE customer_id=${customerId}`;
    await sql`DELETE FROM ordering_order_points_redemptions WHERE customer_id=${customerId}`;
    await sql`DELETE FROM ordering_points_ledger WHERE customer_id=${customerId}`;
    if (orders.length) await sql`DELETE FROM ordering_orders WHERE id=ANY(${orders}::uuid[])`;
    await sql`DELETE FROM ordering_customer_phones WHERE customer_id=${customerId}`;
    await sql`DELETE FROM ordering_customers WHERE id=${customerId}`;
    if (before) await sql`UPDATE ordering_points_settings SET active=${before.active},online_rate=${before.online_rate},store_rate=${before.store_rate},staff_phone_orders_earn=${before.staff_phone_orders_earn},bonus_multiplier=${before.bonus_multiplier},bonus_days=${before.bonus_days},bonus_start=${before.bonus_start},bonus_end=${before.bonus_end},expiry_months=${before.expiry_months} WHERE business='Corner Deli'`;
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
