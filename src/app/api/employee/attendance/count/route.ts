import { ensureAttendanceSchema } from "@/lib/attendance";
import { getEmployeeSession } from "@/lib/employee-auth";
import { ensureMissedClockOutSchema } from "@/lib/missed-clock-outs";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();

    await ensureAttendanceSchema();
    const rows = await getSql()`
      SELECT COUNT(*)::INTEGER AS count
      FROM missed_shift_cases
      WHERE employee_id = ${session.employeeId}
        AND business = ${session.business}
        AND status IN ('Awaiting Correction', 'Rejected')
    ` as unknown as Array<{ count: number | string }>;

    await ensureMissedClockOutSchema();
    const clockOuts = await getSql()`
      SELECT COUNT(*)::INTEGER AS count
      FROM missed_clock_out_cases c
      JOIN time_entries t ON t.id = c.time_entry_id AND t.clock_out IS NULL
      WHERE c.employee_id = ${session.employeeId}
        AND c.business = ${session.business}
        AND c.status = 'Open'
    ` as unknown as Array<{ count: number | string }>;

    return Response.json({ count: Number(rows[0]?.count || 0) + Number(clockOuts[0]?.count || 0) }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
