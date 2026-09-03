import { getSession, canAccessBusiness } from "@/lib/auth";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import {
  accountingSnapshot,
  createEmployee,
  createSimpleJournalEntry,
  listEmployees,
  listRecentTimeEntries,
  payrollSummary,
  updateEmployee,
} from "@/lib/operations";
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

    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");

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
