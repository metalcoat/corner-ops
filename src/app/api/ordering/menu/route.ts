import { apiError, unauthorized } from "@/lib/http";
import { orderingMenuWithVariants } from "@/lib/ordering-menu-variants";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

function readBusiness(value: string | null): OrderingBusiness {
  if (value === "Corner Deli" || value === "Tiki") return value;
  throw new Error("Unknown business.");
}

export async function GET(request: Request) {
  try {
    const business = readBusiness(new URL(request.url).searchParams.get("business") || "Corner Deli");
    if (!await orderingActor(business)) return unauthorized();
    const channel=new URL(request.url).searchParams.get("channel")==="web"?"web":"pos";
    return Response.json({ business,channel,categories:await orderingMenuWithVariants(business,channel) });
  } catch (error) {
    return apiError(error);
  }
}
