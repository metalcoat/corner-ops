import { isoJson } from "@/lib/timestamp-values";
import { driverActor } from "@/lib/ordering-driver-delivery";
import { logCustomerCall } from "@/lib/ordering-driver-orders";

export const runtime = "nodejs";
/** Logs a call to the customer and returns the 3CX dial link for the tablet to open. */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await driverActor();
    if (!actor) return isoJson({ error: "Employee sign-in required." }, { status: 401 });
    if (!actor.driver && !actor.manager) return isoJson({ error: "Driver or dispatcher access required." }, { status: 403 });
    return isoJson(await logCustomerCall(actor, (await params).id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Call could not be started.";
    return isoJson({ error: message }, { status: message.includes("assigned") ? 403 : 400 });
  }
}
