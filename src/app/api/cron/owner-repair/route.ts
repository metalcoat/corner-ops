import { createHash, timingSafeEqual } from "node:crypto";
import { repairRezkuFeed } from "@/lib/rezku-feed-repair";
import { syncSquareConnection } from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TOKEN_HASH = "1b8288ee42dd675ac4eabea656e0a98e642bb330e40193aa14aa378ead4ea254";

function validToken(value: string) {
  const digest = createHash("sha256").update(value).digest("hex");
  const left = Buffer.from(digest);
  const right = Buffer.from(TOKEN_HASH);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!validToken(url.searchParams.get("token") || "")) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const actor = (process.env.APP_EMAIL || "crfrary@gmail.com").trim().toLowerCase();
  const rezku = await repairRezkuFeed(actor);
  const square = await syncSquareConnection();
  return Response.json({ repaired: true, rezku, square });
}
