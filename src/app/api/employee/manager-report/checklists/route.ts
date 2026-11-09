import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { businessDateOf } from "@/lib/ordering-registers";
import { managerReportRange, type ManagerReportView } from "@/lib/ordering-manager-report";
import { checklistManager } from "@/lib/store-checklist-access";
import { checklistHistory } from "@/lib/store-checklists";

export const runtime = "nodejs";

/** Who ticked what and when, what was missed, and every salad batch, for a day, week or month. */
export async function GET(request: Request) {
  try {
    if (!(await checklistManager())) return isoJson({ error: "Manager access required." }, { status: 403 });
    const params = new URL(request.url).searchParams;
    const view = params.get("view") as ManagerReportView;
    const date = params.get("date") || businessDateOf(new Date());
    if (!["day", "week", "month"].includes(view) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return isoJson({ error: "Choose a day, week or month." }, { status: 400 });
    return isoJson(await checklistHistory(managerReportRange(view, date)));
  } catch (error) {
    return apiError(error);
  }
}
