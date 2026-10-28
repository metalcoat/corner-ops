import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";
import { applyPromotionsToOrder } from "@/lib/ordering-promotions";
import { recalculateLoyaltyOrder } from "@/lib/ordering-loyalty";
import { sendTransactionalSms } from "@/lib/sms-notifications";
import {
  pointsBonusApplies,
  pointsEarnRate,
  pointsForCents,
  pointsRewardDiscount,
  type PointsLine,
  type PointsRewardRule,
  type PointsSettings,
} from "@/lib/ordering-points-rules";

// Points rewards: earn on nearly every order, spend on a reward menu. Tables come
// from db/migrations/0025_points_rewards.sql; the item-count loyalty programs in
// ordering-loyalty.ts run alongside and are unaffected.

type Row = Record<string, unknown>;
const EARNING_STATUSES = ["sent_to_kitchen", "in_progress", "ready", "completed"];

export type PointsReward = { id: string; label: string; points: number; kind: "item" | "modifier" | "upgrade"; itemIds: string[]; variantIds: string[]; optionIds: string[] };
export type PointsStatus = { active: boolean; balance: number; rewards: PointsReward[]; bonus: { multiplier: number; days: number[]; start: string; end: string }; onlineRate: number; storeRate: number };

function settingsFrom(row: Row | undefined): PointsSettings {
  return {
    active: Boolean(row?.active),
    onlineRate: Number(row?.online_rate ?? 1.1),
    storeRate: Number(row?.store_rate ?? 1),
    staffPhoneOrdersEarn: row?.staff_phone_orders_earn !== false,
    bonusMultiplier: Number(row?.bonus_multiplier ?? 2),
    bonusDays: ((row?.bonus_days as number[] | undefined) ?? [1, 2]).map(Number),
    bonusStart: String(row?.bonus_start ?? "10:30").slice(0, 5),
    bonusEnd: String(row?.bonus_end ?? "14:00").slice(0, 5),
    expiryMonths: Number(row?.expiry_months ?? 12),
  };
}

export async function pointsSettings(business = "Corner Deli"): Promise<PointsSettings> {
  return settingsFrom((await getSql()`SELECT * FROM ordering_points_settings WHERE business=${business}`)[0]);
}

export async function pointsRewards(business = "Corner Deli", includeInactive = false) {
  return getSql()`SELECT * FROM ordering_points_rewards WHERE business=${business} AND (active OR ${includeInactive}) ORDER BY points,sort_order,label`;
}

