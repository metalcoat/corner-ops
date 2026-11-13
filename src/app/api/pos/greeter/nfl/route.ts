import { nflGamesToday } from "@/lib/greeter-nfl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Today's NFL games and scores for the greeter TV (store network only, like the rest of /api/pos).
// ?date=2026-10-25T18:00:00Z previews another day.
export async function GET(request: Request) {
  const asked = new URL(request.url).searchParams.get("date");
  const at = asked && !Number.isNaN(Date.parse(asked)) ? new Date(asked) : new Date();
  return Response.json({ games: await nflGamesToday(at) }, { headers: { "cache-control": "no-store" } });
}
