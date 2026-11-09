/** An ASAP preorder prints immediately, but preparation starts at its quoted opening. */
export function waitingForOpening(order: {
  status: string;
  timing_mode: string | null;
  promised_at: string | Date | null;
  quoted_lead_max_minutes: number | string | null;
}, now = new Date()): boolean {
  if (order.status !== "sent_to_kitchen" || order.timing_mode !== "asap" || !order.promised_at || order.quoted_lead_max_minutes == null) return false;
  const promised = new Date(order.promised_at).getTime();
  const lead = Number(order.quoted_lead_max_minutes);
  if (!Number.isFinite(promised) || !Number.isFinite(lead) || lead < 0) return false;
  // quoteTimingForOrder uses the next opening as the start of an ASAP
  // preorder's lead time. Ordinary ASAP quotes start when the order is made.
  return promised - lead * 60_000 > now.getTime();
}
