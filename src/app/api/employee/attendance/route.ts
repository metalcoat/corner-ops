import { employeeAttendanceCases, submitEmployeeAttendanceCase } from "@/lib/attendance";
import { getEmployeeSession } from "@/lib/employee-auth";
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
    if (String(body.action || "") !== "submit") {
      return Response.json({ error: "Unknown attendance action." }, { status: 400 });
    }
    return Response.json(await submitEmployeeAttendanceCase(session, {
      id: String(body.id || ""),
      correctionStart: String(body.correctionStart || ""),
      correctionEnd: String(body.correctionEnd || ""),
      reason: String(body.reason || ""),
    }));
  } catch (error) {
    return apiError(error);
  }
}
