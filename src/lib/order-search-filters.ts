/** Manager order search filters, read from the query string (no database here, so tests can load it). */
export const ORDER_SEARCH_MAX_DAYS = 366;
export const ORDER_SEARCH_PRESETS = [1, 7, 30, 90] as const;

export type OrderSearchFilters = {
  from: string; to: string;
  name: string; last4: string; address: string; phone: string; number: string;
  serviceType: "" | "pickup" | "delivery" | "dine_in";
  channel: "" | "pos" | "web" | "ai_phone";
  payment: "" | "paid" | "owes" | "refunded" | "voided";
  tender: "" | "cash" | "card" | "other";
};

export class OrderSearchInputError extends Error {}

const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const shiftDate = (date: string, days: number) => { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); };
const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | "" => (allowed as readonly string[]).includes(value || "") ? (value as T) : "";

/** Reads the search query string; `days` (1 = today, 7, 30, 90) wins over from/to, and no dates means the last 7 days. */
export function parseOrderSearch(params: URLSearchParams, today: string): OrderSearchFilters {
  const days = Number(params.get("days") || 0);
  let from = String(params.get("from") || ""), to = String(params.get("to") || "");
  if (days) {
    if (!Number.isInteger(days) || days < 1 || days > ORDER_SEARCH_MAX_DAYS) throw new OrderSearchInputError("Choose a number of days from 1 to 366.");
    from = shiftDate(today, 1 - days); to = today;
  } else if (!from && !to) { from = shiftDate(today, -6); to = today; }
  else { from ||= to; to ||= from; }
  if (!validDate(from) || !validDate(to)) throw new OrderSearchInputError("Choose valid dates.");
  if (from > to) [from, to] = [to, from];
  if ((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000 >= ORDER_SEARCH_MAX_DAYS) throw new OrderSearchInputError("Search up to a year at a time.");
  const text = (key: string) => String(params.get(key) || "").trim().slice(0, 120);
  const last4 = text("last4").replace(/\D/g, "");
  if (last4 && last4.length !== 4) throw new OrderSearchInputError("Card last 4 must be 4 digits.");
  const phone = text("phone").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (text("phone") && phone.length < 3) throw new OrderSearchInputError("Enter at least 3 digits of the phone number.");
  return {
    from, to, last4, phone,
    name: text("name"), address: text("address"), number: text("number").replace(/^#/, ""),
    serviceType: pick(params.get("serviceType"), ["pickup", "delivery", "dine_in"] as const),
    channel: pick(params.get("channel"), ["pos", "web", "ai_phone"] as const),
    payment: pick(params.get("payment"), ["paid", "owes", "refunded", "voided"] as const),
    tender: pick(params.get("tender"), ["cash", "card", "other"] as const),
  };
}
