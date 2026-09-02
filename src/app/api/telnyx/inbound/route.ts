import { apiError } from "@/lib/http";
import { processTelnyxInbound, verifyTelnyxWebhook } from "@/lib/telnyx-inbound";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("telnyx-signature-ed25519") || "";
    const timestamp = request.headers.get("telnyx-timestamp") || "";
    if (!verifyTelnyxWebhook(rawBody, signature, timestamp)) {
      return Response.json({ error: "Invalid Telnyx webhook signature." }, { status: 403 });
    }
    return Response.json(await processTelnyxInbound(rawBody));
  } catch (error) {
    return apiError(error);
  }
}
