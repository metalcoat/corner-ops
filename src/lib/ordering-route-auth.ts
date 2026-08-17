import { canAccessBusiness, getSession } from "@/lib/auth";
import { getPosSession } from "@/lib/pos-auth";
import type { OrderingBusiness } from "@/lib/ordering-core";

export type OrderingActor = { id: string; email?: string; name: string; type: "employee" | "account"; role?: "employee" | "manager" | "owner" };

export async function orderingActor(business: OrderingBusiness): Promise<OrderingActor | null> {
  if (business === "Corner Deli") {
    const employee = await getPosSession(true);
    return employee ? { id: employee.employeeId, email: employee.employeeId, name: employee.name, type: "employee", role: employee.posRole } : null;
  }
  const account = await getSession();
  if (!account || !canAccessBusiness(account, business)) return null;
  // Ordering audit schemas use employee/web/system channel values. A signed-in
  // operations account acting at a POS is recorded through the employee
  // channel while retaining its stable account id, display name, and role.
  return { id: account.email, email: account.email, name: account.displayName || account.email, type: "employee", role: account.role === "Owner" || account.role === "Co-Owner" ? "owner" : account.role === "Manager" ? "manager" : "employee" };
}

export function canManagePos(actor: OrderingActor): boolean {
  return actor.role === "manager" || actor.role === "owner";
}

export async function orderingManagerActor(business: OrderingBusiness): Promise<OrderingActor | Response> {
  const actor = await orderingActor(business);
  if (!actor) return Response.json({ error: "POS authentication required." }, { status: 401 });
  if (!canManagePos(actor)) return Response.json({ error: "Manager access required." }, { status: 403 });
  return actor;
}

export function isAuthorizationResponse(value: OrderingActor | Response): value is Response {
  return value instanceof Response;
}
