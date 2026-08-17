import { after } from "next/server";
import { rezkuInboundGet, rezkuInboundPost } from "@/lib/rezku-inbound-handler";
import { tryOwnerRepairTrigger } from "@/lib/owner-repair-trigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = rezkuInboundGet;

export async function POST(request: Request) {
  const queuedRequest = request.clone();

  // Resend needs a fast 2xx acknowledgement. The actual Rezku workbook downloads
  // and imports can take much longer, so finish them after the response is sent.
  after(async () => {
    try {
      const ownerRepairRequest = queuedRequest.clone();
      if (await tryOwnerRepairTrigger(ownerRepairRequest)) return;

      const response = await rezkuInboundPost(queuedRequest);
      if (!response.ok) {
        console.error("[rezku/inbound] background processing returned an error", {
          status: response.status,
          body: await response.text(),
        });
      }
    } catch (error) {
      console.error("[rezku/inbound] background processing failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return Response.json({ accepted: true });
}
