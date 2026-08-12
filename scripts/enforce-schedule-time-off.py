from pathlib import Path

# Shared server-side time-off enforcement.
Path('src/lib/schedule-time-off.ts').write_text(r'''import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

const TIME_ZONE = "America/New_York";

export type ScheduleTimeOffConflict = {
  id: string;
  status: "Pending" | "Approved";
  startsOn: string;
  endsOn: string;
  employeeName: string;
};

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

function rangeLabel(conflict: ScheduleTimeOffConflict): string {
  return conflict.startsOn === conflict.endsOn
    ? dateLabel(conflict.startsOn)
    : `${dateLabel(conflict.startsOn)} through ${dateLabel(conflict.endsOn)}`;
}

export async function scheduleTimeOffConflicts(input: {
  business: Business;
  employeeId: string;
  startsAt: string | Date;
  endsAt: string | Date;
}): Promise<ScheduleTimeOffConflict[]> {
  const start = new Date(input.startsAt);
  const end = new Date(input.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return [];

  const rows = await getSql()`
    SELECT t.id, t.status, t.starts_on::text AS starts_on, t.ends_on::text AS ends_on, e.name AS employee_name
    FROM time_off_requests t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.business = ${input.business}
      AND t.employee_id = ${input.employeeId}
      AND t.status IN ('Pending', 'Approved')
      AND (t.starts_on::date AT TIME ZONE ${TIME_ZONE}) < ${end.toISOString()}
      AND ((t.ends_on::date + 1) AT TIME ZONE ${TIME_ZONE}) > ${start.toISOString()}
    ORDER BY CASE WHEN t.status = 'Approved' THEN 0 ELSE 1 END, t.starts_on
  ` as unknown as Array<{
    id: string;
    status: "Pending" | "Approved";
    starts_on: string;
    ends_on: string;
    employee_name: string;
  }>;

  return rows.map((row) => ({
    id: String(row.id),
    status: row.status,
    startsOn: String(row.starts_on),
    endsOn: String(row.ends_on),
    employeeName: String(row.employee_name || "Employee"),
  }));
}

export async function enforceScheduleTimeOff(input: {
  business: Business;
  employeeId: string;
  startsAt: string | Date;
  endsAt: string | Date;
  acknowledgePendingTimeOff?: boolean;
}) {
  const conflicts = await scheduleTimeOffConflicts(input);
  const approved = conflicts.find((conflict) => conflict.status === "Approved");
  if (approved) {
    throw new Error(`${approved.employeeName} has approved time off ${rangeLabel(approved)}. Reassign this shift or leave it open.`);
  }
  const pending = conflicts.find((conflict) => conflict.status === "Pending");
  if (pending && !input.acknowledgePendingTimeOff) {
    throw new Error(`${pending.employeeName} has a pending time-off request ${rangeLabel(pending)}. Review the request or acknowledge the warning before assigning this shift.`);
  }
  return { conflicts, pending: conflicts.filter((conflict) => conflict.status === "Pending") };
}
''')

# Draft creation: enforce approved hard block and pending acknowledgement.
p = Path('src/lib/schedule-draft.ts')
s = p.read_text()
s = s.replace('import { normalizeScheduleTimeRange } from "@/lib/schedule-time-range";\n', 'import { normalizeScheduleTimeRange } from "@/lib/schedule-time-range";\nimport { enforceScheduleTimeOff } from "@/lib/schedule-time-off";\n')
s = s.replace('  actor: string;\n}) {', '  actor: string;\n  acknowledgePendingTimeOff?: boolean;\n}) {', 1)
old = '''    if (overlap[0]) throw new Error("That employee already has an overlapping shift.");\n  }\n\n  const id = crypto.randomUUID();'''
new = '''    if (overlap[0]) throw new Error("That employee already has an overlapping shift.");
    await enforceScheduleTimeOff({
      business: input.business,
      employeeId: input.employeeId,
      startsAt: start,
      endsAt: end,
      acknowledgePendingTimeOff: input.acknowledgePendingTimeOff,
    });
  }

  const id = crypto.randomUUID();'''
if old not in s: raise SystemExit('draft enforcement insertion not found')
s = s.replace(old, new, 1)
p.write_text(s)

# Shift edit/move enforcement.
p = Path('src/lib/schedule-actions.ts')
s = p.read_text()
s = s.replace('import { normalizeScheduleTimeRange } from "@/lib/schedule-time-range";\n', 'import { normalizeScheduleTimeRange } from "@/lib/schedule-time-range";\nimport { enforceScheduleTimeOff } from "@/lib/schedule-time-off";\n')
s = s.replace('  notes?: string;\n}) {', '  notes?: string;\n  acknowledgePendingTimeOff?: boolean;\n}) {', 1)
old = '''    if (overlap[0]) throw new Error("That employee already has an overlapping shift.");\n  }\n\n  await sql`'''
new = '''    if (overlap[0]) throw new Error("That employee already has an overlapping shift.");
    await enforceScheduleTimeOff({
      business: input.business,
      employeeId,
      startsAt: start,
      endsAt: end,
      acknowledgePendingTimeOff: input.acknowledgePendingTimeOff,
    });
  }

  await sql`'''
