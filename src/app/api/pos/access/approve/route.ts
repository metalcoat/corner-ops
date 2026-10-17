import { getSql } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { ensurePosNetworkSchema, validApprovalToken } from "@/lib/pos-network-access";
import { approvalRequestOpen, escapeHtml } from "@/lib/pos-access-guard";

export const runtime = "nodejs";

function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.6rem 1.2rem;margin:.25rem .5rem .25rem 0;border-radius:.4rem;border:1px solid #888;cursor:pointer}.approve{background:#14532d;color:#fff;border-color:#14532d}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

async function openRequest(id: string, token: string) {
  await ensurePosNetworkSchema();
  if (!/^[0-9a-f-]{36}$/i.test(id) || !token) return null;
  const [row] = await getSql()`SELECT id,ip_address,requester_note,status,requested_at FROM pos_network_access_requests WHERE id=${id}`;
  if (!row || !validApprovalToken(id, String(row.ip_address), token)) return null;
  return row;
}

const unavailable = () => page("Link no longer valid", "<p>This approval link is invalid, expired (links last 24 hours), or the request was already reviewed. Ask the device to request access again.</p>", 403);

// GET only shows a confirmation; email link scanners must never approve.
export async function GET(request: Request) {
  const url = new URL(request.url), id = url.searchParams.get("id") || "", token = url.searchParams.get("token") || "";
  const row = await openRequest(id, token);
  if (!row || !approvalRequestOpen(row)) return unavailable();
  return page(
    "Approve POS network?",
    `<p>A device at <strong>${escapeHtml(String(row.ip_address))}</strong> asked for access to the Corner Deli POS.</p><p>Note: ${escapeHtml(String(row.requester_note || "Not provided"))}</p><p>Only approve if you recognize this device or location.</p><form method="post"><input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="token" value="${escapeHtml(token)}"><button class="approve" name="decision" value="approve">Approve this network</button><button name="decision" value="deny">Deny</button></form>`,
  );
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const id = String(form?.get("id") || ""), token = String(form?.get("token") || ""), decision = String(form?.get("decision") || "");
  const row = await openRequest(id, token);
  if (!row || !approvalRequestOpen(row)) return unavailable();
  const session = await getSession().catch(() => null);
  const reviewer = session && (session.role === "Owner" || session.role === "Co-Owner") ? `email approval (${session.email})` : "email approval";
  const sql = getSql();
  if (decision === "deny") {
    await sql`UPDATE pos_network_access_requests SET status='denied',reviewed_at=NOW(),reviewed_by=${reviewer} WHERE id=${id} AND status='pending'`;
    return page("Request denied", "<p>The POS network request was denied.</p>");
  }
  if (decision !== "approve") return unavailable();
  // Conditional update so a request can be approved once, only while pending and unexpired.
  const [approved] = await sql`UPDATE pos_network_access_requests SET status='approved',reviewed_at=NOW(),reviewed_by=${reviewer} WHERE id=${id} AND status='pending' AND requested_at > NOW() - INTERVAL '24 hours' RETURNING ip_address`;
  if (!approved) return unavailable();
  await sql`INSERT INTO pos_network_allowlist(ip_address,label,approved_request_id,approved_by) VALUES(${approved.ip_address},'Approved POS network',${id},${reviewer}) ON CONFLICT(ip_address) DO UPDATE SET active=TRUE,approved_request_id=EXCLUDED.approved_request_id,approved_by=EXCLUDED.approved_by,approved_at=NOW()`;
  return page("POS network approved", "<p>The requesting device can refresh its access page now.</p>");
}
