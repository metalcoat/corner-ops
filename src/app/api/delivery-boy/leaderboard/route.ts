import { deliveryLeaderboard } from "@/lib/delivery-boy/server";
export const runtime = "nodejs";
export async function GET() {
  try {
    return Response.json({ leaders: await deliveryLeaderboard() });
  } catch {
    return Response.json({ leaders: [] });
  }
}
