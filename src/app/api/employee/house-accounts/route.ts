import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { houseAccountManager } from "@/lib/house-account-access";
import { HouseAccountError, houseAccountReceiptPrinters, listHouseAccounts, saveHouseAccount } from "@/lib/ordering-house-accounts";

export const runtime = "nodejs";

/** Manager portal: every house account with its balance. */
export async function GET(request: Request) {
  try {
    if (!(await houseAccountManager())) return isoJson({ error: "Manager access required." }, { status: 403 });
    const params = new URL(request.url).searchParams;
    const [accounts, printers] = await Promise.all([listHouseAccounts({ includeClosed: params.get("closed") === "1", query: (params.get("q") || "").slice(0, 80) }), houseAccountReceiptPrinters()]);
    return isoJson({ accounts, printers });
  } catch (error) {
    return apiError(error);
  }
}

/** Opens a new house account. */
export async function POST(request: Request) {
  try {
    const actor = await houseAccountManager();
    if (!actor) return isoJson({ error: "Manager access required." }, { status: 403 });
    const body = await request.json() as Record<string, unknown>;
    return isoJson({ id: await saveHouseAccount({ name: body.name, phone: body.phone, email: body.email, notes: body.notes, creditLimitCents: body.creditLimitCents, actor }) }, { status: 201 });
  } catch (error) {
    if (error instanceof HouseAccountError) return isoJson({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
