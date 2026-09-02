import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { createCustomer, findCustomers, updateCustomerName } from "@/lib/ordering-customers";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    if (!await orderingActor("Corner Deli")) return unauthorized();
    const q = new URL(request.url).searchParams.get("q") || "";
    return Response.json({ customers: await findCustomers("Corner Deli", q) });
  } catch (error) { return apiError(error); }
}
export async function POST(request: Request) {
  try {
    if (!await orderingActor("Corner Deli")) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const result = await createCustomer({ business:"Corner Deli",firstName:String(body.firstName||""),lastName:String(body.lastName||""),phone:String(body.phone||""),email:String(body.email||""),notes:String(body.notes||"") });
    return Response.json(result, { status: result.duplicate ? 409 : 201 });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try {
    if (!await orderingActor("Corner Deli")) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    const customer = await updateCustomerName({
      business: "Corner Deli",
      customerId: String(body.customerId || ""),
      firstName: String(body.firstName || ""),
      lastName: String(body.lastName || ""),
    });
    return Response.json({ customer });
  } catch (error) { return apiError(error); }
}
