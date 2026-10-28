import { withTablet } from "@/lib/car-tablet-route";
import { waitForCommands } from "@/lib/car-tablet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Long poll (?wait=25): "snap now" requests from the POS arrive within about a second. */
export function GET(request: Request) {
  const wait = Number(new URL(request.url).searchParams.get("wait") || 25);
  return withTablet(request, async (tablet) => ({ commands: await waitForCommands(tablet, Number.isFinite(wait) ? wait : 25, request.signal) }));
}
