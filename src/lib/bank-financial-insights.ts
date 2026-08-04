import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { ensureCardStatementSchema } from "@/lib/card-statements";
import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

const MAX_RANGE_DAYS = 5 * 366;

type Interval = "day" | "week" | "month";
type InsightTone = "positive" | "warning" | "critical" | "info";

type TransactionRow = {
  id: string;
  transaction_date: string;
  merchant_name: string;
  description: string;
  signed_amount: string | number;
  direction: "Inflow" | "Outflow";
  pending: boolean;
  category: string;
  account_code: string;
  review_status: string;
  confidence: string | number;
  classification_source: string;
  external_account_id: string;
  account_name: string | null;
  institution_name: string | null;
  account_type: string | null;
  account_subtype: string | null;
  posted: boolean;
};

type AccountRow = {
  id: string;
  institution_name: string;
  name: string;
  official_name: string;
  mask: string;
  account_type: string;
  account_subtype: string;
  current_balance: string | number | null;
  available_balance: string | number | null;
  currency: string;
  active: boolean;
  updated_at: string;
};

type ConnectionRow = {
  id: string;
  provider: string;
  institution_name: string;
  status: string;
  last_sync_at: string | null;
};

type FinancialTransaction = {
  id: string;
  date: string;
  merchant: string;
  description: string;
  amount: number;
  direction: "Inflow" | "Outflow";
  pending: boolean;
  category: string;
  accountCode: string;
  reviewStatus: string;
  confidence: number;
  classificationSource: string;
  externalAccountId: string;
  accountName: string;
  institutionName: string;
  accountType: string;
  accountSubtype: string;
  posted: boolean;
  transferLike: boolean;
};

export type BankingInsight = {
  id: string;
  tone: InsightTone;
  title: string;
  detail: string;
  metric?: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function dateText(value: Date): string {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function parseDate(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid.`);
  return date;
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function daysBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function defaultRange() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 12));
  return { start, end };
}

function requestedRange(startValue?: string, endValue?: string) {
  const fallback = defaultRange();
  const start = startValue ? parseDate(startValue, "Start date") : fallback.start;
  const end = endValue ? parseDate(endValue, "End date") : fallback.end;
  const length = daysBetween(start, end);
  if (length < 0) throw new Error("End date must be on or after the start date.");
  if (length > MAX_RANGE_DAYS) throw new Error("Banking dashboard ranges are limited to five years.");
  const priorEnd = addDays(start, -1);
  const priorStart = addDays(priorEnd, -length);
  return {
    start,
    end,
    startText: dateText(start),
    endText: dateText(end),
    endExclusiveText: dateText(addDays(end, 1)),
    priorStart,
    priorEnd,
    priorStartText: dateText(priorStart),
    priorEndText: dateText(priorEnd),
    priorEndExclusiveText: dateText(addDays(priorEnd, 1)),
    dayCount: length + 1,
  };
}

function intervalFrom(value?: string): Interval {
  return value === "day" || value === "week" ? value : "month";
}

function monthKey(value: string): string {
  return value.slice(0, 7);
}

function mondayKey(value: string): string {
  const date = parseDate(value, "Transaction date");
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return dateText(date);
}

function bucketKey(date: string, interval: Interval): string {
  return interval === "day" ? date : interval === "week" ? mondayKey(date) : monthKey(date);
}

function bucketLabel(key: string, interval: Interval): string {
  if (interval === "month") {
    return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
      .format(new Date(`${key}-01T12:00:00Z`));
  }
  const date = new Date(`${key}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: interval === "week" ? undefined : "2-digit",
    timeZone: "UTC",
  }).format(date);
}

