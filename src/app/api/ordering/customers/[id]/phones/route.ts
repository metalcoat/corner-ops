import { apiError, unauthorized } from "@/lib/http";
import { addCustomerPhone } from "@/lib/ordering-customers";
import { orderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";
import { getSql, withTransaction } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await orderingActor("Corner Deli"))) return unauthorized();
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const result = await addCustomerPhone({
      business: "Corner Deli",
      customerId: id,
      phone: String(body.phone || ""),
      label: String(body.label || "Mobile"),
      isPrimary: body.isPrimary === true,
      allowShared: body.allowShared === true,
    });
    return Response.json(result, { status: result.duplicate ? 409 : 201 });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const actor = await orderingActor("Corner Deli");
    if (!actor) return unauthorized();
    if (!canManagePos(actor))
      return Response.json(
        { error: "Manager or owner authorization is required." },
        { status: 403 },
      );
    const { id: customerId } = await params,
      phoneId = new URL(request.url).searchParams.get("phoneId") || "";
    if (!phoneId)
      return Response.json(
        { error: "Choose a phone number to remove." },
        { status: 400 },
      );
    const removed = await withTransaction(async () => {
      const sql = getSql(),
        row = (
          await sql`DELETE FROM ordering_customer_phones WHERE id=${phoneId} AND customer_id=${customerId} RETURNING id,is_primary`
        )[0];
      if (!row) return null;
      if (row.is_primary)
        await sql`UPDATE ordering_customer_phones SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_phones WHERE customer_id=${customerId} ORDER BY last_used_at DESC NULLS LAST,created_at LIMIT 1)`;
      return row;
    });
    if (!removed)
      return Response.json(
        { error: "Phone number was not found." },
        { status: 404 },
      );
    return Response.json({ removed: true });
  } catch (error) {
    return apiError(error);
  }
}
