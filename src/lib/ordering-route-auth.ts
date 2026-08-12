import { canAccessBusiness, getSession } from "@/lib/auth";
import { getPosSession } from "@/lib/pos-auth";
import type { OrderingBusiness } from "@/lib/ordering-core";

export type OrderingActor = { id: string; name: string; type: "employee" | "account" };

export async function orderingActor(business: OrderingBusiness): Promise<OrderingActor | null> {
  if (business === "Corner Deli") {
    const employee = await getPosSession(true);
    return employee ? { id: employee.employeeId, name: employee.name, type: "employee" } : null;
  }
  const account = await getSession();
  if (!account || !canAccessBusiness(account, business)) return null;
  return { id: account.email, name: account.displayName || account.email, type: "account" };
}
