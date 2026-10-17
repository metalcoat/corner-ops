import { getSql } from "@/lib/db";
import { ensureDeliverySchema } from "@/lib/delivery-boy/server";
import { ensureGauntletSchema } from "@/lib/pizza-gauntlet/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    await Promise.all([ensureGauntletSchema(), ensureDeliverySchema()]);
    const rows = await getSql()`
      SELECT 'pizza' game, game_version, COUNT(*)::int plays,
        COUNT(*) FILTER (WHERE status='won')::int wins,
        COUNT(*) FILTER (WHERE status='lost')::int failed_runs,
        COUNT(*) FILTER (WHERE status='active')::int active_runs,
        COALESCE(MAX(COALESCE((stats->>'delivered')::int,(stats->>'pizzasMade')::int,0)),0)::int furthest
      FROM pizza_gauntlet_runs GROUP BY game_version
      UNION ALL
      SELECT 'delivery' game, game_version, COUNT(*)::int plays,
        COUNT(*) FILTER (WHERE status='won')::int wins,
        COUNT(*) FILTER (WHERE status='lost')::int failed_runs,
        COUNT(*) FILTER (WHERE status='active')::int active_runs,
        COALESCE(MAX(stage),0)::int furthest
      FROM delivery_boy_runs GROUP BY game_version
      ORDER BY game, game_version DESC`;
    return Response.json({ versions: rows });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Analytics failed." },
      { status: 500 },
    );
  }
}
