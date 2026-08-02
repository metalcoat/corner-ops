import { createDecipheriv, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { getSql } from "@/lib/db";
import { apiError } from "@/lib/http";
import { importRezkuReport } from "@/lib/operations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const IMPORT_TOKEN = "bUWSZ73mPpsxYTA-WG7baxkguk9-HjhpdS1vzAGC4ys";
const PAYLOAD_KEY = Buffer.from("Id6-TFYoEA2YXDDYNZR0wxyR-K39j5o0PilStA48ye4", "base64url");
const REZKU_HOST = "files.reporting.rezkupos.com";

type ImportedShift = {
  employeeName: string;
  position?: string;
  roleGroup?: string;
  clockIn: string;
  clockOut?: string | null;
  reportedHours?: number;
  source?: string;
};

type ImportBody = {
  fileName?: string;
  shifts?: ImportedShift[];
  reportUrls?: string[];
  deleteBatchId?: string;
};

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function validDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date.toISOString();
}

function sourceKey(shift: ImportedShift): string {
  return createHash("sha256").update(JSON.stringify([
    "historical-time-import-v1",
    clean(shift.employeeName, 120).toLowerCase(),
    validDate(shift.clockIn),
    validDate(shift.clockOut),
    clean(shift.position, 100).toLowerCase(),
  ])).digest("hex");
}

function decryptPayload(value: string): ImportBody {
  const [nonceText, cipherText] = value.split(".");
  if (!nonceText || !cipherText) throw new Error("Encrypted import payload is malformed.");
  const nonce = Buffer.from(nonceText, "base64url");
  const combined = Buffer.from(cipherText, "base64url");
  if (combined.length <= 16) throw new Error("Encrypted import payload is incomplete.");
  const encrypted = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", PAYLOAD_KEY, nonce);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(gunzipSync(compressed).toString("utf8")) as ImportBody;
}

async function stats() {
  const rows = await getSql()`
    SELECT COUNT(*)::INTEGER AS count, MIN(clock_in) AS first_clock_in, MAX(COALESCE(clock_out, clock_in)) AS last_clock_out
    FROM rezku_shifts
  ` as unknown as Array<{ count: number; first_clock_in: string | null; last_clock_out: string | null }>;
  return rows[0];
}

async function importManualShifts(body: ImportBody) {
  if (!Array.isArray(body.shifts) || body.shifts.length < 1 || body.shifts.length > 5000) return null;

  const sql = getSql();
  const batchId = crypto.randomUUID();
  const fileName = clean(body.fileName, 255) || "Historical Google Sheets import";
  let inserted = 0;
  let duplicate = 0;

  await sql`
    INSERT INTO rezku_import_batches (id, report_type, file_name, row_count, imported_by)
    VALUES (${batchId}, 'shifts', ${fileName}, 0, 'Historical Google Sheets import')
  `;

  for (const shift of body.shifts) {
    const employeeName = clean(shift.employeeName, 120);
    if (!employeeName) throw new Error("Every shift requires an employee name.");
    const clockIn = validDate(shift.clockIn);
    const clockOut = validDate(shift.clockOut);
    if (!clockIn) throw new Error(`Clock-in is required for ${employeeName}.`);
    if (clockOut && new Date(clockOut) < new Date(clockIn)) throw new Error(`Clock-out precedes clock-in for ${employeeName}.`);
    const roleGroup = ["Driver", "In-House", "Ignore"].includes(String(shift.roleGroup))
      ? String(shift.roleGroup)
      : "In-House";
    const key = sourceKey(shift);
    const rows = await sql`
      INSERT INTO rezku_shifts (
        id, source_key, batch_id, employee_name, position, role_group,
        clock_in, clock_out, reported_hours, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${key}, ${batchId}, ${employeeName}, ${clean(shift.position, 100) || "Employee"},
        ${roleGroup}, ${clockIn}, ${clockOut}, ${Math.max(0, Number(shift.reportedHours || 0))},
        ${JSON.stringify({ source: clean(shift.source, 255) || "Google Sheets", historicalImport: true })}::jsonb
      )
      ON CONFLICT (source_key) DO NOTHING
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    if (rows[0]) inserted += 1;
    else duplicate += 1;
  }

  await sql`UPDATE rezku_import_batches SET row_count = ${inserted} WHERE id = ${batchId}`;
  if (inserted === 0) await sql`DELETE FROM rezku_import_batches WHERE id = ${batchId}`;
  return { submitted: body.shifts.length, inserted, duplicate, batchId: inserted ? batchId : null };
}

async function importReportUrls(urls: string[] | undefined) {
  if (!urls?.length) return [];
  if (urls.length > 14) throw new Error("No more than 14 report URLs may be imported at once.");
  const results = [];
  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== REZKU_HOST || !url.pathname.endsWith("shift-attestation-export.xlsx")) {
      throw new Error("Only trusted Rezku shift-attestation Excel links are allowed.");
    }
    const response = await fetch(url, { redirect: "follow", cache: "no-store" });
    if (!response.ok) throw new Error(`Rezku shift download failed: HTTP ${response.status}`);
    results.push(await importRezkuReport(
      `shift-attestation-${results.length + 1}.xlsx`,
      await response.arrayBuffer(),
      "shifts",
      "Historical last-week replacement",
    ));
  }
  return results;
}

async function importBody(body: ImportBody) {
  if ((!body.shifts?.length) && (!body.reportUrls?.length)) {
    throw new Error("The import contains no shifts or report URLs.");
  }

  await ensureEmployeeDirectorySchema();
  const sql = getSql();
  const before = await stats();
  const reports = await importReportUrls(body.reportUrls);
  const manual = await importManualShifts(body);
  const imported = reports.reduce((sum, result) => sum + result.imported, 0) + (manual?.inserted || 0);
  if (imported < 1) throw new Error("The replacement imported zero shifts, so the existing batch was preserved.");

  let deletedBatch = false;
  if (body.deleteBatchId) {
    const deleted = await sql`
      DELETE FROM rezku_import_batches
      WHERE id = ${body.deleteBatchId}::uuid
      RETURNING id
    ` as unknown as Array<{ id: string }>;
    deletedBatch = Boolean(deleted[0]);
  }

  return {
    before,
    after: await stats(),
    reportResults: reports,
    manual,
    imported,
    deletedBatch,
  };
}

export async function GET(request: Request) {
  try {
    if (process.env.VERCEL_ENV !== "preview") {
      return Response.json({ error: "Historical import is preview-only." }, { status: 403 });
    }
    const url = new URL(request.url);
    if (url.searchParams.get("token") !== IMPORT_TOKEN) {
      return Response.json({ error: "Import token is invalid." }, { status: 403 });
    }
    const payload = url.searchParams.get("payload");
    if (!payload) throw new Error("Encrypted import payload is required.");
    return Response.json(await importBody(decryptPayload(payload)));
  } catch (error) {
    return apiError(error);
  }
}
