import { isoJson } from "@/lib/timestamp-values";
import { getSql } from "@/lib/db";
import { getEmployeeSession } from "@/lib/employee-auth";
import { apiError } from "@/lib/http";
import { addStockRequest, saveStockCount, stockSheet, SupplierCostError } from "@/lib/ordering-supplier-costs";

export const runtime = "nodejs";

/** Any active Corner Deli employee signed in with their PIN can count stock and ask for things. */
async function stockEmployee() {
  const session = await getEmployeeSession();
  if (!session || session.business !== "Corner Deli") return null;
  const row = (await getSql()`SELECT name,active FROM employees WHERE id=${session.employeeId} AND business='Corner Deli'`)[0];
  return row?.active ? { employeeId: session.employeeId, name: String(row.name) } : null;
}

export async function GET() {
  const employee = await stockEmployee();
  if (!employee) return isoJson({ error: "Employee sign-in required." }, { status: 401 });
  try {
    return isoJson({ employee: employee.name, ...(await stockSheet()) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const employee = await stockEmployee();
  if (!employee) return isoJson({ error: "Employee sign-in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "count") return isoJson(await saveStockCount(employee, Array.isArray(body.counts) ? (body.counts as Array<{ itemId: string; quantity: number }>) : []));
    if (body.action === "request")
      return isoJson(await addStockRequest(employee, { itemId: body.itemId as string | undefined, itemText: body.itemText as string | undefined, quantity: body.quantity as number | null, unit: body.unit as string | undefined, urgency: body.urgency as string | undefined, note: body.note as string | undefined }));
    return isoJson({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof SupplierCostError) return isoJson({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
