import { readFile } from "node:fs/promises";
import { isoJson } from "@/lib/timestamp-values";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The newest car tablet build (written by tools/car-tablet/publish-dev.sh), so the tablet can offer the update. */
export async function GET() {
  try {
    const info = JSON.parse(await readFile("/data/uploads/mobile-builds/car-tablet.json", "utf8")) as Record<string, unknown>;
    return isoJson({ ...info, downloadPath: "/downloads/corner-ops-car-tablet.apk" }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return isoJson({ error: "No car tablet build has been published yet." }, { status: 404 });
  }
}
