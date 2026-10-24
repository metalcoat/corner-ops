import { clientIp, consumeRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/http";

// Scores come from the player's browser, so prize codes are capped: a few winning
// runs per visitor per day, and a daily limit for the whole game.
async function limitPrizes(request: Request, game: string) {
  await consumeRateLimit([
    { scope: `${game}-prize`, discriminator: `ip:${clientIp(request)}`, maxFailures: 2, windowSeconds: 86_400, blockSeconds: 86_400 },
    { scope: `${game}-prize`, discriminator: "business:all:daily", maxFailures: 40, windowSeconds: 86_400, blockSeconds: 3_600 },
  ]);
}
import {
  checkpointDelivery,
  completeDeliveryRun,
  recordDeliveryLoss,
  startDeliveryRun,
} from "@/lib/delivery-boy/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const b = await request.json(),
      action = String(b.action || "start");
    if (action === "start")
      return Response.json(await startDeliveryRun(String(b.playerName || "")), {
        status: 201,
      });
    if (action === "checkpoint")
      return Response.json(
        await checkpointDelivery(b.checkpoint, String(b.token || "")),
      );
    if (action === "complete") await limitPrizes(request, "delivery-boy");
    if (action === "complete")
      return Response.json(
        await completeDeliveryRun(String(b.runId), String(b.token || "")),
      );
    if (action === "loss")
      return Response.json(
        await recordDeliveryLoss(
          {
            runId: String(b.runId || ""),
            stage: Number(b.stage),
            activeSeconds: Number(b.activeSeconds),
            score: Number(b.score),
            delivered: Number(b.delivered),
            missed: Number(b.missed),
            hits: Number(b.hits),
          },
          String(b.token || ""),
        ),
      );
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    if (e instanceof RateLimitError)
      return Response.json({ error: "That's the most prizes allowed today. Come back tomorrow!" }, { status: 429 });
    return Response.json(
      { error: e instanceof Error ? e.message : "Route failed." },
      { status: 409 },
    );
  }
}