/** The customer's balance after expiring points that sat 12 months (configurable) with no orders. */
export async function pointsBalance(customerId: string, business = "Corner Deli", settings?: PointsSettings): Promise<number> {
  const sql = getSql();
  const config = settings || (await pointsSettings(business));
  const [row] = await sql`SELECT COALESCE(SUM(points),0) balance,MAX(created_at) FILTER (WHERE entry_type IN ('earn','redeem')) last_activity FROM ordering_points_ledger WHERE customer_id=${customerId} AND business=${business}`;
  let balance = Number(row?.balance || 0);
  const last = row?.last_activity ? new Date(String(row.last_activity)) : null;
  if (balance > 0 && last && config.expiryMonths > 0) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - config.expiryMonths);
    if (last < cutoff) {
      const reason = `No orders for ${config.expiryMonths} months`;
      await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,entry_type,points,reason,description,created_by,metadata) VALUES(${randomUUID()},${business},${customerId},'expiry',${-balance},${reason},'Points expired','system',${JSON.stringify({ lastActivity: last.toISOString() })}::jsonb)`;
      balance = 0;
    }
  }
  return Math.round(balance * 10) / 10;
}

export async function pointsStatus(customerId: string, business = "Corner Deli"): Promise<PointsStatus> {
  const settings = await pointsSettings(business);
  const ids = (value: unknown) => ((value as string[] | null) || []).map(String);
  const rewards = (await pointsRewards(business)).map((row) => ({ id: String(row.id), label: String(row.label), points: Number(row.points), kind: row.kind as PointsReward["kind"], itemIds: ids(row.item_ids), variantIds: ids(row.variant_ids), optionIds: ids(row.option_ids) }));
  return {
    active: settings.active,
    balance: settings.active && customerId ? await pointsBalance(customerId, business, settings) : 0,
    rewards: settings.active ? rewards : [],
    bonus: { multiplier: settings.bonusMultiplier, days: settings.bonusDays, start: settings.bonusStart, end: settings.bonusEnd },
    onlineRate: settings.onlineRate,
    storeRate: settings.storeRate,
  };
}

export async function pointsHistory(customerId: string, limit = 12) {
  return getSql()`SELECT ledger.id,ledger.entry_type,ledger.points,ledger.reason,ledger.description,ledger.created_by,ledger.created_at,orders.display_number FROM ordering_points_ledger ledger LEFT JOIN ordering_orders orders ON orders.id=ledger.order_id WHERE ledger.customer_id=${customerId} ORDER BY ledger.created_at DESC,ledger.id LIMIT ${Math.max(1, Math.min(100, limit))}`;
}

async function orderLines(orderId: string): Promise<Array<PointsLine & { id: string; promoted: boolean; loyaltyCents: number; pointsCents: number }>> {
  const sql = getSql();
  const lines = await sql`
    SELECT line.id,line.item_id,line.variant_id,line.unit_price_cents,line.line_total_cents,line.sort_order,
      EXISTS(SELECT 1 FROM ordering_order_promotion_allocations allocation JOIN ordering_order_promotion_applications application ON application.id=allocation.application_id WHERE application.order_id=line.order_id AND allocation.order_item_id=line.id AND allocation.discount_cents>0) promoted,
      COALESCE((SELECT SUM(discount_cents) FROM ordering_order_loyalty_applications app WHERE app.order_item_id=line.id),0) loyalty_cents,
      COALESCE((SELECT SUM(discount_cents) FROM ordering_order_points_redemptions points WHERE points.order_item_id=line.id),0) points_cents
    FROM ordering_order_items line WHERE line.order_id=${orderId} ORDER BY line.sort_order,line.created_at,line.id`;
  const modifiers = lines.length
    ? await sql`SELECT order_item_id,option_id,unit_price_delta_cents,pizza_topping_amount FROM ordering_order_item_modifiers WHERE order_item_id=ANY(${lines.map((line) => String(line.id))}::uuid[]) AND selection_state IN ('selected','extra') ORDER BY unit_price_delta_cents DESC,created_at,id`
    : [];
  return lines.map((line) => ({
    id: String(line.id),
    itemId: String(line.item_id),
    variantId: line.variant_id ? String(line.variant_id) : null,
    unitPriceCents: Number(line.unit_price_cents),
    lineTotalCents: Number(line.line_total_cents),
    otherDiscountCents: Number(line.loyalty_cents) + Number(line.points_cents),
    promoted: Boolean(line.promoted),
    loyaltyCents: Number(line.loyalty_cents),
    pointsCents: Number(line.points_cents),
    modifiers: modifiers.filter((row) => String(row.order_item_id) === String(line.id)).map((row) => ({ optionId: String(row.option_id), unitPriceDeltaCents: Number(row.unit_price_delta_cents), pizzaToppingAmount: row.pizza_topping_amount ? String(row.pizza_topping_amount) : null })),
  }));
}

async function rewardRule(reward: Row): Promise<PointsRewardRule> {
  let fromVariantPriceCents: number | null = null;
  if (reward.kind === "upgrade" && reward.from_variant_id) {
    const [variant] = await getSql()`SELECT base_price_cents FROM ordering_menu_item_variants WHERE id=${String(reward.from_variant_id)}`;
    fromVariantPriceCents = variant ? Number(variant.base_price_cents) : null;
  }
  const ids = (value: unknown) => ((value as string[] | null) || []).map(String);
  return { kind: reward.kind as PointsRewardRule["kind"], itemIds: ids(reward.item_ids), variantIds: ids(reward.variant_ids), optionIds: ids(reward.option_ids), fromVariantPriceCents };
}

/**
 * Earns points for an order that reached the kitchen (or completed, for orders
 * paid at the end). Idempotent: one earn entry per order. Discounted lines,
 * items bought with points or a loyalty reward, tax, tips and fees don't earn.
 */
export async function earnPointsForOrder(orderId: string, actor: OrderingActor) {
  const sql = getSql();
  const [order] = await sql`SELECT id,business,customer_id,source,order_origin,payment_status,status,caller_phone,scheduled_for,created_at,created_by FROM ordering_orders WHERE id=${orderId}`;
  if (!order?.customer_id || !EARNING_STATUSES.includes(String(order.status))) return;
  if ((await sql`SELECT 1 FROM ordering_points_ledger WHERE order_id=${orderId} AND entry_type='earn'`)[0]) return;
  const settings = await pointsSettings(String(order.business));
  const phones = (await sql`SELECT normalized_phone FROM ordering_customer_phones WHERE customer_id=${String(order.customer_id)}`).map((row) => String(row.normalized_phone));
  const rate = pointsEarnRate({ source: String(order.source), orderOrigin: String(order.order_origin || ""), paymentStatus: String(order.payment_status || ""), callerPhone: String(order.caller_phone || ""), customerPhones: phones }, settings);
  if (!rate) return;
  const lines = await orderLines(orderId);
  const eligibleCents = lines.filter((line) => !line.promoted && !line.loyaltyCents).reduce((sum, line) => sum + Math.max(0, line.lineTotalCents - line.pointsCents), 0);
  const orderFor = new Date(String(order.scheduled_for || order.created_at));
  const bonus = pointsBonusApplies(orderFor, settings);
  const points = pointsForCents(eligibleCents, rate, bonus ? settings.bonusMultiplier : 1);
  if (!points) return;
  await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,order_id,entry_type,points,description,created_by,metadata) VALUES(${randomUUID()},${order.business},${order.customer_id},${orderId},'earn',${points},${bonus ? "Order points (lunch bonus)" : "Order points"},${actor.id},${JSON.stringify({ eligibleCents, rate, bonus, multiplier: bonus ? settings.bonusMultiplier : 1, source: order.source, orderOrigin: order.order_origin, orderCreatedBy: order.created_by, actorName: actor.name, actorType: actor.type })}::jsonb) ON CONFLICT DO NOTHING`;
}

