import { withTablet } from "@/lib/car-tablet-route";
import { finishCommand } from "@/lib/car-tablet";

export const runtime = "nodejs";

/** The tablet reports a command it couldn't finish (no camera, error). Photos finish snaps by themselves. */
export function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return withTablet(request, async (tablet) => {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    return finishCommand(tablet, (await params).id, { status: String(body.status || "failed"), error: String(body.error || "") });
  });
}
