import { isoJson } from "@/lib/timestamp-values";
import { waitingCurbsideArrivals } from "@/lib/curbside-arrivals";

export const runtime = "nodejs";

// The store PC's door alarm (tools/door-alarm-windows) polls this. Store network only, like the rest of /api/pos;
// it needs no sign-in, so it returns just what the alert shows: name, car and order number of customers waiting outside.
export async function GET() {
  try {
    return isoJson({ arrivals: await waitingCurbsideArrivals("Corner Deli") }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Curbside arrivals unavailable", error);
    return isoJson({ error: "Curbside arrivals are temporarily unavailable." }, { status: 503 });
  }
}
