import { ensureSchema, getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function correctPunch(input: {
  business: Business;
  sourceType: "Tiki" | "Rezku";
  sourceId: string;
  employeeName?: string;
  position?: string;
  clockIn: string;
  clockOut?: string | null;
  reason: string;
  actor: string;
}) {
  await ensureSchema();
  const clockIn = new Date(input.clockIn);
  const clockOut = input.clockOut ? new Date(input.clockOut) : null;
  if (Number.isNaN(clockIn.getTime())) throw new Error("Enter a valid clock-in time.");
  if (clockOut && Number.isNaN(clockOut.getTime())) throw new Error("Enter a valid clock-out time.");
  if (clockOut && clockOut < clockIn) throw new Error("Clock-out cannot precede clock-in.");
  const reason = clean(input.reason, 1000);
  if (reason.length < 3) throw new Error("A correction reason is required.");

  const beforeRows = input.sourceType === "Tiki"
    ? await getSql()`SELECT * FROM time_entries WHERE id = ${input.sourceId} AND business = ${input.business} LIMIT 1`
    : await getSql()`SELECT * FROM rezku_shifts WHERE id = ${input.sourceId} LIMIT 1`;
  const before = (beforeRows as unknown as Array<Record<string, unknown>>)[0];
  if (!before) throw new Error("Punch record was not found. Reload payroll and try again.");

  let savedRows: Array<Record<string, unknown>>;
  if (input.sourceType === "Tiki") {
    savedRows = await getSql()`
      UPDATE time_entries SET
        employee_name = ${clean(input.employeeName || before.employee_name, 120)},
        position = ${clean(input.position || before.position, 100)},
        clock_in = ${clockIn.toISOString()},
        clock_out = ${clockOut?.toISOString() || null},
        status = 'Corrected',
        notes = CONCAT_WS(E'\n', NULLIF(notes, ''), ${`Correction: ${reason}`}),
        updated_at = NOW()
      WHERE id = ${input.sourceId} AND business = ${input.business}
      RETURNING *
    ` as unknown as Array<Record<string, unknown>>;
  } else {
    const hours = clockOut
      ? Math.max(0, (clockOut.getTime() - clockIn.getTime()) / 3_600_000)
      : numberValue(before.reported_hours);
    const correction = {
      correctionReason: reason,
      correctedBy: input.actor,
      correctedAt: new Date().toISOString(),
    };
    savedRows = await getSql()`
      UPDATE rezku_shifts SET
        employee_name = ${clean(input.employeeName || before.employee_name, 120)},
        position = ${clean(input.position || before.position, 100)},
        clock_in = ${clockIn.toISOString()},
        clock_out = ${clockOut?.toISOString() || null},
        reported_hours = ${hours},
        raw = COALESCE(raw, '{}'::jsonb) || ${JSON.stringify(correction)}::jsonb
      WHERE id = ${input.sourceId}
      RETURNING *
    ` as unknown as Array<Record<string, unknown>>;
  }

  const after = savedRows[0];
  if (!after) {
    throw new Error("Shift correction was not saved. Reload payroll and try again.");
  }

  await getSql()`
    INSERT INTO time_entry_adjustments (
      id, business, source_type, source_id, before_state, after_state, reason, actor
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.sourceType}, ${input.sourceId},
      ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, ${reason}, ${input.actor}
    )
  `;

  return {
    corrected: true,
    source: input.sourceType === "Tiki" ? "time_entries" : "rezku_shifts",
    punch: {
      id: after.id,
      clockIn: after.clock_in,
      clockOut: after.clock_out,
    },
  };
}
