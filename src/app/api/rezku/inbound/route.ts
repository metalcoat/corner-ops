import { after } from "next/server";
import { rezkuInboundGet, retryRezkuInboundEmail } from "@/lib/rezku-inbound-handler";
import { verifyRezkuWebhook } from "@/lib/rezku-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = rezkuInboundGet;

export async function POST(request: Request) {
  const apiKeyConfigured = Boolean(process.env.RESEND_API_KEY?.trim());
  const webhookSecretConfigured = Boolean(process.env.RESEND_WEBHOOK_SECRET?.trim());
  if (!apiKeyConfigured || !webhookSecretConfigured) {
    return Response.json({ error: "Resend inbound email is not configured." }, { status: 503 });
  }

  const id = request.headers.get("svix-id") || "";
  const timestamp = request.headers.get("svix-timestamp") || "";
  const signature = request.headers.get("svix-signature") || "";
  if (!id || !timestamp || !signature) {
    return Response.json({ error: "Missing webhook signature headers." }, { status: 400 });
  }

  const payload = await request.text();
  let verified;
  try {
    verified = verifyRezkuWebhook({ payload, id, timestamp, signature });
  } catch (error) {
    console.error("[rezku/inbound] invalid webhook", {
      webhookId: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "Invalid webhook signature or payload." }, { status: 400 });
  }

  if (verified.eventType !== "email.received") {
    return Response.json({ ignored: true, reason: "Not an inbound email event." });
  }

  // Acknowledge Resend quickly, but carry only the durable email ID into the
  // post-response task. The hourly repair cron independently reconciles the
  // Resend receiving inbox, so a killed background task cannot lose the email.
  after(async () => {
    try {
      const result = await retryRezkuInboundEmail(
        verified.emailId,
        `Resend inbound ${verified.emailId}`,
      );
      if (result.statusCode >= 400) {
        console.error("[rezku/inbound] background processing returned an error", {
          webhookId: verified.webhookId,
          emailId: verified.emailId,
          status: result.statusCode,
          payload: result.payload,
        });
      }
    } catch (error) {
      console.error("[rezku/inbound] background processing failed", {
        webhookId: verified.webhookId,
        emailId: verified.emailId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return Response.json({ accepted: true, emailId: verified.emailId });
}
