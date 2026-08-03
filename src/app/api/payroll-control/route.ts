import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  correctPunch,
  createPayrollDraft,
  createTipOverride,
  deleteTipOverride,
  lockPayrollRun,
  payrollControlDashboard,
  payrollCsv,
  reopenPayrollRun,
} from "@/lib/payroll-control";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "payroll.read");
    const url = new URL(request.url);
    const exportId = url.searchParams.get("export");
    if (exportId) {
      const result = await payrollCsv(exportId);
      return new Response(result.csv, {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${result.fileName}"` },
      });
    }
    const business = businessFrom(url.searchParams.get("business") || "Corner Deli");
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    return Response.json(await payrollControlDashboard(business, String(url.searchParams.get("weekStart") || "")));
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
    const action = String(body.action || "");
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) return Response.json({ error: "Business access denied." }, { status: 403 });
    if (action === "punch-correct") return Response.json(await correctPunch({
      business, sourceType: body.sourceType === "Tiki" ? "Tiki" : "Rezku", sourceId: String(body.sourceId || ""),
      employeeName: body.employeeName ? String(body.employeeName) : undefined, position: body.position ? String(body.position) : undefined,
      clockIn: String(body.clockIn || ""), clockOut: body.clockOut ? String(body.clockOut) : null,
      reason: String(body.reason || ""), actor: session.email,
    }));
    if (action === "tip-override-create") return Response.json(await createTipOverride({
      business, weekStart: String(body.weekStart || ""), sourceTransactionId: String(body.sourceTransactionId || ""),
      employeeName: String(body.employeeName || ""), amount: Number(body.amount || 0), reason: String(body.reason || ""), actor: session.email,
    }), { status: 201 });
    if (action === "tip-override-delete") return Response.json(await deleteTipOverride(String(body.id || ""), session.email));
    if (action === "draft-create") return Response.json(await createPayrollDraft({ business, weekStart: String(body.weekStart || ""), actor: session.email }), { status: 201 });
    if (action === "run-lock") return Response.json(await lockPayrollRun(String(body.id || ""), session.email));
    if (action === "run-reopen") return Response.json(await reopenPayrollRun(String(body.id || ""), session.email), { status: 201 });
    return Response.json({ error: "Unknown payroll action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
