import { isoJson } from "@/lib/timestamp-values";
import { latestDoorWalkIn } from "@/lib/door-chime";

export const runtime = "nodejs";

// The TV greeter polls this. Like the rest of /api/pos, the proxy only serves it on
// the store network; it returns nothing but the newest walk-in's id and age.
export async function GET() {
  try {
    return isoJson({ latest: await latestDoorWalkIn("Corner Deli") }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Greeter walk-ins unavailable", error);
    return isoJson({ error: "Walk-ins are temporarily unavailable." }, { status: 503 });
  }
}
