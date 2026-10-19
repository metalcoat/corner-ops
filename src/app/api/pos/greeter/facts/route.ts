import { createHash } from "node:crypto";
import { GREETER_FACTS } from "@/lib/greeter-facts";

export const runtime = "nodejs";

/** How many fun-fact slides there are, and a version that changes when any fact does (the Pi re-downloads then). */
export async function GET() {
  const version = createHash("sha1").update(JSON.stringify(GREETER_FACTS)).digest("hex").slice(0, 12);
  return Response.json({ count: GREETER_FACTS.length, version }, { headers: { "cache-control": "no-store" } });
}
