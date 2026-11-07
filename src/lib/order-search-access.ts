import { getEmployeeSession } from "@/lib/employee-auth";
import { getPosSession } from "@/lib/pos-auth";

const manager = (role: unknown) => role === "manager" || role === "owner";

/** Same rule as the daily report: a Corner Deli manager/owner in the employee app, or a manager signed in at the POS. */
export async function orderSearchAllowed() {
  const employee = await getEmployeeSession();
  return (employee?.business === "Corner Deli" && manager(employee.posRole)) || manager((await getPosSession(true))?.posRole);
}
