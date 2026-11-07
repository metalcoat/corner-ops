// House accounts: regulars (and businesses) who order now and settle up later. Every order
// charged to the account is a ledger entry; the balance is charges minus payments and credits.
// These are the rules with no database, shared by the POS, the manager portal and the tests.

export type HouseAccountStatus = "active" | "hold" | "closed";
export type HouseAccountEntryType = "charge" | "payment" | "credit" | "refund" | "reversal" | "adjustment";
export const HOUSE_PAYMENT_METHODS = ["cash", "check", "card"] as const;
export type HousePaymentMethod = (typeof HOUSE_PAYMENT_METHODS)[number];

export const houseEntryLabels: Record<HouseAccountEntryType, string> = {
  charge: "Charge",
  payment: "Payment",
  credit: "Credit",
  refund: "Refund",
  reversal: "Charge reversed",
  adjustment: "Adjustment",
};

const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** Why this account can't take this charge right now, or null when it can. */
export function houseChargeBlocker(input: { status: string; balanceCents: number; creditLimitCents: number | null; amountCents: number }): string | null {
  if (input.status === "closed") return "This house account is closed.";
  if (input.status === "hold") return "This house account is on hold. A manager has to take it off hold before it can be charged.";
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) return "Enter an amount to charge.";
  if (input.creditLimitCents != null && input.balanceCents + input.amountCents > input.creditLimitCents) {
    const room = Math.max(0, input.creditLimitCents - input.balanceCents);
    return `Over the ${dollars(input.creditLimitCents)} limit: the tab owes ${dollars(input.balanceCents)}, so only ${dollars(room)} more can go on it. A manager can raise the limit.`;
  }
  return null;
}

