import { apiError, unauthorized } from "@/lib/http";
import { addCustomerPhone } from "@/lib/ordering-customers";
import { orderingActor } from "@/lib/ordering-route-auth";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!await orderingActor("Corner Deli")) return unauthorized();
    const { id } = await params;
    const body = await request.json() as Record<string, unknown>;
    const result = await addCustomerPhone({
      business: "Corner Deli",
      customerId: id,
      phone: String(body.phone || ""),
      label: String(body.label || "Mobile"),
      isPrimary: body.isPrimary === true,
      allowShared: body.allowShared === true,
    });
    return Response.json(result, { status: result.duplicate ? 409 : 201 });
  } catch (error) { return apiError(error); }
}
