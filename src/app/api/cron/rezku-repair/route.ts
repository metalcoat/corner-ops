import { timingSafeEqual } from "node:crypto";
import { repairRezkuFeed } from "@/lib/rezku-feed-repair";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
  const supplied = request.headers.get("authorization") || "";
  if (!safeEqual(supplied, `Bearer ${secret}`)) {
    return Response.json({ error: "Unauthorized Rezku repair request." }, { status: 401 });
  }

  try {
    const result = await repairRezkuFeed("Vercel Rezku repair cron", { maxEmails: 2 });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    console.error("[cron/rezku-repair] repair failed", error);
    return Response.json({
      error: error instanceof Error ? error.message : String(error),
    }, { status: 500 });
  }
}
