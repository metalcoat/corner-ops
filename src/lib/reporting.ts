import { ensureSchema, getSql } from "@/lib/db";
import { ensureRezkuProductSalesSchema } from "@/lib/rezku-product-sales";
import { ensureSquareControlSchema } from "@/lib/square-control";
import { syncSquareReportRange } from "@/lib/square-report-sync";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";
const BUSINESS_DAY_HOUR = 4;

type Metrics = {
  sales: number;
  taxes: number;
  tips: number;
  orders: number;
  laborHours: number;
  averageTicket: number;
};

type Period = {
  metrics: Metrics;
  daily: Array<{
    date: string;
    sales: number;
    taxes: number;
    tips: number;
    orders: number;
    laborHours: number;
  }>;
  topItems: Array<{ item: string; quantity: number; sales: number }>;
};

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getOffsetMilliseconds(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return represented - date.getTime();
}

function zonedDateToUtc(dateText: string, hour = BUSINESS_DAY_HOUR): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  let timestamp = Date.UTC(year, month - 1, day, hour, 0, 0);
  for (let index = 0; index < 2; index += 1) {
    timestamp = Date.UTC(year, month - 1, day, hour, 0, 0)
      - getOffsetMilliseconds(new Date(timestamp), TIME_ZONE);
  }
  return new Date(timestamp);
}

function bounds(startText: string, endText: string) {
  if (!validDate(startText) || !validDate(endText)) {
    throw new Error("Report dates must use YYYY-MM-DD.");
  }
  const start = zonedDateToUtc(startText);
  const end = zonedDateToUtc(endText);
  if (end.getTime() <= start.getTime()) throw new Error("Report end date must be after the start date.");
  const maximum = 740 * 24 * 60 * 60 * 1000;
  if (end.getTime() - start.getTime() > maximum) {
    throw new Error("A report range cannot exceed two years.");
  }
  return { startText, endText, start, end };
}

function emptyMetrics(): Metrics {
  return { sales: 0, taxes: 0, tips: 0, orders: 0, laborHours: 0, averageTicket: 0 };
}

