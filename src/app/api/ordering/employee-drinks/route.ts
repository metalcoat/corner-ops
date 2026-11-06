import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { employeeDrinkMenu, recordEmployeeDrinks, saveEmployeeDrinkCosts } from "@/lib/ordering-employee-drinks";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { getPosSession } from "@/lib/pos-auth";

export const runtime = "nodejs";
const business = "Corner Deli" as const;

export async function GET() {
  try {
    // Same as MEAL: a PIN sign-in is enough (clocked in or not).
    if (!(await getPosSession(false))) return unauthorized();
    return isoJson(await employeeDrinkMenu(business));
  } catch (error) { return apiError(error); }
}

/** A PIN employee buys their own drinks at the employee price. */
export async function POST(request: Request) {
  const session = await getPosSession(false);
  if (!session) return unauthorized();
  const actor = { id: session.employeeId, name: session.name, type: "employee" as const, role: session.posRole };
  try {
    const body = await request.json() as { lines?: unknown };
    return isoJson(await recordEmployeeDrinks({ business, lines: Array.isArray(body.lines) ? body.lines : [], actor }), { status: 201 });
  } catch (error) {
    return isoJson({ error: error instanceof Error ? error.message : "Employee drinks could not be rung up." }, { status: 400 });
  }
}

/** Manager: update today's costs. */
export async function PUT(request: Request) {
  try {
    const actor = await orderingActor(business);
    if (!actor) return unauthorized();
    if (!canManagePos(actor)) return isoJson({ error: "Manager or owner access is required." }, { status: 403 });
    const body = await request.json() as { sizes?: Array<{ key: unknown; costCents: unknown; depositCents: unknown }> };
    try { return isoJson(await saveEmployeeDrinkCosts(business, Array.isArray(body.sizes) ? body.sizes : [], actor)); }
    catch (error) { return isoJson({ error: error instanceof Error ? error.message : "Could not save." }, { status: 409 }); }
  } catch (error) { return apiError(error); }
}
