import { withTablet } from "@/lib/car-tablet-route";
import { ogdensburgRouter } from "@/lib/route-map/ogdensburg-router";

export const runtime = "nodejs";

/**
 * The street map the tablet draws its Drive screen from: every road as [name, class, [[lat, lng], …]].
 * Downloaded once per version and kept on the tablet (no map tiles, so almost no data while driving).
 */
export function GET(request: Request) {
  return withTablet(request, async () => {
    const { data } = ogdensburgRouter();
    return {
      version: (data as unknown as { builtAt?: string }).builtAt ?? "1",
      ways: data.ways.map(([name, kind, , path]) => [data.names[name], data.classes[kind], path.map((node) => data.nodes[node])]),
    };
  });
}