async function tikiPeriod(start: Date, end: Date): Promise<Period> {
  await ensureSquareControlSchema();
  await ensureSchema();
  const summary = await getSql()`
    SELECT COUNT(*)::INTEGER AS orders,
      COALESCE(SUM(total_amount), 0) AS sales,
      COALESCE(SUM(tax_total), 0) AS taxes,
      COALESCE(SUM(tip_total), 0) AS tips
    FROM square_orders
    WHERE state = 'COMPLETED'
      AND created_at_square >= ${start.toISOString()}
      AND created_at_square < ${end.toISOString()}
  ` as unknown as Array<Record<string, unknown>>;
  const labor = await getSql()`
    SELECT COALESCE(SUM(
      EXTRACT(EPOCH FROM (
        LEAST(COALESCE(clock_out, ${end.toISOString()}::timestamptz), ${end.toISOString()}::timestamptz)
        - GREATEST(clock_in, ${start.toISOString()}::timestamptz)
      )) / 3600
    ), 0) AS labor_hours
    FROM time_entries
    WHERE business = 'Tiki'
      AND clock_in < ${end.toISOString()}
      AND COALESCE(clock_out, ${end.toISOString()}::timestamptz) > ${start.toISOString()}
  ` as unknown as Array<Record<string, unknown>>;
  const dailyRows = await getSql()`
    SELECT TO_CHAR(
        (created_at_square AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date,
        'YYYY-MM-DD'
      ) AS business_date,
      COUNT(*)::INTEGER AS orders,
      COALESCE(SUM(total_amount), 0) AS sales,
      COALESCE(SUM(tax_total), 0) AS taxes,
      COALESCE(SUM(tip_total), 0) AS tips
    FROM square_orders
    WHERE state = 'COMPLETED'
      AND created_at_square >= ${start.toISOString()}
      AND created_at_square < ${end.toISOString()}
    GROUP BY business_date
    ORDER BY business_date
  ` as unknown as Array<Record<string, unknown>>;
  const laborDaily = await getSql()`
    SELECT TO_CHAR(
        (clock_in AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date,
        'YYYY-MM-DD'
      ) AS business_date,
      COALESCE(SUM(
        EXTRACT(EPOCH FROM (COALESCE(clock_out, ${end.toISOString()}::timestamptz) - clock_in)) / 3600
      ), 0) AS labor_hours
    FROM time_entries
    WHERE business = 'Tiki'
      AND clock_in >= ${start.toISOString()}
      AND clock_in < ${end.toISOString()}
    GROUP BY business_date
    ORDER BY business_date
  ` as unknown as Array<Record<string, unknown>>;
  const topItems = await getSql()`
    SELECT COALESCE(NULLIF(l.item_name, ''), NULLIF(l.variation_name, ''), 'Unnamed item') AS item,
      COALESCE(SUM(l.quantity), 0) AS quantity,
      COALESCE(SUM(l.total_money), 0) AS sales
    FROM square_order_lines l
    JOIN square_orders o ON o.id = l.square_order_id
    WHERE o.state = 'COMPLETED'
      AND o.created_at_square >= ${start.toISOString()}
      AND o.created_at_square < ${end.toISOString()}
    GROUP BY COALESCE(NULLIF(l.item_name, ''), NULLIF(l.variation_name, ''), 'Unnamed item')
    ORDER BY SUM(l.total_money) DESC
    LIMIT 20
  ` as unknown as Array<Record<string, unknown>>;

  const summaryRow = summary[0] || {};
  const orders = numeric(summaryRow.orders);
  const metrics: Metrics = {
    sales: numeric(summaryRow.sales),
    taxes: numeric(summaryRow.taxes),
    tips: numeric(summaryRow.tips),
    orders,
    laborHours: numeric(labor[0]?.labor_hours),
    averageTicket: orders ? numeric(summaryRow.sales) / orders : 0,
  };
  const laborByDate = new Map(laborDaily.map((row) => [String(row.business_date), numeric(row.labor_hours)]));
  return {
    metrics,
    daily: dailyRows.map((row) => ({
      date: String(row.business_date),
      sales: numeric(row.sales),
      taxes: numeric(row.taxes),
      tips: numeric(row.tips),
      orders: numeric(row.orders),
      laborHours: laborByDate.get(String(row.business_date)) || 0,
    })),
    topItems: topItems.map((row) => ({
      item: String(row.item || "Unnamed item"),
      quantity: numeric(row.quantity),
      sales: numeric(row.sales),
    })),
  };
}

