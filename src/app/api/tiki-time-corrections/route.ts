import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized, ValidationError } from "@/lib/http";
import { correctPunch } from "@/lib/payroll-punch-correction";
import { payrollWeekBounds } from "@/lib/payroll-week";

export const runtime = "nodejs";

const TIME_ZONE = "America/New_York";

function easternOffsetMilliseconds(date: Date) {
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
  return Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  ) - date.getTime();
}

function easternWallToIso(value: unknown) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new ValidationError("Enter a valid Eastern date and time.");
  const wall = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] || 0),
  );
  let timestamp = wall;
  for (let index = 0; index < 3; index += 1) timestamp = wall - easternOffsetMilliseconds(new Date(timestamp));
  return new Date(timestamp).toISOString();
}

function correctionReason(value: unknown) {
  return String(value || "").trim().slice(0, 1000) || "Owner time correction";
}

async function adjustment(input: {
  sourceId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  actor: string;
}) {
  await getSql()`
    INSERT INTO time_entry_adjustments (
      id, business, source_type, source_id, before_state, after_state, reason, actor
    ) VALUES (
      ${crypto.randomUUID()}, 'Tiki', 'Tiki', ${input.sourceId},
      ${JSON.stringify(input.before)}::jsonb, ${JSON.stringify(input.after)}::jsonb,
      ${input.reason}, ${input.actor}
    )
  `;
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "payroll.read");
    if (!canAccessBusiness(session, "Tiki")) return Response.json({ error: "Business access denied." }, { status: 403 });

    const url = new URL(request.url);
    const weekStart = String(url.searchParams.get("weekStart") || "");
    const bounds = payrollWeekBounds(weekStart);
    const rows = await getSql()`
      SELECT id, employee_id, employee_name, position, role_group,
        clock_in, clock_out, status, notes, source, created_at, updated_at
      FROM time_entries
      WHERE business = 'Tiki'
        AND clock_in >= ${bounds.start.toISOString()}
        AND clock_in < ${bounds.end.toISOString()}
      ORDER BY employee_name, clock_in, created_at, id
    ` as unknown as Array<Record<string, unknown>>;

    return Response.json({
      weekStart,
      punches: rows.map((row) => ({
        id: String(row.id),
        employeeId: String(row.employee_id),
        employeeName: String(row.employee_name),
        position: String(row.position || ""),
        roleGroup: String(row.role_group || ""),
        clockIn: row.clock_in ? new Date(String(row.clock_in)).toISOString() : null,
        clockOut: row.clock_out ? new Date(String(row.clock_out)).toISOString() : null,
        status: String(row.status || ""),
        notes: String(row.notes || ""),
        source: String(row.source || ""),
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "payroll.write");
    if (!canAccessBusiness(session, "Tiki")) return Response.json({ error: "Business access denied." }, { status: 403 });

    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "correct") {
      const clockIn = easternWallToIso(body.clockInWall);
      const clockOut = String(body.clockOutWall || "").trim() ? easternWallToIso(body.clockOutWall) : null;
      return Response.json(await correctPunch({
        business: "Tiki",
        sourceType: "Tiki",
        sourceId: String(body.sourceId || ""),
        employeeName: body.employeeName ? String(body.employeeName) : undefined,
        position: body.position ? String(body.position) : undefined,
        clockIn,
        clockOut,
        reason: correctionReason(body.reason),
        actor: session.email,
      }));
    }

    if (action === "use-in-as-prior-out") {
      const sourceId = String(body.sourceId || "");
      const reason = correctionReason(body.reason);
      const mistakenRows = await getSql()`
        SELECT * FROM time_entries
        WHERE id = ${sourceId} AND business = 'Tiki'
        LIMIT 1
      ` as unknown as Array<Record<string, unknown>>;
      const mistaken = mistakenRows[0];
      if (!mistaken) throw new ValidationError("That Tiki punch was not found. Reload and try again.");
      const mistakenClockIn = new Date(String(mistaken.clock_in));
      if (Number.isNaN(mistakenClockIn.getTime())) throw new ValidationError("The selected Tiki punch has an invalid clock-in time.");
      const mistakenClockInIso = mistakenClockIn.toISOString();

      const priorRows = await getSql()`
        SELECT * FROM time_entries
        WHERE business = 'Tiki'
          AND employee_id = ${String(mistaken.employee_id)}::uuid
          AND id <> ${sourceId}::uuid
          AND clock_in < ${mistakenClockInIso}
          AND clock_in >= ${mistakenClockInIso}::timestamptz - INTERVAL '18 hours'
        ORDER BY clock_in DESC, created_at DESC, id DESC
        LIMIT 1
      ` as unknown as Array<Record<string, unknown>>;
      const prior = priorRows[0];
      if (!prior) throw new ValidationError("No earlier Tiki shift was found close enough to use this punch as its clock-out.");

      const priorSaved = await getSql()`
        UPDATE time_entries SET
          clock_out = ${mistakenClockInIso},
          status = 'Corrected',
          notes = CONCAT_WS(E'\n', NULLIF(notes, ''), ${`Correction: ${reason}. Lunch/duplicate IN used as prior shift OUT.`}),
          updated_at = NOW()
        WHERE id = ${String(prior.id)}::uuid AND business = 'Tiki'
        RETURNING *
      ` as unknown as Array<Record<string, unknown>>;
      const mistakenSaved = await getSql()`
        UPDATE time_entries SET
          clock_out = clock_in,
          status = 'Corrected',
          notes = CONCAT_WS(E'\n', NULLIF(notes, ''), ${`Correction: ${reason}. Mistaken IN moved to prior shift OUT; this row was zeroed.`}),
          updated_at = NOW()
        WHERE id = ${sourceId}::uuid AND business = 'Tiki'
        RETURNING *
      ` as unknown as Array<Record<string, unknown>>;

      const priorAfter = priorSaved[0];
      const mistakenAfter = mistakenSaved[0];
      if (!priorAfter || !mistakenAfter) throw new Error("The Tiki punch correction did not fully save. Reload before making another change.");

      await adjustment({ sourceId: String(prior.id), before: prior, after: priorAfter, reason, actor: session.email });
      await adjustment({ sourceId, before: mistaken, after: mistakenAfter, reason, actor: session.email });

      return Response.json({
        corrected: true,
        priorShiftId: String(prior.id),
        mistakenPunchId: sourceId,
        priorClockOut: mistakenClockInIso,
      });
    }

    return Response.json({ error: "Unknown Tiki correction action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
