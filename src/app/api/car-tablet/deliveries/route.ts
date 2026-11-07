import { withTablet } from "@/lib/car-tablet-route";
import { tabletDeliveries } from "@/lib/car-tablet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return withTablet(request, (tablet) => tabletDeliveries(tablet));
}
