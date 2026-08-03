import { ensureSchema, getSql } from "@/lib/db";
import { ensureRezkuVoidSchema } from "@/lib/rezku-voids";

type InboundStatus = "Received" | "Processing" | "Processed" | "Partial" | "Failed";
type ReportStatus = "Processing" | "Processed" | "Failed";

let monitorSchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 1000): string {
  return String(value ?? "").trim().slice(0, max);
}

function nonNegative(value: unknown): number {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

export function ensureRezkuMonitorSchema(): Promise<void> {
  if (!monitorSchemaPromise) {
    monitorSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS rezku_inbound_emails (
          email_id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL DEFAULT '',
          sender TEXT NOT NULL DEFAULT '',
          subject TEXT NOT NULL DEFAULT '',
          report_date DATE,
          received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          status TEXT NOT NULL DEFAULT 'Received'
            CHECK (status IN ('Received', 'Processing', 'Processed', 'Partial', 'Failed')),
          reports_found INTEGER NOT NULL DEFAULT 0,
          reports_processed INTEGER NOT NULL DEFAULT 0,
          error_text TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_inbound_emails_received_idx ON rezku_inbound_emails (received_at DESC)`;
      await sql`
        CREATE TABLE IF NOT EXISTS rezku_inbound_reports (
          id UUID PRIMARY KEY,
          email_id TEXT NOT NULL REFERENCES rezku_inbound_emails(email_id) ON DELETE CASCADE,
          file_name TEXT NOT NULL,
          report_type TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'Processing'
            CHECK (status IN ('Processing', 'Processed', 'Failed')),
          batch_id UUID,
          rows_read INTEGER NOT NULL DEFAULT 0,
          rows_imported INTEGER NOT NULL DEFAULT 0,
          error_text TEXT NOT NULL DEFAULT '',
          processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (email_id, file_name)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS rezku_inbound_reports_email_idx ON rezku_inbound_reports (email_id, processed_at)`;
    })().catch((error) => {
      monitorSchemaPromise = null;
      throw error;
    });
  }
  return monitorSchemaPromise;
}

export async function startRezkuInboundEmail(input: {
  emailId: string;
  webhookId: string;
  sender: string;
  subject: string;
  reportDate?: string | null;
  reportsFound: number;
}) {
  await ensureRezkuMonitorSchema();
  await getSql()`
    INSERT INTO rezku_inbound_emails (
      email_id, webhook_id, sender, subject, report_date, status, reports_found,
      reports_processed, error_text, received_at, updated_at
    ) VALUES (
      ${clean(input.emailId, 180)}, ${clean(input.webhookId, 180)}, ${clean(input.sender, 320)},
      ${clean(input.subject, 320)}, ${input.reportDate || null}, 'Processing',
      ${nonNegative(input.reportsFound)}, 0, '', NOW(), NOW()
    )
    ON CONFLICT (email_id) DO UPDATE SET
      webhook_id = EXCLUDED.webhook_id,
      sender = EXCLUDED.sender,
      subject = EXCLUDED.subject,
      report_date = COALESCE(EXCLUDED.report_date, rezku_inbound_emails.report_date),
      status = 'Processing',
      reports_found = EXCLUDED.reports_found,
      error_text = '',
      updated_at = NOW()
  `;
}

export async function recordRezkuInboundReport(input: {
  emailId: string;
  fileName: string;
  reportType?: string;
  status: ReportStatus;
  batchId?: string | null;
  rowsRead?: number;
  rowsImported?: number;
  error?: string;
}) {
  await ensureRezkuMonitorSchema();
  await getSql()`
    INSERT INTO rezku_inbound_reports (
      id, email_id, file_name, report_type, status, batch_id,
      rows_read, rows_imported, error_text, processed_at
    ) VALUES (
      ${crypto.randomUUID()}, ${clean(input.emailId, 180)}, ${clean(input.fileName, 255)},
      ${clean(input.reportType, 40)}, ${input.status}, ${input.batchId || null},
      ${nonNegative(input.rowsRead)}, ${nonNegative(input.rowsImported)},
      ${clean(input.error, 2000)}, NOW()
    )
    ON CONFLICT (email_id, file_name) DO UPDATE SET
      report_type = CASE WHEN EXCLUDED.report_type <> '' THEN EXCLUDED.report_type ELSE rezku_inbound_reports.report_type END,
      status = EXCLUDED.status,
      batch_id = COALESCE(EXCLUDED.batch_id, rezku_inbound_reports.batch_id),
      rows_read = GREATEST(rezku_inbound_reports.rows_read, EXCLUDED.rows_read),
      rows_imported = GREATEST(rezku_inbound_reports.rows_imported, EXCLUDED.rows_imported),
      error_text = EXCLUDED.error_text,
      processed_at = NOW()
  `;
}

export async function finishRezkuInboundEmail(input: {
  emailId: string;
  status: InboundStatus;
  reportsProcessed: number;
  error?: string;
}) {
  await ensureRezkuMonitorSchema();
  await getSql()`
    UPDATE rezku_inbound_emails SET
      status = ${input.status},
      reports_processed = GREATEST(reports_processed, ${nonNegative(input.reportsProcessed)}),
      error_text = ${clean(input.error, 3000)},
      updated_at = NOW()
    WHERE email_id = ${clean(input.emailId, 180)}
  `;
}

export async function rezkuImportDashboard() {
  await Promise.all([ensureRezkuMonitorSchema(), ensureRezkuVoidSchema()]);
  const sql = getSql();
  const [emails, reports, imports, exceptions] = await Promise.all([
    sql`
      SELECT email_id, webhook_id, sender, subject, report_date, received_at,
        status, reports_found, reports_processed, error_text, updated_at
      FROM rezku_inbound_emails
      ORDER BY received_at DESC
      LIMIT 35
    `,
    sql`
      SELECT id, email_id, file_name, report_type, status, batch_id,
        rows_read, rows_imported, error_text, processed_at
      FROM rezku_inbound_reports
      ORDER BY processed_at DESC
      LIMIT 120
    `,
    sql`
      SELECT * FROM (
        SELECT b.id, b.report_type, b.file_name, b.row_count, b.imported_by, b.imported_at,
          CASE
            WHEN b.report_type = 'shifts' THEN (SELECT COUNT(*) FROM rezku_shifts s WHERE s.batch_id = b.id)
            WHEN b.report_type = 'orders' THEN (SELECT COUNT(*) FROM rezku_orders o WHERE o.batch_id = b.id)
            WHEN b.report_type = 'transactions' THEN (SELECT COUNT(*) FROM rezku_transactions t WHERE t.batch_id = b.id)
            ELSE 0
          END AS imported_count,
          CASE WHEN b.report_type = 'shifts' THEN (
            SELECT COUNT(*) FROM rezku_shifts s WHERE s.batch_id = b.id AND s.clock_in IS NULL
          ) ELSE 0 END AS missing_clock_in_count,
          CASE WHEN b.report_type = 'shifts' THEN (
            SELECT COUNT(*) FROM rezku_shifts s WHERE s.batch_id = b.id AND s.clock_out IS NULL
          ) ELSE 0 END AS missing_clock_out_count
        FROM rezku_import_batches b

        UNION ALL

        SELECT b.id, b.report_type, b.file_name, b.row_count, b.imported_by, b.imported_at,
          (SELECT COUNT(*) FROM rezku_void_events v WHERE v.batch_id = b.id) AS imported_count,
          0 AS missing_clock_in_count,
          0 AS missing_clock_out_count
        FROM rezku_void_import_batches b
      ) combined_imports
      ORDER BY imported_at DESC
      LIMIT 80
    `,
    sql`
      SELECT s.id, s.batch_id, s.employee_name, s.position, s.role_group,
        s.clock_in, s.clock_out, s.reported_hours, s.raw, b.file_name, b.imported_at
      FROM rezku_shifts s
      JOIN rezku_import_batches b ON b.id = s.batch_id
      WHERE s.clock_in IS NULL OR s.clock_out IS NULL
      ORDER BY b.imported_at DESC, s.employee_name
      LIMIT 150
    `,
  ]);

  const emailRows = emails as unknown as Array<Record<string, unknown>>;
  const reportRows = reports as unknown as Array<Record<string, unknown>>;
  const reportMap = new Map<string, Array<Record<string, unknown>>>();
  for (const report of reportRows) {
    const key = String(report.email_id);
    const list = reportMap.get(key) || [];
    list.push(report);
    reportMap.set(key, list);
  }

  return {
    emails: emailRows.map((row) => ({
      emailId: String(row.email_id),
      webhookId: String(row.webhook_id || ""),
      sender: String(row.sender || ""),
      subject: String(row.subject || ""),
      reportDate: row.report_date ? String(row.report_date) : null,
      receivedAt: String(row.received_at),
      status: String(row.status),
      reportsFound: Number(row.reports_found || 0),
      reportsProcessed: Number(row.reports_processed || 0),
      error: String(row.error_text || ""),
      reports: (reportMap.get(String(row.email_id)) || []).map((report) => ({
        id: String(report.id),
        fileName: String(report.file_name),
        reportType: String(report.report_type || ""),
        status: String(report.status),
        batchId: report.batch_id ? String(report.batch_id) : null,
        rowsRead: Number(report.rows_read || 0),
        rowsImported: Number(report.rows_imported || 0),
        error: String(report.error_text || ""),
        processedAt: String(report.processed_at),
      })),
    })),
    imports: (imports as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      reportType: String(row.report_type),
      fileName: String(row.file_name),
      rowsRead: Number(row.row_count || 0),
      rowsImported: Number(row.imported_count || 0),
      duplicateOrSkipped: Math.max(0, Number(row.row_count || 0) - Number(row.imported_count || 0)),
      missingClockIn: Number(row.missing_clock_in_count || 0),
      missingClockOut: Number(row.missing_clock_out_count || 0),
      importedBy: String(row.imported_by || ""),
      importedAt: String(row.imported_at),
    })),
    punchExceptions: (exceptions as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      batchId: String(row.batch_id),
      employeeName: String(row.employee_name || ""),
      position: String(row.position || ""),
      roleGroup: String(row.role_group || ""),
      clockIn: row.clock_in ? String(row.clock_in) : null,
      clockOut: row.clock_out ? String(row.clock_out) : null,
      reportedHours: Number(row.reported_hours || 0),
      sheet: row.raw && typeof row.raw === "object" ? String((row.raw as Record<string, unknown>).__sheet || "") : "",
      fileName: String(row.file_name || ""),
      importedAt: String(row.imported_at),
    })),
  };
}
