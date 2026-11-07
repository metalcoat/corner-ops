import { getEmployeeSession } from "@/lib/employee-auth";
import { getPosSession } from "@/lib/pos-auth";
import type { OrderingActor } from "@/lib/ordering-route-auth";

const manager = (role: unknown): role is "manager" | "owner" => role === "manager" || role === "owner";

/** Same rule as order search: a Corner Deli manager/owner in the employee app, or a manager signed in at the POS. */
export async function houseAccountManager(): Promise<OrderingActor | null> {
  const employee = await getEmployeeSession();
  if (employee?.business === "Corner Deli" && manager(employee.posRole)) return { id: employee.employeeId, name: employee.name, type: "employee", role: employee.posRole };
  const pos = await getPosSession(true);
  return pos && manager(pos.posRole) ? { id: pos.employeeId, name: pos.name, type: "employee", role: pos.posRole } : null;
}