async function deliPeriod(start: Date, end: Date): Promise<Period> {
  await Promise.all([ensureSchema(), ensureRezkuProductSalesSchema()]);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  const summary = await getSql()`
    SELECT
      (SELECT COUNT(*) FROM rezku_orders
        WHERE opened_at >= ${start.toISOString()} AND opened_at < ${end.toISOString()})::INTEGER AS orders,
      (SELECT COALESCE(SUM(tip), 0) FROM rezku_transactions
        WHERE transaction_time >= ${start.toISOString()} AND transaction_time < ${end.toISOString()}) AS tips,
      (SELECT COALESCE(SUM(sales), 0) FROM rezku_product_sales
        WHERE business_date >= ${startDate}::date AND business_date < ${endDate}::date) AS sales,
      (SELECT COALESCE(SUM(
        CASE
          WHEN reported_hours > 0 THEN reported_hours
          WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL
            THEN EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600
          ELSE 0
        END
      ), 0) FROM rezku_shifts
        WHERE clock_in >= ${start.toISOString()} AND clock_in < ${end.toISOString()}) AS labor_hours
  ` as unknown as Array<Record<string, unknown>>;
  const ordersDaily = await getSql()`
    SELECT TO_CHAR(
        (opened_at AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date,
        'YYYY-MM-DD'
      ) AS business_date,
      COUNT(*)::INTEGER AS orders
    FROM rezku_orders
    WHERE opened_at >= ${start.toISOString()} AND opened_at < ${end.toISOString()}
    GROUP BY business_date
    ORDER BY business_date
  ` as unknown as Array<Record<string, unknown>>;
  const tipsDaily = await getSql()`
    SELECT TO_CHAR(
        (transaction_time AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date,
        'YYYY-MM-DD'
      ) AS business_date,
      COALESCE(SUM(tip), 0) AS tips
    FROM rezku_transactions
    WHERE transaction_time >= ${start.toISOString()} AND transaction_time < ${end.toISOString()}
    GROUP BY business_date
    ORDER BY business_date
  ` as unknown as Array<Record<string, unknown>>;
  const salesDaily = await getSql()`
    SELECT TO_CHAR(business_date, 'YYYY-MM-DD') AS business_date,
      COALESCE(SUM(sales), 0) AS sales
    FROM rezku_product_sales
    WHERE business_date >= ${startDate}::date AND business_date < ${endDate}::date
    GROUP BY business_date
    ORDER BY business_date
  ` as unknown as Array<Record<string, unknown>>;
  const laborDaily = await getSql()`
    SELECT TO_CHAR(
        (clock_in AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date,
        'YYYY-MM-DD'
      ) AS business_date,
      COALESCE(SUM(
        CASE
          WHEN reported_hours > 0 THEN reported_hours
          WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL
            THEN EXTRACT(EPOCH FROM (clock_out - clock_in)) / 3600
          ELSE 0
        END
      ), 0) AS labor_hours
    FROM rezku_shifts
    WHERE clock_in >= ${start.toISOString()} AND clock_in < ${end.toISOString()}
    GROUP BY business_date
    ORDER BY business_date
  ` as unknown as Array<Record<string, unknown>>;
  const topItems = await getSql()`
    SELECT product AS item,
      COALESCE(SUM(quantity), 0) AS quantity,
      COALESCE(SUM(sales), 0) AS sales
    FROM rezku_product_sales
    WHERE business_date >= ${startDate}::date AND business_date < ${endDate}::date
    GROUP BY product
    ORDER BY SUM(sales) DESC, product
    LIMIT 20
  ` as unknown as Array<Record<string, unknown>>;

  const row = summary[0] || {};
  const orders = numeric(row.orders);
  const sales = numeric(row.sales);
  const daily = new Map<string, Period["daily"][number]>();
  const getDay = (date: string) => {
    const existing = daily.get(date);
    if (existing) return existing;
    const created = { date, sales: 0, taxes: 0, tips: 0, orders: 0, laborHours: 0 };
    daily.set(date, created);
    return created;
  };
  for (const item of ordersDaily) getDay(String(item.business_date)).orders = numeric(item.orders);
  for (const item of tipsDaily) getDay(String(item.business_date)).tips = numeric(item.tips);
  for (const item of salesDaily) getDay(String(item.business_date)).sales = numeric(item.sales);
  for (const item of laborDaily) getDay(String(item.business_date)).laborHours = numeric(item.labor_hours);

  return {
    metrics: {
      ...emptyMetrics(),
      sales,
      orders,
      tips: numeric(row.tips),
      laborHours: numeric(row.labor_hours),
      averageTicket: orders ? sales / orders : 0,
    },
    daily: Array.from(daily.values()).sort((left, right) => left.date.localeCompare(right.date)),
    topItems: topItems.map((item) => ({
      item: String(item.item || "Unnamed item"),
      quantity: numeric(item.quantity),
      sales: numeric(item.sales),
    })),
  };
}

