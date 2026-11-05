import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { getEmployeeSession } from "@/lib/employee-auth";
import { getPosSession } from "@/lib/pos-auth";
import { itemSalesMetrics, salesMetrics } from "@/lib/ordering-sales-metrics";
import { METRICS_PRESETS, MetricsRangeError, type MetricsPreset } from "@/lib/sales-metrics";

export const runtime = "nodejs";

const manager = (role: unknown) => role === "manager" || role === "owner";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Sales metrics for managers and owners: from the employee app anywhere, or from the POS at the store. */
export async function GET(request: Request) {
  try {
    const employee = await getEmployeeSession();
    const allowed = (employee?.business === "Corner Deli" && manager(employee.posRole)) || manager((await getPosSession(true))?.posRole);
    if (!allowed) return isoJson({ error: "Manager access required." }, { status: 403 });
    const params = new URL(request.url).searchParams;
    const preset = (params.get("range") || "this_week") as MetricsPreset;
    if (!METRICS_PRESETS.includes(preset)) return isoJson({ error: "Pick a date range." }, { status: 400 });
    const input = { preset, start: params.get("start") || undefined, end: params.get("end") || undefined };
    const item = params.get("item");
    if (item !== null) {
      if (!UUID.test(item)) return isoJson({ error: "Unknown item." }, { status: 400 });
      return isoJson(await itemSalesMetrics({ ...input, itemId: item }));
    }
    return isoJson(await salesMetrics(input));
  } catch (error) {
    if (error instanceof MetricsRangeError) return isoJson({ error: error.message }, { status: 400 });
    return apiError(error);
  }
}
