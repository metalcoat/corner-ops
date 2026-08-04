import { payrollSummary } from "@/lib/payroll-summary-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [previousWeek, currentWeek] = await Promise.all([
    payrollSummary("Corner Deli", "2026-07-27"),
    payrollSummary("Corner Deli", "2026-08-03"),
  ]);
  return Response.json({ previousWeek, currentWeek });
}
