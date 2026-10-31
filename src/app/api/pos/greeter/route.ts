import { isoJson } from "@/lib/timestamp-values";
import { latestDoorWalkIn } from "@/lib/door-chime";
import { greeterVolumes } from "@/lib/greeter-tv-settings";
import { storeMonthDay } from "@/lib/menu-board";
import { seasonFor } from "@/lib/menu-board-layout";

export const runtime = "nodejs";

// The TV greeter polls this. Like the rest of /api/pos, the proxy only serves it on
// the store network; it returns the newest walk-in's id and age, the volumes set in POS Settings, and
// today's season (the TV reloads when that changes).
export async function GET() {
  try {
    const [latest, volumes] = await Promise.all([latestDoorWalkIn("Corner Deli"), greeterVolumes()]);
    return isoJson({ latest, volumes, season: seasonFor(storeMonthDay()) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Greeter walk-ins unavailable", error);
    return isoJson({ error: "Walk-ins are temporarily unavailable." }, { status: 503 });
  }
}
