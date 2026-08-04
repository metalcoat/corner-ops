import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { ensureSchema, getSql } from "@/lib/db";

export type RezkuProductSalesReportType = "sales_by_product";

let productSalesSchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function numeric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = clean(value, 100);
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text);
  const parsed = Number(text.replace(/[\s$,%(),]/g, ""));
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -parsed : parsed;
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sourceKey(parts: unknown[]): string {
  return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
}

function rowLookup(row: Record<string, unknown>, candidates: string[]): unknown {
  const values = new Map(Object.entries(row).map(([key, value]) => [normalized(key), value]));
  for (const candidate of candidates) {
    const value = values.get(normalized(candidate));
    if (value !== undefined && value !== null && clean(value) !== "") return value;
  }
  return "";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function dateKey(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts) return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
  }
  const text = clean(value, 120);
  if (!text) return "";
  let match = text.match(/(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (match) return `${match[1]}-${pad(Number(match[2]))}-${pad(Number(match[3]))}`;
  match = text.match(/(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);
  if (match) {
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    return `${year}-${pad(Number(match[1]))}-${pad(Number(match[2]))}`;
  }
  const parsed = new Date(`${text} 12:00:00 UTC`);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`;
}

function reportDate(workbook: XLSX.WorkBook): string {
  const coverName = workbook.SheetNames.find((name) => /^cover$/i.test(name.trim()));
  if (!coverName) throw new Error("Sales by Product did not contain its Cover sheet date.");
  const cover = workbook.Sheets[coverName];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(cover, {
    header: 1,
    defval: "",
    raw: true,
    blankrows: false,
  });
  for (const row of matrix) {
    const labelIndex = row.findIndex((cell) => normalized(cell) === "dates");
    if (labelIndex < 0) continue;
    for (const candidate of row.slice(labelIndex + 1)) {
      const key = dateKey(candidate);
      if (key) return key;
    }
  }
  throw new Error("Sales by Product Cover sheet did not contain a usable business date.");
}

function workbookRows(workbook: XLSX.WorkBook) {
  return workbook.SheetNames
    .filter((sheetName) => !/^cover$/i.test(sheetName.trim()))
    .flatMap((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return [];
      return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
        raw: true,
        dateNF: "yyyy-mm-dd",
      }).map((row) => ({ ...row, __sheet: sheetName.trim() }));
    })
    .filter((row) => clean(rowLookup(row, ["Product", "Product Name", "Item", "Item Name"])) !== "");
}

export function detectRezkuProductSalesReportType(
  fileName: string,
  requested?: string,
): RezkuProductSalesReportType | undefined {
  const requestedKey = normalized(requested);
  if (["salesbyproduct", "productsales", "salesproduct"].includes(requestedKey)) return "sales_by_product";
  const lower = fileName.toLowerCase();
  return lower.includes("sales") && lower.includes("product") ? "sales_by_product" : undefined;
}

export function ensureRezkuProductSalesSchema(): Promise<void> {
  if (!productSalesSchemaPromise) {
    productSalesSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS rezku_product_sales_import_batches (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL DEFAULT 'Corner Deli' CHECK (business = 'Corner Deli'),
          report_type TEXT NOT NULL DEFAULT 'sales_by_product' CHECK (report_type = 'sales_by_product'),
          business_date DATE NOT NULL,
          file_name TEXT NOT NULL,
          row_count INTEGER NOT NULL DEFAULT 0,
          imported_by TEXT NOT NULL,
          imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_product_sales_batches_date_idx ON rezku_product_sales_import_batches (business_date DESC, imported_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS rezku_product_sales (
          id UUID PRIMARY KEY,
          source_key TEXT NOT NULL UNIQUE,
          batch_id UUID NOT NULL REFERENCES rezku_product_sales_import_batches(id) ON DELETE CASCADE,
          business_date DATE NOT NULL,
          category TEXT NOT NULL DEFAULT '',
          product TEXT NOT NULL,
          list_price NUMERIC(14,4) NOT NULL DEFAULT 0,
          average_price NUMERIC(14,4) NOT NULL DEFAULT 0,
          quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
          sales NUMERIC(14,2) NOT NULL DEFAULT 0,
          percent_sales NUMERIC(14,8) NOT NULL DEFAULT 0,
          average_profit NUMERIC(14,4) NOT NULL DEFAULT 0,
          profit NUMERIC(14,2) NOT NULL DEFAULT 0,
          percent_profit NUMERIC(14,8) NOT NULL DEFAULT 0,
          raw JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_product_sales_date_idx ON rezku_product_sales (business_date DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS rezku_product_sales_product_idx ON rezku_product_sales (product, business_date DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS rezku_product_sales_category_idx ON rezku_product_sales (category, business_date DESC)`;
    })().catch((error) => {
      productSalesSchemaPromise = null;
      throw error;
    });
  }
  return productSalesSchemaPromise;
}

