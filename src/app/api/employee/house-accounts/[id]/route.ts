import { isoJson } from "@/lib/timestamp-values";
import { apiError } from "@/lib/http";
import { houseAccountManager } from "@/lib/house-account-access";
import {
  HouseAccountError, houseAccountDetail, houseAccountStatement, printHouseAccountStatement, recordHouseAccountAdjustment, recordHouseAccountPayment, saveHouseAccount, setHouseAccountStatus,
} from "@/lib/ordering-house-accounts";

export const runtime = "nodejs";

/** One account's activity, or (?statement=1&from=&to=) its statement. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (!(await houseAccountManager())) return isoJson({ error: "Manager access required." }, { status: 403 });
    const { id } = await context.params, params = new URL(request.url).searchParams;
    const result = params.get("statement") === "1" ? await houseAccountStatement({ id, from: params.get("from"), to: params.get("to") }) : await houseAccountDetail(id);
    if (!result) return isoJson({ error: "House account not found." }, { status: 404 });
    return isoJson(result);
  } catch (error) {
    return apiError(error);
  }
}

/** Edit, put on hold / close / reopen, record a payment or an adjustment, or print the statement. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await houseAccountManager();
    if (!actor) return isoJson({ error: "Manager access required." }, { status: 403 });
    const { id } = await context.params, body = await request.json() as Record<string, unknown>;
    if (body.action === "update") return isoJson({ id: await saveHouseAccount({ id, name: body.name, phone: body.phone, email: body.email, notes: body.notes, creditLimitCents: body.creditLimitCents, actor }) });
    if (body.action === "status") return isoJson(await setHouseAccountStatus({ id, status: body.status, actor }));
    if (body.action === "payment") return isoJson(await recordHouseAccountPayment({ id, amountCents: body.amountCents, method: body.method, reference: body.reference, note: body.note, actor }), { status: 201 });
    if (body.action === "adjustment") return isoJson(await recordHouseAccountAdjustment({ id, amountCents: body.amountCents, direction: body.direction, reason: body.reason, actor }), { status: 201 });
    if (body.action === "print_statement") return isoJson(await printHouseAccountStatement({ id, from: body.from ? String(body.from) : null, to: body.to ? String(body.to) : null, printerId: String(body.printerId || ""), actor }));
    return isoJson({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (error instanceof HouseAccountError) return isoJson({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
