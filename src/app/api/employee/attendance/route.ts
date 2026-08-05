import {
  employeeAttendanceCases,
  ensureAttendanceSchema,
  submitEmployeeAttendanceCase,
} from "@/lib/attendance";
import { getEmployeeSession } from "@/lib/employee-auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    return Response.json(await employeeAttendanceCases(session));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "submit") {
      return Response.json(await submitEmployeeAttendanceCase(session, {
        id: String(body.id || ""),
        correctionStart: String(body.correctionStart || ""),
        correctionEnd: String(body.correctionEnd || ""),
        reason: String(body.reason || ""),
      }));
    }

    if (action === "did-not-work") {
      await ensureAttendanceSchema();
      const note = String(body.reason || "Employee reported they did not work this scheduled shift.")
        .trim()
        .slice(0, 3000) || "Employee reported they did not work this scheduled shift.";
      const rows = await getSql()`
        UPDATE missed_shift_cases SET
          correction_start = NULL,
          correction_end = NULL,
          employee_note = ${note},
          submission_channel = 'Employee Hub - Did Not Work',
          status = 'Resolved',
          reviewed_by = ${session.name},
          reviewed_at = NOW(),
          manager_note = 'Employee reported they did not work this scheduled shift.'
        WHERE id = ${String(body.id || "")}
          AND employee_id = ${session.employeeId}
          AND business = ${session.business}
          AND status IN ('Awaiting Correction', 'Submitted', 'Rejected')
        RETURNING id, status
      ` as unknown as Array<{ id: string; status: string }>;
      if (!rows[0]) throw new Error("That attendance item is no longer available to dismiss.");
      return Response.json(rows[0]);
    }

    return Response.json({ error: "Unknown attendance action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
