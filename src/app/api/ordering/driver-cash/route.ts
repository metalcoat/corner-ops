import { driverActor } from "@/lib/ordering-driver-delivery";
import {
  driverCashDashboard,
  postDriverCashSettlement,
} from "@/lib/ordering-driver-cash";

export const runtime = "nodejs";
export async function GET() {
  try {
    const actor = await driverActor();
    if (!actor)
      return Response.json(
        { error: "Employee sign-in required." },
        { status: 401 },
      );
    return Response.json(await driverCashDashboard(actor));
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Driver cash-out could not be loaded.";
    return Response.json(
      { error: message },
      { status: message.includes("access") ? 403 : 400 },
    );
  }
}
export async function POST(request: Request) {
  try {
    const actor = await driverActor();
    if (!actor)
      return Response.json(
        { error: "Employee sign-in required." },
        { status: 401 },
      );
    const body = (await request.json()) as Record<string, unknown>;
    return Response.json(
      await postDriverCashSettlement(actor, {
        orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [],
        turnedInCashCents: Number(body.turnedInCashCents),
        businessDate: String(body.businessDate || ""),
      }),
      { status: 201 },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Driver cash-out could not be posted.";
    return Response.json(
      { error: message },
      { status: message.includes("access") ? 403 : 400 },
    );
  }
}
