// Till closeout rules. Corner Deli: the front (upfront) till keeps a $100 float in quarters, $1, $5 and $10;
// the back till is emptied to $0 and keeps a separate $60 change bag. Managers edit both in POS Settings → Tills.

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
const CENTS = Object.fromEntries(DENOMINATIONS.map((d) => [d.key, d.cents])) as Record<DenominationKey, number>;
const LABEL = Object.fromEntries(DENOMINATIONS.map((d) => [d.key, d.label])) as Record<DenominationKey, string>;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** One denomination allowed in a float or change bag: what it should hold, the least it may hold, the most. */
export type FloatItem = { key: DenominationKey; targetCents: number; minCents: number; maxCents: number };
/** `float` is what stays in the till (empty = reset to $0); `bag` is a separate change bag counted at close. */
export type TillSettings = { float: FloatItem[]; bag: FloatItem[] | null };

// Chris, 2026-10-30: front $100 = $5 quarters (up to $10), $25 ones, $30 fives, $40 tens; never coin under a
// quarter or a $20+. Minimums $5 quarters, $25 ones, $25 fives. Back till $0 plus a $60 bag: $2 quarters, $28 ones, $30 fives.
export const FRONT_TILL_FLOAT: FloatItem[] = [
  { key: "quarters", targetCents: 500, minCents: 500, maxCents: 1000 },
  { key: "ones", targetCents: 2500, minCents: 2500, maxCents: 4000 },
  { key: "fives", targetCents: 3000, minCents: 2500, maxCents: 4500 },
  { key: "tens", targetCents: 4000, minCents: 0, maxCents: 5000 },
];
export const BACK_TILL_BAG: FloatItem[] = [
  { key: "quarters", targetCents: 200, minCents: 100, maxCents: 500 },
  { key: "ones", targetCents: 2800, minCents: 1500, maxCents: 4000 },
  { key: "fives", targetCents: 3000, minCents: 1000, maxCents: 4000 },
];

export function isBackTill(till: { terminalKey?: string; name?: string }) {
  return /\bback\b|back[-_ ]/.test(`${till.terminalKey || ""} ${till.name || ""}`.toLowerCase());
}

export function tillLabel(till: { terminalKey?: string; name?: string }) {
  return isBackTill(till) ? "back till" : "front till";
}

export function defaultTillSettings(till: { terminalKey?: string; name?: string }): TillSettings {
  return isBackTill(till) ? { float: [], bag: BACK_TILL_BAG.map((i) => ({ ...i })) } : { float: FRONT_TILL_FLOAT.map((i) => ({ ...i })), bag: null };
}

