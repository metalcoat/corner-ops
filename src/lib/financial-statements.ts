import { ensureAccountingControlSchema } from "@/lib/accounting-control";
import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function validDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD.`);
  return value;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayCount(start: string, end: string): number {
  return Math.round((new Date(`${end}T12:00:00Z`).getTime() - new Date(`${start}T12:00:00Z`).getTime()) / 86_400_000) + 1;
}

export async function financialStatements(input: {
  business: Business;
  start: string;
  end: string;
}) {
  await ensureAccountingControlSchema();
  const start = validDate(input.start, "Statement start date");
  const end = validDate(input.end, "Statement end date");
  if (end < start) throw new Error("Statement end date must not precede the start date.");
  const days = dayCount(start, end);
  if (days > 5 * 366) throw new Error("Financial statement ranges cannot exceed five years.");
  const priorEnd = addDays(start, -1);
  const priorStart = addDays(priorEnd, -(days - 1));
  const sql = getSql();

  const [accountRows, ledgerRows, cashRows, entryRows] = await Promise.all([
    sql`
      SELECT a.code, a.name, a.account_type,
        COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ${start}::date AND ${end}::date THEN l.debit ELSE 0 END), 0) AS period_debit,
        COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ${start}::date AND ${end}::date THEN l.credit ELSE 0 END), 0) AS period_credit,
        COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ${priorStart}::date AND ${priorEnd}::date THEN l.debit ELSE 0 END), 0) AS prior_debit,
        COALESCE(SUM(CASE WHEN e.entry_date BETWEEN ${priorStart}::date AND ${priorEnd}::date THEN l.credit ELSE 0 END), 0) AS prior_credit,
        COALESCE(SUM(CASE WHEN e.entry_date <= ${end}::date THEN l.debit ELSE 0 END), 0) AS ending_debit,
        COALESCE(SUM(CASE WHEN e.entry_date <= ${end}::date THEN l.credit ELSE 0 END), 0) AS ending_credit
      FROM accounting_accounts a
      LEFT JOIN journal_lines l ON l.account_id = a.id
      LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.business = a.business
      WHERE a.business = ${input.business} AND a.active = TRUE
      GROUP BY a.code, a.name, a.account_type
      ORDER BY a.code
    ` as unknown as Array<Record<string, unknown>>,
    sql`
      SELECT e.id, e.entry_date, e.description, e.source, e.reference, e.created_by, e.created_at,
        a.code, a.name AS account_name, a.account_type, l.debit, l.credit
      FROM journal_entries e
      JOIN journal_lines l ON l.entry_id = e.id
      JOIN accounting_accounts a ON a.id = l.account_id
      WHERE e.business = ${input.business}
        AND e.entry_date BETWEEN ${start}::date AND ${end}::date
      ORDER BY e.entry_date DESC, e.created_at DESC, a.code
      LIMIT 2000
    ` as unknown as Array<Record<string, unknown>>,
    sql`
      SELECT TO_CHAR(DATE_TRUNC('month', e.entry_date), 'YYYY-MM') AS month,
        COALESCE(SUM(l.debit - l.credit), 0) AS net_cash,
        COALESCE(SUM(l.debit), 0) AS cash_in,
        COALESCE(SUM(l.credit), 0) AS cash_out
      FROM journal_entries e
      JOIN journal_lines l ON l.entry_id = e.id
      JOIN accounting_accounts a ON a.id = l.account_id
      WHERE e.business = ${input.business}
        AND e.entry_date BETWEEN ${start}::date AND ${end}::date
        AND a.account_type = 'Asset' AND a.code = '1000'
      GROUP BY DATE_TRUNC('month', e.entry_date)
      ORDER BY month
    ` as unknown as Array<Record<string, unknown>>,
    sql`
      SELECT e.id, e.entry_date, e.description, e.source, e.reference,
        COALESCE(SUM(l.debit), 0) AS debit,
        COALESCE(SUM(l.credit), 0) AS credit,
        COUNT(l.id)::INTEGER AS lines
      FROM journal_entries e
      JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.business = ${input.business}
        AND e.entry_date BETWEEN ${start}::date AND ${end}::date
      GROUP BY e.id
      ORDER BY e.entry_date DESC, e.created_at DESC
      LIMIT 500
    ` as unknown as Array<Record<string, unknown>>,
  ]);

  const accounts = accountRows.map((row) => {
    const accountType = String(row.account_type);
    const normalDebit = accountType === "Asset" || accountType === "Expense";
    const periodDebit = numeric(row.period_debit);
    const periodCredit = numeric(row.period_credit);
    const priorDebit = numeric(row.prior_debit);
    const priorCredit = numeric(row.prior_credit);
    const endingDebit = numeric(row.ending_debit);
    const endingCredit = numeric(row.ending_credit);
    return {
      code: String(row.code),
      name: String(row.name),
      accountType,
      periodDebit: roundMoney(periodDebit),
      periodCredit: roundMoney(periodCredit),
      priorDebit: roundMoney(priorDebit),
      priorCredit: roundMoney(priorCredit),
      endingDebit: roundMoney(endingDebit),
      endingCredit: roundMoney(endingCredit),
      periodBalance: roundMoney(normalDebit ? periodDebit - periodCredit : periodCredit - periodDebit),
      priorBalance: roundMoney(normalDebit ? priorDebit - priorCredit : priorCredit - priorDebit),
      endingBalance: roundMoney(normalDebit ? endingDebit - endingCredit : endingCredit - endingDebit),
    };
  });

  const revenue = accounts.filter((row) => row.accountType === "Revenue");
  const expenses = accounts.filter((row) => row.accountType === "Expense");
  const assets = accounts.filter((row) => row.accountType === "Asset");
  const liabilities = accounts.filter((row) => row.accountType === "Liability");
  const equity = accounts.filter((row) => row.accountType === "Equity");
  const totalRevenue = roundMoney(revenue.reduce((sum, row) => sum + row.periodBalance, 0));
  const totalExpenses = roundMoney(expenses.reduce((sum, row) => sum + row.periodBalance, 0));
  const priorRevenue = roundMoney(revenue.reduce((sum, row) => sum + row.priorBalance, 0));
  const priorExpenses = roundMoney(expenses.reduce((sum, row) => sum + row.priorBalance, 0));
  const netIncome = roundMoney(totalRevenue - totalExpenses);
  const priorNetIncome = roundMoney(priorRevenue - priorExpenses);

  const allTimeRevenue = roundMoney(revenue.reduce((sum, row) => sum + row.endingBalance, 0));
  const allTimeExpenses = roundMoney(expenses.reduce((sum, row) => sum + row.endingBalance, 0));
  const retainedEarnings = roundMoney(allTimeRevenue - allTimeExpenses);
  const totalAssets = roundMoney(assets.reduce((sum, row) => sum + row.endingBalance, 0));
  const totalLiabilities = roundMoney(liabilities.reduce((sum, row) => sum + row.endingBalance, 0));
  const statedEquity = roundMoney(equity.reduce((sum, row) => sum + row.endingBalance, 0));
  const totalEquity = roundMoney(statedEquity + retainedEarnings);
  const balanceDifference = roundMoney(totalAssets - totalLiabilities - totalEquity);

  const journalMap = new Map<string, {
    id: string;
    date: string;
    description: string;
    source: string;
    reference: string;
    createdBy: string;
    createdAt: string;
    totalDebit: number;
    totalCredit: number;
    lines: Array<{ code: string; accountName: string; accountType: string; debit: number; credit: number }>;
  }>();
  for (const row of ledgerRows) {
    const id = String(row.id);
    const entry = journalMap.get(id) || {
      id,
      date: String(row.entry_date).slice(0, 10),
      description: String(row.description || ""),
      source: String(row.source || ""),
      reference: String(row.reference || ""),
      createdBy: String(row.created_by || ""),
      createdAt: String(row.created_at || ""),
      totalDebit: 0,
      totalCredit: 0,
      lines: [],
    };
    const debit = roundMoney(numeric(row.debit));
    const credit = roundMoney(numeric(row.credit));
    entry.totalDebit = roundMoney(entry.totalDebit + debit);
    entry.totalCredit = roundMoney(entry.totalCredit + credit);
    entry.lines.push({
      code: String(row.code),
      accountName: String(row.account_name),
      accountType: String(row.account_type),
      debit,
      credit,
    });
    journalMap.set(id, entry);
  }

  return {
    business: input.business,
    generatedAt: new Date().toISOString(),
    range: { start, end, priorStart, priorEnd, dayCount: days },
    profitAndLoss: {
      revenue,
      expenses,
      totalRevenue,
      totalExpenses,
      netIncome,
      priorRevenue,
      priorExpenses,
      priorNetIncome,
      grossMarginPercent: totalRevenue ? roundMoney((totalRevenue - (accounts.find((row) => row.code === "5000")?.periodBalance || 0)) / totalRevenue * 100) : null,
    },
    balanceSheet: {
      asOf: end,
      assets,
      liabilities,
      equity,
      retainedEarnings,
      totalAssets,
      totalLiabilities,
      statedEquity,
      totalEquity,
      balanceDifference,
      balanced: Math.abs(balanceDifference) < 0.01,
    },
    cashFlow: {
      directMonthly: cashRows.map((row) => ({
        month: String(row.month),
        cashIn: roundMoney(numeric(row.cash_in)),
        cashOut: roundMoney(numeric(row.cash_out)),
        netCash: roundMoney(numeric(row.net_cash)),
      })),
      cashIn: roundMoney(cashRows.reduce((sum, row) => sum + numeric(row.cash_in), 0)),
      cashOut: roundMoney(cashRows.reduce((sum, row) => sum + numeric(row.cash_out), 0)),
      netCash: roundMoney(cashRows.reduce((sum, row) => sum + numeric(row.net_cash), 0)),
      method: "Direct movement in account 1000 Operating Cash",
    },
    trialBalance: {
      accounts,
      totalDebits: roundMoney(accounts.reduce((sum, row) => sum + row.endingDebit, 0)),
      totalCredits: roundMoney(accounts.reduce((sum, row) => sum + row.endingCredit, 0)),
    },
    journalEntries: Array.from(journalMap.values()),
    entrySummary: entryRows.map((row) => ({
      id: String(row.id),
      date: String(row.entry_date).slice(0, 10),
      description: String(row.description || ""),
      source: String(row.source || ""),
      reference: String(row.reference || ""),
      debit: roundMoney(numeric(row.debit)),
      credit: roundMoney(numeric(row.credit)),
      lines: Math.round(numeric(row.lines)),
    })),
  };
}
