// Pure payment/tip/cash-out rules shared by the ordering payment modules.
// Kept free of "@/..." imports so they can be unit tested directly.

/** Tips are capped at the greater of $100 or 100% of the pre-tax subtotal. */
export const TIP_CAP_FLOOR_CENTS = 10_000;

export function maxTipCents(subtotalCents: number): number {
  return Math.max(TIP_CAP_FLOOR_CENTS, Math.max(0, Math.trunc(Number(subtotalCents) || 0)));
}

export type TipChangeInput = {
  tipCents: number;
  currentTipCents: number;
  subtotalCents: number;
  totalCents: number;
  paidCents: number;
  orderStatus: string;
  voided: boolean;
  paymentStatus: string;
  isManager: boolean;
  /** Order-level tip after this change (differs from tipCents when tipping one split check). */
  resultingOrderTipCents?: number;
};

/** Returns an error message when the tip change is not allowed, otherwise null. */
export function tipChangeError(input: TipChangeInput): string | null {
  if (!Number.isSafeInteger(input.tipCents) || input.tipCents < 0) return "Tip must be a non-negative amount in cents.";
  if (input.voided || input.orderStatus === "cancelled") return "Tips cannot be changed on a voided or cancelled order.";
  if (input.paymentStatus === "refunded" || input.paymentStatus === "partially_refunded") return "Tips cannot be changed after a refund.";
  if ((input.resultingOrderTipCents ?? input.tipCents) > maxTipCents(input.subtotalCents)) return `Tip cannot exceed $${(maxTipCents(input.subtotalCents) / 100).toFixed(2)} for this order.`;
  // Split tender (e.g. part cash, then a card with a tip from the customer display) adds a tip
  // while a balance is still due; raising the tip only raises what is still owed, so staff may
  // do that. Lowering a tip, or changing it once the check is fully paid, needs a manager.
  const addingTipToOpenBalance = input.tipCents > input.currentTipCents && input.totalCents > input.paidCents;
  if (input.paidCents > 0 && input.tipCents !== input.currentTipCents && !input.isManager && !addingTipToOpenBalance) return "Manager or owner authorization is required to change the tip after a payment has been taken.";
  if (input.totalCents + input.tipCents - input.currentTipCents < input.paidCents) return "The tip cannot be lowered below what has already been paid. Reverse a tender first.";
  return null;
}

/** Tip amount that should be actively allocated to staff for an order. */
export function tipAllocationTarget(order: { tipCents: number; paymentStatus: string; voided: boolean; status: string }): number {
  if (order.voided || order.status === "cancelled" || order.paymentStatus !== "paid") return 0;
  return Math.max(0, Math.trunc(Number(order.tipCents) || 0));
}

/** Driver cash-out: only shortfalls require manager approval; returns an error or null. */
export function driverSettlementError(input: { isDriver: boolean; isManager: boolean; expectedCents: number; turnedInCents: number; unassignedOrderCount: number }): string | null {
  if (!input.isManager && !input.isDriver) return "Driver or manager access is required to post a cash-out.";
  if (!input.isManager && input.unassignedOrderCount > 0) return "Drivers can only cash out delivery orders assigned to them. Ask a manager.";
  if (!input.isManager && input.turnedInCents < input.expectedCents) return `Cash turned in is $${((input.expectedCents - input.turnedInCents) / 100).toFixed(2)} short. A manager must approve a short cash-out.`;
  return null;
}
