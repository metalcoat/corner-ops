import { createHash } from "node:crypto";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { getSql } from "@/lib/db";
import { apiError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const IMPORT_TOKEN = "bUWSZ73mPpsxYTA-WG7baxkguk9-HjhpdS1vzAGC4ys";

type ImportedShift = {
  employeeName: string;
  position?: string;
  roleGroup?: string;
  clockIn: string;
  clockOut?: string | null;
  reportedHours?: number;
  source?: string;
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

async function stats() {
  const rows = await getSql()`
    SELECT COUNT(*)::INTEGER AS count, MIN(clock_in) AS first_clock_in, MAX(COALESCE(clock_out, clock_in)) AS last_clock_out
    FROM rezku_shifts
  ` as unknown as Array<{ count: number; first_clock_in: string | null; last_clock_out: string | null }>;
  return rows[0];
}

export async function POST(request: Request) {
  try {
    if (process.env.VERCEL_ENV !== "preview") {
      return Response.json({ error: "Historical import is preview-only." }, { status: 403 });
    }
    if (request.headers.get("x-import-token") !== IMPORT_TOKEN) {
      return Response.json({ error: "Import token is invalid." }, { status: 403 });
    }

    const body = await request.json() as { fileName?: string; shifts?: ImportedShift[] };
    if (!Array.isArray(body.shifts) || body.shifts.length < 1 || body.shifts.length > 5000) {
      throw new Error("Import must contain between 1 and 5,000 shifts.");
    }

    await ensureEmployeeDirectorySchema();
    const sql = getSql();
    const before = await stats();
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
    const after = await stats();

    return Response.json({ before, after, submitted: body.shifts.length, inserted, duplicate, batchId: inserted ? batchId : null });
  } catch (error) {
    return apiError(error);
  }
}
