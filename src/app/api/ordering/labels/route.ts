import { apiError, unauthorized } from "@/lib/http";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { labelQueue, printItemLabel } from "@/lib/ordering-labels";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

function businessFrom(value: unknown): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

/** The label station's list: subs and pizzas still to label, plus recently printed ones. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const business = businessFrom(url.searchParams.get("business") || "Corner Deli");
    if (!(await orderingActor(business))) return unauthorized();
    return Response.json(await labelQueue(business, String(url.searchParams.get("printerId") || "")));
  } catch (error) {
    return apiError(error);
  }
}

/** Print (or reprint) one label. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const business = businessFrom(body.business || "Corner Deli");
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    const unitIndex = Number(body.unitIndex);
    if (!Number.isSafeInteger(unitIndex) || unitIndex < 0) throw new Error("Unknown label.");
    return Response.json(
      await printItemLabel({ business, printerId: String(body.printerId || ""), orderItemId: String(body.orderItemId || ""), unitIndex, reprint: body.reprint === true, actor }),
    );
  } catch (error) {
    return apiError(error);
  }
}
