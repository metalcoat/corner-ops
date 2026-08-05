import { getSql } from "@/lib/db";
import { ensureFinanceOperationsSchema } from "@/lib/finance-operations-schema";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const FORECAST_WEEKS = 13;

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

function parseDate(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function currentLocalDate(): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value || 0);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day"), 12));
}

function currentMonday(): Date {
  const date = currentLocalDate();
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (weekday === 0 ? 6 : weekday - 1));
  return date;
}

function weekIndex(start: Date, value: string | Date): number {
  const date = value instanceof Date ? value : parseDate(value);
  return Math.floor((date.getTime() - start.getTime()) / (7 * 86_400_000));
}

function nextMonthly(date: Date): Date {
  const day = date.getUTCDate();
  const result = new Date(date);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0, 12)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export async function thirteenWeekCashForecast(input: {
  business: Business;
  salesAdjustmentPercent?: number;
  expenseAdjustmentPercent?: number;
  minimumCash?: number;
}) {
  await ensureFinanceOperationsSchema();
  const sql = getSql();
  const start = currentMonday();
  const end = addDays(start, FORECAST_WEEKS * 7);
  const historyStart = addDays(start, -13 * 7);
  const salesFactor = Math.max(0, 1 + Number(input.salesAdjustmentPercent || 0) / 100);
  const expenseFactor = Math.max(0, 1 + Number(input.expenseAdjustmentPercent || 0) / 100);
  const minimumCash = Math.max(0, Number(input.minimumCash || 0));

  const [cashRows, historyRows, payrollRows, billRows, eventRows] = await Promise.all([
    sql`
      SELECT
        COALESCE(SUM(CASE WHEN LOWER(account_type) <> 'credit' THEN current_balance ELSE 0 END), 0) AS cash,
        COALESCE(SUM(CASE WHEN LOWER(account_type) = 'credit' THEN ABS(current_balance) ELSE 0 END), 0) AS card_balance,
        COUNT(*) FILTER (WHERE active = TRUE)::INTEGER AS account_count
      FROM bank_accounts
      WHERE business = ${input.business} AND active = TRUE
    ` as unknown as Array<Record<string, unknown>>,
    sql`
      SELECT
        COALESCE(SUM(CASE
          WHEN signed_amount > 0
            AND COALESCE(account_code, '') <> '1100'
            AND LOWER(COALESCE(category, '')) NOT LIKE '%transfer%'
            AND LOWER(COALESCE(description, '')) NOT LIKE '%transfer%'
          THEN signed_amount ELSE 0 END), 0) AS inflows,
        COALESCE(SUM(CASE
          WHEN signed_amount < 0
            AND COALESCE(account_code, '') NOT IN ('1100', '2100', '5100')
            AND LOWER(COALESCE(category, '')) NOT LIKE '%transfer%'
            AND LOWER(COALESCE(category, '')) NOT LIKE '%credit card%'
            AND LOWER(COALESCE(description, '')) NOT LIKE '%transfer%'
          THEN ABS(signed_amount) ELSE 0 END), 0) AS non_payroll_outflows,
        COALESCE(SUM(CASE
          WHEN signed_amount < 0
            AND (COALESCE(account_code, '') = '5100' OR LOWER(COALESCE(category, '')) LIKE '%payroll%')
          THEN ABS(signed_amount) ELSE 0 END), 0) AS payroll_outflows
      FROM bank_transactions
      WHERE business = ${input.business} AND removed = FALSE AND pending = FALSE
        AND transaction_date >= ${dateText(historyStart)}::date
        AND transaction_date < ${dateText(start)}::date
    ` as unknown as Array<Record<string, unknown>>,
    sql`
      SELECT TO_CHAR((s.starts_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS shift_date,
        COALESCE(SUM(
          GREATEST(0,
            EXTRACT(EPOCH FROM (s.ends_at - s.starts_at)) / 3600
            - COALESCE(s.meal_break_minutes, 0) / 60.0
            - COALESCE(s.extra_meal_break_minutes, 0) / 60.0
          ) * COALESCE(e.hourly_rate, 0)
        ), 0) AS payroll
      FROM schedule_shifts s
      JOIN employees e ON e.id = s.employee_id AND e.business = s.business
      WHERE s.business = ${input.business}
        AND s.status <> 'Cancelled'
        AND s.starts_at >= ${dateText(start)}::date
        AND s.starts_at < ${dateText(end)}::date
      GROUP BY shift_date
      ORDER BY shift_date
    ` as unknown as Array<{ shift_date: string; payroll: string | number }>,
    sql`
      SELECT id, vendor, invoice_number, due_date, total_amount
      FROM vendor_bills
      WHERE business = ${input.business} AND status = 'Open'
        AND due_date < ${dateText(end)}::date
      ORDER BY due_date, vendor
    ` as unknown as Array<{
      id: string;
      vendor: string;
      invoice_number: string;
      due_date: string;
      total_amount: string | number;
    }>,
    sql`
      SELECT id, event_date, description, amount, direction, recurrence
      FROM forecast_events
      WHERE business = ${input.business} AND active = TRUE
        AND event_date < ${dateText(end)}::date
      ORDER BY event_date
    ` as unknown as Array<{
      id: string;
      event_date: string;
      description: string;
      amount: string | number;
      direction: "Inflow" | "Outflow";
      recurrence: "None" | "Weekly" | "Monthly";
    }>,
  ]);

  const currentCash = roundMoney(numeric(cashRows[0]?.cash));
  const historicalWeeklyInflows = roundMoney(numeric(historyRows[0]?.inflows) / 13);
  const historicalWeeklyOperatingOutflows = roundMoney(numeric(historyRows[0]?.non_payroll_outflows) / 13);
  const historicalWeeklyPayroll = roundMoney(numeric(historyRows[0]?.payroll_outflows) / 13);

  const weeks = Array.from({ length: FORECAST_WEEKS }, (_, index) => {
    const weekStart = addDays(start, index * 7);
    const weekEnd = addDays(weekStart, 6);
    return {
      index,
      weekStart: dateText(weekStart),
      weekEnd: dateText(weekEnd),
      openingCash: 0,
      baselineInflows: roundMoney(historicalWeeklyInflows * salesFactor),
      baselineOperatingOutflows: roundMoney(historicalWeeklyOperatingOutflows * expenseFactor),
      payroll: 0,
      bills: 0,
      manualInflows: 0,
      manualOutflows: 0,
      endingCash: 0,
      belowMinimum: false,
      details: [] as Array<{ type: string; date: string; description: string; amount: number }>,
    };
  });

  for (const row of payrollRows) {
    const index = weekIndex(start, row.shift_date);
    if (index < 0 || index >= weeks.length) continue;
    const amount = roundMoney(numeric(row.payroll));
    weeks[index].payroll += amount;
    weeks[index].details.push({ type: "Payroll", date: row.shift_date, description: "Scheduled payroll", amount });
  }

  for (const week of weeks) {
    if (week.payroll <= 0) {
      week.payroll = historicalWeeklyPayroll;
      if (historicalWeeklyPayroll > 0) {
        week.details.push({ type: "Payroll estimate", date: week.weekStart, description: "Historical weekly payroll average", amount: historicalWeeklyPayroll });
      }
    }
  }

  for (const bill of billRows) {
    const due = parseDate(bill.due_date);
    const index = Math.max(0, weekIndex(start, due));
    if (index >= weeks.length) continue;
    const amount = roundMoney(numeric(bill.total_amount));
    weeks[index].bills += amount;
    weeks[index].details.push({
      type: "Bill",
      date: bill.due_date,
      description: `${bill.vendor}${bill.invoice_number ? ` · ${bill.invoice_number}` : ""}`,
      amount,
    });
  }

  for (const event of eventRows) {
    let eventDate = parseDate(event.event_date);
    let guard = 0;
    while (eventDate < end && guard < 60) {
      const index = weekIndex(start, eventDate);
      if (index >= 0 && index < weeks.length) {
        const amount = roundMoney(numeric(event.amount));
        if (event.direction === "Inflow") weeks[index].manualInflows += amount;
        else weeks[index].manualOutflows += amount;
        weeks[index].details.push({
          type: event.direction === "Inflow" ? "Manual inflow" : "Manual outflow",
          date: dateText(eventDate),
          description: event.description,
          amount,
        });
      }
      if (event.recurrence === "None") break;
      eventDate = event.recurrence === "Weekly" ? addDays(eventDate, 7) : nextMonthly(eventDate);
      guard += 1;
    }
  }

  let runningCash = currentCash;
  let lowestCash = currentCash;
  let lowestWeek = weeks[0]?.weekEnd || dateText(start);
  for (const week of weeks) {
    week.openingCash = roundMoney(runningCash);
    const inflows = week.baselineInflows + week.manualInflows;
    const outflows = week.baselineOperatingOutflows + week.payroll + week.bills + week.manualOutflows;
    runningCash = roundMoney(runningCash + inflows - outflows);
    week.endingCash = runningCash;
    week.belowMinimum = runningCash < minimumCash;
    if (runningCash < lowestCash) {
      lowestCash = runningCash;
      lowestWeek = week.weekEnd;
    }
    week.baselineInflows = roundMoney(week.baselineInflows);
    week.baselineOperatingOutflows = roundMoney(week.baselineOperatingOutflows);
    week.payroll = roundMoney(week.payroll);
    week.bills = roundMoney(week.bills);
    week.manualInflows = roundMoney(week.manualInflows);
    week.manualOutflows = roundMoney(week.manualOutflows);
  }

  const firstBelow = weeks.find((week) => week.belowMinimum) || null;
  const totalBills = roundMoney(billRows.reduce((total, bill) => total + numeric(bill.total_amount), 0));
  const totalPayroll = roundMoney(weeks.reduce((total, week) => total + week.payroll, 0));

  return {
    business: input.business,
    generatedAt: new Date().toISOString(),
    range: { start: dateText(start), end: dateText(addDays(end, -1)), weeks: FORECAST_WEEKS },
    assumptions: {
      salesAdjustmentPercent: Number(input.salesAdjustmentPercent || 0),
      expenseAdjustmentPercent: Number(input.expenseAdjustmentPercent || 0),
      minimumCash,
      historicalWeeklyInflows,
      historicalWeeklyOperatingOutflows,
      historicalWeeklyPayroll,
      scheduledPayrollOverridesHistoricalAverage: true,
    },
    summary: {
      currentCash,
      cardBalance: roundMoney(numeric(cashRows[0]?.card_balance)),
      accountCount: Math.round(numeric(cashRows[0]?.account_count)),
      endingCash: roundMoney(runningCash),
      lowestCash: roundMoney(lowestCash),
      lowestWeek,
      firstBelowMinimumWeek: firstBelow?.weekEnd || null,
      openBillsInForecast: totalBills,
      payrollInForecast: totalPayroll,
    },
    weeks,
    events: eventRows.map((event) => ({ ...event, amount: roundMoney(numeric(event.amount)) })),
    openBills: billRows.map((bill) => ({ ...bill, totalAmount: roundMoney(numeric(bill.total_amount)) })),
  };
}
