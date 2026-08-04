import { getSession, canAccessBusiness } from "@/lib/auth";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import {
  accountingSnapshot,
  createEmployee,
  createSimpleJournalEntry,
  listEmployees,
  listRecentTimeEntries,
  listRezkuImports,
  payrollSummary,
  updateEmployee,
} from "@/lib/operations";
import { repairExistingRezkuTimesOnce } from "@/lib/rezku-eastern-time";
import { importSafeRezkuReport } from "@/lib/safe-rezku-import";
import { detectRezkuVoidReportType, importRezkuVoidReport } from "@/lib/rezku-voids";
import { apiError, unauthorized } from "@/lib/http";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function businessFrom(value: unknown): Business {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

function boolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "yes", "1", "on"].includes(value.toLowerCase());
  return fallback;
}

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const url = new URL(request.url);
    const area = url.searchParams.get("area") || "";
    const business = businessFrom(url.searchParams.get("business") || "Tiki");
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    if (area === "employees") {
      await ensureEmployeeDirectorySchema();
      return Response.json({ employees: await listEmployees(business) });
    }
    if (area === "time") return Response.json({ entries: await listRecentTimeEntries(business) });
    if (area === "payroll") {
      return Response.json(await payrollSummary(business, url.searchParams.get("weekStart") || undefined));
    }
    if (area === "imports") return Response.json({ imports: await listRezkuImports() });
    if (area === "accounting") return Response.json(await accountingSnapshot(business));

    return Response.json({ error: "Unknown operations area." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const action = String(form.get("action") || "");
      if (action !== "rezku-import") {
        return Response.json({ error: "Unknown file operation." }, { status: 400 });
      }
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return Response.json({ error: "Choose a Rezku Excel report." }, { status: 400 });
      }
      if (file.size > 25 * 1024 * 1024) {
        return Response.json({ error: "Rezku reports are limited to 25 MB." }, { status: 413 });
      }
      if (!/\.(xlsx|xls)$/i.test(file.name)) {
        return Response.json({ error: "Rezku imports must be Excel files." }, { status: 415 });
      }
      const requested = String(form.get("reportType") || "") || undefined;
      const bytes = await file.arrayBuffer();
      const voidType = detectRezkuVoidReportType(file.name, requested);
      if (!voidType) await ensureEmployeeDirectorySchema();
      const result = voidType
        ? await importRezkuVoidReport(file.name, bytes, voidType, session.email)
        : await importSafeRezkuReport(file.name, bytes, requested, session.email);
      return Response.json(result, { status: 201 });
    }

    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");

    if (action === "rezku-repair-times") {
      if (!canAccessBusiness(session, "Corner Deli")) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      return Response.json(await repairExistingRezkuTimesOnce());
    }

    if (action === "employee-create") {
      const business = businessFrom(body.business);
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const roleGroup = body.roleGroup === "Driver" || body.roleGroup === "Ignore" ? body.roleGroup : "In-House";
      const employee = await createEmployee({
        business,
        name: String(body.name || ""),
        pin: String(body.pin || ""),
        position: String(body.position || ""),
        roleGroup,
        countsForTips: boolean(body.countsForTips, true),
        hourlyRate: Number(body.hourlyRate || 0),
        tippedRate: Number(body.tippedRate || 0),
      });
      return Response.json({ employee }, { status: 201 });
    }

    if (action === "employee-update") {
      const employee = await updateEmployee({
        id: String(body.id || ""),
        active: typeof body.active === "boolean" ? body.active : undefined,
        pin: body.pin ? String(body.pin) : undefined,
        name: body.name ? String(body.name) : undefined,
        position: body.position ? String(body.position) : undefined,
        roleGroup: body.roleGroup === "Driver" || body.roleGroup === "In-House" || body.roleGroup === "Ignore"
          ? body.roleGroup
          : undefined,
        countsForTips: typeof body.countsForTips === "boolean" ? body.countsForTips : undefined,
        hourlyRate: body.hourlyRate === undefined ? undefined : Number(body.hourlyRate),
        tippedRate: body.tippedRate === undefined ? undefined : Number(body.tippedRate),
      });
      if (!canAccessBusiness(session, employee.business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      return Response.json({ employee });
    }

    if (action === "journal-create") {
      const business = businessFrom(body.business);
      if (!canAccessBusiness(session, business)) {
        return Response.json({ error: "Business access denied." }, { status: 403 });
      }
      const kind = body.kind === "Expense" ? "Expense" : "Revenue";
      const entry = await createSimpleJournalEntry({
        business,
        entryDate: String(body.entryDate || ""),
        description: String(body.description || ""),
        reference: String(body.reference || ""),
        kind,
        accountCode: String(body.accountCode || ""),
        amount: Number(body.amount || 0),
        actor: session.email,
      });
      return Response.json({ entry }, { status: 201 });
    }

    return Response.json({ error: "Unknown operations action." }, { status: 400 });
  } catch (error) {
    return apiError(error);
  }
}
