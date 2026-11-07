/**
 * Which online orders need the texted code (owner rule, 2026-10-26): only orders paid in
 * cash at pickup or delivery, because nothing else ties them to a real person. Card orders
 * are paid up front and never need it. A signed-in customer already proved their phone or
 * email. A manager can switch the code off until a set time (Store Operations); it switches
 * itself back on then.
 */
export type OnlinePayment = "card" | "saved_card" | "pay_later";

export function smsCodeRequired(input: { payment: OnlinePayment; signedIn: boolean; bypassUntil: Date | null; now?: Date }): boolean {
  if (input.payment !== "pay_later" || input.signedIn) return false;
  return !smsBypassActive(input.bypassUntil, input.now);
}

export function smsBypassActive(bypassUntil: Date | null, now = new Date()): boolean {
  return Boolean(bypassUntil && bypassUntil.getTime() > now.getTime());
}

/** Longest a manager can switch the code off for in one go. */
export const MAX_SMS_BYPASS_HOURS = 72;
