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
  if (!employee) return Response.json({ error: "Employee sign-in required." }, { status: 401 });
  try {
    return Response.json({ employee: employee.name, ...(await stockSheet()) });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const employee = await stockEmployee();
  if (!employee) return Response.json({ error: "Employee sign-in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "count") return Response.json(await saveStockCount(employee, Array.isArray(body.counts) ? (body.counts as Array<{ itemId: string; quantity: number }>) : []));
    if (body.action === "request")
      return Response.json(await addStockRequest(employee, { itemId: body.itemId as string | undefined, itemText: body.itemText as string | undefined, quantity: body.quantity as number | null, unit: body.unit as string | undefined, urgency: body.urgency as string | undefined, note: body.note as string | undefined }));
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof SupplierCostError) return Response.json({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
