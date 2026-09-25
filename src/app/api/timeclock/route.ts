import { after } from "next/server";
import { parsePunchCommand } from "@/lib/timeclock-contract";
import { getEmployeeSession } from "@/lib/employee-auth";
import { ensureWorkforceSchema } from "@/lib/workforce";
import { getSql } from "@/lib/db";
import { apiError, AuthenticationError } from "@/lib/http";
import { evaluateAndNotifyOvertimeRisk } from "@/lib/overtime-risk";
import { punchAuthenticatedTikiEmployee, getTikiClockState, TikiPunchStateError, TikiPunchUnconfirmedError } from "@/lib/tiki-timeclock";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getEmployeeSession();
    if (!session || session.business !== "Tiki") throw new AuthenticationError("Tiki employee sign-in required.");
    return Response.json({ employeeId: session.employeeId, employee: session.name,
      ...await getTikiClockState(session.employeeId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session || session.business !== "Tiki") throw new AuthenticationError("Tiki employee sign-in required before punching the time clock.");
    const body = await request.json() as {
      latitude?: number | null;
      longitude?: number | null;
      accuracy?: number | null;
    };

    const command = parsePunchCommand(body);
    if (!command) return Response.json({ code: "PUNCH_CLIENT_OUTDATED",
      error: "Refresh the time clock. An explicit action and request ID are required." }, { status: 409 });
    const result = await punchAuthenticatedTikiEmployee(session.employeeId, {
      latitude: body.latitude,
      longitude: body.longitude,
      accuracy: body.accuracy,
    }, command);

    if (result.action === "clocked-out") {
      if (!result.replayed) after(async () => {
        try {
          await evaluateAndNotifyOvertimeRisk({ business: "Tiki", source: `Tiki clock-out by ${result.employee}`, notify: true });
        } catch { console.error("[timeclock] punch saved but overtime check failed"); }
      });
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    }

    let scheduledShift: {
      id: string;
      position: string;
      startsAt: string;
      endsAt: string;
      instructions: string;
    } | null = null;

    try {
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
      scheduledShift = shift ? {
        id: shift.id,
        position: shift.position,
        startsAt: shift.starts_at,
        endsAt: shift.ends_at,
        instructions: shift.notes,
      } : null;
    } catch (error) {
      // The punch has already been saved. Optional schedule instructions must never
      // make the employee think the clock-in itself failed or encourage a second punch.
      console.error("[timeclock] punch saved but scheduled-shift lookup failed", error);
    }

    return Response.json({ ...result, scheduledShift });
  } catch (error) {
    if (error instanceof TikiPunchStateError) {
      return Response.json({ code: error.code, error: error.message }, { status: error.code === "PUNCH_UNAUTHORIZED" ? 401 : 409 });
    }
    if (error instanceof TikiPunchUnconfirmedError) {
      return Response.json({ code: error.code, error: error.message }, { status: 503 });
    }
    return apiError(error);
  }
}
