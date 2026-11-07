import { createHash } from "node:crypto";
import { greeterFacts } from "@/lib/greeter-facts";

export const runtime = "nodejs";

/**
 * How many fun-fact slides there are, and a version that changes when any fact does (the Pi re-downloads then).
 * ?season= counts that holiday's facts instead.
 */
export async function GET(request: Request) {
  const facts = greeterFacts(new URL(request.url).searchParams.get("season"));
  const version = createHash("sha1").update(JSON.stringify(facts)).digest("hex").slice(0, 12);
  return Response.json({ count: facts.length, version }, { headers: { "cache-control": "no-store" } });
}
