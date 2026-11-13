import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { getEmployeeSession } from "@/lib/employee-auth";
import { businessDateOf } from "@/lib/ordering-registers";
import { busyTimesReport } from "@/lib/ordering-busy-times";
import type { ManagerReportView } from "@/lib/ordering-manager-report";
import { getPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";

const manager = (role: unknown) => role === "manager" || role === "owner";

/** Busy times open wherever the Daily report does: the employee app or the POS. */
export async function GET(request: Request) {
  try {
    const employee = await getEmployeeSession();
    const allowed = (employee?.business === "Corner Deli" && manager(employee.posRole)) || manager((await getPosSession(true))?.posRole);
    if (!allowed) return isoJson({ error: "Manager access required." }, { status: 403 });
    const params = new URL(request.url).searchParams;
    const view = params.get("view") as ManagerReportView;
    const date = params.get("date") || businessDateOf(new Date());
    const slot = Number(params.get("slot") || 30);
    if (!["day", "week", "month"].includes(view) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return isoJson({ error: "Choose a day, week or month." }, { status: 400 });
    if (slot !== 15 && slot !== 30) return isoJson({ error: "Slots are 15 or 30 minutes." }, { status: 400 });
    return isoJson(await busyTimesReport({ view, date, slotMinutes: slot }));
  } catch (error) {
    return apiError(error);
  }
}
