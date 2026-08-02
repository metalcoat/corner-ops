import { createDecipheriv, createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as XLSX from "xlsx";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { getSql } from "@/lib/db";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const IMPORT_TOKEN = "bUWSZ73mPpsxYTA-WG7baxkguk9-HjhpdS1vzAGC4ys";
const PAYLOAD_KEY = Buffer.from("Id6-TFYoEA2YXDDYNZR0wxyR-K39j5o0PilStA48ye4", "base64url");
const REZKU_HOST = "files.reporting.rezkupos.com";
const TIME_ZONE = "America/New_York";

type Payload = { reportUrls: string[]; deleteBatchIds: string[] };
type AttestationRow = { User?: unknown; "Clock In"?: unknown; "Clock Out"?: unknown; Text?: unknown; Response?: unknown };

function decryptPayload(value: string): Payload {
  const [nonceText, cipherText] = value.split(".");
  if (!nonceText || !cipherText) throw new Error("Encrypted payload is malformed.");
  const nonce = Buffer.from(nonceText, "base64url");
  const combined = Buffer.from(cipherText, "base64url");
  if (combined.length <= 16) throw new Error("Encrypted payload is incomplete.");
  const encrypted = combined.subarray(0, combined.length - 16);
  const tag = combined.subarray(combined.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", PAYLOAD_KEY, nonce);
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(gunzipSync(compressed).toString("utf8")) as Payload;
}

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function getOffsetMilliseconds(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
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
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return represented - date.getTime();
}

function parseRezkuLocal(value: unknown): Date | null {
  const text = clean(value, 100);
  if (!text) return null;
  const match = text.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) throw new Error(`Unexpected Rezku timestamp: ${text}`);
  const month = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(match[1].toLowerCase());
  if (month < 0) throw new Error(`Unexpected Rezku month: ${text}`);
  let hour = Number(match[4]);
  const meridiem = match[6].toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  const localUtc = Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5]), 0);
  let timestamp = localUtc;
  for (let index = 0; index < 2; index += 1) timestamp = localUtc - getOffsetMilliseconds(new Date(timestamp));
  return new Date(timestamp);
}

function sourceKey(employee: string, clockIn: Date, clockOut: Date | null): string {
  return createHash("sha256")
    .update(["last-week-attestation-v2", employee.toLowerCase(), clockIn.toISOString(), clockOut?.toISOString() || ""].join("|"))
    .digest("hex");
}

async function stats() {
  const rows = await getSql()`
    SELECT COUNT(*)::INTEGER AS count, MIN(clock_in) AS first_clock_in, MAX(COALESCE(clock_out, clock_in)) AS last_clock_out
    FROM rezku_shifts
  ` as unknown as Array<{ count: number; first_clock_in: string | null; last_clock_out: string | null }>;
  return rows[0];
}

export async function GET(request: Request) {
  try {
    if (process.env.VERCEL_ENV !== "preview") return Response.json({ error: "Preview only." }, { status: 403 });
    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.get("token") !== IMPORT_TOKEN) return Response.json({ error: "Invalid token." }, { status: 403 });
    const encrypted = requestUrl.searchParams.get("payload");
    if (!encrypted) throw new Error("Encrypted payload is required.");
    const payload = decryptPayload(encrypted);
    if (!Array.isArray(payload.reportUrls) || payload.reportUrls.length !== 7) throw new Error("Exactly seven daily reports are required.");

    await ensureEmployeeDirectorySchema();
    const sql = getSql();
    const employeeRows = await sql`
      SELECT name, position, role_group
      FROM employees
      WHERE business = 'Corner Deli'
    ` as unknown as Array<{ name: string; position: string; role_group: string }>;
    const employees = new Map(employeeRows.map((row) => [row.name.trim().toLowerCase(), row]));

    const parsed: Array<{ employee: string; position: string; roleGroup: string; clockIn: Date; clockOut: Date | null; raw: AttestationRow }> = [];
    for (const value of payload.reportUrls) {
      const reportUrl = new URL(value);
      if (reportUrl.protocol !== "https:" || reportUrl.hostname !== REZKU_HOST || !reportUrl.pathname.endsWith("shift-attestation-export.xlsx")) {
        throw new Error("Only trusted Rezku shift-attestation Excel links are allowed.");
      }
      const response = await fetch(reportUrl, { redirect: "follow", cache: "no-store" });
      if (!response.ok) throw new Error(`Rezku download failed: HTTP ${response.status}`);
      const workbook = XLSX.read(await response.arrayBuffer(), { type: "array", cellDates: false });
      const sheet = workbook.Sheets.Main;
      if (!sheet) throw new Error("Rezku workbook is missing the Main sheet.");
      const rows = XLSX.utils.sheet_to_json<AttestationRow>(sheet, { defval: "", raw: false });
      for (const row of rows) {
        const employee = clean(row.User, 120);
        const clockIn = parseRezkuLocal(row["Clock In"]);
        if (!employee || !clockIn) continue;
        const clockOut = parseRezkuLocal(row["Clock Out"]);
        const directory = employees.get(employee.toLowerCase());
        parsed.push({
          employee,
          position: clean(directory?.position, 100) || "Employee",
          roleGroup: ["Driver", "In-House", "Ignore"].includes(directory?.role_group || "") ? directory!.role_group : "In-House",
          clockIn,
          clockOut,
          raw: row,
        });
      }
    }
    if (parsed.length < 1) throw new Error("No valid punches were found in the seven reports.");

    const before = await stats();
    const batchId = crypto.randomUUID();
    await sql`
      INSERT INTO rezku_import_batches (id, report_type, file_name, row_count, imported_by)
      VALUES (${batchId}, 'shifts', 'Rezku punches 2026-07-20 through 2026-07-26', 0, 'One-time last-week replacement')
    `;

    let inserted = 0;
    let duplicates = 0;
    for (const row of parsed) {
      const hours = row.clockOut ? Math.max(0, (row.clockOut.getTime() - row.clockIn.getTime()) / 3_600_000) : 0;
      const result = await sql`
        INSERT INTO rezku_shifts (
          id, source_key, batch_id, employee_name, position, role_group,
          clock_in, clock_out, reported_hours, raw
        ) VALUES (
          ${crypto.randomUUID()}, ${sourceKey(row.employee, row.clockIn, row.clockOut)}, ${batchId},
          ${row.employee}, ${row.position}, ${row.roleGroup}, ${row.clockIn.toISOString()},
          ${row.clockOut?.toISOString() || null}, ${hours},
          ${JSON.stringify({ ...row.raw, source: "Rezku Shift Attestation", historicalImport: true })}::jsonb
        )
        ON CONFLICT (source_key) DO NOTHING
        RETURNING id
      ` as unknown as Array<{ id: string }>;
      if (result[0]) inserted += 1;
      else duplicates += 1;
    }
    await sql`UPDATE rezku_import_batches SET row_count = ${inserted} WHERE id = ${batchId}`;
    if (inserted < 1) throw new Error("The corrected import inserted zero punches; old batches were preserved.");

    let deletedBatches = 0;
    for (const oldBatchId of payload.deleteBatchIds || []) {
      const deleted = await sql`
        DELETE FROM rezku_import_batches WHERE id = ${oldBatchId}::uuid RETURNING id
      ` as unknown as Array<{ id: string }>;
      if (deleted[0]) deletedBatches += 1;
    }

    return Response.json({ before, after: await stats(), parsed: parsed.length, inserted, duplicates, deletedBatches, batchId });
  } catch (error) {
    return apiError(error);
  }
}
