import { STORE_TIME_ZONE } from "./business-day";

// Pure rules for the points program, kept free of database access so they can be unit tested.

export type PointsSettings = {
  active: boolean;
  onlineRate: number;
  storeRate: number;
  staffPhoneOrdersEarn: boolean;
  bonusMultiplier: number;
  bonusDays: number[];
  bonusStart: string;
  bonusEnd: string;
  expiryMonths: number;
};

export type PointsOrderFacts = {
  source: string;
  orderOrigin: string;
  paymentStatus: string;
  callerPhone: string;
  customerPhones: string[];
};

const digits = (phone: string) => phone.replace(/\D/g, "").slice(-10);

/**
 * Points earned per $1 of food for this order, or 0 when it must not earn:
 * - online orders earn the online rate;
 * - AI phone orders earn only when the order's customer owns the incoming caller ID
 *   (blocked or unknown caller ID earns nothing; a number spoken on the call never counts);
 * - staff-taken phone orders on the POS earn only when the setting allows it and the order is paid;
 * - other POS orders earn the store rate.
 */
export function pointsEarnRate(order: PointsOrderFacts, settings: PointsSettings): number {
  if (!settings.active) return 0;
  if (order.source === "web") return settings.onlineRate;
  if (order.source === "ai_phone") {
    const caller = digits(order.callerPhone);
    return caller.length === 10 && order.customerPhones.some((phone) => digits(phone) === caller) ? settings.storeRate : 0;
  }
  if (order.source === "pos" && order.orderOrigin === "phone")
    return settings.staffPhoneOrdersEarn && order.paymentStatus === "paid" ? settings.storeRate : 0;
  if (order.source === "pos") return settings.storeRate;
  return 0;
}

const timeToMinutes = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
};

/** Whether the bonus window covers the time the order is for (pickup/delivery time), in store time. */
export function pointsBonusApplies(orderFor: Date, settings: PointsSettings): boolean {
  if (settings.bonusMultiplier <= 1 || !settings.bonusDays.length) return false;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: STORE_TIME_ZONE, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(orderFor);
  const part = (type: string) => parts.find((row) => row.type === type)?.value || "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  return settings.bonusDays.includes(day) && minutes >= timeToMinutes(settings.bonusStart) && minutes < timeToMinutes(settings.bonusEnd);
}

/** Points for a food amount, rounded down to a tenth of a point. */
export function pointsForCents(eligibleCents: number, rate: number, multiplier = 1): number {
  if (eligibleCents <= 0 || rate <= 0) return 0;
  return Math.floor((eligibleCents * rate * multiplier) / 10) / 10;
}

export type PointsRewardRule = {
  kind: "item" | "modifier" | "upgrade";
  itemIds: string[];
  variantIds: string[];
  optionIds: string[];
  fromVariantPriceCents: number | null;
};

export type PointsLine = {
  itemId: string;
  variantId: string | null;
  unitPriceCents: number;
  lineTotalCents: number;
  otherDiscountCents: number;
  modifiers: Array<{ optionId: string; unitPriceDeltaCents: number; pizzaToppingAmount: string | null }>;
};

/** What a reward takes off one cart line; 0 when the line doesn't match the reward. */
export function pointsRewardDiscount(rule: PointsRewardRule, line: PointsLine): number {
  let discount = 0;
  if (rule.kind === "item") {
    if (!rule.itemIds.includes(line.itemId)) return 0;
    if (rule.variantIds.length && !(line.variantId && rule.variantIds.includes(line.variantId))) return 0;
    discount = line.unitPriceCents;
  } else if (rule.kind === "upgrade") {
    if (!line.variantId || !rule.variantIds.includes(line.variantId) || rule.fromVariantPriceCents == null) return 0;
    discount = line.unitPriceCents - rule.fromVariantPriceCents;
  } else {
    // One regular portion of the first matching paid add-on (an extra/double portion still charges the rest).
    for (const modifier of line.modifiers) {
      if (!rule.optionIds.includes(modifier.optionId) || modifier.unitPriceDeltaCents <= 0) continue;
      const amount = modifier.pizzaToppingAmount || "";
      const multiplier = amount === "triple_extra" ? 4 : amount === "double_extra" ? 3 : amount === "extra" ? 2 : 1;
      discount = Math.floor(modifier.unitPriceDeltaCents / multiplier);
      break;
    }
  }
  return Math.max(0, Math.min(discount, line.lineTotalCents - line.otherDiscountCents));
}

/** Whether a reward could apply to something in the cart (the server makes the final check). */
export function pointsRewardFitsCart(reward: { kind: string; itemIds: string[]; variantIds: string[]; optionIds: string[] }, lines: Array<{ itemId: string; variantId: string | null; optionIds: string[] }>): boolean {
  return lines.some((line) => {
    if (reward.kind === "item") return reward.itemIds.includes(line.itemId) && (!reward.variantIds.length || Boolean(line.variantId && reward.variantIds.includes(line.variantId)));
    if (reward.kind === "upgrade") return Boolean(line.variantId && reward.variantIds.includes(line.variantId));
    return line.optionIds.some((id) => reward.optionIds.includes(id));
  });
}
