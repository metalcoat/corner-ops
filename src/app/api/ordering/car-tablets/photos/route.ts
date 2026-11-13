import { apiError } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { isoJson } from "@/lib/timestamp-values";
import { listPhotos } from "@/lib/car-tablet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Car tablet photos, newest first; ?tabletId= or ?orderId= narrows them. */
export async function GET(request: Request) {
  try {
    if (!(await orderingActor("Corner Deli"))) return isoJson({ error: "POS sign-in required." }, { status: 401 });
    const url = new URL(request.url), uuid = /^[0-9a-f-]{36}$/i;
    const tabletId = url.searchParams.get("tabletId") || "", orderId = url.searchParams.get("orderId") || "";
    return isoJson({ photos: await listPhotos("Corner Deli", {
      tabletId: uuid.test(tabletId) ? tabletId : undefined,
      orderId: uuid.test(orderId) ? orderId : undefined,
      limit: Number(url.searchParams.get("limit") || 60),
    }) });
  } catch (error) {
    return apiError(error);
  }
}
