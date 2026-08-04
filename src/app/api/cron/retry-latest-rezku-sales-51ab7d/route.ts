import { payrollSummary } from "@/lib/payroll-summary-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const summary = await payrollSummary("Corner Deli", "2026-08-03") as {
    rows?: unknown[];
    dailyTipReconciliation?: unknown[];
    tipJoinIssues?: unknown[];
  };
  return Response.json({
    rows: summary.rows || [],
    dailyTipReconciliation: summary.dailyTipReconciliation || [],
    tipJoinIssues: summary.tipJoinIssues || [],
  });
}