if old not in s: raise SystemExit('actions enforcement insertion not found')
s = s.replace(old, new, 1)
p.write_text(s)

# API passes pending acknowledgement from the manager UI.
p = Path('src/app/api/workforce/route.ts')
s = p.read_text()
s = s.replace('          actor: session.displayName,\n        }), { status: 201 });', '          actor: session.displayName,\n          acknowledgePendingTimeOff: body.acknowledgePendingTimeOff === true,\n        }), { status: 201 });', 1)
s = s.replace('          notes: body.notes === undefined ? undefined : String(body.notes || ""),\n        }));', '          notes: body.notes === undefined ? undefined : String(body.notes || ""),\n          acknowledgePendingTimeOff: body.acknowledgePendingTimeOff === true,\n        }));', 1)
p.write_text(s)

# Copy weeks: approved time-off assignments become unassigned drafts.
p = Path('src/lib/schedule-week-copy.ts')
s = p.read_text()
start = s.index('  const inserted = await sql`')
end = s.index('\n\n  return {', start)
replacement = r'''  const inserted = await sql`
    WITH source_shifts AS (
      SELECT
        s.*,
        COALESCE(e.active, FALSE) AS employee_active,
        ((s.starts_at AT TIME ZONE ${TIME_ZONE}) + (${targetWeekStart}::date - ${sourceWeekStart}::date) * INTERVAL '1 day') AT TIME ZONE ${TIME_ZONE} AS target_starts_at,
        ((s.ends_at AT TIME ZONE ${TIME_ZONE}) + (${targetWeekStart}::date - ${sourceWeekStart}::date) * INTERVAL '1 day') AT TIME ZONE ${TIME_ZONE} AS target_ends_at,
        CASE WHEN s.meal_break_start IS NULL THEN NULL ELSE ((s.meal_break_start AT TIME ZONE ${TIME_ZONE}) + (${targetWeekStart}::date - ${sourceWeekStart}::date) * INTERVAL '1 day') AT TIME ZONE ${TIME_ZONE} END AS target_meal_break_start,
        CASE WHEN s.extra_meal_break_start IS NULL THEN NULL ELSE ((s.extra_meal_break_start AT TIME ZONE ${TIME_ZONE}) + (${targetWeekStart}::date - ${sourceWeekStart}::date) * INTERVAL '1 day') AT TIME ZONE ${TIME_ZONE} END AS target_extra_meal_break_start
      FROM schedule_shifts s
      LEFT JOIN employees e ON e.id = s.employee_id AND e.business = s.business
      WHERE s.business = ${input.business}
        AND s.starts_at >= (${sourceWeekStart}::date AT TIME ZONE ${TIME_ZONE})
        AND s.starts_at < ((${sourceWeekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
        AND s.status <> 'Cancelled'
    ), prepared AS (
      SELECT source_shifts.*,
        CASE
          WHEN employee_active = TRUE AND employee_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM time_off_requests t
            WHERE t.business = source_shifts.business
              AND t.employee_id = source_shifts.employee_id
              AND t.status = 'Approved'
              AND (t.starts_on::date AT TIME ZONE ${TIME_ZONE}) < source_shifts.target_ends_at
              AND ((t.ends_on::date + 1) AT TIME ZONE ${TIME_ZONE}) > source_shifts.target_starts_at
          ) THEN employee_id
          ELSE NULL
        END AS target_employee_id
      FROM source_shifts
    )
    INSERT INTO schedule_shifts (
      id, business, employee_id, position, starts_at, ends_at,
      meal_break_start, meal_break_minutes,
      extra_meal_break_start, extra_meal_break_minutes,
      status, notes, created_by, published_at, created_at, updated_at
    )
    SELECT
      gen_random_uuid(), business, target_employee_id, position, target_starts_at, target_ends_at,
      target_meal_break_start, meal_break_minutes, target_extra_meal_break_start, extra_meal_break_minutes,
      'Draft', notes, ${input.actor}, NULL, NOW(), NOW()
    FROM prepared
    WHERE NOT EXISTS (
      SELECT 1 FROM schedule_shifts existing
      WHERE existing.business = prepared.business
        AND existing.status <> 'Cancelled'
        AND existing.employee_id IS NOT DISTINCT FROM prepared.target_employee_id
        AND existing.position = prepared.position
        AND existing.starts_at = prepared.target_starts_at
        AND existing.ends_at = prepared.target_ends_at
    )
    RETURNING id, employee_id
  ` as unknown as Array<{ id: string; employee_id: string | null }>;'''
s = s[:start] + replacement + s[end:]
p.write_text(s)

