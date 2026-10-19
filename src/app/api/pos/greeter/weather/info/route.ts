import { greeterWeather } from "@/lib/greeter-weather";
import { cardIconRect, SKY } from "@/lib/greeter-weather-layout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the TV greeter Pi animates on top of the weather slide picture: the current
 * condition in the sky area and one icon per day card, with where each one goes.
 * Store network only, like the rest of /api/pos.
 */
export async function GET() {
  const weather = await greeterWeather();
  return Response.json(
    weather
      ? {
          sky: { kind: weather.now.kind, rect: SKY },
          cards: weather.next.map((day, index) => ({ kind: day.kind, rect: cardIconRect(index) })),
          updatedAt: weather.updatedAt,
        }
      : { sky: null, cards: [], updatedAt: null },
    { headers: { "cache-control": "no-store" } },
  );
}
