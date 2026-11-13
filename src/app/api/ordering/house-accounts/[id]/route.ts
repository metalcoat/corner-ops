import { isoJson } from "@/lib/timestamp-values";
import { apiError, unauthorized } from "@/lib/http";
import { canManagePos, orderingActor } from "@/lib/ordering-route-auth";
import { HouseAccountError, houseAccountDetail, houseAccountReceiptPrinters, houseAccountStatement, printHouseAccountStatement } from "@/lib/ordering-house-accounts";

export const runtime = "nodejs";

/** POS Tabs: any signed-in employee can look up what a customer owes, every charge and payment, or the statement. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const { id } = await context.params, params = new URL(request.url).searchParams;
    if (params.get("statement") === "1") {
      const statement = await houseAccountStatement({ id, from: params.get("from"), to: params.get("to") });
      return statement ? isoJson(statement) : isoJson({ error: "House account not found." }, { status: 404 });
    }
    const detail = await houseAccountDetail(id);
    if (!detail) return isoJson({ error: "House account not found." }, { status: 404 });
    // Notes are for managers.
    return isoJson({ ...detail, account: { ...detail.account, notes: canManagePos(actor) ? detail.account.notes : "" }, printers: await houseAccountReceiptPrinters() });
  } catch (error) {
    return apiError(error);
  }
}

/** Prints the statement on a receipt printer for the customer at the counter. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    const { id } = await context.params, body = await request.json() as Record<string, unknown>;
    if (body.action !== "print_statement") return isoJson({ error: "Unknown action." }, { status: 400 });
    return isoJson(await printHouseAccountStatement({ id, from: body.from ? String(body.from) : null, to: body.to ? String(body.to) : null, printerId: String(body.printerId || ""), actor }));
  } catch (error) {
    if (error instanceof HouseAccountError) return isoJson({ error: error.message }, { status: 409 });
    return apiError(error);
  }
}