# Publishing hard-blocks any approved time-off conflict, including already-published schedules being resent.
p = Path('src/lib/schedule-publish-validation.ts')
s = p.read_text()
marker = '''  const problems: string[] = [];\n'''
insert = r'''  const approvedTimeOffConflicts = await getSql()`
    SELECT s.id AS shift_id, e.name AS employee_name, s.starts_at
    FROM schedule_shifts s
    JOIN employees e ON e.id = s.employee_id
    JOIN time_off_requests t ON t.employee_id = s.employee_id AND t.business = s.business
    WHERE s.business = ${input.business}
      AND s.starts_at >= (${weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < ((${weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
      AND t.status = 'Approved'
      AND (t.starts_on::date AT TIME ZONE ${TIME_ZONE}) < s.ends_at
      AND ((t.ends_on::date + 1) AT TIME ZONE ${TIME_ZONE}) > s.starts_at
    ORDER BY s.starts_at, e.name
  ` as unknown as Array<{ shift_id: string; employee_name: string; starts_at: string }>;

  const problems: string[] = [];
  if (approvedTimeOffConflicts.length) {
    problems.push(`Approved time off conflicts: ${approvedTimeOffConflicts.slice(0, 8).map((item) => `${item.employee_name} at ${localStamp(item.starts_at)}`).join("; ")}. Reassign or open these shifts.`);
  }
'''
if marker not in s: raise SystemExit('publish problems marker not found')
s = s.replace(marker, insert, 1)
p.write_text(s)

# Workforce review + claims/swaps: approval reports existing conflicts and assignment paths honor approved time off.
p = Path('src/lib/workforce.ts')
s = p.read_text()
s = s.replace('import { sendStaffNotification } from "@/lib/staff-notifications";\n', 'import { sendStaffNotification } from "@/lib/staff-notifications";\nimport { enforceScheduleTimeOff } from "@/lib/schedule-time-off";\n')
old = r'''export async function reviewTimeOff(input: { id: string; business: Business; approve: boolean; managerNote?: string; actor: string }) {
  await ensureWorkforceSchema();
  const rows = await getSql()`
    UPDATE time_off_requests SET
      status = ${input.approve ? "Approved" : "Rejected"},
      manager_note = ${clean(input.managerNote, 1000)},
      reviewed_by = ${input.actor}, reviewed_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business} AND status = 'Pending'
    RETURNING id
  ` as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new Error("Pending time-off request not found.");
  return { id: rows[0].id };
}'''
new = r'''export async function reviewTimeOff(input: { id: string; business: Business; approve: boolean; managerNote?: string; actor: string }) {
  await ensureWorkforceSchema();
  const sql = getSql();
  const requests = await sql`
    SELECT t.id, t.employee_id, t.starts_on::text AS starts_on, t.ends_on::text AS ends_on, e.name AS employee_name
    FROM time_off_requests t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.id = ${input.id} AND t.business = ${input.business} AND t.status = 'Pending'
    LIMIT 1
  ` as unknown as Array<{ id: string; employee_id: string; starts_on: string; ends_on: string; employee_name: string }>;
  const request = requests[0];
  if (!request) throw new Error("Pending time-off request not found.");

  await sql`
    UPDATE time_off_requests SET
      status = ${input.approve ? "Approved" : "Rejected"},
      manager_note = ${clean(input.managerNote, 1000)},
      reviewed_by = ${input.actor}, reviewed_at = NOW()
    WHERE id = ${input.id}
  `;

  const conflicts = input.approve ? await sql`
    SELECT id, starts_at, ends_at, position, status
    FROM schedule_shifts
    WHERE business = ${input.business}
      AND employee_id = ${request.employee_id}
      AND status <> 'Cancelled'
      AND starts_at < ((${request.ends_on}::date + 1) AT TIME ZONE ${TIME_ZONE})
      AND ends_at > (${request.starts_on}::date AT TIME ZONE ${TIME_ZONE})
    ORDER BY starts_at
  ` as unknown as Array<{ id: string; starts_at: string; ends_at: string; position: string; status: string }> : [];

  return {
    id: request.id,
    employeeName: request.employee_name,
    requiresReassignment: conflicts.length > 0,
    conflictingShifts: conflicts.map((shift) => ({
      id: String(shift.id),
      startsAt: String(shift.starts_at),
      endsAt: String(shift.ends_at),
      position: clean(shift.position, 100),
      status: clean(shift.status, 30),
    })),
  };
}'''
if old not in s: raise SystemExit('reviewTimeOff block not found')
s = s.replace(old, new, 1)

# Claim request: approved time off cannot claim the shift.
old = '''  if (input.requestType === "Claim") {\n    if (shift.employee_id || shift.status !== "Open") throw new Error("That shift is no longer open.");\n  } else if'''
new = '''  if (input.requestType === "Claim") {
    if (shift.employee_id || shift.status !== "Open") throw new Error("That shift is no longer open.");
    await enforceScheduleTimeOff({
      business: session.business,
      employeeId: session.employeeId,
      startsAt: String(shift.starts_at),
      endsAt: String(shift.ends_at),
      acknowledgePendingTimeOff: true,
    });
  } else if'''
if old not in s: raise SystemExit('claim enforcement block not found')
s = s.replace(old, new, 1)

