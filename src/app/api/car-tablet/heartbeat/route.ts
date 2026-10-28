import { withTablet } from "@/lib/car-tablet-route";
import { recordHeartbeat } from "@/lib/car-tablet";

export const runtime = "nodejs";

/** Every 30 s: battery, charging, network, app version, queue sizes. Answers with the tablet's status. */
export function POST(request: Request) {
  return withTablet(request, async (tablet) => recordHeartbeat(tablet, await request.json().catch(() => ({})) as Record<string, unknown>));
}
