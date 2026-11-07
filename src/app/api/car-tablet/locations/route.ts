import { withTablet } from "@/lib/car-tablet-route";
import { parsePointBatch } from "@/lib/car-tablet-rules";
import { ingestPoints } from "@/lib/car-tablet";

export const runtime = "nodejs";

/** A batch of queued GPS points (up to 500). Re-sending a batch is harmless. */
export function POST(request: Request) {
  return withTablet(request, async (tablet) => {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const { points, rejected } = parsePointBatch(body.points);
    return { ok: true, rejected, ...(await ingestPoints(tablet, points)) };
  });
}
