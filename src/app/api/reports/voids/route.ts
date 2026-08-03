import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { apiError, unauthorized } from "@/lib/http";
import {
  detectRezkuVoidReportType,
  importRezkuVoidReport,
  rezkuVoidDashboard,
} from "@/lib/rezku-voids";

export const runtime = "nodejs";
export const maxDuration = 300;

function todayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "reports.read");
    if (!canAccessBusiness(session, "Corner Deli")) {
      return Response.json({ error: "Corner Deli access denied." }, { status: 403 });
    }
    const url = new URL(request.url);
    const today = todayKey();
    const start = url.searchParams.get("start") || addDays(today, -30);
    const end = url.searchParams.get("end") || addDays(today, 1);
    return Response.json(await rezkuVoidDashboard(start, end));
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();
    requirePermission(session, "payroll.write");
    if (!canAccessBusiness(session, "Corner Deli")) {
      return Response.json({ error: "Corner Deli access denied." }, { status: 403 });
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json({ error: "Choose a Rezku product-void or transaction-void workbook." }, { status: 400 });
    }
    if (file.size > 25 * 1024 * 1024) {
      return Response.json({ error: "Rezku reports are limited to 25 MB." }, { status: 413 });
    }
    if (!/\.(xlsx|xls)$/i.test(file.name)) {
      return Response.json({ error: "Rezku imports must be Excel workbooks." }, { status: 415 });
    }
    const requested = String(form.get("reportType") || "") || undefined;
    if (!detectRezkuVoidReportType(file.name, requested)) {
      return Response.json({ error: "This page accepts Product Voids or Transaction Voids reports." }, { status: 422 });
    }
    return Response.json(await importRezkuVoidReport(
      file.name,
      await file.arrayBuffer(),
      requested,
      session.email,
    ), { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
