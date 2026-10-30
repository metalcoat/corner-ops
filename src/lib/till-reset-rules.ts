// What a till is reset to at closeout. Corner Deli: the front (upfront) till keeps a $100 float,
// the back till is emptied to $0. A manager can set a different amount per till on the Register page.
export const FRONT_TILL_RESET_CENTS = 10000;
export const BACK_TILL_RESET_CENTS = 0;

export function defaultTillResetCents(till: { terminalKey?: string; name?: string }) {
  const label = `${till.terminalKey || ""} ${till.name || ""}`.toLowerCase();
  return /\bback\b|back[-_ ]/.test(label) ? BACK_TILL_RESET_CENTS : FRONT_TILL_RESET_CENTS;
}

export function tillResetCents(till: { terminalKey?: string; name?: string; resetCashCents?: number | null }) {
  const configured = till.resetCashCents;
  return configured != null && Number.isSafeInteger(Number(configured)) && Number(configured) >= 0 ? Number(configured) : defaultTillResetCents(till);
}

export function tillLabel(till: { terminalKey?: string; name?: string }) {
  return defaultTillResetCents(till) === BACK_TILL_RESET_CENTS ? "back till" : "front till";
}

/** Cash to take out of the drawer at closeout so the reset amount stays in it. */
export function cashToRemoveCents(countedCents: number, resetCents: number) {
  return Math.max(0, countedCents - resetCents);
}