const codeDigest = (orderId: string, code: string) => createHmac("sha256", process.env.SESSION_SECRET || "").update(`points:${orderId}:${code}`).digest("hex");
const sameDigest = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };

/**
 * Dev-only test option for the POS redemption code: when POINTS_REDEEM_CODES_ON_SCREEN=true
 * and no Telnyx settings exist, the code is returned to the POS screen instead of texted.
 * Separate from DEV_SHOW_SMS_CODES and never on where texting is configured.
 */
export function pointsCodesShownOnScreen(env: Record<string, string | undefined> = process.env): boolean {
  return env.POINTS_REDEEM_CODES_ON_SCREEN?.trim() === "true" && !env.TELNYX_API_KEY?.trim() && env.APP_ENV?.trim().toLowerCase() !== "production";
}

async function draftOrder(orderId: string) {
  const [order] = await getSql()`SELECT id,business,customer_id,status FROM ordering_orders WHERE id=${orderId}`;
  if (!order || order.status !== "draft") throw new Error("Points can only be used on an order that hasn't been sent yet.");
  if (!order.customer_id) throw new Error("Attach the customer before using points.");
  return order;
}

/** Texts a one-time code to the phone on the customer's account so staff can spend their points. */
export async function requestPointsRedeemCode(orderId: string, actor: OrderingActor) {
  const sql = getSql();
  const order = await draftOrder(orderId);
  const [phone] = await sql`SELECT normalized_phone,display_phone FROM ordering_customer_phones WHERE customer_id=${String(order.customer_id)} ORDER BY is_primary DESC,created_at LIMIT 1`;
  if (!phone?.normalized_phone) throw new Error("This customer has no phone number on their account, so points can't be used.");
  const [recent] = await sql`SELECT COUNT(*)::integer count FROM ordering_points_redeem_codes WHERE customer_id=${String(order.customer_id)} AND created_at>NOW()-INTERVAL '15 minutes'`;
  if (Number(recent?.count || 0) >= 3) throw new Error("Too many codes sent. Wait 15 minutes and try again.");
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  await sql`INSERT INTO ordering_points_redeem_codes(id,order_id,customer_id,normalized_phone,code_hash,expires_at,requested_by) VALUES(${randomUUID()},${orderId},${order.customer_id},${phone.normalized_phone},${codeDigest(orderId, code)},NOW()+INTERVAL '10 minutes',${actor.id})`;
  const last4 = String(phone.normalized_phone).slice(-4);
  if (pointsCodesShownOnScreen()) return { sent: true, last4, testCode: code };
  await sendTransactionalSms(String(phone.normalized_phone), `Corner Deli: your code to use your reward points is ${code}. Only share it with the person taking your order. It expires in 10 minutes.`);
  return { sent: true, last4 };
}

