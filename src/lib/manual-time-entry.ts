import { ensureSchema, getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

const MAX_SHIFT_HOURS = 18;
let auditSchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function parseDate(value: string, label: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid.`);
  return parsed;
}

async function ensureManualTimeAuditSchema() {
  if (!auditSchemaPromise) {
    auditSchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS manual_time_entry_audit (
          id UUID PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          source_type TEXT NOT NULL CHECK (source_type IN ('Corner Ops', 'Rezku')),
          source_id UUID NOT NULL,
          employee_id UUID NOT NULL REFERENCES employees(id),
          employee_name TEXT NOT NULL,
          action TEXT NOT NULL DEFAULT 'Manager Added',
          actor TEXT NOT NULL,
          details JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS manual_time_entry_audit_business_created_idx ON manual_time_entry_audit (business, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS manual_time_entry_audit_employee_idx ON manual_time_entry_audit (employee_id, created_at DESC)`;
    })().catch((error) => {
      auditSchemaPromise = null;
      throw error;
    });
  }
  return auditSchemaPromise;
}

export async function createManualTimeEntry(input: {
  business: Business;
  employeeId: string;
  position: string;
  roleGroup: "Driver" | "In-House" | "Ignore";
  clockIn: string;
  clockOut: string;
  note?: string;
  actor: string;
}) {
  await ensureManualTimeAuditSchema();
  const sql = getSql();
  const start = parseDate(input.clockIn, "Clock-in");
  const end = parseDate(input.clockOut, "Clock-out");
  if (end <= start) throw new Error("Clock-out must be after clock-in.");

  const hours = Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 10000) / 10000;
  if (hours > MAX_SHIFT_HOURS) throw new Error(`A manually added shift cannot exceed ${MAX_SHIFT_HOURS} hours.`);

  const employeeRows = await sql`
    SELECT id, name, active
    FROM employees
    WHERE id = ${input.employeeId} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{ id: string; name: string; active: boolean }>;
  const employee = employeeRows[0];
  if (!employee?.active) throw new Error("Choose an active employee for this business.");

  const position = clean(input.position, 100);
  if (!position) throw new Error("Position is required.");
  const note = clean(input.note, 1500) || "Missed both clock-in and clock-out.";
  const entryId = crypto.randomUUID();
  const now = new Date().toISOString();

  if (input.business === "Tiki") {
    const overlap = await sql`
      SELECT id FROM time_entries
      WHERE employee_id = ${employee.id}
        AND clock_in < ${end.toISOString()}
        AND COALESCE(clock_out, NOW()) > ${start.toISOString()}
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (overlap[0]) throw new Error("This employee already has a Corner Ops time entry overlapping those times.");

    await sql`
      INSERT INTO time_entries (
        id, business, employee_id, employee_name, position, role_group,
        clock_in, clock_out, source, status, notes
      ) VALUES (
        ${entryId}, 'Tiki', ${employee.id}, ${employee.name}, ${position}, ${input.roleGroup},
        ${start.toISOString()}, ${end.toISOString()}, 'Manager Added', 'Corrected',
        ${`Manager added by ${input.actor}: ${note}`}
      )
    `;

    const details = JSON.stringify({ clockIn: start.toISOString(), clockOut: end.toISOString(), hours, position, note });
    await sql`
      INSERT INTO manual_time_entry_audit (
        id, business, source_type, source_id, employee_id, employee_name, action, actor, details
      ) VALUES (
        ${crypto.randomUUID()}, 'Tiki', 'Corner Ops', ${entryId}, ${employee.id}, ${employee.name},
        'Manager Added', ${input.actor}, ${details}::jsonb
      )
    `;

    return { id: entryId, business: input.business, employeeName: employee.name, source: "Corner Ops", hours };
  }

  const overlap = await sql`
    SELECT id FROM rezku_shifts
    WHERE LOWER(employee_name) = LOWER(${employee.name})
      AND clock_in IS NOT NULL
      AND clock_out IS NOT NULL
      AND clock_in < ${end.toISOString()}
      AND clock_out > ${start.toISOString()}
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (overlap[0]) throw new Error("This employee already has a Rezku shift overlapping those times.");

  const batchId = crypto.randomUUID();
  await sql`
    INSERT INTO rezku_import_batches (id, business, report_type, file_name, row_count, imported_by)
    VALUES (${batchId}, 'Corner Deli', 'shifts', 'Manual manager entry', 1, ${input.actor})
  `;

  const raw = JSON.stringify({
    manualManagerEntry: true,
    correctedAt: now,
    correctedBy: input.actor,
    note,
    clockIn: start.toISOString(),
    clockOut: end.toISOString(),
  });
  await sql`
    INSERT INTO rezku_shifts (
      id, source_key, batch_id, employee_name, position, role_group,
      clock_in, clock_out, reported_hours, raw
    ) VALUES (
      ${entryId}, ${`manual:${entryId}`}, ${batchId}, ${employee.name}, ${position}, ${input.roleGroup},
      ${start.toISOString()}, ${end.toISOString()}, ${hours}, ${raw}::jsonb
    )
  `;

  const details = JSON.stringify({ clockIn: start.toISOString(), clockOut: end.toISOString(), hours, position, note, batchId });
  await sql`
    INSERT INTO manual_time_entry_audit (
      id, business, source_type, source_id, employee_id, employee_name, action, actor, details
    ) VALUES (
      ${crypto.randomUUID()}, 'Corner Deli', 'Rezku', ${entryId}, ${employee.id}, ${employee.name},
      'Manager Added', ${input.actor}, ${details}::jsonb
    )
  `;

  return { id: entryId, business: input.business, employeeName: employee.name, source: "Rezku", hours };
}
