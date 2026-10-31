/**
 * Owner rule (2026-10-30): part of a cash order isn't handed back from the till; it's left
 * as store credit for next time. A whole order still refunds in cash, and so does part of
 * one with no customer on it, because credit has nowhere to go.
 */
export function cashRefundBecomesCredit(input: { tenderType: string; wholeOrder: boolean; customerId?: string | null }): boolean {
  return input.tenderType === "cash" && !input.wholeOrder && Boolean(input.customerId);
}
