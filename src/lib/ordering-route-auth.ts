import { canAccessBusiness, getSession } from "@/lib/auth";
import { getPosSession } from "@/lib/pos-auth";
import type { OrderingBusiness } from "@/lib/ordering-core";

export type OrderingActor = { id: string; name: string; type: "employee" | "account"; role?: "employee" | "manager" | "owner" };

export async function orderingActor(business: OrderingBusiness): Promise<OrderingActor | null> {
  if (business === "Corner Deli") {
    const employee = await getPosSession(true);
    return employee ? { id: employee.employeeId, name: employee.name, type: "employee", role: employee.posRole } : null;
  }
  const account = await getSession();
  if (!account || !canAccessBusiness(account, business)) return null;
  // Ordering audit schemas use employee/web/system channel values. A signed-in
  // operations account acting at a POS is recorded through the employee
  // channel while retaining its stable account id, display name, and role.
  return { id: account.email, name: account.displayName || account.email, type: "employee", role: account.role === "Owner" || account.role === "Co-Owner" ? "owner" : account.role === "Manager" ? "manager" : "employee" };
}

export function canManagePos(actor: OrderingActor): boolean {
  return actor.role === "manager" || actor.role === "owner";
}
