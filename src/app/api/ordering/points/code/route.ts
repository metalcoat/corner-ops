import { isoJson } from "@/lib/timestamp-values";
import { orderingActor } from "@/lib/ordering-route-auth";
import { pointsCodeVerified, requestPointsRedeemCode, verifyPointsRedeemCode } from "@/lib/ordering-points";

// POS: text the customer a one-time code (to the phone on their account) and verify it before spending points.
export async function POST(request: Request) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return isoJson({ error: "POS authentication required." }, { status: 401 });
    const body = (await request.json()) as Record<string, unknown>, orderId = String(body.orderId || "");
    if (body.action === "request") return isoJson(await requestPointsRedeemCode(orderId, actor));
    if (body.action === "verify") return isoJson(await verifyPointsRedeemCode(orderId, String(body.code || ""), actor));
    if (body.action === "status") return isoJson({ verified: await pointsCodeVerified(orderId) });
    return isoJson({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "The code step failed." }, { status: 409 });
  }
}
