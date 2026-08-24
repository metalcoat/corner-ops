import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError, unauthorized } from "@/lib/http";
import { deleteEmployeeMessage } from "@/lib/message-deletion";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const session = await getEmployeeSession();
    if (!session) return unauthorized();
    const body = await request.json() as { id?: unknown };
    const deleted = await deleteEmployeeMessage(session, String(body.id || ""));
    return Response.json({ deleted: true, id: deleted.id });
  } catch (error) { return apiError(error); }
}
