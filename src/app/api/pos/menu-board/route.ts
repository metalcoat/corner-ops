import { createHash } from "node:crypto";
import { menuBoard } from "@/lib/menu-board";
import { SEASONS, type SeasonKey } from "@/lib/menu-board-layout";

export const runtime = "nodejs";

// The menu TVs poll this every minute. Like the rest of /api/pos, the proxy only serves it
// on the store network. ?tv=1..3 picks the TV; ?season= previews a holiday theme.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const tv = Number(params.get("tv") || 1);
  const asked = params.get("season");
  const season = asked === "everyday" || SEASONS.some((s) => s.key === asked) ? (asked as SeasonKey) : undefined;
  try {
    const board = await menuBoard(Number.isInteger(tv) ? tv : 1, season);
    const version = createHash("sha1").update(JSON.stringify(board)).digest("hex").slice(0, 12);
    return Response.json({ version, ...board }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("Menu board unavailable", error);
    return Response.json({ error: "The menu is temporarily unavailable." }, { status: 503 });
  }
}
