import { withTablet } from "@/lib/car-tablet-route";
import { tabletStatus } from "@/lib/car-tablet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return withTablet(request, (tablet) => tabletStatus(tablet));
}