# Review Claim and Swap before reassignment.
old = '''    if (request.request_type === "Claim") {\n      await getSql()`\n        UPDATE schedule_shifts SET employee_id = ${String(request.requester_employee_id)}, status = 'Published', updated_at = NOW()\n        WHERE id = ${String(request.shift_id)} AND employee_id IS NULL AND status = 'Open'\n      `;'''
new = '''    if (request.request_type === "Claim") {
      const claimShift = await getSql()`
        SELECT starts_at, ends_at FROM schedule_shifts
        WHERE id = ${String(request.shift_id)} AND employee_id IS NULL AND status = 'Open'
        LIMIT 1
      ` as unknown as Array<{ starts_at: string; ends_at: string }>;
      if (!claimShift[0]) throw new Error("That shift is no longer open.");
      await enforceScheduleTimeOff({
        business: input.business,
        employeeId: String(request.requester_employee_id),
        startsAt: claimShift[0].starts_at,
        endsAt: claimShift[0].ends_at,
        acknowledgePendingTimeOff: true,
      });
      await getSql()`
        UPDATE schedule_shifts SET employee_id = ${String(request.requester_employee_id)}, status = 'Published', updated_at = NOW()
        WHERE id = ${String(request.shift_id)} AND employee_id IS NULL AND status = 'Open'
      `;'''
if old not in s: raise SystemExit('review claim block not found')
s = s.replace(old, new, 1)

old = '''      const shiftRows = await getSql()`\n        SELECT id, employee_id FROM schedule_shifts\n        WHERE id IN (${String(request.shift_id)}, ${offeredShiftId})\n        ORDER BY id\n      ` as unknown as Array<{ id: string; employee_id: string | null }>;\n      const first = shiftRows.find((row) => row.id === String(request.shift_id));\n      const second = shiftRows.find((row) => row.id === offeredShiftId);\n      if (!first?.employee_id || !second?.employee_id) throw new Error("Both swap shifts must still be assigned.");\n      await getSql()`UPDATE schedule_shifts SET employee_id = ${second.employee_id}, updated_at = NOW() WHERE id = ${first.id}`;'''
new = '''      const shiftRows = await getSql()`
        SELECT id, employee_id, starts_at, ends_at FROM schedule_shifts
        WHERE id IN (${String(request.shift_id)}, ${offeredShiftId})
        ORDER BY id
      ` as unknown as Array<{ id: string; employee_id: string | null; starts_at: string; ends_at: string }>;
      const first = shiftRows.find((row) => row.id === String(request.shift_id));
      const second = shiftRows.find((row) => row.id === offeredShiftId);
      if (!first?.employee_id || !second?.employee_id) throw new Error("Both swap shifts must still be assigned.");
      await enforceScheduleTimeOff({
        business: input.business,
        employeeId: second.employee_id,
        startsAt: first.starts_at,
        endsAt: first.ends_at,
        acknowledgePendingTimeOff: true,
      });
      await enforceScheduleTimeOff({
        business: input.business,
        employeeId: first.employee_id,
        startsAt: second.starts_at,
        endsAt: second.ends_at,
        acknowledgePendingTimeOff: true,
      });
      await getSql()`UPDATE schedule_shifts SET employee_id = ${second.employee_id}, updated_at = NOW() WHERE id = ${first.id}`;'''
if old not in s: raise SystemExit('swap enforcement block not found')
s = s.replace(old, new, 1)
p.write_text(s)

# Workforce page passes time off into schedule and warns immediately when approving an existing scheduled conflict.
p = Path('src/app/ops/workforce/page.tsx')
s = p.read_text()
s = s.replace('import ScheduleBoard, { type ScheduleEmployee, type ScheduleShift } from "./schedule-board";', 'import ScheduleBoard, { type ScheduleEmployee, type ScheduleShift, type ScheduleTimeOff } from "./schedule-board";')
s = s.replace('type TimeOff = {\n  id: string;\n  employee_name: string;', 'type TimeOff = ScheduleTimeOff & {\n  reason: string;\n  employee_name: string;')
s = s.replace('  ends_on: string;\n  reason: string;\n  status: string;\n};', '  ends_on: string;\n};', 1)

helper_marker = '''function firstName(value: string | null) {\n'''
helper = r'''function newYorkDateKey(value: string | Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function timeOffShiftConflicts(request: TimeOff, shifts: ScheduleShift[]) {
  return shifts.filter((shift) => {
    if (shift.status === "Cancelled" || shift.employeeId !== request.employee_id) return false;
    const shiftStart = newYorkDateKey(shift.startsAt);
    const endInstant = new Date(Math.max(new Date(shift.startsAt).getTime(), new Date(shift.endsAt).getTime() - 1));
    const shiftEnd = newYorkDateKey(endInstant);
    return request.starts_on <= shiftEnd && request.ends_on >= shiftStart;
  });
}

'''
if helper_marker not in s: raise SystemExit('page helper marker missing')
s = s.replace(helper_marker, helper + helper_marker, 1)

# Add dedicated approve helper after action().
marker = '''  async function sendMessage(event: FormEvent<HTMLFormElement>) {\n'''
approve_func = r'''  async function approveTimeOff(request: TimeOff) {
    const actionBusiness = businessRef.current;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/workforce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "time-off-review", business: actionBusiness, id: request.id, approve: true }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; requiresReassignment?: boolean; conflictingShifts?: unknown[]; employeeName?: string } | null;
      if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
      if (businessRef.current === actionBusiness) {
        await load(actionBusiness);
        if (businessRef.current === actionBusiness) {
          const count = payload?.conflictingShifts?.length || 0;
          setNotice(payload?.requiresReassignment
            ? `Time off approved. ${payload.employeeName || request.employee_name} is already assigned to ${count} conflicting shift${count === 1 ? "" : "s"}. Reassign or open ${count === 1 ? "that shift" : "those shifts"} before publishing/resending.`
            : "Time off approved.");
        }
      }
    } catch (error) {
      if (businessRef.current === actionBusiness) setNotice(error instanceof Error ? error.message : "Time off could not be approved.");
    } finally {
      setBusy(false);
    }
  }

'''
if marker not in s: raise SystemExit('approve helper insertion marker missing')
s = s.replace(marker, approve_func + marker, 1)