/** Which way an entry moves the balance: a charge (and a debit adjustment) adds; everything else takes off. */
export function houseEntryDelta(type: HouseAccountEntryType, amountCents: number): number {
  const amount = Math.abs(Math.trunc(amountCents));
  if (type === "charge") return amount;
  if (type === "adjustment") return Math.trunc(amountCents);
  return -amount;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
/** First day of the month a YYYY-MM-DD date falls in. */
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;

/**
 * The statement's default dates: everything since the last payment (that payment included, so the
 * customer sees it was received), or since the 1st of this month when they've never paid.
 */
export function defaultStatementPeriod(input: { today: string; lastPaymentDate?: string | null }) {
  const from = input.lastPaymentDate && isoDate.test(input.lastPaymentDate) && input.lastPaymentDate <= input.today ? input.lastPaymentDate : monthStart(input.today);
  return { from, to: input.today };
}

/** Dates from a statement request; a missing or bad date falls back to the default period. */
export function statementPeriod(input: { from?: string | null; to?: string | null; today: string; lastPaymentDate?: string | null }) {
  const fallback = defaultStatementPeriod(input);
  const from = input.from && isoDate.test(input.from) ? input.from : fallback.from;
  const to = input.to && isoDate.test(input.to) ? input.to : fallback.to;
  return from <= to ? { from, to } : { from: to, to: from };
}

export type HouseLedgerEntry = { at: string; type: HouseAccountEntryType; deltaCents: number; orderNumber?: string | null; items?: string | null; description?: string | null; method?: string | null; reference?: string | null; by?: string | null };
export type HouseStatementRow = HouseLedgerEntry & { label: string; balanceCents: number };

/** Entries oldest first, each with the balance after it, starting from the balance before the period. */
export function runningBalance(openingCents: number, entries: HouseLedgerEntry[]): HouseStatementRow[] {
  let balance = openingCents;
  return entries.map((entry) => {
    balance += entry.deltaCents;
    return { ...entry, label: houseEntryLabels[entry.type] || entry.type, balanceCents: balance };
  });
}

export function statementTotals(openingCents: number, rows: HouseStatementRow[]) {
  const charges = rows.filter((row) => row.deltaCents > 0).reduce((sum, row) => sum + row.deltaCents, 0);
  const credits = rows.filter((row) => row.deltaCents < 0).reduce((sum, row) => sum - row.deltaCents, 0);
  return { openingCents, chargesCents: charges, paymentsAndCreditsCents: credits, closingCents: openingCents + charges - credits };
}

/** The charge slip on the customer's receipt for an order put on a house account. */
export function houseChargeSlipLines(input: { accountName: string; chargedCents: number; balanceAfterCents: number }): string[] {
  return [
    "--------------------------------",
    "CHARGED TO ACCOUNT",
    `HOUSE ACCOUNT: ${input.accountName}`,
    `CHARGED: ${dollars(input.chargedCents)}`,
    `ACCOUNT BALANCE: ${dollars(input.balanceAfterCents)}`,
    "",
    "SIGNATURE: ______________________",
  ];
}

const usDate = (iso: string, timeZone = "America/New_York") => new Intl.DateTimeFormat("en-US", { timeZone, month: "2-digit", day: "2-digit", year: "2-digit" }).format(new Date(iso));
const usTime = (iso: string, timeZone = "America/New_York") => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const pretty = (date: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${date}T12:00:00Z`));

/** The statement as receipt-printer lines (42 columns or less). */
export function statementPrintLines(input: { accountName: string; phone?: string; from: string; to: string; openingCents: number; rows: HouseStatementRow[]; printedBy: string }): string[] {
  const totals = statementTotals(input.openingCents, input.rows);
  const right = (left: string, value: string, width = 32) => `${left.slice(0, Math.max(1, width - value.length - 1)).padEnd(width - value.length)}${value}`;
  const lines = ["HOUSE ACCOUNT STATEMENT", `ACCOUNT: ${input.accountName}`];
  if (input.phone) lines.push(`PHONE: ${input.phone}`);
  lines.push(`PERIOD: ${pretty(input.from)} - ${pretty(input.to)}`, "--------------------------------", right("PREVIOUS BALANCE", dollars(input.openingCents)));
  for (const row of input.rows) {
    lines.push("--------------------------------");
    lines.push(`${usDate(row.at)} ${usTime(row.at)}  ${row.orderNumber ? `ORDER #${row.orderNumber}` : row.label.toUpperCase()}`);
    if (row.items) lines.push(`  ${row.items}`);
    if (!row.orderNumber || row.type !== "charge") {
      const note = [row.orderNumber ? row.label : "", row.method ? row.method.toUpperCase() : "", row.reference || "", row.description || ""].filter(Boolean).join(" ");
      if (note) lines.push(`  ${note}`);
    }
    lines.push(right(`  ${row.deltaCents > 0 ? "CHARGE" : "CREDIT"}`, dollars(row.deltaCents)));
    lines.push(right("  BALANCE", dollars(row.balanceCents)));
  }
  if (!input.rows.length) lines.push("--------------------------------", "NO ACTIVITY IN THIS PERIOD");
  lines.push(
    "================================",
    right("CHARGES", dollars(totals.chargesCents)),
    right("PAYMENTS & CREDITS", dollars(-totals.paymentsAndCreditsCents)),
    right("BALANCE DUE", dollars(totals.closingCents)),
    "--------------------------------",
    `PRINTED BY: ${input.printedBy}`,
  );
  return lines;
}

/** "Mike Russell", "(518) 555-0100" and the like. */
export function cleanAccountInput(input: { name?: unknown; phone?: unknown; email?: unknown; notes?: unknown; creditLimitCents?: unknown }) {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2) throw new Error("Enter the account name.");
  if (name.length > 120) throw new Error("The account name must be 120 characters or fewer.");
  const phone = String(input.phone ?? "").trim();
  const digits = phone.replace(/\D/g, "");
  if (phone && (digits.length < 7 || digits.length > 15)) throw new Error("Enter a valid phone number.");
  const email = String(input.email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address.");
  const notes = String(input.notes ?? "").trim();
  if (notes.length > 1000) throw new Error("Notes must be 1000 characters or fewer.");
  const rawLimit = input.creditLimitCents;
  const creditLimitCents = rawLimit === null || rawLimit === undefined || rawLimit === "" ? null : Number(rawLimit);
  if (creditLimitCents !== null && (!Number.isSafeInteger(creditLimitCents) || creditLimitCents < 0)) throw new Error("The credit limit must be zero or more.");
  return { name, phone: digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : phone, email, notes, creditLimitCents };
}
