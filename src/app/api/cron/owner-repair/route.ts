import { createHash, timingSafeEqual } from "node:crypto";
import { repairRezkuFeed } from "@/lib/rezku-feed-repair";
import { syncSquareConnection } from "@/lib/integrations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TOKEN_HASH = "fb4fcf20582814ec56cc55c43d5af3841c6c7879f6d66be87b745b0866163db5";

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