s = s.replace('        shifts={currentData?.shifts || []}\n        busy={busy}', '        shifts={currentData?.shifts || []}\n        timeOff={currentData?.timeOff || []}\n        busy={busy}', 1)

old = '''<div className="wfList">{(currentData?.timeOff || []).map((request) => <div className="wfRequest" key={request.id}><div><strong>{request.employee_name}</strong><span>{dateOnly(request.starts_on)} through {dateOnly(request.ends_on)}</span>{request.reason && <p>{request.reason}</p>}</div><div className="wfActions"><span className={`wfBadge ${request.status.toLowerCase()}`}>{request.status}</span>{request.status === "Pending" && <><button disabled={busy} onClick={() => void action({ action: "time-off-review", id: request.id, approve: true }, "Time off approved.").catch(() => undefined)}>Approve</button><button disabled={busy} onClick={() => void action({ action: "time-off-review", id: request.id, approve: false }, "Time off rejected.").catch(() => undefined)}>Reject</button></>}</div></div>)}{!currentData?.timeOff.length && <p className="wfEmpty">No time-off requests.</p>}</div>'''
new = '''<div className="wfList">{(currentData?.timeOff || []).map((request) => {
          const conflicts = timeOffShiftConflicts(request, currentData?.shifts || []);
          return <div className="wfRequest" key={request.id}><div><strong>{request.employee_name}</strong><span>{dateOnly(request.starts_on)} through {dateOnly(request.ends_on)}</span>{request.reason && <p>{request.reason}</p>}{conflicts.length > 0 && <p className="wfTimeOffConflict"><strong>Schedule conflict:</strong> already assigned to {conflicts.map((shift) => `${local(shift.startsAt)}–${new Date(shift.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`).join("; ")}. {request.status === "Pending" ? "Approving this request will require reassignment." : request.status === "Approved" ? "Reassign or open the conflicting shift." : ""}</p>}</div><div className="wfActions"><span className={`wfBadge ${request.status.toLowerCase()}`}>{request.status}</span>{request.status === "Pending" && <><button disabled={busy} onClick={() => void approveTimeOff(request)}>Approve</button><button disabled={busy} onClick={() => void action({ action: "time-off-review", id: request.id, approve: false }, "Time off rejected.").catch(() => undefined)}>Reject</button></>}</div></div>;
        })}{!currentData?.timeOff.length && <p className="wfEmpty">No time-off requests.</p>}</div>'''
if old not in s: raise SystemExit('time off list block not found')
s = s.replace(old, new, 1)
p.write_text(s)

# Schedule board UI: approved block, pending confirmation, cell/shift warnings, publish block.
p = Path('src/app/ops/workforce/schedule-board.tsx')
s = p.read_text()
s = s.replace('  newYorkTimeValue,\n', '  newYorkDateKey,\n  newYorkTimeValue,\n')
insert_type = r'''
export type ScheduleTimeOff = {
  id: string;
  employee_id: string;
  employee_name: string;
  starts_on: string;
  ends_on: string;
  status: string;
};
'''
s = s.replace('export type ScheduleShift = {', insert_type + '\nexport type ScheduleShift = {', 1)
s = s.replace('  shifts: ScheduleShift[];\n  busy: boolean;', '  shifts: ScheduleShift[];\n  timeOff: ScheduleTimeOff[];\n  busy: boolean;', 1)

helper_marker = '''function cellKey(employeeId: string | null, dayKeyValue: string): string {\n'''
helpers = r'''function timeOffKey(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match?.[1] || "";
}

function timeOffOverlapsShift(request: ScheduleTimeOff, employeeId: string | null, startsAt: string | Date, endsAt: string | Date): boolean {
  if (!employeeId || request.employee_id !== employeeId || !["Pending", "Approved"].includes(request.status)) return false;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  const lastInstant = new Date(Math.max(start.getTime(), end.getTime() - 1));
  const shiftStart = newYorkDateKey(start);
  const shiftEnd = newYorkDateKey(lastInstant);
  return timeOffKey(request.starts_on) <= shiftEnd && timeOffKey(request.ends_on) >= shiftStart;
}

function timeOffLabel(request: ScheduleTimeOff): string {
  const start = dateFromKey(timeOffKey(request.starts_on));
  const end = dateFromKey(timeOffKey(request.ends_on));
  if (timeOffKey(request.starts_on) === timeOffKey(request.ends_on)) {
    return start.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return `${start.toLocaleDateString([], { month: "short", day: "numeric" })}–${end.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}

'''
if helper_marker not in s: raise SystemExit('schedule helper marker missing')
s = s.replace(helper_marker, helpers + helper_marker, 1)
s = s.replace('export default function ScheduleBoard({ business, employees, shifts, busy, runAction }: Props) {', 'export default function ScheduleBoard({ business, employees, shifts, timeOff, busy, runAction }: Props) {')

