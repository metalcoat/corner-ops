import { safePayrollControlDashboard } from "@/lib/payroll-control-dashboard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN = "q7Jm2Vx9Kp4Dn8Rw5Lc1Hs6Tb3Ye0UaF";

export async function GET(request: Request) {
  if (new URL(request.url).searchParams.get("token") !== TOKEN) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const dashboard = await safePayrollControlDashboard("Corner Deli", "2026-08-03");
  return Response.json({
    punches: dashboard.punches,
    types: dashboard.punches.map((punch) => ({
      employeeName: punch.employeeName,
      clockInType: typeof punch.clockIn,
      clockOutType: typeof punch.clockOut,
      clockInString: String(punch.clockIn),
      clockOutString: String(punch.clockOut),
    })),
  });
}
