/** Pure rules for orders reopened from the Order Center for editing. */

export type ReopenDetails = { existingItemIds?: string[]; previousStatus?: string; previousTotalCents?: number };

const RESTORABLE_STATUSES = ["sent_to_kitchen", "in_progress", "ready", "completed"];

/**
 * A reopen recorded against a never-sent draft is not an add-on: the order
 * still needs its first full submit. Returns the reopen details only when they
 * describe a real reopen of a sent order.
 */
export function effectiveReopen<T extends ReopenDetails>(details: T | undefined | null): T | undefined {
  if (!details || details.previousStatus === "draft") return undefined;
  return details;
}

/**
 * Status to put an abandoned reopened order back into, or null when it must
 * stay in draft because it has unsent changes (new lines or adjustments).
 */
export function abandonedReopenRestoreStatus(
  details: ReopenDetails | undefined | null,
  currentItemIds: string[],
  hasAdjustments: boolean,
): string | null {
  const reopen = effectiveReopen(details ?? undefined);
  const prior = String(reopen?.previousStatus || "");
  if (!reopen || !RESTORABLE_STATUSES.includes(prior) || hasAdjustments) return null;
  const existing = new Set((reopen.existingItemIds || []).map(String));
  if (currentItemIds.some((id) => !existing.has(String(id)))) return null;
  return prior;
}