# Insert conflict calculations after missing email count.
marker = '''  const missingEmailCount = activeEmployees.filter((employee) => !employee.email.trim()).length;\n'''
calc = r'''  const missingEmailCount = activeEmployees.filter((employee) => !employee.email.trim()).length;

  const assignmentTimeOff = (employeeId: string | null, startsAt: string | Date, endsAt: string | Date) =>
    timeOff.filter((request) => timeOffOverlapsShift(request, employeeId, startsAt, endsAt));

  const approvedTimeOffShiftConflicts = weekShifts.flatMap((shift) =>
    assignmentTimeOff(shift.employeeId, shift.startsAt, shift.endsAt)
      .filter((request) => request.status === "Approved")
      .map((request) => ({ shift, request })),
  );
  const pendingTimeOffShiftConflicts = weekShifts.flatMap((shift) =>
    assignmentTimeOff(shift.employeeId, shift.startsAt, shift.endsAt)
      .filter((request) => request.status === "Pending")
      .map((request) => ({ shift, request })),
  );

  function confirmTimeOffAssignment(employeeId: string | null, startsAt: string | Date, endsAt: string | Date) {
    const conflicts = assignmentTimeOff(employeeId, startsAt, endsAt);
    const approved = conflicts.find((request) => request.status === "Approved");
    if (approved) {
      window.alert(`${approved.employee_name} has APPROVED time off ${timeOffLabel(approved)}. Reassign the shift or leave it open.`);
      return { allowed: false, acknowledgePendingTimeOff: false };
    }
    const pending = conflicts.find((request) => request.status === "Pending");
    if (pending) {
      const allowed = window.confirm(`${pending.employee_name} has a PENDING time-off request ${timeOffLabel(pending)}.\n\nAssign this shift anyway while the request is still pending?`);
      return { allowed, acknowledgePendingTimeOff: allowed };
    }
    return { allowed: true, acknowledgePendingTimeOff: false };
  }
'''
if marker not in s: raise SystemExit('schedule conflict calc marker missing')
s = s.replace(marker, calc, 1)

# Editor time-off status after editorPreview.
marker = '''  const primaryMealTimeOptions = useMemo(\n'''
editor_conf = r'''  const editorTimeOff = useMemo(() => {
    if (!editor?.employeeId) return { approved: [] as ScheduleTimeOff[], pending: [] as ScheduleTimeOff[] };
    try {
      const { start, end } = editorDates(editor);
      const conflicts = timeOff.filter((request) => timeOffOverlapsShift(request, editor.employeeId, start, end));
      return {
        approved: conflicts.filter((request) => request.status === "Approved"),
        pending: conflicts.filter((request) => request.status === "Pending"),
      };
    } catch {
      return { approved: [] as ScheduleTimeOff[], pending: [] as ScheduleTimeOff[] };
    }
  }, [editor, timeOff]);

'''
if marker not in s: raise SystemExit('editor conflict marker missing')
s = s.replace(marker, editor_conf + marker, 1)

# save shift confirm and acknowledgement.
old = '''    const { start, end, mealBreakStart, extraMealBreakStart } = editorDates(editor);\n    await runAction({'''
new = '''    const { start, end, mealBreakStart, extraMealBreakStart } = editorDates(editor);
    const timeOffCheck = confirmTimeOffAssignment(editor.employeeId, start, end);
    if (!timeOffCheck.allowed) return;
    await runAction({'''
if old not in s: raise SystemExit('save shift start not found')
s = s.replace(old, new, 1)
s = s.replace('      notes: editor.notes,\n    }, editor.shift ?', '      notes: editor.notes,\n      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n    }, editor.shift ?', 1)

# move/paste confirms.
old = '''    const moved = moveShiftToCell(shift, targetDay, employeeId);\n    await runAction({'''
new = '''    const moved = moveShiftToCell(shift, targetDay, employeeId);
    const timeOffCheck = confirmTimeOffAssignment(employeeId, moved.startsAt, moved.endsAt);
    if (!timeOffCheck.allowed) return;
    await runAction({'''
if old not in s: raise SystemExit('move shift block not found')
s = s.replace(old, new, 1)
s = s.replace('      status: "Draft",\n    }, "Shift moved', '      status: "Draft",\n      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n    }, "Shift moved', 1)

old = '''    const copied = moveShiftToCell(copiedShift, targetDay, employeeId);\n    await runAction({'''
new = '''    const copied = moveShiftToCell(copiedShift, targetDay, employeeId);
    const timeOffCheck = confirmTimeOffAssignment(employeeId, copied.startsAt, copied.endsAt);
    if (!timeOffCheck.allowed) return;
    await runAction({'''
if old not in s: raise SystemExit('paste block not found')
s = s.replace(old, new, 1)
s = s.replace('      notes: copied.notes,\n    }, "Copied shift', '      notes: copied.notes,\n      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n    }, "Copied shift', 1)