async function coverage(business: Business) {
  if (business === "Tiki") {
    await ensureSquareControlSchema();
    const rows = await getSql()`
      SELECT MIN(created_at_square) AS first_record,
        MAX(created_at_square) AS last_record,
        COUNT(*)::INTEGER AS records
      FROM square_orders
      WHERE state = 'COMPLETED'
    ` as unknown as Array<Record<string, unknown>>;
    return {
      firstRecord: rows[0]?.first_record || null,
      lastRecord: rows[0]?.last_record || null,
      records: numeric(rows[0]?.records),
      latestImport: null,
    };
  }

  await Promise.all([ensureSchema(), ensureRezkuProductSalesSchema()]);
  const rows = await getSql()`
    SELECT MIN(source_time) AS first_record, MAX(source_time) AS last_record,
      COUNT(*)::INTEGER AS records
    FROM (
      SELECT opened_at AS source_time FROM rezku_orders WHERE opened_at IS NOT NULL
      UNION ALL
      SELECT transaction_time AS source_time FROM rezku_transactions WHERE transaction_time IS NOT NULL
      UNION ALL
      SELECT clock_in AS source_time FROM rezku_shifts WHERE clock_in IS NOT NULL
      UNION ALL
      SELECT business_date::timestamp AT TIME ZONE 'America/New_York' AS source_time
      FROM rezku_product_sales
    ) source_records
  ` as unknown as Array<Record<string, unknown>>;
  const imports = await getSql()`
    SELECT MAX(imported_at) AS latest_import, COUNT(*)::INTEGER AS import_count
    FROM (
      SELECT imported_at FROM rezku_import_batches
      UNION ALL
      SELECT imported_at FROM rezku_product_sales_import_batches
    ) imports
  ` as unknown as Array<Record<string, unknown>>;
  return {
    firstRecord: rows[0]?.first_record || null,
    lastRecord: rows[0]?.last_record || null,
    records: numeric(rows[0]?.records),
    latestImport: imports[0]?.latest_import || null,
    importCount: numeric(imports[0]?.import_count),
  };
}

function metricDeltas(current: Metrics, comparison: Metrics) {
  const calculate = (value: number, previous: number) => ({
    value: value - previous,
    percent: previous === 0 ? null : ((value - previous) / Math.abs(previous)) * 100,
  });
  return {
    sales: calculate(current.sales, comparison.sales),
    taxes: calculate(current.taxes, comparison.taxes),
    tips: calculate(current.tips, comparison.tips),
    orders: calculate(current.orders, comparison.orders),
    laborHours: calculate(current.laborHours, comparison.laborHours),
    averageTicket: calculate(current.averageTicket, comparison.averageTicket),
  };
}

export async function performanceReport(input: {
  business: Business;
  start: string;
  end: string;
  compareStart?: string;
  compareEnd?: string;
  refresh?: boolean;
}) {
  const primaryBounds = bounds(input.start, input.end);
  const comparisonBounds = input.compareStart && input.compareEnd
    ? bounds(input.compareStart, input.compareEnd)
    : null;
  let refreshResult: Record<string, unknown> | null = null;
  let refreshWarning = "";

  if (input.business === "Tiki" && input.refresh) {
    try {
      const primarySync = await syncSquareReportRange(
        primaryBounds.start.toISOString(),
        primaryBounds.end.toISOString(),
      );
      const comparisonSync = comparisonBounds
        ? await syncSquareReportRange(
            comparisonBounds.start.toISOString(),
            comparisonBounds.end.toISOString(),
          )
        : null;
      refreshResult = { primary: primarySync, comparison: comparisonSync };
    } catch (error) {
      refreshWarning = error instanceof Error ? error.message : String(error);
    }
  }

  const loadPeriod = input.business === "Tiki" ? tikiPeriod : deliPeriod;
  const primary = await loadPeriod(primaryBounds.start, primaryBounds.end);
  const comparison = comparisonBounds
    ? await loadPeriod(comparisonBounds.start, comparisonBounds.end)
    : null;

  return {
    business: input.business,
    timeZone: TIME_ZONE,
    businessDayStartsAt: "04:00",
    range: { start: input.start, end: input.end },
    comparisonRange: comparisonBounds
      ? { start: input.compareStart, end: input.compareEnd }
      : null,
    primary,
    comparison,
    deltas: comparison ? metricDeltas(primary.metrics, comparison.metrics) : null,
    availability: {
      sales: true,
      taxes: input.business === "Tiki",
      averageTicket: true,
      topItems: true,
      orders: true,
      tips: true,
      laborHours: true,
    },
    source: input.business === "Tiki"
      ? "Square orders plus the Corner Ops Tiki time clock"
      : "Rezku emailed Order, Transaction, Labor, and Sales by Product reports",
    sourceNote: input.business === "Tiki"
      ? "The selected and comparison ranges can be refreshed directly from Square."
      : "Deli sales and top products come from Sales by Product. Orders classify transaction tips by matching Order ID to the Order Export. Taxes are not included in the current Rezku email reports.",
    coverage: await coverage(input.business),
    refreshResult,
    refreshWarning,
  };
}
