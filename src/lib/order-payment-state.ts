/**
 * How an order's payment reads in lists (POS Order Center, manager order search).
 *
 * A refund on an order that was still open put it back to "unpaid" with the whole
 * total due, so refunded orders looked like they still owed (and went overdue the
 * next day). Money given back on a sent order is a refund, not a balance due. Only
 * a draft (still at checkout, where a wrong tender is taken off to pay again) owes.
 */
export type OrderPaymentInput = {
  status: string;
  paymentStatus: string;
  voided: boolean;
  paidCents: number;
  dueCents: number;
  refundedCents: number;
};

export type OrderPaymentState = {
  key: "voided" | "paid" | "refunded" | "partially_refunded" | "owes" | "other";
  label: string;
  /** Still has money to collect: belongs with the unpaid orders. */
  owes: boolean;
};

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function orderPaymentState(order: OrderPaymentInput): OrderPaymentState {
  const refunded = order.refundedCents > 0 || ["refunded", "partially_refunded"].includes(order.paymentStatus);
  if (order.voided || order.status === "cancelled") {
    const label = !refunded ? (order.paidCents > 0 ? "Voided · not refunded" : "Voided") : order.paidCents > 0 ? "Voided · partly refunded" : "Voided · refunded";
    return { key: "voided", label, owes: false };
  }
  if (order.paymentStatus === "paid" && order.dueCents <= 0) return { key: "paid", label: "Paid", owes: false };
  if (refunded && order.status !== "draft") {
    return order.paidCents > 0 ? { key: "partially_refunded", label: "Partially refunded", owes: false } : { key: "refunded", label: "Refunded", owes: false };
  }
  if (order.dueCents > 0) return { key: "owes", label: order.paidCents > 0 ? `Owes ${dollars(order.dueCents)}` : "Unpaid", owes: true };
  return { key: "other", label: order.paymentStatus.replaceAll("_", " "), owes: false };
}
