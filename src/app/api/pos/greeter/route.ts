import { isoJson } from "@/lib/timestamp-values";
import { latestDoorWalkIn } from "@/lib/door-chime";
import { greeterVolumes } from "@/lib/greeter-tv-settings";

export const runtime = "nodejs";

// The TV greeter polls this. Like the rest of /api/pos, the proxy only serves it on
// the store network; it returns the newest walk-in's id and age, and the volumes set in POS Settings.
export async function GET() {
  try {
    const [latest, volumes] = await Promise.all([latestDoorWalkIn("Corner Deli"), greeterVolumes()]);
    return isoJson({ latest, volumes }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Greeter walk-ins unavailable", error);
    return isoJson({ error: "Walk-ins are temporarily unavailable." }, { status: 503 });
  }
}
