import { getEmployeeSession } from "@/lib/employee-auth";
import { getPosSession } from "@/lib/pos-auth";

const manager = (role: unknown) => role === "manager" || role === "owner";

/** Checklist history and setup open wherever the Daily report does: the employee app anywhere, or the POS at the store. */
export async function checklistManager(): Promise<{ name: string } | null> {
  const employee = await getEmployeeSession();
  if (employee?.business === "Corner Deli" && manager(employee.posRole)) return { name: employee.name };
  const pos = await getPosSession(true);
  return pos && manager(pos.posRole) ? { name: pos.name } : null;
}
