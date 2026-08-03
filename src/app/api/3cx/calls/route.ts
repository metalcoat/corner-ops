import { getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { threeCxDeliCallReport } from "@/lib/three-cx-cdr";

export const runtime = "nodejs";

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "reports.read");
    const url = new URL(request.url);
    const endDefault = new Date();
    endDefault.setUTCDate(endDefault.getUTCDate() + 1);
    const startDefault = new Date(endDefault);
    startDefault.setUTCDate(startDefault.getUTCDate() - 7);
    const start = url.searchParams.get("start") || dateKey(startDefault);
    const end = url.searchParams.get("end") || dateKey(endDefault);
    return Response.json(await threeCxDeliCallReport(start, end));
  } catch (error) {
    return apiError(error);
  }
}