function bucketSequence(start: Date, end: Date, interval: Interval) {
  const result: string[] = [];
  if (interval === "month") {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1, 12));
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1, 12));
    while (cursor <= last) {
      result.push(dateText(cursor).slice(0, 7));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return result;
  }
  if (interval === "week") {
    const cursor = parseDate(mondayKey(dateText(start)), "Week start");
    while (cursor <= end) {
      result.push(dateText(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
    return result;
  }
  const cursor = new Date(start);
  while (cursor <= end) {
    result.push(dateText(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function transferLike(row: Pick<FinancialTransaction, "accountCode" | "category" | "merchant" | "description">): boolean {
  const text = `${row.category} ${row.merchant} ${row.description}`.toLowerCase();
  return row.accountCode === "1100"
    || row.accountCode === "2100"
    || /bank clearing|internal transfer|online transfer|account transfer|credit card payment|card payment|payment thank you|autopay payment/.test(text);
}

function mapTransaction(row: TransactionRow): FinancialTransaction {
  const transaction: FinancialTransaction = {
    id: String(row.id),
    date: String(row.transaction_date).slice(0, 10),
    merchant: clean(row.merchant_name, 240),
    description: clean(row.description, 600),
    amount: roundMoney(numeric(row.signed_amount)),
    direction: row.direction,
    pending: Boolean(row.pending),
    category: clean(row.category, 140) || "Uncategorized",
    accountCode: clean(row.account_code, 30),
    reviewStatus: clean(row.review_status, 50),
    confidence: Math.max(0, Math.min(1, numeric(row.confidence))),
    classificationSource: clean(row.classification_source, 160),
    externalAccountId: clean(row.external_account_id, 180),
    accountName: clean(row.account_name, 160) || "Unmapped account",
    institutionName: clean(row.institution_name, 160) || "Unknown institution",
    accountType: clean(row.account_type, 60),
    accountSubtype: clean(row.account_subtype, 80),
    posted: Boolean(row.posted),
    transferLike: false,
  };
  transaction.transferLike = transferLike(transaction);
  return transaction;
}

function percentChange(current: number, prior: number): number | null {
  if (!prior) return current ? null : 0;
  return Math.round(((current - prior) / Math.abs(prior)) * 1000) / 10;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarize(transactions: FinancialTransaction[]) {
  const operating = transactions.filter((item) => !item.transferLike);
  const inflows = roundMoney(operating.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0));
  const outflows = roundMoney(Math.abs(operating.filter((item) => item.amount < 0).reduce((sum, item) => sum + item.amount, 0)));
  const transfers = roundMoney(transactions.filter((item) => item.transferLike).reduce((sum, item) => sum + Math.abs(item.amount), 0));
  const uncategorized = operating.filter((item) => !item.accountCode || item.category === "Uncategorized");
  return {
    inflows,
    outflows,
    netCashFlow: roundMoney(inflows - outflows),
    transfers,
    transactionCount: transactions.length,
    operatingTransactionCount: operating.length,
    pendingCount: transactions.filter((item) => item.pending).length,
    postedCount: transactions.filter((item) => item.posted).length,
    reviewedCount: transactions.filter((item) => item.reviewStatus === "Approved").length,
    uncategorizedCount: uncategorized.length,
    uncategorizedAmount: roundMoney(uncategorized.reduce((sum, item) => sum + Math.abs(item.amount), 0)),
  };
}

function aggregateTrend(transactions: FinancialTransaction[], start: Date, end: Date, interval: Interval) {
  const buckets = new Map<string, { inflow: number; outflow: number; net: number; transfers: number; transactions: number }>();
  for (const key of bucketSequence(start, end, interval)) {
    buckets.set(key, { inflow: 0, outflow: 0, net: 0, transfers: 0, transactions: 0 });
  }
  for (const transaction of transactions) {
    const key = bucketKey(transaction.date, interval);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.transactions += 1;
    if (transaction.transferLike) {
      bucket.transfers += Math.abs(transaction.amount);
    } else if (transaction.amount >= 0) {
      bucket.inflow += transaction.amount;
      bucket.net += transaction.amount;
    } else {
      bucket.outflow += Math.abs(transaction.amount);
      bucket.net += transaction.amount;
    }
  }
  return [...buckets.entries()].map(([key, value]) => ({
    key,
    label: bucketLabel(key, interval),
    inflow: roundMoney(value.inflow),
    outflow: roundMoney(value.outflow),
    net: roundMoney(value.net),
    transfers: roundMoney(value.transfers),
    transactions: value.transactions,
  }));
}

function categoryTotals(transactions: FinancialTransaction[]) {
  const map = new Map<string, { amount: number; count: number }>();
  for (const transaction of transactions) {
    if (transaction.amount >= 0 || transaction.transferLike) continue;
    const category = transaction.category || "Uncategorized";
    const current = map.get(category) || { amount: 0, count: 0 };
    current.amount += Math.abs(transaction.amount);
    current.count += 1;
    map.set(category, current);
  }
  return [...map.entries()]
    .map(([category, value]) => ({ category, amount: roundMoney(value.amount), count: value.count }))
    .sort((left, right) => right.amount - left.amount);
}

function merchantTotals(transactions: FinancialTransaction[]) {
  const map = new Map<string, { amount: number; count: number; category: string }>();
  for (const transaction of transactions) {
    if (transaction.amount >= 0 || transaction.transferLike) continue;
    const merchant = transaction.merchant || transaction.description || "Unknown merchant";
    const current = map.get(merchant) || { amount: 0, count: 0, category: transaction.category };
    current.amount += Math.abs(transaction.amount);
    current.count += 1;
    if (transaction.category && current.category === "Uncategorized") current.category = transaction.category;
    map.set(merchant, current);
  }
  return [...map.entries()]
    .map(([merchant, value]) => ({ merchant, amount: roundMoney(value.amount), count: value.count, category: value.category }))
    .sort((left, right) => right.amount - left.amount);
}

function categoryComparison(current: ReturnType<typeof categoryTotals>, prior: ReturnType<typeof categoryTotals>) {
  const priorMap = new Map(prior.map((item) => [item.category, item.amount]));
  return current.slice(0, 12).map((item) => ({
    ...item,
    priorAmount: roundMoney(priorMap.get(item.category) || 0),
    changePercent: percentChange(item.amount, priorMap.get(item.category) || 0),
  }));
}

function anomalies(transactions: FinancialTransaction[]) {
  const expenses = transactions.filter((item) => item.amount < 0 && !item.transferLike && !item.pending);
  const typical = median(expenses.map((item) => Math.abs(item.amount)));
  const threshold = Math.max(500, typical * 3);
  return expenses
    .filter((item) => Math.abs(item.amount) >= threshold)
    .sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount))
    .slice(0, 10)
    .map((item) => ({
      id: item.id,
      date: item.date,
      merchant: item.merchant || item.description,
      description: item.description,
      category: item.category,
      amount: roundMoney(Math.abs(item.amount)),
      accountName: item.accountName,
      reason: typical > 0
        ? `${(Math.abs(item.amount) / typical).toFixed(1)}× the median outflow for this period`
        : "Large outflow for the selected period",
    }));
}

function accountSummary(rows: AccountRow[]) {
  const accounts = rows.map((row) => ({
    id: String(row.id),
    institutionName: clean(row.institution_name, 160),
    name: clean(row.name, 160),
    officialName: clean(row.official_name, 200),
    mask: clean(row.mask, 12),
    accountType: clean(row.account_type, 60),
    accountSubtype: clean(row.account_subtype, 80),
    currentBalance: row.current_balance === null ? null : roundMoney(numeric(row.current_balance)),
    availableBalance: row.available_balance === null ? null : roundMoney(numeric(row.available_balance)),
    currency: clean(row.currency, 10) || "USD",
    active: Boolean(row.active),
    updatedAt: String(row.updated_at),
  }));
  const cashAccounts = accounts.filter((account) => /depository|checking|savings|cash/i.test(`${account.accountType} ${account.accountSubtype}`));
  const cardAccounts = accounts.filter((account) => /credit|card/i.test(`${account.accountType} ${account.accountSubtype}`));
  return {
    accounts,
    currentCash: roundMoney(cashAccounts.reduce((sum, account) => sum + Math.max(0, account.currentBalance || 0), 0)),
    availableCash: roundMoney(cashAccounts.reduce((sum, account) => sum + Math.max(0, account.availableBalance ?? account.currentBalance ?? 0), 0)),
    cardBalance: roundMoney(cardAccounts.reduce((sum, account) => sum + Math.abs(account.currentBalance || 0), 0)),
    cashAccountCount: cashAccounts.length,
    cardAccountCount: cardAccounts.length,
  };
}

function buildInsights(input: {
  current: ReturnType<typeof summarize>;
  prior: ReturnType<typeof summarize>;
  accounts: ReturnType<typeof accountSummary>;
  categories: ReturnType<typeof categoryComparison>;
  merchants: ReturnType<typeof merchantTotals>;
  anomalyRows: ReturnType<typeof anomalies>;
  unmatchedStatements: number;
  staleConnections: number;
  intervalCount: number;
}) {
  const insights: BankingInsight[] = [];
  const netChange = percentChange(input.current.netCashFlow, input.prior.netCashFlow);
  insights.push({
    id: "net-cash-flow",
    tone: input.current.netCashFlow >= 0 ? "positive" : "critical",
    title: input.current.netCashFlow >= 0 ? "Positive operating cash flow" : "Operating cash declined",
    detail: input.current.netCashFlow >= 0
      ? `Cash received exceeded operating outflows by $${Math.abs(input.current.netCashFlow).toLocaleString("en-US", { maximumFractionDigits: 0 })} during the selected period.`
      : `Operating outflows exceeded cash received by $${Math.abs(input.current.netCashFlow).toLocaleString("en-US", { maximumFractionDigits: 0 })} during the selected period.`,
    metric: netChange === null ? "No comparable prior base" : `${netChange >= 0 ? "+" : ""}${netChange}% vs prior period`,
  });

  const averageMonthlyOutflow = input.intervalCount > 0 ? input.current.outflows / input.intervalCount : 0;
  if (input.accounts.currentCash > 0 && averageMonthlyOutflow > 0) {
    const runway = input.accounts.currentCash / averageMonthlyOutflow;
    insights.push({
      id: "cash-runway",
      tone: runway < 1 ? "critical" : runway < 2 ? "warning" : "info",
      title: "Cash coverage",
      detail: `Connected depository balances cover about ${runway.toFixed(1)} average selected-period month${runway.toFixed(1) === "1.0" ? "" : "s"} of operating outflows. This is a cash estimate, not a profit forecast.`,
      metric: `$${input.accounts.currentCash.toLocaleString("en-US", { maximumFractionDigits: 0 })} connected cash`,
    });
  }

  const topCategory = input.categories[0];
  if (topCategory && input.current.outflows > 0) {
    const share = Math.round((topCategory.amount / input.current.outflows) * 100);
    const change = topCategory.changePercent;
    insights.push({
      id: "top-category",
      tone: share >= 45 ? "warning" : "info",
      title: `${topCategory.category} is the largest outflow category`,
      detail: `${topCategory.category} represents ${share}% of operating outflows${change === null ? "" : ` and is ${Math.abs(change)}% ${change >= 0 ? "higher" : "lower"} than the prior period`}.`,
      metric: `$${topCategory.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    });
  }

  const topMerchant = input.merchants[0];
  if (topMerchant && input.current.outflows > 0) {
    const share = Math.round((topMerchant.amount / input.current.outflows) * 100);
    insights.push({
      id: "merchant-concentration",
      tone: share >= 30 ? "warning" : "info",
      title: "Largest payee concentration",
      detail: `${topMerchant.merchant} received ${share}% of operating outflows across ${topMerchant.count} transaction${topMerchant.count === 1 ? "" : "s"}.`,
      metric: `$${topMerchant.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    });
  }

  if (input.current.uncategorizedCount > 0) {
    insights.push({
      id: "uncategorized",
      tone: input.current.uncategorizedAmount >= 1000 ? "warning" : "info",
      title: "Transactions still need coding",
      detail: `${input.current.uncategorizedCount} transaction${input.current.uncategorizedCount === 1 ? "" : "s"} totaling $${input.current.uncategorizedAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })} remain uncategorized or lack an account code.`,
      metric: `${input.current.uncategorizedCount} open`,
    });
  }

  if (input.anomalyRows[0]) {
    const anomaly = input.anomalyRows[0];
    insights.push({
      id: "largest-anomaly",
      tone: "warning",
      title: "Large transaction to review",
      detail: `${anomaly.merchant} posted a $${anomaly.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} outflow on ${anomaly.date}, ${anomaly.reason.toLowerCase()}.`,
      metric: anomaly.category,
    });
  }

  if (input.unmatchedStatements > 0) {
    insights.push({
      id: "card-statements",
      tone: "warning",
      title: "Card statements need reconciliation",
      detail: `${input.unmatchedStatements} credit-card statement${input.unmatchedStatements === 1 ? "" : "s"} still need a confirmed matching bank payment.`,
      metric: `${input.unmatchedStatements} unmatched`,
    });
  }

  if (input.staleConnections > 0) {
    insights.push({
      id: "stale-feeds",
      tone: "critical",
      title: "Bank feeds may be stale",
      detail: `${input.staleConnections} active connection${input.staleConnections === 1 ? " has" : "s have"} not synchronized within the last 48 hours. Dashboard totals may be incomplete.`,
      metric: `${input.staleConnections} stale`,
    });
  }

  return insights.slice(0, 8);
}

export async function bankFinancialInsights(input: {
  business: Business;
  start?: string;
  end?: string;
  interval?: string;
}) {
  await ensureAccountingControlSchema();
  await ensureCardStatementSchema();
  const range = requestedRange(input.start, input.end);
  const interval = intervalFrom(input.interval);
  const sql = getSql();

  const [transactionRows, priorRows, accountRows, connectionRows, statementRows] = await Promise.all([
    sql`
      SELECT t.id, t.transaction_date::text, t.merchant_name, t.description, t.signed_amount,
        t.direction, t.pending, t.category, t.account_code, t.review_status, t.confidence,
        t.classification_source, t.external_account_id,
        a.name AS account_name, a.institution_name, a.account_type, a.account_subtype,
        EXISTS (SELECT 1 FROM bank_transaction_postings p WHERE p.bank_transaction_id = t.id) AS posted
      FROM bank_transactions t
      LEFT JOIN bank_accounts a ON a.external_account_id = t.external_account_id
      WHERE t.business = ${input.business}
        AND t.removed = FALSE
        AND t.transaction_date >= ${range.startText}::date
        AND t.transaction_date < ${range.endExclusiveText}::date
      ORDER BY t.transaction_date, t.created_at
      LIMIT 20000
    ` as unknown as TransactionRow[],
    sql`
      SELECT t.id, t.transaction_date::text, t.merchant_name, t.description, t.signed_amount,
        t.direction, t.pending, t.category, t.account_code, t.review_status, t.confidence,
        t.classification_source, t.external_account_id,
        a.name AS account_name, a.institution_name, a.account_type, a.account_subtype,
        EXISTS (SELECT 1 FROM bank_transaction_postings p WHERE p.bank_transaction_id = t.id) AS posted
      FROM bank_transactions t
      LEFT JOIN bank_accounts a ON a.external_account_id = t.external_account_id
      WHERE t.business = ${input.business}
        AND t.removed = FALSE
        AND t.transaction_date >= ${range.priorStartText}::date
        AND t.transaction_date < ${range.priorEndExclusiveText}::date
      ORDER BY t.transaction_date, t.created_at
      LIMIT 20000
    ` as unknown as TransactionRow[],
    sql`
      SELECT id, institution_name, name, official_name, mask, account_type, account_subtype,
        current_balance, available_balance, currency, active, updated_at
      FROM bank_accounts
      WHERE business = ${input.business} AND active = TRUE
      ORDER BY institution_name, name
    ` as unknown as AccountRow[],
    sql`
      SELECT id, provider, institution_name, status, last_sync_at
      FROM integration_connections
      WHERE business = ${input.business} AND status = 'Active'
      ORDER BY provider, institution_name
    ` as unknown as ConnectionRow[],
    sql`
      SELECT match_status, COUNT(*)::integer AS count
      FROM credit_card_statements
      WHERE business = ${input.business}
      GROUP BY match_status
    ` as unknown as Array<{ match_status: string; count: number | string }>,
  ]);

  const transactions = transactionRows.map(mapTransaction);
  const priorTransactions = priorRows.map(mapTransaction);
  const current = summarize(transactions);
  const prior = summarize(priorTransactions);
  const accounts = accountSummary(accountRows);
  const currentCategories = categoryTotals(transactions);
  const priorCategories = categoryTotals(priorTransactions);
  const categories = categoryComparison(currentCategories, priorCategories);
  const merchants = merchantTotals(transactions).slice(0, 12);
  const anomalyRows = anomalies(transactions);
  const trend = aggregateTrend(transactions, range.start, range.end, interval);
  const unmatchedStatements = statementRows
    .filter((row) => row.match_status !== "Matched")
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const matchedStatements = statementRows
    .filter((row) => row.match_status === "Matched")
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const staleConnections = connectionRows.filter((row) => {
    if (!row.last_sync_at) return true;
    return Date.now() - new Date(row.last_sync_at).getTime() > 48 * 60 * 60 * 1000;
  }).length;
  const intervalCount = interval === "month"
    ? Math.max(1, trend.length)
    : Math.max(1, range.dayCount / 30.4375);

  const insights = buildInsights({
    current,
    prior,
    accounts,
    categories,
    merchants,
    anomalyRows,
    unmatchedStatements,
    staleConnections,
    intervalCount,
  });

  return {
    business: input.business,
    range: {
      start: range.startText,
      end: range.endText,
      priorStart: range.priorStartText,
      priorEnd: range.priorEndText,
      dayCount: range.dayCount,
      interval,
    },
    summary: {
      ...current,
      currentCash: accounts.currentCash,
      availableCash: accounts.availableCash,
      cardBalance: accounts.cardBalance,
      averageMonthlyInflow: roundMoney(current.inflows / intervalCount),
      averageMonthlyOutflow: roundMoney(current.outflows / intervalCount),
      cashRunwayMonths: current.outflows > 0
        ? Math.round((accounts.currentCash / (current.outflows / intervalCount)) * 10) / 10
        : null,
      inflowChangePercent: percentChange(current.inflows, prior.inflows),
      outflowChangePercent: percentChange(current.outflows, prior.outflows),
      netChangePercent: percentChange(current.netCashFlow, prior.netCashFlow),
      postingPercent: current.transactionCount
        ? Math.round((current.postedCount / current.transactionCount) * 100)
        : 0,
      codingPercent: current.transactionCount
        ? Math.round(((current.transactionCount - current.uncategorizedCount) / current.transactionCount) * 100)
        : 0,
    },
    priorSummary: prior,
    trend,
    categories,
    merchants,
    accounts: accounts.accounts,
    reconciliation: {
      matchedStatements,
      unmatchedStatements,
      staleConnections,
      activeConnections: connectionRows.length,
      connections: connectionRows.map((row) => ({
        id: row.id,
        provider: row.provider,
        institutionName: row.institution_name,
        status: row.status,
        lastSyncAt: row.last_sync_at,
        stale: !row.last_sync_at || Date.now() - new Date(row.last_sync_at).getTime() > 48 * 60 * 60 * 1000,
      })),
    },
    anomalies: anomalyRows,
    insights,
    generatedAt: new Date().toISOString(),
  };
}
