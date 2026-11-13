import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { searchChargeableHouseAccounts } from "@/lib/ordering-house-accounts";

export const runtime = "nodejs";

/** POS checkout: find the house account to charge, by name or phone. Any signed-in staff member. */
export async function GET(request: Request) {
  try {
    if (!(await orderingActor("Corner Deli"))) return unauthorized();
    const query = (new URL(request.url).searchParams.get("q") || "").slice(0, 80);
    return isoJson({ accounts: await searchChargeableHouseAccounts(query) });
  } catch (error) {
    return apiError(error);
  }
}
