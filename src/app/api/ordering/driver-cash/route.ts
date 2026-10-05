import { getSql } from "@/lib/db";
import { getPosSession } from "@/lib/pos-auth";
import { deliveryStaffing, driverActor, type DriverActor } from "@/lib/ordering-driver-delivery";
import {
  driverCashDashboard,
  postDriverCashSettlement,
} from "@/lib/ordering-driver-cash";

export const runtime = "nodejs";

/**
 * Cash-out is posted under the employee signed into this POS (PIN). The employee
 * app's sign-in still works for a driver settling from their own phone.
 */
async function cashOutActor(): Promise<DriverActor | null> {
  const pos = await getPosSession(true);
  if (!pos) return driverActor();
  const row = (await getSql()`SELECT active,role_group,position FROM employees WHERE id=${pos.employeeId} AND business='Corner Deli' LIMIT 1`)[0];
  if (!row?.active) return null;
  return {
    employeeId: pos.employeeId, business: "Corner Deli", name: pos.name, position: String(row.position || pos.position || ""),
    roleGroup: row.role_group, posRole: pos.posRole, deviceSessionId: "", expiresAt: pos.expiresAt,
    manager: pos.posRole === "manager" || pos.posRole === "owner", // Whoever took deliveries (a cashier on a short-staffed morning too) settles their own.
    driver: row.role_group === "Driver" || (await deliveryStaffing("Corner Deli")).anyoneCanDeliver,
  };
}
export async function GET() {
  try {
    const actor = await cashOutActor();
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
    const actor = await cashOutActor();
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
