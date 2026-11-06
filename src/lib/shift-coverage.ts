import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import { assertOnboardingAllowsScheduling } from "@/lib/employee-onboarding";
import { sendConversationMessage, TEAM_CONVERSATION_KEY } from "@/lib/message-conversations";
import { notifyRecipientsOfEmployeeMessage } from "@/lib/push-notifications";
import { enforceScheduleTimeOff } from "@/lib/schedule-time-off";
import { coverageGroupMessage, coverageShiftLabel, isLateCallOut } from "@/lib/shift-coverage-rules";
import { ensureWorkforceSchema } from "@/lib/workforce";

/** Posts to the team group chat as the employee, with the same app notification a normal team message gets. */
async function postToTeam(session: EmployeeSession, body: string) {
  await sendConversationMessage({ business: session.business, conversationKey: TEAM_CONVERSATION_KEY, senderEmployeeId: session.employeeId, senderName: session.name, body });
  await notifyRecipientsOfEmployeeMessage({ business: session.business, senderEmployeeId: session.employeeId, recipientEmployeeId: null, body, hasPhoto: false })
    .catch((error) => console.error("[shift-coverage] push failed", error));
}

type ShiftRow = { id: string; employee_id: string | null; starts_at: string | Date; ends_at: string | Date; position: string; status: string };

async function ownFutureShift(session: EmployeeSession, shiftId: string): Promise<ShiftRow> {
  const rows = await getSql()`SELECT id, employee_id, starts_at, ends_at, position, status FROM schedule_shifts WHERE id = ${shiftId} AND business = ${session.business} LIMIT 1` as unknown as ShiftRow[];
  const shift = rows[0];
  if (!shift) throw new Error("Shift not found.");
  if (String(shift.employee_id || "") !== session.employeeId) throw new Error("You can only ask for coverage on your own shift.");
  if (new Date(shift.ends_at).getTime() <= Date.now()) throw new Error("That shift is already over.");
  return shift;
}

/**
 * "I need coverage": records the call-out, then posts in the team group chat (with the app
 * notification) so anyone can pick the shift up. The employee keeps the shift until a
 * manager approves a coworker taking it.
 */
export async function requestShiftCoverage(session: EmployeeSession, input: { shiftId: string; note?: string; sickLeave?: boolean }) {
  await ensureWorkforceSchema();
  const shift = await ownFutureShift(session, input.shiftId);
  const existing = await getSql()`SELECT id FROM shift_requests WHERE shift_id = ${shift.id} AND status = 'Pending' AND coverage_requested_at IS NOT NULL LIMIT 1` as unknown as Array<{ id: string }>;
  if (existing[0]) throw new Error("You already asked for coverage on this shift.");
  const late = isLateCallOut(new Date(shift.starts_at));
  const id = crypto.randomUUID();
  await getSql()`
    INSERT INTO shift_requests (id, business, request_type, shift_id, requester_employee_id, employee_response, note, coverage_requested_at, late_call_out, sick_leave)
    VALUES (${id}, ${session.business}, 'Offer', ${shift.id}, ${session.employeeId}, 'Pending', ${String(input.note || "").trim().slice(0, 500)}, NOW(), ${late}, ${input.sickLeave === true})
  `;
  const body = coverageGroupMessage({ shift: coverageShiftLabel(new Date(shift.starts_at), new Date(shift.ends_at), shift.position) });
  await postToTeam(session, body);
  return { id, late };
}

/** Shifts teammates asked to have covered (not the signed-in employee's own). */
export async function listCoverageNeeded(session: EmployeeSession) {
  await ensureWorkforceSchema();
  const rows = await getSql()`
    SELECT r.id, r.target_employee_id, r.employee_response, s.starts_at, s.ends_at, s.position, e.name requester, t.name taker
    FROM shift_requests r JOIN schedule_shifts s ON s.id = r.shift_id
    JOIN employees e ON e.id = r.requester_employee_id LEFT JOIN employees t ON t.id = r.target_employee_id
    WHERE r.business = ${session.business} AND r.status = 'Pending' AND r.coverage_requested_at IS NOT NULL
      AND s.ends_at > NOW() AND r.requester_employee_id <> ${session.employeeId}
    ORDER BY s.starts_at
  ` as unknown as Array<{ id: string; target_employee_id: string | null; employee_response: string; starts_at: string; ends_at: string; position: string; requester: string; taker: string | null }>;
  return rows.map((row) => ({
    id: row.id,
    requester: row.requester,
    shift: coverageShiftLabel(new Date(row.starts_at), new Date(row.ends_at), row.position),
    takenBy: row.target_employee_id ? (row.target_employee_id === session.employeeId ? "you" : row.taker || "a coworker") : null,
  }));
}

/** "I'll take it": first coworker wins; a manager still approves the hand-over. */
export async function volunteerForCoverage(session: EmployeeSession, requestId: string) {
  await ensureWorkforceSchema();
  const sql = getSql();
  const rows = await sql`
    SELECT r.id, r.requester_employee_id, s.starts_at, s.ends_at, s.position, s.id shift_id
    FROM shift_requests r JOIN schedule_shifts s ON s.id = r.shift_id
    WHERE r.id = ${requestId} AND r.business = ${session.business} AND r.status = 'Pending' AND r.coverage_requested_at IS NOT NULL LIMIT 1
  ` as unknown as Array<{ id: string; requester_employee_id: string; starts_at: string; ends_at: string; position: string; shift_id: string }>;
  const request = rows[0];
  if (!request) throw new Error("That coverage request is no longer open.");
  if (request.requester_employee_id === session.employeeId) throw new Error("That's your own shift.");
  const overlap = await sql`SELECT 1 FROM schedule_shifts WHERE employee_id = ${session.employeeId} AND status <> 'Cancelled' AND starts_at < ${request.ends_at} AND ends_at > ${request.starts_at} LIMIT 1` as unknown as unknown[];
  if (overlap.length) throw new Error("You already work during that time.");
  await assertOnboardingAllowsScheduling(session.business, session.employeeId);
  await enforceScheduleTimeOff({ business: session.business, employeeId: session.employeeId, startsAt: request.starts_at, endsAt: request.ends_at, acknowledgePendingTimeOff: true });
  const taken = await sql`
    UPDATE shift_requests SET target_employee_id = ${session.employeeId}, employee_response = 'Accepted'
    WHERE id = ${requestId} AND status = 'Pending' AND target_employee_id IS NULL RETURNING id
  ` as unknown as unknown[];
  if (!taken.length) throw new Error("Someone else already offered to take it.");
  const shift = coverageShiftLabel(new Date(request.starts_at), new Date(request.ends_at), request.position);
  await postToTeam(session, `I'll cover ${shift}. Waiting for a manager to approve; until then the shift stays with the original person.`);
  return { taken: true };
}
