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
    return Response.json(
      { error: e instanceof Error ? e.message : "Route failed." },
      { status: 409 },
    );
  }
}