function parseItems(value: unknown, label: string): FloatItem[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of bills and coins.`);
  const seen = new Set<string>();
  return value.map((raw) => {
    const row = (raw || {}) as Record<string, unknown>, key = String(row.key || "") as DenominationKey;
    if (!(key in CENTS)) throw new Error(`${label}: unknown bill or coin "${key}".`);
    if (seen.has(key)) throw new Error(`${label}: ${LABEL[key]} is listed twice.`);
    seen.add(key);
    const [targetCents, minCents, maxCents] = [row.targetCents, row.minCents, row.maxCents].map(Number);
    for (const [name, cents] of [["target", targetCents], ["minimum", minCents], ["limit", maxCents]] as const) {
      if (!Number.isSafeInteger(cents) || cents < 0 || cents > 1_000_000) throw new Error(`${label}: the ${LABEL[key]} ${name} must be a dollar amount.`);
      if (cents % CENTS[key] !== 0) throw new Error(`${label}: the ${LABEL[key]} ${name} must be a multiple of ${money(CENTS[key])}.`);
    }
    if (minCents > targetCents || targetCents > maxCents) throw new Error(`${label}: ${LABEL[key]} needs minimum ≤ target ≤ limit.`);
    return { key, targetCents, minCents, maxCents };
  }).sort((a, b) => CENTS[a.key] - CENTS[b.key]);
}

export function parseTillSettings(value: unknown): TillSettings {
  const input = (value || {}) as Record<string, unknown>;
  const bag = input.bag == null ? null : parseItems(input.bag, "Change bag");
  return { float: parseItems(input.float ?? [], "Till float"), bag: bag && bag.length ? bag : null };
}

/** Stored settings for a till, or the defaults for its name. */
export function tillSettings(till: { terminalKey?: string; name?: string; settings?: unknown }): TillSettings {
  if (till.settings) {
    try { return parseTillSettings(till.settings); } catch { /* fall back to the defaults */ }
  }
  return defaultTillSettings(till);
}

export const planTotalCents = (items: FloatItem[]) => items.reduce((sum, item) => sum + item.targetCents, 0);

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

const subtract = (a: DenominationCounts, b: DenominationCounts) => Object.fromEntries(DENOMINATIONS.map((d) => [d.key, a[d.key] - b[d.key]])) as DenominationCounts;
const add = (a: DenominationCounts, b: DenominationCounts) => Object.fromEntries(DENOMINATIONS.map((d) => [d.key, a[d.key] + b[d.key]])) as DenominationCounts;

/**
 * Makes `target` cents from `available` using the denominations in `order` (earlier ones preferred), or with
 * `allowUnder` the most it can without going over. Bounded coin change with a per-layer used count.
 */
function fill(available: DenominationCounts, target: number, order: DenominationKey[], allowUnder = false): DenominationCounts | null {
  if (target <= 0) return target === 0 ? emptyCounts() : null;
  if (target > 1_000_000) return null;
  let reach = new Uint8Array(target + 1);
  reach[0] = 1;
  const layers: Int32Array[] = [];
  for (const key of order) {
    const d = CENTS[key], limit = available[key], used = new Int32Array(target + 1), next = reach.slice();
    for (let s = d; s <= target && limit > 0; s++) {
      if (!next[s] && next[s - d] && used[s - d] < limit) { next[s] = 1; used[s] = used[s - d] + 1; }
    }
    layers.push(used);
    reach = next;
  }
  let s = target;
  if (!reach[s]) {
    if (!allowUnder) return null;
    while (s > 0 && !reach[s]) s--;
  }
  const result = emptyCounts();
  for (let i = order.length - 1; i >= 0; i--) {
    const k = layers[i][s];
    result[order[i]] = k;
    s -= k * CENTS[order[i]];
  }
  return result;
}

export type FloatPlan = { leave: DenominationCounts; leaveCents: number; targetCents: number; shortCents: number; flags: string[] };

/**
 * Which bills and coins to put in a float (till or change bag) from what is `available`. Each allowed
 * denomination gets its target when there is enough; a shortfall is made up from the next size up within the
 * limits, then past the limits, and only from the allowed denominations. Anything under a minimum, over a
 * limit, off target or short overall is flagged.
 */
export function planFloat(available: DenominationCounts, items: FloatItem[], name: string): FloatPlan {
  const targetCents = planTotalCents(items), leave = emptyCounts();
  if (!items.length || targetCents === 0) return { leave, leaveCents: 0, targetCents, shortCents: 0, flags: [] };
  for (const item of items) leave[item.key] = Math.min(available[item.key], Math.floor(item.targetCents / CENTS[item.key]));
  const remaining = targetCents - countsTotalCents(leave);
  if (remaining > 0) {
    const order = items.map((i) => i.key).sort((a, b) => CENTS[b] - CENTS[a]), spare = subtract(available, leave), capped = emptyCounts(), allowed = emptyCounts();
    for (const item of items) {
      allowed[item.key] = spare[item.key];
      capped[item.key] = Math.max(0, Math.min(spare[item.key], Math.floor(item.maxCents / CENTS[item.key]) - leave[item.key]));
    }
    const extra = fill(capped, remaining, order) || fill(allowed, remaining, order) || fill(allowed, remaining, order, true) || emptyCounts();
    for (const key of order) leave[key] += extra[key];
  }
  const leaveCents = countsTotalCents(leave), shortCents = Math.max(0, targetCents - leaveCents), flags: string[] = [];
  for (const item of items) {
    const cents = leave[item.key] * CENTS[item.key], label = LABEL[item.key];
    if (cents < item.minCents) flags.push(`${name}: only ${money(cents)} in ${label} (minimum ${money(item.minCents)}).`);
    else if (cents > item.maxCents) flags.push(`${name}: ${money(cents)} in ${label} (over the ${money(item.maxCents)} limit).`);
    else if (cents < item.targetCents) flags.push(`${name}: ${money(cents)} in ${label} instead of ${money(item.targetCents)}, made up with other bills.`);
  }
  if (shortCents > 0) flags.push(`${name}: short ${money(shortCents)} — the drawer can't make ${money(targetCents)} from ${items.map((i) => LABEL[i.key]).join(", ")}.`);
  return { leave, leaveCents, targetCents, shortCents, flags };
}

export type ResetPlan = FloatPlan & {
  deposit: DenominationCounts;
  depositCents: number;
  bag: (FloatPlan & { counted: DenominationCounts; countedCents: number }) | null;
};

/**
 * The whole closeout: the till float comes out of the drawer count; the change bag is then made up from
 * what's in the bag plus the rest of the drawer (topped up or trimmed back to its target); everything
 * else is the deposit.
 */
export function planCloseout(drawer: DenominationCounts, bagCounted: DenominationCounts | null, settings: TillSettings): ResetPlan {
  const till = planFloat(drawer, settings.float, "Till");
  let pool = subtract(drawer, till.leave), bag: ResetPlan["bag"] = null;
  if (settings.bag) {
    const counted = bagCounted || emptyCounts(), countedCents = countsTotalCents(counted);
    pool = add(pool, counted);
    const plan = planFloat(pool, settings.bag, "Change bag");
    if (countedCents !== plan.targetCents) plan.flags.unshift(`Change bag counted ${money(countedCents)}, should be ${money(plan.targetCents)}${countedCents < plan.targetCents ? " (topped up from the drawer)" : " (extra goes in the deposit)"}.`);
    pool = subtract(pool, plan.leave);
    bag = { ...plan, counted, countedCents };
  }
  return { ...till, deposit: pool, depositCents: countsTotalCents(pool), bag };
}
