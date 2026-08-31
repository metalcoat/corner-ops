import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized, ValidationError } from "@/lib/http";
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

function easternLabel(value: unknown) {
  if (!value) return "Open";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return "Invalid time";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

function correctionReason(value: unknown) {
  return String(value || "").trim().slice(0, 1000) || "Owner time correction";
}

function clean(value: unknown, max: number) {
  return String(value || "").trim().slice(0, max);
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

async function reconcileLiveClockState(input: {
  sourceId: string;
  reason: string;
  actor: string;
}) {
  const selectedRows = await getSql()`
    SELECT * FROM time_entries
    WHERE id = ${input.sourceId}::uuid AND business = 'Tiki'
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const selected = selectedRows[0];
  if (!selected) throw new ValidationError("The corrected Tiki punch could not be reloaded.");
  if (!selected.clock_out) return { staleOpenPunchesResolved: 0 };

  const correctedOut = new Date(String(selected.clock_out));
  if (Number.isNaN(correctedOut.getTime())) throw new ValidationError("The corrected Tiki clock-out is invalid.");
  const correctedOutIso = correctedOut.toISOString();

  const staleRows = await getSql()`
    SELECT * FROM time_entries
    WHERE business = 'Tiki'
      AND employee_id = ${String(selected.employee_id)}::uuid
      AND id <> ${input.sourceId}::uuid
      AND clock_out IS NULL
      AND clock_in <= ${correctedOutIso}
    ORDER BY clock_in, created_at, id
  ` as unknown as Array<Record<string, unknown>>;

  let resolved = 0;
  for (const stale of staleRows) {
    const savedRows = await getSql()`
      UPDATE time_entries SET
        clock_out = clock_in,
        status = 'Corrected',
        notes = CONCAT_WS(E'\n', NULLIF(notes, ''), ${`Correction: ${input.reason}. Stale open punch zeroed after owner correction reconciled live clock state.`}::text),
        updated_at = NOW()
      WHERE id = ${String(stale.id)}::uuid
        AND business = 'Tiki'
        AND clock_out IS NULL
      RETURNING *
    ` as unknown as Array<Record<string, unknown>>;
    const after = savedRows[0];
    if (!after) continue;
    try {
      await adjustment({
        sourceId: String(stale.id),
        before: stale,
        after,
        reason: input.reason,
        actor: input.actor,
      });
    } catch (error) {
      console.error("[tiki-time-correction] stale-punch audit failed", {
        sourceId: String(stale.id),
        error,
      });
    }
    resolved += 1;
  }

  return { staleOpenPunchesResolved: resolved };
}

async function correctTikiPunch(input: {
  sourceId: string;
  employeeName: string;
  position: string;
  clockIn: string;
  clockOut: string | null;
  reason: string;
  actor: string;
}) {
  const requestId = crypto.randomUUID().slice(0, 8);
  const clockIn = new Date(input.clockIn);
  const clockOut = input.clockOut ? new Date(input.clockOut) : null;
  if (Number.isNaN(clockIn.getTime())) throw new ValidationError("Enter a valid clock-in time.");
  if (clockOut && Number.isNaN(clockOut.getTime())) throw new ValidationError("Enter a valid clock-out time.");
  if (clockOut && clockOut < clockIn) throw new ValidationError("Clock-out cannot precede clock-in.");

  try {
    const beforeRows = await getSql()`
      SELECT * FROM time_entries
      WHERE id = ${input.sourceId}::uuid AND business = 'Tiki'
      LIMIT 1
    ` as unknown as Array<Record<string, unknown>>;
    const before = beforeRows[0];
    if (!before) throw new ValidationError("That Tiki punch was not found. Reload payroll and try again.");

    const savedRows = await getSql()`
      UPDATE time_entries SET
        employee_name = ${input.employeeName || String(before.employee_name || "")},
        position = ${input.position || String(before.position || "")},
        clock_in = ${clockIn.toISOString()},
        clock_out = ${clockOut?.toISOString() || null},
        status = 'Corrected',
        notes = CONCAT_WS(E'\n', NULLIF(notes, ''), ${`Correction: ${input.reason}`}::text),
        updated_at = NOW()
      WHERE id = ${input.sourceId}::uuid AND business = 'Tiki'
      RETURNING *
    ` as unknown as Array<Record<string, unknown>>;
    const saved = savedRows[0];
    if (!saved) throw new Error("The Tiki punch update returned no row.");

    let auditSaved = true;
    try {
      await adjustment({
        sourceId: input.sourceId,
        before,
        after: saved,
        reason: input.reason,
        actor: input.actor,
      });
    } catch (error) {
      auditSaved = false;
      console.error("[tiki-time-correction] primary audit failed", { requestId, sourceId: input.sourceId, error });
    }

    let staleOpenPunchesResolved = 0;
    let cleanupWarning = "";
    try {
      const liveState = await reconcileLiveClockState({ sourceId: input.sourceId, reason: input.reason, actor: input.actor });
      staleOpenPunchesResolved = liveState.staleOpenPunchesResolved;
    } catch (error) {
      cleanupWarning = "The punch saved, but live-clock cleanup needs review.";
      console.error("[tiki-time-correction] live-clock cleanup failed", { requestId, sourceId: input.sourceId, error });
    }

    console.info("[tiki-time-correction] saved", {
      requestId,
      sourceId: input.sourceId,
      employeeName: String(saved.employee_name || ""),
      clockIn: saved.clock_in,
      clockOut: saved.clock_out,
      auditSaved,
      staleOpenPunchesResolved,
    });

    return {
      corrected: true,
      requestId,
      punch: {
        id: String(saved.id),
        employeeId: String(saved.employee_id),
        employeeName: String(saved.employee_name),
        clockIn: new Date(String(saved.clock_in)).toISOString(),
        clockOut: saved.clock_out ? new Date(String(saved.clock_out)).toISOString() : null,
        clockInEastern: easternLabel(saved.clock_in),
        clockOutEastern: easternLabel(saved.clock_out),
        status: String(saved.status),
      },
      auditSaved,
      staleOpenPunchesResolved,
      warning: cleanupWarning || (auditSaved ? "" : "The punch saved, but its audit entry needs review."),
    };
  } catch (error) {
    console.error("[tiki-time-correction] save failed", {
      requestId,
      sourceId: input.sourceId,
      employeeName: input.employeeName,
      clockIn: input.clockIn,
      clockOut: input.clockOut,
      error,
    });
    if (error instanceof ValidationError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`Tiki correction failed [${requestId}]: ${detail}`);
  }
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
      const sourceId = String(body.sourceId || "");
      const reason = correctionReason(body.reason);
      const clockIn = easternWallToIso(body.clockInWall);
      const clockOut = String(body.clockOutWall || "").trim() ? easternWallToIso(body.clockOutWall) : null;
      return Response.json(await correctTikiPunch({
        sourceId,
        employeeName: clean(body.employeeName, 120),
        position: clean(body.position, 100),
        clockIn,
        clockOut,
        reason,
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
          notes = CONCAT_WS(E'\n', NULLIF(notes, ''), ${`Correction: ${reason}. Lunch/duplicate IN used as prior shift OUT.`}::text),
          updated_at = NOW()
        WHERE id = ${String(prior.id)}::uuid AND business = 'Tiki'
        RETURNING *
      ` as unknown as Array<Record<string, unknown>>;
      const mistakenSaved = await getSql()`
        UPDATE time_entries SET
          clock_out = clock_in,
          status = 'Corrected',
          notes = CONCAT_WS(E'\n', NULLIF(notes, ''), ${`Correction: ${reason}. Mistaken IN moved to prior shift OUT; this row was zeroed.`}::text),
          updated_at = NOW()
        WHERE id = ${sourceId}::uuid AND business = 'Tiki'
        RETURNING *
      ` as unknown as Array<Record<string, unknown>>;

      const priorAfter = priorSaved[0];
      const mistakenAfter = mistakenSaved[0];
      if (!priorAfter || !mistakenAfter) throw new Error("The Tiki punch correction did not fully save. Reload before making another change.");

      await adjustment({ sourceId: String(prior.id), before: prior, after: priorAfter, reason, actor: session.email });
      await adjustment({ sourceId, before: mistaken, after: mistakenAfter, reason, actor: session.email });
      const liveState = await reconcileLiveClockState({ sourceId: String(prior.id), reason, actor: session.email });

      return Response.json({
        corrected: true,
        priorShiftId: String(prior.id),
        mistakenPunchId: sourceId,
        priorClockOut: mistakenClockInIso,
        ...liveState,
      });
    }

    return Response.json({ error: "Unknown Tiki correction action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
