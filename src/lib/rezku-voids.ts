import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { ensureSchema, getSql } from "@/lib/db";

const TIME_ZONE = "America/New_York";
const BUSINESS_DAY_HOUR = 4;

export type RezkuVoidReportType = "product_voids" | "transaction_voids";
type VoidType = "Product" | "Transaction";

type VoidRow = {
  id: string;
  void_type: VoidType;
  order_id: string;
  transaction_id: string;
  voided_at: string | null;
  employee_name: string;
  voided_by: string;
  reason: string;
  item_name: string;
  quantity: string | number;
  amount: string | number;
  raw: Record<string, unknown>;
  file_name: string;
  imported_at: string;
};

let voidSchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function numeric(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[\s$,%(),]/g, (match) => match === "(" || match === ")" ? "" : ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(Math.abs(value) * 100) / 100;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rowLookup(row: Record<string, unknown>, candidates: string[]): unknown {
  const map = new Map(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  for (const candidate of candidates) {
    const value = map.get(normalizeKey(candidate));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts) return new Date(Date.UTC(parts.y, parts.m - 1, parts.d, parts.H, parts.M, Math.floor(parts.S)));
  }
  const text = clean(value, 120);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function combineDateAndTime(dateValue: unknown, timeValue: unknown): Date | null {
  const direct = parseDate(timeValue);
  if (direct && direct.getFullYear() > 1971) return direct;
  const date = parseDate(dateValue);
  if (!date) return direct;
  if (typeof timeValue === "number") {
    const parts = XLSX.SSF.parse_date_code(timeValue);
    if (parts) {
      const result = new Date(date);
      result.setHours(parts.H, parts.M, Math.floor(parts.S), 0);
      return result;
    }
  }
  const text = clean(timeValue, 80);
  if (!text) return date;
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return direct || date;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = match[4]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  const result = new Date(date);
  result.setHours(hour, minute, second, 0);
  return result;
}

function sourceKey(parts: unknown[]): string {
  return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
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

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function workbookRows(workbook: XLSX.WorkBook) {
  return workbook.SheetNames
    .filter((name) => !/^(cover|summary|instructions?)$/i.test(name.trim()))
    .flatMap((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return [];
      return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
        raw: false,
        dateNF: "yyyy-mm-dd hh:mm:ss",
      }).map((row) => ({ ...row, __sheet: sheetName }));
    })
    .filter((row) => Object.entries(row).some(([key, value]) => key !== "__sheet" && clean(value) !== ""));
}

export function detectRezkuVoidReportType(fileName: string, requested?: string): RezkuVoidReportType | undefined {
  const requestedKey = normalizeKey(requested || "");
  if (["productvoids", "productvoid", "itemvoids", "itemvoid"].includes(requestedKey)) return "product_voids";
  if (["transactionvoids", "transactionvoid", "ordervoids", "ordervoid"].includes(requestedKey)) return "transaction_voids";
  const lower = fileName.toLowerCase();
  if (!lower.includes("void")) return undefined;
  if (lower.includes("product") || lower.includes("item")) return "product_voids";
  if (lower.includes("transaction") || lower.includes("order")) return "transaction_voids";
  return undefined;
}

export function ensureRezkuVoidSchema(): Promise<void> {
  if (!voidSchemaPromise) {
    voidSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS rezku_void_import_batches (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL DEFAULT 'Corner Deli' CHECK (business = 'Corner Deli'),
          report_type TEXT NOT NULL CHECK (report_type IN ('product_voids', 'transaction_voids')),
          file_name TEXT NOT NULL,
          row_count INTEGER NOT NULL DEFAULT 0,
          imported_by TEXT NOT NULL,
          imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_void_import_batches_created_idx ON rezku_void_import_batches (imported_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS rezku_void_events (
          id UUID PRIMARY KEY,
          source_key TEXT NOT NULL UNIQUE,
          batch_id UUID NOT NULL REFERENCES rezku_void_import_batches(id) ON DELETE CASCADE,
          void_type TEXT NOT NULL CHECK (void_type IN ('Product', 'Transaction')),
          order_id TEXT NOT NULL DEFAULT '',
          transaction_id TEXT NOT NULL DEFAULT '',
          voided_at TIMESTAMPTZ,
          employee_name TEXT NOT NULL DEFAULT '',
          voided_by TEXT NOT NULL DEFAULT '',
          reason TEXT NOT NULL DEFAULT '',
          item_name TEXT NOT NULL DEFAULT '',
          quantity NUMERIC(12,3) NOT NULL DEFAULT 0,
          amount NUMERIC(14,2) NOT NULL DEFAULT 0,
          raw JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_void_events_time_idx ON rezku_void_events (voided_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS rezku_void_events_order_idx ON rezku_void_events (order_id, transaction_id)`;
      await sql`CREATE INDEX IF NOT EXISTS rezku_void_events_type_idx ON rezku_void_events (void_type, voided_at DESC)`;
    })().catch((error) => {
      voidSchemaPromise = null;
      throw error;
    });
  }
  return voidSchemaPromise;
}

export async function importRezkuVoidReport(
  fileName: string,
  bytes: ArrayBuffer,
  requestedType: string | undefined,
  actor: string,
) {
  await ensureRezkuVoidSchema();
  const reportType = detectRezkuVoidReportType(fileName, requestedType);
  if (!reportType) throw new Error("Could not identify the Rezku void report type from the filename.");
  const voidType: VoidType = reportType === "product_voids" ? "Product" : "Transaction";
  const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  const rows = workbookRows(workbook);
  const batchId = crypto.randomUUID();

  await getSql()`
    INSERT INTO rezku_void_import_batches (id, report_type, file_name, row_count, imported_by)
    VALUES (${batchId}, ${reportType}, ${clean(fileName, 255)}, ${rows.length}, ${clean(actor, 320)})
  `;

  let imported = 0;
  for (const row of rows) {
    const dateValue = rowLookup(row, [
      "Date", "Business Date", "Void Date", "Voided Date", "Order Date", "Transaction Date",
    ]);
    const timeValue = rowLookup(row, [
      "Voided At", "Void Date/Time", "Void Time", "Voided Time", "Time", "Transaction Time", "Created At",
    ]);
    const voidedAt = combineDateAndTime(dateValue, timeValue);
    const orderId = clean(rowLookup(row, ["Order ID", "Order Number", "Order #", "Ticket Number", "Check Number", "Check #"]), 120);
    const transactionId = clean(rowLookup(row, ["Transaction ID", "Payment ID", "Void ID", "ID"]), 120);
    const itemName = voidType === "Product"
      ? clean(rowLookup(row, ["Product", "Product Name", "Item", "Item Name", "Menu Item", "Description"]), 240)
      : "";
    const quantity = Math.abs(numeric(rowLookup(row, ["Quantity", "Qty", "Voided Quantity", "Count"]))) || (voidType === "Product" && itemName ? 1 : 0);
    const amount = roundMoney(numeric(rowLookup(row, [
      "Void Amount", "Voided Amount", "Amount", "Total", "Total Amount", "Void Total", "Extended Price", "Price", "Net Amount",
    ])));
    const employeeName = clean(rowLookup(row, ["Employee", "Employee Name", "Server", "Cashier", "Team Member", "Opened By"]), 160);
    const voidedBy = clean(rowLookup(row, ["Voided By", "Void By", "Void Employee", "Manager", "Approved By", "Authorized By"]), 160);
    const reason = clean(rowLookup(row, ["Void Reason", "Reason", "Reason Code", "Comment", "Notes", "Memo"]), 500);

    if (!orderId && !transactionId && !voidedAt && !itemName && !amount && !employeeName && !voidedBy && !reason) continue;
    const key = sourceKey([
      "rezku-void", voidType, orderId, transactionId, voidedAt?.toISOString(), itemName,
      quantity, amount, employeeName, voidedBy, reason, JSON.stringify(row),
    ]);
    const result = await getSql()`
      INSERT INTO rezku_void_events (
        id, source_key, batch_id, void_type, order_id, transaction_id, voided_at,
        employee_name, voided_by, reason, item_name, quantity, amount, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${key}, ${batchId}, ${voidType}, ${orderId}, ${transactionId},
        ${voidedAt?.toISOString() || null}, ${employeeName}, ${voidedBy}, ${reason},
        ${itemName}, ${quantity}, ${amount}, ${JSON.stringify(row)}::jsonb
      )
      ON CONFLICT (source_key) DO NOTHING
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    if (result.length) imported += 1;
  }

  return { batchId, reportType, rowsRead: rows.length, imported };
}

export async function rezkuVoidDashboard(startText: string, endText: string) {
  await ensureRezkuVoidSchema();
  if (!validDate(startText) || !validDate(endText)) throw new Error("Void report dates must use YYYY-MM-DD.");
  const start = zonedDateToUtc(startText);
  const end = zonedDateToUtc(endText);
  if (end.getTime() <= start.getTime()) throw new Error("Void report end date must be after the start date.");
  if (end.getTime() - start.getTime() > 740 * 86_400_000) throw new Error("A void report range cannot exceed two years.");

  const sql = getSql();
  const [summaryRows, dailyRows, recentRows, topItems, byVoider, coverageRows, batchRows] = await Promise.all([
    sql`
      SELECT v.void_type, COUNT(*)::INTEGER AS void_count, COALESCE(SUM(v.amount), 0) AS void_amount,
        COUNT(*) FILTER (WHERE v.reason = '')::INTEGER AS missing_reason_count,
        COUNT(*) FILTER (WHERE v.voided_at IS NULL)::INTEGER AS missing_time_count
      FROM rezku_void_events v
      JOIN rezku_void_import_batches b ON b.id = v.batch_id
      WHERE COALESCE(v.voided_at, b.imported_at) >= ${start.toISOString()}
        AND COALESCE(v.voided_at, b.imported_at) < ${end.toISOString()}
      GROUP BY v.void_type
    `,
    sql`
      SELECT TO_CHAR(
          (COALESCE(v.voided_at, b.imported_at) AT TIME ZONE 'America/New_York' - INTERVAL '4 hours')::date,
          'YYYY-MM-DD'
        ) AS business_date,
        v.void_type,
        COUNT(*)::INTEGER AS void_count,
        COALESCE(SUM(v.amount), 0) AS void_amount
      FROM rezku_void_events v
      JOIN rezku_void_import_batches b ON b.id = v.batch_id
      WHERE COALESCE(v.voided_at, b.imported_at) >= ${start.toISOString()}
        AND COALESCE(v.voided_at, b.imported_at) < ${end.toISOString()}
      GROUP BY business_date, v.void_type
      ORDER BY business_date
    `,
    sql`
      SELECT v.id, v.void_type, v.order_id, v.transaction_id, v.voided_at,
        v.employee_name, v.voided_by, v.reason, v.item_name, v.quantity, v.amount,
        v.raw, b.file_name, b.imported_at
      FROM rezku_void_events v
      JOIN rezku_void_import_batches b ON b.id = v.batch_id
      WHERE COALESCE(v.voided_at, b.imported_at) >= ${start.toISOString()}
        AND COALESCE(v.voided_at, b.imported_at) < ${end.toISOString()}
      ORDER BY COALESCE(v.voided_at, b.imported_at) DESC, v.id
      LIMIT 300
    `,
    sql`
      SELECT COALESCE(NULLIF(v.item_name, ''), 'Unidentified product') AS item,
        COUNT(*)::INTEGER AS void_count, COALESCE(SUM(v.quantity), 0) AS quantity,
        COALESCE(SUM(v.amount), 0) AS void_amount
      FROM rezku_void_events v
      JOIN rezku_void_import_batches b ON b.id = v.batch_id
      WHERE v.void_type = 'Product'
        AND COALESCE(v.voided_at, b.imported_at) >= ${start.toISOString()}
        AND COALESCE(v.voided_at, b.imported_at) < ${end.toISOString()}
      GROUP BY COALESCE(NULLIF(v.item_name, ''), 'Unidentified product')
      ORDER BY SUM(v.amount) DESC, COUNT(*) DESC
      LIMIT 20
    `,
    sql`
      SELECT COALESCE(NULLIF(v.voided_by, ''), NULLIF(v.employee_name, ''), 'Unidentified employee') AS employee,
        COUNT(*)::INTEGER AS void_count, COALESCE(SUM(v.amount), 0) AS void_amount
      FROM rezku_void_events v
      JOIN rezku_void_import_batches b ON b.id = v.batch_id
      WHERE COALESCE(v.voided_at, b.imported_at) >= ${start.toISOString()}
        AND COALESCE(v.voided_at, b.imported_at) < ${end.toISOString()}
      GROUP BY COALESCE(NULLIF(v.voided_by, ''), NULLIF(v.employee_name, ''), 'Unidentified employee')
      ORDER BY COUNT(*) DESC, SUM(v.amount) DESC
      LIMIT 20
    `,
    sql`
      SELECT MIN(COALESCE(v.voided_at, b.imported_at)) AS first_record,
        MAX(COALESCE(v.voided_at, b.imported_at)) AS last_record,
        COUNT(*)::INTEGER AS records
      FROM rezku_void_events v
      JOIN rezku_void_import_batches b ON b.id = v.batch_id
    `,
    sql`
      SELECT id, report_type, file_name, row_count, imported_by, imported_at,
        (SELECT COUNT(*) FROM rezku_void_events v WHERE v.batch_id = b.id)::INTEGER AS imported_count
      FROM rezku_void_import_batches b
      ORDER BY imported_at DESC
      LIMIT 30
    `,
  ]);

  const summary = {
    productCount: 0,
    productAmount: 0,
    transactionCount: 0,
    transactionAmount: 0,
    missingReasonCount: 0,
    missingTimeCount: 0,
  };
  for (const row of summaryRows as unknown as Array<Record<string, unknown>>) {
    if (row.void_type === "Product") {
      summary.productCount = Number(row.void_count || 0);
      summary.productAmount = numeric(row.void_amount);
    } else {
      summary.transactionCount = Number(row.void_count || 0);
      summary.transactionAmount = numeric(row.void_amount);
    }
    summary.missingReasonCount += Number(row.missing_reason_count || 0);
    summary.missingTimeCount += Number(row.missing_time_count || 0);
  }

  const dailyMap = new Map<string, {
    date: string;
    productCount: number;
    productAmount: number;
    transactionCount: number;
    transactionAmount: number;
  }>();
  for (const row of dailyRows as unknown as Array<Record<string, unknown>>) {
    const date = String(row.business_date);
    const day = dailyMap.get(date) || { date, productCount: 0, productAmount: 0, transactionCount: 0, transactionAmount: 0 };
    if (row.void_type === "Product") {
      day.productCount = Number(row.void_count || 0);
      day.productAmount = numeric(row.void_amount);
    } else {
      day.transactionCount = Number(row.void_count || 0);
      day.transactionAmount = numeric(row.void_amount);
    }
    dailyMap.set(date, day);
  }

  const recent = (recentRows as unknown as VoidRow[]).map((row) => ({
    id: row.id,
    voidType: row.void_type,
    orderId: row.order_id,
    transactionId: row.transaction_id,
    voidedAt: row.voided_at,
    timeKnown: Boolean(row.voided_at),
    employeeName: row.employee_name,
    voidedBy: row.voided_by,
    reason: row.reason,
    itemName: row.item_name,
    quantity: numeric(row.quantity),
    amount: numeric(row.amount),
    sourceFile: row.file_name,
    importedAt: row.imported_at,
    sheet: row.raw && typeof row.raw === "object" ? clean(row.raw.__sheet, 120) : "",
  }));

  return {
    business: "Corner Deli" as const,
    timeZone: TIME_ZONE,
    businessDayStartsAt: "04:00",
    range: { start: startText, end: endText },
    summary: {
      ...summary,
      totalCount: summary.productCount + summary.transactionCount,
      totalAmount: summary.productAmount + summary.transactionAmount,
    },
    daily: Array.from(dailyMap.values()).sort((left, right) => left.date.localeCompare(right.date)),
    recent,
    topItems: (topItems as unknown as Array<Record<string, unknown>>).map((row) => ({
      item: String(row.item),
      voidCount: Number(row.void_count || 0),
      quantity: numeric(row.quantity),
      amount: numeric(row.void_amount),
    })),
    byVoider: (byVoider as unknown as Array<Record<string, unknown>>).map((row) => ({
      employee: String(row.employee),
      voidCount: Number(row.void_count || 0),
      amount: numeric(row.void_amount),
    })),
    coverage: {
      firstRecord: (coverageRows as unknown as Array<Record<string, unknown>>)[0]?.first_record || null,
      lastRecord: (coverageRows as unknown as Array<Record<string, unknown>>)[0]?.last_record || null,
      records: Number((coverageRows as unknown as Array<Record<string, unknown>>)[0]?.records || 0),
    },
    imports: (batchRows as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      reportType: String(row.report_type),
      fileName: String(row.file_name),
      rowsRead: Number(row.row_count || 0),
      rowsImported: Number(row.imported_count || 0),
      importedBy: String(row.imported_by || ""),
      importedAt: String(row.imported_at),
    })),
  };
}
