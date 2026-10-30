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

export const DENOMINATIONS = [
  { key: "pennies", label: "Pennies", cents: 1 },
  { key: "nickels", label: "Nickels", cents: 5 },
  { key: "dimes", label: "Dimes", cents: 10 },
  { key: "quarters", label: "Quarters", cents: 25 },
  { key: "ones", label: "$1 bills", cents: 100 },
  { key: "fives", label: "$5 bills", cents: 500 },
  { key: "tens", label: "$10 bills", cents: 1000 },
  { key: "twenties", label: "$20 bills", cents: 2000 },
  { key: "fifties", label: "$50 bills", cents: 5000 },
  { key: "hundreds", label: "$100 bills", cents: 10000 },
] as const;
export type DenominationKey = (typeof DENOMINATIONS)[number]["key"];
export type DenominationCounts = Record<DenominationKey, number>;

/** How the $100 front float is made up when the drawer has it: $10 in coin, 25 × $1, 5 × $5, 4 × $10. */
export const PREFERRED_100_FLOAT: Partial<DenominationCounts> = { pennies: 50, nickels: 20, dimes: 25, quarters: 24, ones: 25, fives: 5, tens: 4 };

export function emptyCounts(): DenominationCounts {
  return Object.fromEntries(DENOMINATIONS.map((d) => [d.key, 0])) as DenominationCounts;
}

/** Validates counts from the POS: whole numbers, 0–100,000 each; missing denominations are 0. */
export function parseDenominationCounts(value: unknown): DenominationCounts {
  if (!value || typeof value !== "object") throw new Error("Enter the count for each bill and coin.");
  const input = value as Record<string, unknown>, counts = emptyCounts();
  for (const d of DENOMINATIONS) {
    const raw = input[d.key] ?? 0, count = Number(raw === "" ? 0 : raw);
    if (!Number.isSafeInteger(count) || count < 0 || count > 100000) throw new Error(`${d.label} must be a whole number.`);
    counts[d.key] = count;
  }
  return counts;
}

export function countsTotalCents(counts: Partial<DenominationCounts>) {
  return DENOMINATIONS.reduce((sum, d) => sum + (counts[d.key] || 0) * d.cents, 0);
}

// Filling the rest of the float prefers small bills, then coin, and uses $20/$50/$100 only when nothing else adds up.
const FILL_ORDER: DenominationKey[] = ["ones", "fives", "tens", "quarters", "dimes", "nickels", "pennies", "twenties", "fifties", "hundreds"];
const CENTS = Object.fromEntries(DENOMINATIONS.map((d) => [d.key, d.cents])) as Record<DenominationKey, number>;

/** Exactly `target` cents out of `available` (limited counts), or null when it can't be made. */
function exactFill(available: DenominationCounts, target: number): DenominationCounts | null {
  if (target === 0) return emptyCounts();
  if (target < 0 || target > 1_000_000) return null;
  let reach = new Uint8Array(target + 1);
  reach[0] = 1;
  const layers: Int32Array[] = [];
  for (const key of FILL_ORDER) {
    const d = CENTS[key], limit = available[key], used = new Int32Array(target + 1), next = reach.slice();
    for (let s = d; s <= target && limit > 0; s++) {
      if (!next[s] && next[s - d] && used[s - d] < limit) { next[s] = 1; used[s] = used[s - d] + 1; }
    }
    layers.push(used);
    reach = next;
  }
  if (!reach[target]) return null;
  const result = emptyCounts();
  let s = target;
  for (let i = FILL_ORDER.length - 1; i >= 0; i--) {
    const k = layers[i][s];
    result[FILL_ORDER[i]] = k;
    s -= k * CENTS[FILL_ORDER[i]];
  }
  return s === 0 ? result : null;
}

export type ResetPlan = { leave: DenominationCounts; deposit: DenominationCounts; leaveCents: number; depositCents: number; shortCents: number };

/**
 * Which bills and coins to leave in the till so it holds exactly `targetCents`; everything else goes
 * in the deposit. If the drawer can't make the amount exactly, it leaves as close under it as possible
 * and reports the shortfall.
 */
export function planTillReset(counted: DenominationCounts, targetCents: number): ResetPlan {
  const total = countsTotalCents(counted);
  let leave: DenominationCounts | null = null;
  if (targetCents >= total) leave = { ...counted };
  else {
    const preferred = targetCents === 10000 ? PREFERRED_100_FLOAT : {};
    const start = emptyCounts();
    for (const d of DENOMINATIONS) start[d.key] = Math.min(counted[d.key], preferred[d.key] || 0);
    const rest = emptyCounts();
    for (const d of DENOMINATIONS) rest[d.key] = counted[d.key] - start[d.key];
    const fill = exactFill(rest, targetCents - countsTotalCents(start));
    if (fill) leave = Object.fromEntries(DENOMINATIONS.map((d) => [d.key, start[d.key] + fill[d.key]])) as DenominationCounts;
    else leave = exactFill(counted, targetCents);
    for (let t = targetCents - 1; !leave && t >= 0; t--) leave = exactFill(counted, t);
  }
  const finalLeave = leave || emptyCounts(), deposit = emptyCounts();
  for (const d of DENOMINATIONS) deposit[d.key] = counted[d.key] - finalLeave[d.key];
  const leaveCents = countsTotalCents(finalLeave);
  return { leave: finalLeave, deposit, leaveCents, depositCents: total - leaveCents, shortCents: Math.max(0, targetCents - leaveCents) };
}
