import { getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { rezkuImportDashboard } from "@/lib/rezku-monitor";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "payroll.read");
    return Response.json(await rezkuImportDashboard());
  } catch (error) {
    return apiError(error);
  }
}
