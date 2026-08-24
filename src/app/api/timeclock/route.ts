import { getEmployeeSession } from "@/lib/employee-auth";
import { ensureWorkforceSchema } from "@/lib/workforce";
import { getSql } from "@/lib/db";
import { apiError, AuthenticationError } from "@/lib/http";
import { evaluateAndNotifyOvertimeRisk } from "@/lib/overtime-risk";
import { punchAuthenticatedTikiEmployee } from "@/lib/tiki-timeclock";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session || session.business !== "Tiki") throw new AuthenticationError("Tiki employee sign-in required before punching the time clock.");
    const body = await request.json() as {
      latitude?: number | null;
      longitude?: number | null;
      accuracy?: number | null;
    };

    const result = await punchAuthenticatedTikiEmployee(session.employeeId, {
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy,
    });

    if (result.action === "clocked-out") {
      const overtimeRisk = await evaluateAndNotifyOvertimeRisk({
        business: "Tiki",
        source: `Tiki clock-out by ${result.employee}`,
        notify: true,
      }).then((dashboard) => ({
        warning: dashboard.summary.warning,
        overtime: dashboard.summary.overtime,
      })).catch((error) => {
        console.error("[timeclock] punch saved but overtime check failed", error);
        return null;
      });
      return Response.json({ ...result, overtimeRisk });
    }

    await ensureWorkforceSchema();
    const instructions = await getSql()`
      SELECT s.id, s.position, s.starts_at, s.ends_at, s.notes
      FROM time_entries t
      JOIN schedule_shifts s
        ON s.employee_id = t.employee_id
       AND s.business = 'Tiki'
       AND s.status = 'Published'
      WHERE t.id = ${result.entry.id}
        AND NOW() >= s.starts_at - INTERVAL '4 hours'
        AND NOW() <= s.ends_at + INTERVAL '4 hours'
      ORDER BY ABS(EXTRACT(EPOCH FROM (s.starts_at - NOW())))
      LIMIT 1
    ` as unknown as Array<{
      id: string;
      position: string;
      starts_at: string;
      ends_at: string;
      notes: string;
    }>;

    const shift = instructions[0];
    return Response.json({
      ...result,
      scheduledShift: shift ? {
        id: shift.id,
        position: shift.position,
        startsAt: shift.starts_at,
        endsAt: shift.ends_at,
        instructions: shift.notes,
      } : null,
    });
  } catch (error) {
    return apiError(error);
  }
}
