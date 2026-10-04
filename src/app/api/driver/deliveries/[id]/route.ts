import { driverActor } from "@/lib/ordering-driver-delivery";
import { driverOrderDetail } from "@/lib/ordering-driver-orders";
import { cornerOpsBaseUrl } from "@/lib/transactional-email";

export const runtime = "nodejs";
/** The order behind one delivery: items, options, money, and notes. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await driverActor();
    if (!actor) return Response.json({ error: "Employee sign-in required." }, { status: 401 });
    if (!actor.driver && !actor.manager) return Response.json({ error: "Driver or dispatcher access required." }, { status: 403 });
    return Response.json({ order: await driverOrderDetail(actor, (await params).id, cornerOpsBaseUrl()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Order could not be loaded.";
    if (message.includes("assigned") || message.includes("not found")) return Response.json({ error: message }, { status: 404 });
    console.error(error);
    return Response.json({ error: "Order could not be loaded." }, { status: 500 });
  }
}
