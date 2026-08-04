import { rezkuInboundGet, rezkuInboundPost } from "@/lib/rezku-inbound-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = rezkuInboundGet;
export const POST = rezkuInboundPost;
