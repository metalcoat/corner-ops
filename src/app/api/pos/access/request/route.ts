import { createAccessRequest, approvalToken, requestIp } from "@/lib/pos-network-access";
import { cornerOpsBaseUrl, ownerNotificationEmails, sendTransactionalEmail } from "@/lib/transactional-email";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const ip = requestIp(request.headers);
    if (!ip) return Response.json({ error: "Your network address could not be determined." }, { status: 400 });
    const body = await request.json().catch(() => ({})) as { note?: string };
    const row = await createAccessRequest(ip, String(body.note || ""));
    if (!row.shouldNotify) return Response.json({ requested: true, alreadyPending: true });
    const token = approvalToken(String(row.id), ip);
    const approveUrl = `${cornerOpsBaseUrl()}/api/pos/access/approve?id=${encodeURIComponent(String(row.id))}&token=${encodeURIComponent(token)}`;
    const email = await sendTransactionalEmail({
      to: ownerNotificationEmails(),
      subject: `POS access request from ${ip}`,
      text: `A device at ${ip} requested access to the Corner Deli POS.\n\nNote: ${String(body.note || "Not provided")}\n\nApprove this IP: ${approveUrl}\n\nOnly approve if you recognize this device or location.`,
      idempotencyKey: `pos-ip-${row.id}`,
    });
    if (!email.sent) return Response.json({ error: "The request was saved, but the approval email could not be sent." }, { status: 503 });
    return Response.json({ requested: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Access could not be requested." }, { status: 500 });
  }
}
