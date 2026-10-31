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
  checkpointArcadeRun,
  checkpointRun,
  completeArcadeRun,
  completeRun,
  recordArcadeLoss,
  startRun,
} from "@/lib/pizza-gauntlet/server";
import type { RunCheckpoint } from "@/lib/pizza-gauntlet/types";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>,
      action = String(body.action || "start");
    if (action === "start")
      return Response.json(await startRun(String(body.playerName || "")), {
        status: 201,
      });
    const token = String(body.token || "");
    if (action === "checkpoint")
      return Response.json(
        await checkpointRun(body.checkpoint as RunCheckpoint, token),
      );
    if (action === "complete") await limitPrizes(request, "pizza-gauntlet");
    if (action === "complete")
      return Response.json(await completeRun(String(body.runId || ""), token));
    if (action === "arcade_checkpoint")
      return Response.json(
        await checkpointArcadeRun(
          {
            runId: String(body.runId || ""),
            sequence: Number(body.sequence),
            elapsed: Number(body.elapsed),
            score: Number(body.score),
            delivered: Number(body.delivered),
            perfects: Number(body.perfects),
            ruined: Number(body.ruined),
          },
          token,
        ),
      );
    if (action === "arcade_complete") await limitPrizes(request, "pizza-gauntlet");
    if (action === "arcade_complete")
      return Response.json(
        await completeArcadeRun(
          {
            runId: String(body.runId || ""),
            score: Number(body.score),
            delivered: Number(body.delivered),
            perfects: Number(body.perfects),
            ruined: Number(body.ruined),
          },
          token,
        ),
      );
    if (action === "arcade_loss")
      return Response.json(
        await recordArcadeLoss(
          {
            runId: String(body.runId || ""),
            score: Number(body.score),
            delivered: Number(body.delivered),
            perfects: Number(body.perfects),
            ruined: Number(body.ruined),
          },
          token,
        ),
      );
    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof RateLimitError)
      return Response.json({ error: "That's the most prizes allowed today. Come back tomorrow!" }, { status: 429 });
    return Response.json(
      { error: error instanceof Error ? error.message : "Run update failed." },
      { status: 409 },
    );
  }
}