export async function importRezkuProductSalesReport(
  fileName: string,
  bytes: ArrayBuffer,
  requestedType: string | undefined,
  actor: string,
) {
  const reportType = detectRezkuProductSalesReportType(fileName, requestedType);
  if (!reportType) throw new Error("Could not identify the Rezku Sales by Product report from the filename.");
  await ensureRezkuProductSalesSchema();

  const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  const businessDate = reportDate(workbook);
  const rows = workbookRows(workbook);
  const batchId = crypto.randomUUID();
  const sql = getSql();

  await sql`
    INSERT INTO rezku_product_sales_import_batches (
      id, report_type, business_date, file_name, row_count, imported_by
    ) VALUES (
      ${batchId}, ${reportType}, ${businessDate}, ${clean(fileName, 255)}, ${rows.length}, ${clean(actor, 320)}
    )
  `;

  // This workbook is a complete daily snapshot. Replacing the date prevents stale products
  // from surviving when Rezku later regenerates or corrects the report.
  await sql`DELETE FROM rezku_product_sales WHERE business_date = ${businessDate}::date`;

  let imported = 0;
  for (const row of rows) {
    const category = clean(row.__sheet, 120);
    const product = clean(rowLookup(row, ["Product", "Product Name", "Item", "Item Name"]), 300);
    if (!product) continue;
    const listPrice = round(numeric(rowLookup(row, ["List Price", "Price"])), 4);
    const averagePrice = round(numeric(rowLookup(row, ["Avg Price", "Average Price"])), 4);
    const quantity = round(numeric(rowLookup(row, ["Qty", "Quantity"])), 3);
    const sales = round(numeric(rowLookup(row, ["Sale", "Sales", "Net Sales"])), 2);
    const percentSales = round(numeric(rowLookup(row, ["% of Sales", "Percent of Sales"])), 8);
    const averageProfit = round(numeric(rowLookup(row, ["Avg Profit", "Average Profit"])), 4);
    const profit = round(numeric(rowLookup(row, ["Profit"])), 2);
    const percentProfit = round(numeric(rowLookup(row, ["% of Profit", "Percent of Profit"])), 8);
    const key = sourceKey(["rezku-sales-by-product", businessDate, category.toLowerCase(), product.toLowerCase()]);

    const result = await sql`
      INSERT INTO rezku_product_sales (
        id, source_key, batch_id, business_date, category, product,
        list_price, average_price, quantity, sales, percent_sales,
        average_profit, profit, percent_profit, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${key}, ${batchId}, ${businessDate}, ${category}, ${product},
        ${listPrice}, ${averagePrice}, ${quantity}, ${sales}, ${percentSales},
        ${averageProfit}, ${profit}, ${percentProfit}, ${JSON.stringify(row)}::jsonb
      )
      ON CONFLICT (source_key) DO UPDATE SET
        batch_id = EXCLUDED.batch_id,
        list_price = EXCLUDED.list_price,
        average_price = EXCLUDED.average_price,
        quantity = EXCLUDED.quantity,
        sales = EXCLUDED.sales,
        percent_sales = EXCLUDED.percent_sales,
        average_profit = EXCLUDED.average_profit,
        profit = EXCLUDED.profit,
        percent_profit = EXCLUDED.percent_profit,
        raw = EXCLUDED.raw,
        updated_at = NOW()
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    if (result.length) imported += 1;
  }

  return { batchId, reportType, businessDate, rowsRead: rows.length, imported };
}