export async function verifyPointsRedeemCode(orderId: string, code: string, actor: OrderingActor) {
  const sql = getSql();
  const order = await draftOrder(orderId);
  const digits = code.replace(/\D/g, "");
  if (!/^\d{6}$/.test(digits)) throw new Error("Enter the 6-digit code.");
  const [row] = await sql`UPDATE ordering_points_redeem_codes SET attempts=attempts+1 WHERE id=(SELECT id FROM ordering_points_redeem_codes WHERE order_id=${orderId} AND customer_id=${String(order.customer_id)} AND verified_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1) AND attempts<5 RETURNING *`;
  if (!row || !sameDigest(String(row.code_hash), codeDigest(orderId, digits))) throw new Error("The code is incorrect or expired.");
  await sql`UPDATE ordering_points_redeem_codes SET verified_at=NOW(),verified_by=${actor.id} WHERE id=${String(row.id)} AND verified_at IS NULL`;
  return { verified: true };
}

async function codeVerified(orderId: string, customerId: string) {
  return Boolean((await getSql()`SELECT 1 FROM ordering_points_redeem_codes WHERE order_id=${orderId} AND customer_id=${customerId} AND verified_at IS NOT NULL AND verified_at>NOW()-INTERVAL '2 hours' LIMIT 1`)[0]);
}

export async function pointsCodeVerified(orderId: string) {
  const [order] = await getSql()`SELECT customer_id FROM ordering_orders WHERE id=${orderId}`;
  return Boolean(order?.customer_id) && codeVerified(orderId, String(order.customer_id));
}

/**
 * Applies a points reward to the first matching line of a draft order. Online the
 * customer must be signed in (checked by the route); staff must first verify the
 * texted code. Points come off the balance when the order is sent (finalize).
 */
export async function requestPointsRedemption(input: { orderId: string; rewardId: string; actor: OrderingActor; channel: "web" | "pos"; orderItemId?: string }) {
  const sql = getSql();
  const order = await draftOrder(input.orderId);
  const customerId = String(order.customer_id);
  const settings = await pointsSettings(String(order.business));
  if (!settings.active) throw new Error("Points rewards aren't turned on.");
  if (input.channel === "pos" && !(await codeVerified(input.orderId, customerId))) throw new Error("Text the customer a code and enter it before using their points.");
  const [reward] = await sql`SELECT * FROM ordering_points_rewards WHERE id=${input.rewardId} AND business=${String(order.business)} AND active=TRUE`;
  if (!reward) throw new Error("That reward is unavailable.");
  const [pending] = await sql`SELECT COALESCE(SUM(points),0) points FROM ordering_order_points_redemptions WHERE order_id=${input.orderId} AND ledger_event_id IS NULL`;
  const balance = await pointsBalance(customerId, String(order.business), settings);
  if (balance - Number(pending?.points || 0) < Number(reward.points)) throw new Error(`Not enough points: this reward needs ${reward.points} and the customer has ${Math.floor(balance - Number(pending?.points || 0))} available.`);
  const rule = await rewardRule(reward);
  const used = new Set((await sql`SELECT order_item_id FROM ordering_order_points_redemptions WHERE order_id=${input.orderId} AND reward_id=${input.rewardId}`).map((row) => String(row.order_item_id)));
  const lines = (await orderLines(input.orderId)).filter((line) => !used.has(line.id) && (!input.orderItemId || line.id === input.orderItemId));
  const match = lines.map((line) => ({ line, discount: pointsRewardDiscount(rule, line) })).find((candidate) => candidate.discount > 0);
  if (!match) throw new Error(`Add the item for "${reward.label}" to the order first.`);
  await sql`INSERT INTO ordering_order_points_redemptions(id,order_id,order_item_id,customer_id,reward_id,label_snapshot,points,discount_cents,requested_by,channel) VALUES(${randomUUID()},${input.orderId},${match.line.id},${customerId},${String(reward.id)},${String(reward.label)},${Number(reward.points)},${match.discount},${input.actor.id},${input.channel}) ON CONFLICT DO NOTHING`;
  await recalculateLoyaltyOrder(input.orderId);
  await applyPromotionsToOrder(input.orderId);
  return recalculateLoyaltyOrder(input.orderId);
}

