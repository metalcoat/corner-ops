import { isoJson } from "@/lib/timestamp-values";
import { timingSafeEqual } from "node:crypto";
import { pruneDoorChimeEvents, recordDoorChimeEvent } from "@/lib/door-chime";
import { parseDoorChimeEvent } from "@/lib/door-chime-policy";

export const runtime = "nodejs";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const supplied = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

let lastPrune = 0;

/**
 * The entrance camera detector on the store server (tools/door-chime-detector.mjs)
 * posts here when someone walks in:
 *   { "business": "Corner Deli", "camera": "entrance", "kind": "person" }
 * Repeats inside the cooldown are ignored ({ recorded: false }). The store dashboard
 * matches each walk-in to the first POS order started after it (time to first interaction).
 */
export async function POST(request: Request) {
  if (!process.env.CRON_SECRET?.trim()) return isoJson({ error: "CRON_SECRET is not configured." }, { status: 503 });
  if (!authorized(request)) return isoJson({ error: "Unauthorized." }, { status: 401 });
  let event;
  try {
    event = parseDoorChimeEvent(await request.json().catch(() => ({})));
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Invalid door event." }, { status: 400 });
  }
  const result = await recordDoorChimeEvent(event);
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    await pruneDoorChimeEvents().catch(() => undefined);
  }
  return isoJson(result);
}