# Publish checks time off before standard validation.
marker = '''  async function publishWeek() {\n    if (!publishAnalysis.canPublish) {'''
new = r'''  async function publishWeek() {
    if (approvedTimeOffShiftConflicts.length) {
      const details = approvedTimeOffShiftConflicts.slice(0, 10).map(({ shift, request }) =>
        `${request.employee_name}: ${localDateTime(shift.startsAt)}–${localTime(shift.endsAt)} (${timeOffLabel(request)} approved off)`,
      );
      window.alert(`The schedule cannot be published/resend yet. Approved time off conflicts with assigned shifts:\n\n${details.join("\n")}\n\nReassign those shifts or make them open.`);
      return;
    }
    if (pendingTimeOffShiftConflicts.length) {
      const names = Array.from(new Set(pendingTimeOffShiftConflicts.map(({ request }) => `${request.employee_name} (${timeOffLabel(request)})`)));
      if (!window.confirm(`There are pending time-off requests that overlap assigned shifts:\n\n${names.join("\n")}\n\nPublish anyway while those requests are pending?`)) return;
    }
    if (!publishAnalysis.canPublish) {'''
if marker not in s: raise SystemExit('publish function marker not found')
s = s.replace(marker, new, 1)

# counts/button/validation badges and details.
s = s.replace('  const issueCount = publishAnalysis.blockingIssueCount + publishAnalysis.overThirtyEight.length;', '  const issueCount = publishAnalysis.blockingIssueCount + publishAnalysis.overThirtyEight.length + approvedTimeOffShiftConflicts.length + pendingTimeOffShiftConflicts.length;')
s = s.replace('disabled={busy || !weekShifts.length || !publishAnalysis.canPublish}', 'disabled={busy || !weekShifts.length || !publishAnalysis.canPublish || approvedTimeOffShiftConflicts.length > 0}', 1)
s = s.replace('{publishAnalysis.mealPeriodViolations.length ? "warning" : "clear"}>{publishAnalysis.mealPeriodViolations.length} meal</span>', '{publishAnalysis.mealPeriodViolations.length ? "warning" : "clear"}>{publishAnalysis.mealPeriodViolations.length} meal</span>\n          <span className={approvedTimeOffShiftConflicts.length ? "danger" : pendingTimeOffShiftConflicts.length ? "warning" : "clear"}>{approvedTimeOffShiftConflicts.length ? `${approvedTimeOffShiftConflicts.length} time-off conflict` : pendingTimeOffShiftConflicts.length ? `${pendingTimeOffShiftConflicts.length} pending off` : "time off clear"}</span>', 1)
needle = '''          {publishAnalysis.loneWorkerViolations.map((item) => <div className="scheduleIssue danger" key={`${item.employeeId}-${item.startsAt}`}><strong>{item.employeeName}</strong><span>Alone {item.minutes} minutes starting {localDateTime(item.startsAt)}.</span></div>)}\n'''
insert = needle + '''          {approvedTimeOffShiftConflicts.map(({ shift, request }) => <div className="scheduleIssue danger" key={`off-approved-${shift.id}-${request.id}`}><strong>{request.employee_name}</strong><span>Approved off {timeOffLabel(request)} but assigned {localDateTime(shift.startsAt)}–{localTime(shift.endsAt)}. Reassign or open this shift.</span></div>)}
          {pendingTimeOffShiftConflicts.map(({ shift, request }) => <div className="scheduleIssue warning" key={`off-pending-${shift.id}-${request.id}`}><strong>{request.employee_name}</strong><span>Pending time-off request {timeOffLabel(request)} overlaps {localDateTime(shift.startsAt)}–{localTime(shift.endsAt)}.</span></div>)}
'''
if needle not in s: raise SystemExit('issue list insertion point missing')
s = s.replace(needle, insert, 1)

# Cell status and controls.
old = '''              const shiftsInCell = shiftsByCell.get(cellKey(row.employeeId, dayKeyValue)) || [];\n              const isTarget = dragTarget?.dayKey === dayKeyValue && dragTarget.employeeId === row.employeeId;\n              return <div\n                className={`scheduleGridCell ${isTarget ? "dragTarget" : ""} ${draggingId ? "dragReady" : ""}`}'''
new = '''              const shiftsInCell = shiftsByCell.get(cellKey(row.employeeId, dayKeyValue)) || [];
              const dayTimeOff = row.employeeId ? timeOff.filter((request) => request.employee_id === row.employeeId && ["Pending", "Approved"].includes(request.status) && timeOffKey(request.starts_on) <= dayKeyValue && timeOffKey(request.ends_on) >= dayKeyValue) : [];
              const approvedDayOff = dayTimeOff.find((request) => request.status === "Approved");
              const pendingDayOff = dayTimeOff.find((request) => request.status === "Pending");
              const isTarget = dragTarget?.dayKey === dayKeyValue && dragTarget.employeeId === row.employeeId;
              return <div
                className={`scheduleGridCell ${isTarget ? "dragTarget" : ""} ${draggingId ? "dragReady" : ""} ${approvedDayOff ? "timeOffApproved" : pendingDayOff ? "timeOffPending" : ""}`}'''
