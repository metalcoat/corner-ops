import { greeterMusic } from "@/lib/greeter-music";

export const runtime = "nodejs";

// The greeter TV's playlist for a season (store network only, like the rest of /api/pos).
export async function GET(request: Request) {
  const season = new URL(request.url).searchParams.get("season") || "everyday";
  const tracks = await greeterMusic(season);
  return Response.json(
    { tracks: tracks.map((name) => `/api/pos/greeter/music/file?name=${encodeURIComponent(name)}`) },
    { headers: { "cache-control": "no-store" } },
  );
}
