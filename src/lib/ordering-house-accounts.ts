// House accounts: charge an order to a regular's tab at the POS, record what they pay back
// from the manager portal, and print their statement. Tables: 0014_runtime_schema.sql,
// columns 0036_house_accounts.sql. Pure rules: ordering-house-account-rules.ts.
import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { canManagePos, type OrderingActor } from "@/lib/ordering-route-auth";
import { sendEpsonPrint } from "@/lib/ordering-hardware";
import {
  cleanAccountInput, houseChargeBlocker, houseChargeSlipLines, houseEntryDelta, runningBalance, statementPeriod, statementPrintLines, statementTotals,
  HOUSE_PAYMENT_METHODS, type HouseAccountEntryType, type HouseAccountStatus, type HousePaymentMethod,
} from "@/lib/ordering-house-account-rules";

const BUSINESS = "Corner Deli";

export class HouseAccountError extends Error {}

/** Today's date at the store, YYYY-MM-DD. */
export function storeToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function account(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    phone: String(row.billing_phone || ""),
    email: String(row.billing_email || ""),
    notes: String(row.notes || ""),
    status: String(row.status) as HouseAccountStatus,
    creditLimitCents: row.credit_limit_cents == null ? null : Number(row.credit_limit_cents),
    balanceCents: Number(row.balance_cents || 0),
    lastChargeAt: row.last_charge_at ? new Date(String(row.last_charge_at)).toISOString() : null,
    lastPaymentAt: row.last_payment_at ? new Date(String(row.last_payment_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}
export type HouseAccount = ReturnType<typeof account>;

/** Every account for the manager portal, open ones first; closed ones only when asked for. */
export async function listHouseAccounts(input: { includeClosed?: boolean; query?: string; id?: string } = {}) {
  const sql = getSql(), query = String(input.query || "").trim(), digits = query.replace(/\D/g, "");
  const rows = await sql`SELECT a.*,
      COALESCE((SELECT SUM(l.delta_balance_cents) FROM ordering_house_account_ledger l WHERE l.account_id=a.id),0)::integer balance_cents,
      (SELECT MAX(l.created_at) FROM ordering_house_account_ledger l WHERE l.account_id=a.id AND l.entry_type='charge') last_charge_at,
      (SELECT MAX(l.created_at) FROM ordering_house_account_ledger l WHERE l.account_id=a.id AND l.entry_type='payment') last_payment_at
    FROM ordering_house_accounts a
    WHERE a.business=${BUSINESS} AND (${input.includeClosed === true} OR a.status<>'closed') AND (${input.id || null}::uuid IS NULL OR a.id=${input.id || null}::uuid)
      AND (${query}='' OR a.name ILIKE ${`%${query}%`} OR (${digits}<>'' AND regexp_replace(a.billing_phone,'\\D','','g') LIKE ${`%${digits}%`}))
    ORDER BY a.status='closed', lower(a.name) LIMIT 500`;
  return rows.map(account);
}

/** Accounts staff can pick at checkout: search by name or phone. Held accounts show, but can't be charged. */
export async function searchChargeableHouseAccounts(query: string) {
  const text = query.trim();
  const accounts = await listHouseAccounts({ query: text });
  return accounts.slice(0, text ? 25 : 50).map((row) => ({ ...row, notes: "", blocker: houseChargeBlocker({ status: row.status, balanceCents: row.balanceCents, creditLimitCents: row.creditLimitCents, amountCents: 1 }) }));
}

async function audit(actor: OrderingActor, action: string, accountId: string, reason: string, details: Record<string, unknown>) {
  await getSql()`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details)
    VALUES(${randomUUID()},${BUSINESS},${actor.id},${actor.role || actor.type},${action},'house_account',${accountId},${reason},${JSON.stringify({ ...details, actorName: actor.name })}::jsonb)`;
}

function requireManager(actor: OrderingActor) {
  if (!canManagePos(actor)) throw new HouseAccountError("Manager or owner access is required.");
}

async function lockedAccount(accountId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(accountId)) throw new HouseAccountError("House account was not found.");
  const sql = getSql();
  const row = (await sql`SELECT * FROM ordering_house_accounts WHERE id=${accountId} AND business=${BUSINESS} FOR UPDATE`)[0];
  if (!row) throw new HouseAccountError("House account was not found.");
  const balance = Number((await sql`SELECT COALESCE(SUM(delta_balance_cents),0)::integer balance FROM ordering_house_account_ledger WHERE account_id=${accountId}`)[0].balance);
  return { row, balance };
}

function duplicateName(error: unknown) {
  return error instanceof Error && /ordering_house_accounts_open_name_idx/.test(error.message);
}

export async function saveHouseAccount(input: { id?: string | null; name: unknown; phone?: unknown; email?: unknown; notes?: unknown; creditLimitCents?: unknown; actor: OrderingActor }) {
  requireManager(input.actor);
  const clean = (() => { try { return cleanAccountInput(input); } catch (error) { throw new HouseAccountError(error instanceof Error ? error.message : "Check the account details."); } })();
  try {
    return await withTransaction(async () => {
      const sql = getSql();
      if (input.id) {
        const { row } = await lockedAccount(String(input.id));
        await sql`UPDATE ordering_house_accounts SET name=${clean.name},billing_name=${clean.name},billing_phone=${clean.phone},billing_email=${clean.email},notes=${clean.notes},credit_limit_cents=${clean.creditLimitCents},updated_by=${input.actor.id},updated_at=NOW() WHERE id=${row.id}`;
        await audit(input.actor, "house_account_updated", String(row.id), "", { before: { name: row.name, phone: row.billing_phone, email: row.billing_email, creditLimitCents: row.credit_limit_cents }, after: clean });
        return String(row.id);
      }
      const id = randomUUID();
      await sql`INSERT INTO ordering_house_accounts(id,business,name,status,credit_limit_cents,billing_name,billing_email,billing_phone,notes,created_by,updated_by) VALUES(${id},${BUSINESS},${clean.name},'active',${clean.creditLimitCents},${clean.name},${clean.email},${clean.phone},${clean.notes},${input.actor.id},${input.actor.id})`;
      await audit(input.actor, "house_account_created", id, "", clean);
      return id;
    });
  } catch (error) {
    if (duplicateName(error)) throw new HouseAccountError(`There's already an open house account named ${clean.name}. Add a middle initial or the business name to tell them apart.`);
    throw error;
  }
}

/** Active, on hold (can't be charged), or closed (deactivated: hidden and can't be charged; history kept). */
export async function setHouseAccountStatus(input: { id: string; status: unknown; actor: OrderingActor }) {
  requireManager(input.actor);
  const status = String(input.status);
  if (!["active", "hold", "closed"].includes(status)) throw new HouseAccountError("Choose active, on hold or closed.");
  try {
    return await withTransaction(async () => {
      const { row, balance } = await lockedAccount(input.id);
      await getSql()`UPDATE ordering_house_accounts SET status=${status},closed_at=CASE WHEN ${status}='closed' THEN NOW() ELSE NULL END,updated_by=${input.actor.id},updated_at=NOW() WHERE id=${row.id}`;
      await audit(input.actor, "house_account_status_changed", String(row.id), "", { from: row.status, to: status, balanceCents: balance });
      return { balanceCents: balance };
    });
  } catch (error) {
    if (duplicateName(error)) throw new HouseAccountError("Another open account already has this name. Rename one of them first.");
    throw error;
  }
}

async function insertEntry(input: { accountId: string; type: HouseAccountEntryType; deltaCents: number; balanceAfterCents: number; actor: OrderingActor; orderId?: string | null; paymentTransactionId?: string | null; description?: string; reference?: string; method?: string; stationKey?: string; deviceLabel?: string; relatedEntryId?: string | null }) {
  const id = randomUUID();
  // clock_timestamp, not NOW(): entries written in one transaction (a charge and its reversal) still sort in the order they happened.
  await getSql()`INSERT INTO ordering_house_account_ledger(id,account_id,business,order_id,payment_transaction_id,entry_type,delta_balance_cents,balance_after_cents,description,reference,payment_method,created_by,actor_name,station_key,device_label,related_entry_id,created_at)
    VALUES(${id},${input.accountId},${BUSINESS},${input.orderId || null},${input.paymentTransactionId || null},${input.type},${input.deltaCents},${input.balanceAfterCents},${input.description || ""},${input.reference || ""},${input.method || ""},${input.actor.id},${input.actor.name},${input.stationKey || ""},${input.deviceLabel || ""},${input.relatedEntryId || null},clock_timestamp())`;
  return id;
}

/**
 * Puts an order's payment on the tab. Runs inside commitTender's transaction, after the
 * payment row exists, so the charge and the payment commit (or fail) together.
 */
export async function chargeHouseAccount(input: { accountId: string; orderId: string; orderNumber: string; paymentTransactionId: string; amountCents: number; stationKey?: string; actor: OrderingActor }) {
  const { row, balance } = await lockedAccount(input.accountId);
  const blocker = houseChargeBlocker({ status: String(row.status), balanceCents: balance, creditLimitCents: row.credit_limit_cents == null ? null : Number(row.credit_limit_cents), amountCents: input.amountCents });
  if (blocker) throw new HouseAccountError(blocker);
  const sql = getSql();
  const station = input.stationKey ? (await sql`SELECT name FROM ordering_payment_stations WHERE business=${BUSINESS} AND station_key=${input.stationKey} LIMIT 1`)[0] : null;
  const deviceLabel = station ? String(station.name) : input.stationKey ? input.stationKey : "Unassigned device";
  const balanceAfter = balance + input.amountCents;
  const entryId = await insertEntry({ accountId: String(row.id), type: "charge", deltaCents: input.amountCents, balanceAfterCents: balanceAfter, actor: input.actor, orderId: input.orderId, paymentTransactionId: input.paymentTransactionId, description: `Order #${input.orderNumber}`, reference: input.orderNumber, stationKey: input.stationKey, deviceLabel });
  await sql`UPDATE ordering_payment_transactions SET provider='corner_ops_house_account',provider_transaction_reference=${`house:${entryId}`},details=details||${JSON.stringify({ houseAccountId: row.id, houseAccountName: row.name, houseAccountEntryId: entryId, balanceAfterCents: balanceAfter, deviceLabel })}::jsonb WHERE id=${input.paymentTransactionId}`;
  await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) SELECT ${randomUUID()},id,version,'house_account_charged',${input.actor.type},${input.actor.id},${JSON.stringify({ accountId: row.id, accountName: row.name, amountCents: input.amountCents, balanceAfterCents: balanceAfter, transactionId: input.paymentTransactionId, entryId, stationKey: input.stationKey || "", deviceLabel, actorName: input.actor.name, actorRole: input.actor.role })}::jsonb FROM ordering_orders WHERE id=${input.orderId}`;
  return { accountId: String(row.id), accountName: String(row.name), balanceAfterCents: balanceAfter, slipLines: houseChargeSlipLines({ accountName: String(row.name), chargedCents: input.amountCents, balanceAfterCents: balanceAfter }) };
}

/** A refund or void of a house-account payment takes the charge back off the tab. Runs inside reverseTender's transaction. */
export async function reverseHouseAccountCharge(input: { sourceTransactionId: string; reversalTransactionId: string; orderId: string; amountCents: number; reason: string; actor: OrderingActor }) {
  const sql = getSql();
  const charge = (await sql`SELECT * FROM ordering_house_account_ledger WHERE payment_transaction_id=${input.sourceTransactionId} AND entry_type='charge' LIMIT 1`)[0];
  if (!charge) throw new HouseAccountError("The house-account charge for this payment was not found.");
  const { row, balance } = await lockedAccount(String(charge.account_id));
  const order = (await sql`SELECT display_number FROM ordering_orders WHERE id=${input.orderId}`)[0];
  const balanceAfter = balance - input.amountCents;
  const entryId = await insertEntry({ accountId: String(row.id), type: "reversal", deltaCents: -input.amountCents, balanceAfterCents: balanceAfter, actor: input.actor, orderId: input.orderId, paymentTransactionId: input.reversalTransactionId, description: input.reason, reference: String(order?.display_number || ""), relatedEntryId: String(charge.id) });
  await sql`UPDATE ordering_payment_transactions SET provider='corner_ops_house_account',details=details||${JSON.stringify({ houseAccountId: row.id, houseAccountName: row.name, houseAccountEntryId: entryId, balanceAfterCents: balanceAfter })}::jsonb WHERE id=${input.reversalTransactionId}`;
  await sql`INSERT INTO ordering_order_events(id,order_id,order_version,event_type,actor_type,actor_id,details) SELECT ${randomUUID()},id,version,'house_account_charge_reversed',${input.actor.type},${input.actor.id},${JSON.stringify({ accountId: row.id, accountName: row.name, amountCents: input.amountCents, balanceAfterCents: balanceAfter, transactionId: input.reversalTransactionId, sourceTransactionId: input.sourceTransactionId, entryId, reason: input.reason, actorName: input.actor.name, actorRole: input.actor.role })}::jsonb FROM ordering_orders WHERE id=${input.orderId}`;
  return { accountName: String(row.name), balanceAfterCents: balanceAfter };
}

/** The charge slip for a paid receipt printed later (the POS asks itemized or not after payment). */
export async function houseAccountReceiptLines(orderId: string): Promise<string[]> {
  const rows = await getSql()`SELECT a.name, SUM(l.delta_balance_cents)::integer charged_cents,
      (SELECT COALESCE(SUM(all_entries.delta_balance_cents),0)::integer FROM ordering_house_account_ledger all_entries WHERE all_entries.account_id=a.id) balance_cents
    FROM ordering_house_account_ledger l JOIN ordering_house_accounts a ON a.id=l.account_id
    WHERE l.order_id=${orderId} AND l.entry_type IN ('charge','reversal') GROUP BY a.id, a.name HAVING SUM(l.delta_balance_cents)>0`;
  return rows.flatMap((row) => houseChargeSlipLines({ accountName: String(row.name), chargedCents: Number(row.charged_cents), balanceAfterCents: Number(row.balance_cents) }));
}

function positiveCents(value: unknown, label: string) {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new HouseAccountError(`Enter the ${label}.`);
  if (cents > 10_000_000) throw new HouseAccountError(`That ${label} is too large.`);
  return cents;
}

/** The customer paying down their tab (cash, check or card taken outside the order flow). */
export async function recordHouseAccountPayment(input: { id: string; amountCents: unknown; method: unknown; reference?: unknown; note?: unknown; actor: OrderingActor }) {
  requireManager(input.actor);
  const amount = positiveCents(input.amountCents, "payment amount");
  const method = String(input.method) as HousePaymentMethod;
  if (!HOUSE_PAYMENT_METHODS.includes(method)) throw new HouseAccountError("Choose cash, check or card.");
  const reference = String(input.reference ?? "").trim().slice(0, 80), note = String(input.note ?? "").trim().slice(0, 500);
  if (method === "check" && !reference) throw new HouseAccountError("Enter the check number.");
  return withTransaction(async () => {
    const { row, balance } = await lockedAccount(input.id);
    const balanceAfter = balance - amount;
    const entryId = await insertEntry({ accountId: String(row.id), type: "payment", deltaCents: houseEntryDelta("payment", amount), balanceAfterCents: balanceAfter, actor: input.actor, method, reference, description: note });
    await audit(input.actor, "house_account_payment", String(row.id), note, { entryId, amountCents: amount, method, reference, balanceAfterCents: balanceAfter });
    return { entryId, balanceCents: balanceAfter };
  });
}

/** A manager's correction: a credit takes money off the tab, a debit adds it. Always with a reason. */
export async function recordHouseAccountAdjustment(input: { id: string; amountCents: unknown; direction: unknown; reason: unknown; actor: OrderingActor }) {
  requireManager(input.actor);
  const amount = positiveCents(input.amountCents, "adjustment amount");
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) throw new HouseAccountError("Enter the reason for this adjustment.");
  if (reason.length > 500) throw new HouseAccountError("The reason must be 500 characters or fewer.");
  const type: HouseAccountEntryType = input.direction === "debit" ? "adjustment" : "credit";
  const delta = type === "credit" ? houseEntryDelta("credit", amount) : houseEntryDelta("adjustment", amount);
  return withTransaction(async () => {
    const { row, balance } = await lockedAccount(input.id);
    const balanceAfter = balance + delta;
    const entryId = await insertEntry({ accountId: String(row.id), type, deltaCents: delta, balanceAfterCents: balanceAfter, actor: input.actor, description: reason });
    await audit(input.actor, "house_account_adjustment", String(row.id), reason, { entryId, deltaCents: delta, balanceAfterCents: balanceAfter });
    return { entryId, balanceCents: balanceAfter };
  });
}

type LedgerRow = Record<string, unknown>;
const ledgerEntry = (row: LedgerRow) => ({
  id: String(row.id),
  at: new Date(String(row.created_at)).toISOString(),
  type: String(row.entry_type) as HouseAccountEntryType,
  deltaCents: Number(row.delta_balance_cents),
  orderId: row.order_id ? String(row.order_id) : null,
  orderNumber: row.display_number ? String(row.display_number) : null,
  items: row.items ? String(row.items) : null,
  description: String(row.description || ""),
  method: String(row.payment_method || ""),
  reference: String(row.reference || ""),
  by: String(row.actor_name || row.created_by || ""),
  device: String(row.device_label || ""),
});

/** Ledger entries oldest first with each order's number and what's still on it; store dates, inclusive. */
async function ledgerRows(accountId: string, from: string | null, to: string | null) {
  return getSql()`SELECT l.*, o.display_number,
      (SELECT string_agg((i.quantity-i.cancelled_quantity)::text||'x '||i.item_name_snapshot||COALESCE(' ('||NULLIF(i.variant_name_snapshot,'')||')',''), ', ' ORDER BY i.sort_order,i.created_at,i.id)
        FROM ordering_order_items i WHERE i.order_id=l.order_id AND i.quantity>i.cancelled_quantity) items
    FROM ordering_house_account_ledger l LEFT JOIN ordering_orders o ON o.id=l.order_id
    WHERE l.account_id=${accountId}
      AND (${from}::date IS NULL OR (l.created_at AT TIME ZONE 'America/New_York')::date >= ${from}::date)
      AND (${to}::date IS NULL OR (l.created_at AT TIME ZONE 'America/New_York')::date <= ${to}::date)
    ORDER BY l.created_at, l.id`;
}

/** One account with its activity (newest first) for the manager portal. */
export async function houseAccountDetail(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = (await listHouseAccounts({ includeClosed: true, id }))[0];
  if (!row) return null;
  const entries = (await ledgerRows(id, null, null)).reverse().slice(0, 300);
  // Running balance per entry: everything up to and including it.
  let balance = row.balanceCents;
  const activity = entries.map((entry) => { const shown = { ...ledgerEntry(entry), balanceCents: balance }; balance -= Number(entry.delta_balance_cents); return shown; });
  return { account: row, activity, truncated: entries.length === 300 };
}

/** The statement for a date range (store dates, inclusive): balance before, each entry with its running balance, totals. */
export async function houseAccountStatement(input: { id: string; from?: string | null; to?: string | null }) {
  if (!/^[0-9a-f-]{36}$/i.test(input.id)) return null;
  const row = (await listHouseAccounts({ includeClosed: true, id: input.id }))[0];
  if (!row) return null;
  const sql = getSql(), today = storeToday();
  const lastPayment = (await sql`SELECT ((MAX(created_at) AT TIME ZONE 'America/New_York')::date)::text last_payment_day FROM ordering_house_account_ledger WHERE account_id=${input.id} AND entry_type='payment'`)[0]?.last_payment_day as string | null;
  const period = statementPeriod({ from: input.from, to: input.to, today, lastPaymentDate: lastPayment });
  const opening = Number((await sql`SELECT COALESCE(SUM(delta_balance_cents),0)::integer cents FROM ordering_house_account_ledger WHERE account_id=${input.id} AND (created_at AT TIME ZONE 'America/New_York')::date < ${period.from}::date`)[0].cents);
  const rows = runningBalance(opening, (await ledgerRows(input.id, period.from, period.to)).map(ledgerEntry));
  return { account: row, ...period, today, openingCents: opening, rows, totals: statementTotals(opening, rows) };
}

export async function houseAccountReceiptPrinters() {
  const rows = await getSql()`SELECT id,name FROM ordering_hardware_devices WHERE business=${BUSINESS} AND device_type='printer' AND active=TRUE AND adapter_key='network-printer' AND (role='receipt_printer' OR adapter_config->>'receiptEnabled'='true') ORDER BY name`;
  return rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}

/** Prints the statement on a receipt printer. Any employee can, so the customer can get their total at the counter. */
export async function printHouseAccountStatement(input: { id: string; from?: string | null; to?: string | null; printerId: string; actor: OrderingActor }) {
  const statement = await houseAccountStatement(input);
  if (!statement) throw new HouseAccountError("House account was not found.");
  const printer = /^[0-9a-f-]{36}$/i.test(input.printerId) ? (await getSql()`SELECT id,name,adapter_config FROM ordering_hardware_devices WHERE id=${input.printerId} AND business=${BUSINESS} AND device_type='printer' AND active=TRUE AND adapter_key='network-printer' AND (role='receipt_printer' OR adapter_config->>'receiptEnabled'='true')`)[0] : null;
  if (!printer) throw new HouseAccountError("Choose a receipt printer.");
  const lines = statementPrintLines({ accountName: statement.account.name, phone: statement.account.phone, from: statement.from, to: statement.to, openingCents: statement.openingCents, rows: statement.rows, printedBy: input.actor.name });
  try {
    await sendEpsonPrint(printer.adapter_config || {}, lines);
  } catch (error) {
    throw new HouseAccountError(`The statement didn't print on ${String(printer.name)}: ${error instanceof Error ? error.message : "printer connection failed"}.`);
  }
  await audit(input.actor, "house_account_statement_printed", input.id, "", { from: statement.from, to: statement.to, printerId: printer.id, closingCents: statement.totals.closingCents });
  return { printed: true, printer: String(printer.name) };
}
