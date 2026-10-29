import { withTablet } from "@/lib/car-tablet-route";
import { waitForCommands } from "@/lib/car-tablet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Long poll (?wait=25): "snap now" requests from the POS arrive within about a second. With ?feed=<version>
 * (from the last answer) it also answers as soon as the delivery list changes. Also says whether it's quiet time.
 */
export function GET(request: Request) {
  const url = new URL(request.url), wait = Number(url.searchParams.get("wait") || 25), feed = url.searchParams.get("feed");
  return withTablet(request, (tablet) => waitForCommands(tablet, Number.isFinite(wait) ? wait : 25, request.signal, feed ?? undefined));
}
