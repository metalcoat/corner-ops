import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getSql } from "@/lib/db";

export const POS_NETWORK_COOKIE = "corner_ops_pos_network";

export function requestIp(headers: Headers): string {
  return (headers.get("x-real-ip") || headers.get("cf-connecting-ip") || headers.get("x-forwarded-for")?.split(",")[0] || "")
    .trim().replace(/^::ffff:/, "").slice(0, 80);
}

export function localIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("SESSION_SECRET is required.");
  return value;
}

export function approvalToken(requestId: string, ip: string): string {
  return createHmac("sha256", secret()).update(`pos-ip-approval:${requestId}:${ip}`).digest("base64url");
}

export function validApprovalToken(requestId: string, ip: string, supplied: string): boolean {
  const expected = approvalToken(requestId, ip), left = Buffer.from(expected), right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function networkCookie(ip: string): string {
  const expiresAt = Date.now() + 30 * 86_400_000;
  const encoded = Buffer.from(JSON.stringify({ ip, expiresAt })).toString("base64url");
  const signature = createHmac("sha256", secret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export async function ensurePosNetworkSchema() {
  const sql = getSql();
  await sql`CREATE TABLE IF NOT EXISTS pos_network_access_requests(id UUID PRIMARY KEY,ip_address TEXT NOT NULL,requester_note TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN('pending','approved','denied')),requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),reviewed_at TIMESTAMPTZ,reviewed_by TEXT NOT NULL DEFAULT '')`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS pos_network_pending_ip_idx ON pos_network_access_requests(ip_address) WHERE status='pending'`;
  await sql`CREATE TABLE IF NOT EXISTS pos_network_allowlist(ip_address TEXT PRIMARY KEY,label TEXT NOT NULL DEFAULT '',approved_request_id UUID REFERENCES pos_network_access_requests(id),approved_by TEXT NOT NULL,approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),active BOOLEAN NOT NULL DEFAULT TRUE)`;
}

export async function ipAllowed(ip: string): Promise<boolean> {
  if (localIp(ip)) return true;
  await ensurePosNetworkSchema();
  const rows = await getSql()`SELECT 1 FROM pos_network_allowlist WHERE ip_address=${ip} AND active=TRUE`;
  return Boolean(rows[0]);
}

export async function createAccessRequest(ip: string, note: string): Promise<{id:string;ip_address:string;requested_at:string|Date;shouldNotify:boolean}> {
  await ensurePosNetworkSchema();
  const sql = getSql(), id = randomUUID();
  const [existing] = await sql`SELECT id,ip_address,requested_at FROM pos_network_access_requests WHERE ip_address=${ip} AND status='pending'`;
  if (existing && Date.now() - new Date(existing.requested_at).getTime() < 10 * 60_000)
    return { id:String(existing.id),ip_address:String(existing.ip_address),requested_at:existing.requested_at,shouldNotify:false };
  const rows = await sql`INSERT INTO pos_network_access_requests(id,ip_address,requester_note,status) VALUES(${id},${ip},${note.trim().slice(0,200)},'pending') ON CONFLICT(ip_address) WHERE status='pending' DO UPDATE SET requester_note=EXCLUDED.requester_note,requested_at=NOW() RETURNING id,ip_address,requested_at`;
  return { id:String(rows[0].id),ip_address:String(rows[0].ip_address),requested_at:rows[0].requested_at,shouldNotify:true };
}