if old not in s: raise SystemExit('cell status block not found')
s = s.replace(old, new, 1)

s = s.replace('''              >\n                <div className="scheduleCellActions">\n                  <button type="button" title={`Add ${row.name} shift`} onClick={() => setEditor(defaultEditor(row.employeeId, day, row.employee || undefined))}>+</button>\n                  {copiedShift && <button type="button" onClick={() => void pasteShift(day, row.employeeId)}>Paste</button>}''', '''              >
                {approvedDayOff && <div className="scheduleTimeOffCellBadge approved">Approved off</div>}
                {!approvedDayOff && pendingDayOff && <div className="scheduleTimeOffCellBadge pending">Time off pending</div>}
                <div className="scheduleCellActions">
                  <button type="button" disabled={Boolean(approvedDayOff)} title={approvedDayOff ? `${row.name} has approved time off` : `Add ${row.name} shift`} onClick={() => setEditor(defaultEditor(row.employeeId, day, row.employee || undefined))}>+</button>
                  {copiedShift && <button type="button" disabled={Boolean(approvedDayOff)} onClick={() => void pasteShift(day, row.employeeId)}>Paste</button>}''', 1)

# Shift card badges.
needle = '''                    const hasMealIssue = mealViolationShiftIds.has(shift.id);\n                    const meal = analyzeShiftMealCompliance(shift);'''
replacement = '''                    const hasMealIssue = mealViolationShiftIds.has(shift.id);
                    const shiftTimeOff = assignmentTimeOff(shift.employeeId, shift.startsAt, shift.endsAt);
                    const approvedShiftOff = shiftTimeOff.find((request) => request.status === "Approved");
                    const pendingShiftOff = shiftTimeOff.find((request) => request.status === "Pending");
                    const meal = analyzeShiftMealCompliance(shift);'''
if needle not in s: raise SystemExit('shift badge vars marker missing')
s = s.replace(needle, replacement, 1)
s = s.replace('{shift.notes && <b className="noteBadge">Notes</b>}', '{approvedShiftOff && <b className="safetyDanger">TIME OFF</b>}\n                            {!approvedShiftOff && pendingShiftOff && <b className="hoursWarning">Off?</b>}\n                            {shift.notes && <b className="noteBadge">Notes</b>}', 1)

# Editor warning UI before meal planner.
marker = '''          {editorPreview && <section className="scheduleMealPlanner">'''
warn = '''          {editorTimeOff.approved.length > 0 && <div className="scheduleTimeOffEditorWarning approved"><strong>Cannot assign this shift</strong><span>{editorTimeOff.approved[0].employee_name} has approved time off {timeOffLabel(editorTimeOff.approved[0])}. Choose another employee, date, or leave the shift open.</span></div>}
          {editorTimeOff.approved.length === 0 && editorTimeOff.pending.length > 0 && <div className="scheduleTimeOffEditorWarning pending"><strong>Pending time-off request</strong><span>{editorTimeOff.pending[0].employee_name} requested {timeOffLabel(editorTimeOff.pending[0])} off. You can still assign the shift, but you will be asked to confirm.</span></div>}

'''
if marker not in s: raise SystemExit('editor warning marker missing')
s = s.replace(marker, warn + marker, 1)
p.write_text(s)

# CSS additions.
p = Path('src/app/ops/workforce/schedule-board.css')
s = p.read_text()
s += r'''

/* Time-off scheduling safeguards */
.scheduleGridCell.timeOffApproved{background:linear-gradient(135deg,rgba(220,38,38,.14),rgba(127,29,29,.07));box-shadow:inset 0 0 0 2px rgba(220,38,38,.32)}
.scheduleGridCell.timeOffPending{background:linear-gradient(135deg,rgba(245,158,11,.12),rgba(120,53,15,.05));box-shadow:inset 0 0 0 1px rgba(245,158,11,.28)}
.scheduleTimeOffCellBadge{margin:3px 4px 1px;border-radius:999px;padding:3px 6px;font-size:.62rem;font-weight:900;text-align:center;text-transform:uppercase;letter-spacing:.03em}
.scheduleTimeOffCellBadge.approved{background:#7f1d1d;color:#fee2e2;border:1px solid #ef4444}
.scheduleTimeOffCellBadge.pending{background:#78350f;color:#fef3c7;border:1px solid #f59e0b}
.scheduleGridCell.timeOffApproved .scheduleCellActions button:disabled{cursor:not-allowed;opacity:.35}
.scheduleTimeOffEditorWarning{display:grid;gap:3px;grid-column:1/-1;border-radius:10px;padding:10px 11px}
.scheduleTimeOffEditorWarning strong{font-size:.82rem}
.scheduleTimeOffEditorWarning span{font-size:.76rem;line-height:1.35}
.scheduleTimeOffEditorWarning.approved{border:1px solid #ef4444;background:#450a0a;color:#fee2e2}
.scheduleTimeOffEditorWarning.pending{border:1px solid #f59e0b;background:#451a03;color:#fef3c7}
.wfTimeOffConflict{margin-top:7px!important;border:1px solid #ef4444;border-radius:8px;background:rgba(127,29,29,.18);padding:7px 8px;color:#fecaca!important}
'''
p.write_text(s)
