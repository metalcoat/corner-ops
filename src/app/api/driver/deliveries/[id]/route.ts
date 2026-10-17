import { isoJson } from "@/lib/timestamp-values";
import { driverActor } from "@/lib/ordering-driver-delivery";
import { driverOrderDetail } from "@/lib/ordering-driver-orders";
import { cornerOpsBaseUrl } from "@/lib/transactional-email";

export const runtime = "nodejs";
/** The order behind one delivery: items, options, money, and notes. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await driverActor();
    if (!actor) return isoJson({ error: "Employee sign-in required." }, { status: 401 });
    if (!actor.driver && !actor.manager) return isoJson({ error: "Driver or dispatcher access required." }, { status: 403 });
    return isoJson({ order: await driverOrderDetail(actor, (await params).id, cornerOpsBaseUrl()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Order could not be loaded.";
    if (message.includes("assigned") || message.includes("not found")) return isoJson({ error: message }, { status: 404 });
    console.error(error);
    return isoJson({ error: "Order could not be loaded." }, { status: 500 });
  }
}
