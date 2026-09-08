export const DEFAULT_PUNCH_CORRECTION_REASON = "Owner time correction";

/** A note is optional for an authorized punch correction, but never absent from its audit. */
export function normalizePunchCorrectionReason(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 1000)
    : DEFAULT_PUNCH_CORRECTION_REASON;
}
