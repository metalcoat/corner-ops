import { getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import { retryRezkuInboundEmail } from "@/lib/rezku-inbound-handler";
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

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "payroll.write");
    const body = await request.json() as Record<string, unknown>;
    if (String(body.action || "") !== "retry-email") {
      return Response.json({ error: "Unknown Rezku monitor action." }, { status: 400 });
    }
    const result = await retryRezkuInboundEmail(String(body.emailId || ""), session.email);
    return Response.json(result.payload, { status: 200 });
  } catch (error) {
    return apiError(error);
  }
}