export async function removePointsRedemption(orderId: string, redemptionId: string) {
  await draftOrder(orderId);
  await getSql()`DELETE FROM ordering_order_points_redemptions WHERE id=${redemptionId} AND order_id=${orderId} AND ledger_event_id IS NULL`;
  await recalculateLoyaltyOrder(orderId);
  await applyPromotionsToOrder(orderId);
  return recalculateLoyaltyOrder(orderId);
}

/** Takes the points off the balance when the order is sent; fails if the balance no longer covers them. */
export async function finalizePointsRedemptions(orderId: string) {
  const sql = getSql();
  const redemptions = await sql`SELECT redemption.*,orders.business FROM ordering_order_points_redemptions redemption JOIN ordering_orders orders ON orders.id=redemption.order_id WHERE redemption.order_id=${orderId} AND redemption.ledger_event_id IS NULL FOR UPDATE OF redemption`;
  if (!redemptions.length) return;
  const customerId = String(redemptions[0].customer_id), business = String(redemptions[0].business);
  const needed = redemptions.reduce((sum, row) => sum + Number(row.points), 0);
  if ((await pointsBalance(customerId, business)) < needed) throw new Error("The customer no longer has enough points for the rewards on this order.");
  for (const row of redemptions) {
    const eventId = randomUUID();
    await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,order_id,entry_type,points,description,created_by,metadata) VALUES(${eventId},${business},${customerId},${orderId},'redeem',${-Number(row.points)},${String(row.label_snapshot)},${String(row.requested_by)},${JSON.stringify({ redemptionId: row.id, rewardId: row.reward_id, discountCents: Number(row.discount_cents), channel: row.channel })}::jsonb)`;
    await sql`UPDATE ordering_order_points_redemptions SET ledger_event_id=${eventId} WHERE id=${String(row.id)}`;
  }
}

/** A voided order gives back points spent and takes back points earned. Idempotent. */
export async function reversePointsForOrder(orderId: string, actor: OrderingActor, reason: string) {
  const sql = getSql();
  const events = await sql`SELECT * FROM ordering_points_ledger WHERE order_id=${orderId} AND entry_type IN ('earn','redeem')`;
  for (const event of events)
    await sql`INSERT INTO ordering_points_ledger(id,business,customer_id,order_id,entry_type,points,related_event_id,reason,description,created_by,metadata) VALUES(${randomUUID()},${event.business},${event.customer_id},${orderId},'reversal',${-Number(event.points)},${event.id},${reason},${String(event.description)},${actor.id},${JSON.stringify({ reversedEventType: event.entry_type })}::jsonb) ON CONFLICT DO NOTHING`;
}

export async function adjustPoints(input: { customerId: string; points: number; reason: string; actor: OrderingActor; business?: string }) {
  if (!canManagePos(input.actor)) throw new Error("Manager or owner authorization is required.");
  const points = Math.round(Number(input.points) * 10) / 10;
  if (!Number.isFinite(points) || !points) throw new Error("Adjustment must be a non-zero number of points.");
  if (input.reason.trim().length < 3) throw new Error("An adjustment reason is required.");
  const business = input.business || "Corner Deli";
  const [customer] = await getSql()`SELECT id FROM ordering_customers WHERE id=${input.customerId} AND business=${business} AND active=TRUE`;
  if (!customer) throw new Error("Customer was not found.");
  await getSql()`INSERT INTO ordering_points_ledger(id,business,customer_id,entry_type,points,reason,description,created_by,metadata) VALUES(${randomUUID()},${business},${input.customerId},'adjustment',${points},${input.reason.trim()},'Manager adjustment',${input.actor.id},${JSON.stringify({ actorName: input.actor.name, actorRole: input.actor.role })}::jsonb)`;
  return pointsStatus(input.customerId, business);
}

/** Points rewards already applied to a draft order, for the order screens. */
export async function orderPointsRedemptions(orderId: string) {
  return getSql()`SELECT id,label_snapshot label,points,discount_cents,order_item_id FROM ordering_order_points_redemptions WHERE order_id=${orderId} ORDER BY applied_at,id`;
}
