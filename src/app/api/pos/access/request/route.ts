import { isoJson } from "@/lib/timestamp-values";
import { createAccessRequest, approvalToken, requestIp } from "@/lib/pos-network-access";
import { cornerOpsBaseUrl, ownerNotificationEmails, sendTransactionalEmail } from "@/lib/transactional-email";
import { assertRateLimit, recordRateLimitFailure, type RateLimitPolicy } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/http";

// Each request (and owner email) counts against a per-IP and a global budget.
function requestPolicies(ip: string): RateLimitPolicy[] {
  return [
    { scope: "pos-access-request", discriminator: `ip:${ip}`, maxFailures: 5, windowSeconds: 60 * 60, blockSeconds: 60 * 60 },
    { scope: "pos-access-request", discriminator: "global", maxFailures: 30, windowSeconds: 60 * 60, blockSeconds: 30 * 60 },
  ];
}

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const ip = requestIp(request.headers);
    if (!ip) return isoJson({ error: "Your network address could not be determined." }, { status: 400 });
    const policies = requestPolicies(ip);
    await assertRateLimit(policies);
    await recordRateLimitFailure(policies);
    const body = await request.json().catch(() => ({})) as { note?: string };
    const row = await createAccessRequest(ip, String(body.note || ""));
    if (!row.shouldNotify) return isoJson({ requested: true, alreadyPending: true });
    const token = approvalToken(String(row.id), ip);
    const approveUrl = `${cornerOpsBaseUrl()}/api/pos/access/approve?id=${encodeURIComponent(String(row.id))}&token=${encodeURIComponent(token)}`;
    const email = await sendTransactionalEmail({
      to: ownerNotificationEmails(),
      subject: `POS access request from ${ip}`,
      text: `A device at ${ip} requested access to the Corner Deli POS.\n\nNote: ${String(body.note || "Not provided")}\n\nReview and approve this IP (link expires in 24 hours): ${approveUrl}\n\nOnly approve if you recognize this device or location.`,
      idempotencyKey: `pos-ip-${row.id}`,
    });
    if (!email.sent) return isoJson({ error: "The request was saved, but the approval email could not be sent." }, { status: 503 });
    return isoJson({ requested: true });
  } catch (error) {
    if (error instanceof RateLimitError)
      return isoJson({ error: "Too many access requests. Try again later." }, { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } });
    return isoJson({ error: error instanceof Error ? error.message : "Access could not be requested." }, { status: 500 });
  }
}
