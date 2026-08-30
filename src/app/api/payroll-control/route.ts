import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  createPayrollDraft,
  createTipOverride,
  deleteTipOverride,
  lockPayrollRun,
  payrollCsv,
  reopenPayrollRun,
} from "@/lib/payroll-control";
import { correctPunch } from "@/lib/payroll-punch-correction";
import { safePayrollControlDashboard } from "@/lib/payroll-control-dashboard";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

const TIME_ZONE = "America/New_York";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function easternOffsetMilliseconds(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  ) - date.getTime();
}

function easternWallToIso(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error("Enter a valid Eastern date and time.");
  const wall = Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6] || 0),
  );
  let timestamp = wall;
  for (let index = 0; index < 3; index += 1) {
    timestamp = wall - easternOffsetMilliseconds(new Date(timestamp));
  }
  return new Date(timestamp).toISOString();
}

function correctionTimes(body: Record<string, unknown>) {
  const wallClockIn = String(body.clockInWall || "").trim();
  const wallClockOut = String(body.clockOutWall || "").trim();
  const clockIn = wallClockIn ? easternWallToIso(wallClockIn) : String(body.clockIn || "");
  const rawClockOut = wallClockOut
    ? easternWallToIso(wallClockOut)
    : body.clockOut ? String(body.clockOut) : null;
  if (!rawClockOut) return { clockIn, clockOut: null as string | null };

  const parsedIn = new Date(clockIn);
  const parsedOut = new Date(rawClockOut);
  if (Number.isNaN(parsedIn.getTime()) || Number.isNaN(parsedOut.getTime()) || parsedOut >= parsedIn) {
    return { clockIn, clockOut: rawClockOut };
  }

  // Tiki and deli shifts commonly cross midnight. If an entered clock-out looks
  // earlier than clock-in, treat it as the following day when that creates a
  // sensible overnight shift instead of rejecting the correction outright.
  const overnightOut = new Date(parsedOut.getTime() + 24 * 60 * 60 * 1000);
  const hours = (overnightOut.getTime() - parsedIn.getTime()) / 3_600_000;
  if (hours > 0 && hours <= 18) return { clockIn, clockOut: overnightOut.toISOString() };

  return { clockIn, clockOut: rawClockOut };
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
    return Response.json(await safePayrollControlDashboard(business, String(url.searchParams.get("weekStart") || "")));
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
    if (action === "punch-correct") {
      const times = correctionTimes(body);
      return Response.json(await correctPunch({
        business, sourceType: body.sourceType === "Tiki" ? "Tiki" : "Rezku", sourceId: String(body.sourceId || ""),
        employeeName: body.employeeName ? String(body.employeeName) : undefined, position: body.position ? String(body.position) : undefined,
        clockIn: times.clockIn, clockOut: times.clockOut,
        reason: String(body.reason || ""), actor: session.email,
      }));
    }
    if (action === "tip-override-create") {
      const reason = String(body.reason || "").trim();
      if (reason.length < 3) {
        return Response.json({ error: "Add a reason (at least 3 characters) for this manual tip assignment." }, { status: 400 });
      }
      return Response.json(await createTipOverride({
        business, weekStart: String(body.weekStart || ""), sourceTransactionId: String(body.sourceTransactionId || ""),
        employeeName: String(body.employeeName || ""), amount: Number(body.amount || 0), reason, actor: session.email,
      }), { status: 201 });
    }
    if (action === "tip-override-delete") return Response.json(await deleteTipOverride(String(body.id || ""), session.email));
    if (action === "draft-create") return Response.json(await createPayrollDraft({ business, weekStart: String(body.weekStart || ""), actor: session.email }), { status: 201 });
    if (action === "run-lock") return Response.json(await lockPayrollRun(String(body.id || ""), session.email));
    if (action === "run-reopen") return Response.json(await reopenPayrollRun(String(body.id || ""), session.email), { status: 201 });
    return Response.json({ error: "Unknown payroll action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
