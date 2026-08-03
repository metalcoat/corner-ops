import { processSquareWebhook, verifySquareWebhookSignature } from "@/lib/square-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-square-hmacsha256-signature") || "";
  if (!verifySquareWebhookSignature(rawBody, signature)) {
    return Response.json({ error: "Invalid Square webhook signature." }, { status: 403 });
  }
  try {
    return Response.json(await processSquareWebhook(rawBody));
  } catch (error) {
    console.error("Square webhook processing failed", error);
    return Response.json({ error: "Square webhook processing failed." }, { status: 500 });
  }
}
