import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { getEmployeeSession } from "@/lib/employee-auth";
import { businessDateOf } from "@/lib/ordering-registers";
import { managerReport, type ManagerReportView } from "@/lib/ordering-manager-report";
import { getPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";

const manager = (role: unknown) => role === "manager" || role === "owner";

/** The report opens from the employee app anywhere, or from the POS at the store. */
export async function GET(request: Request) {
  try {
    const employee = await getEmployeeSession();
    const allowed = (employee?.business === "Corner Deli" && manager(employee.posRole)) || manager((await getPosSession(true))?.posRole);
    if (!allowed) return isoJson({ error: "Manager access required." }, { status: 403 });
    const params = new URL(request.url).searchParams;
    const view = params.get("view") as ManagerReportView;
    const date = params.get("date") || businessDateOf(new Date());
    if (!["day", "week", "month"].includes(view) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return isoJson({ error: "Choose a day, week or month." }, { status: 400 });
    return isoJson(await managerReport({ view, date }));
  } catch (error) {
    return apiError(error);
  }
}
