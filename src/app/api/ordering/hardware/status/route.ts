import { apiError, unauthorized } from "@/lib/http";
import { operationalPrinterStatus } from "@/lib/ordering-hardware";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (!await orderingActor("Corner Deli")) return unauthorized();
    return Response.json(await operationalPrinterStatus("Corner Deli"));
  } catch (error) {
    return apiError(error);
  }
}
