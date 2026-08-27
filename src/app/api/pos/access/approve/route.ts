import { getSql } from "@/lib/db";
import { ensurePosNetworkSchema, validApprovalToken } from "@/lib/pos-network-access";

export const runtime = "nodejs";
export async function GET(request: Request) {
  await ensurePosNetworkSchema();
  const url = new URL(request.url), id = url.searchParams.get("id") || "", token = url.searchParams.get("token") || "", sql = getSql();
  const [row] = await sql`SELECT id,ip_address,status FROM pos_network_access_requests WHERE id=${id}`;
  if (!row || !validApprovalToken(id, String(row.ip_address), token)) return new Response("Invalid or expired approval link.", { status: 403 });
  await sql`UPDATE pos_network_access_requests SET status='approved',reviewed_at=NOW(),reviewed_by='email approval' WHERE id=${id}`;
  await sql`INSERT INTO pos_network_allowlist(ip_address,label,approved_request_id,approved_by) VALUES(${row.ip_address},'Approved POS network',${id},'email approval') ON CONFLICT(ip_address) DO UPDATE SET active=TRUE,approved_request_id=EXCLUDED.approved_request_id,approved_by=EXCLUDED.approved_by,approved_at=NOW()`;
  return new Response("POS network approved. The requesting device can refresh its access page now.", { headers: { "content-type": "text/plain; charset=utf-8" } });
}
