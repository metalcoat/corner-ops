import { apiError, unauthorized } from "@/lib/http";
import { orderingActor } from "@/lib/ordering-route-auth";
import { addCustomerAddress } from "@/lib/ordering-customers";
import { getSql, withTransaction } from "@/lib/db";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    if (!(await orderingActor("Corner Deli"))) return unauthorized();
    const { id } = await params;
    const b = (await request.json()) as Record<string, unknown>;
    const addressId = await addCustomerAddress({
      business: "Corner Deli",
      customerId: id,
      label: String(b.label || ""),
      line1: String(b.line1 || ""),
      line2: String(b.line2 || ""),
      city: String(b.city || ""),
      state: String(b.state || ""),
      postalCode: String(b.postalCode || ""),
      standardizedAddress: String(b.standardizedAddress || ""),
      provider: String(b.provider || ""),
      providerReferenceId: String(b.providerReferenceId || ""),
      latitude: b.latitude == null ? null : Number(b.latitude),
      longitude: b.longitude == null ? null : Number(b.longitude),
      isPrimary: b.isPrimary === true,
    });
    return Response.json({ addressId }, { status: 201 });
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
    const { id: customerId } = await params,
      addressId = new URL(request.url).searchParams.get("addressId") || "";
    if (!addressId)
      return Response.json(
        { error: "Choose an address to remove." },
        { status: 400 },
      );
    const removed = await withTransaction(async () => {
      const sql = getSql(),
        row = (
          await sql`UPDATE ordering_customer_addresses SET active=FALSE,is_primary=FALSE,updated_at=NOW() WHERE id=${addressId} AND customer_id=${customerId} AND active=TRUE RETURNING id,is_primary`
        )[0];
      if (!row) return null;
      await sql`UPDATE ordering_customer_addresses SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_addresses WHERE customer_id=${customerId} AND active=TRUE ORDER BY last_used_at DESC NULLS LAST,created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM ordering_customer_addresses WHERE customer_id=${customerId} AND active=TRUE AND is_primary=TRUE)`;
      return row;
    });
    if (!removed)
      return Response.json(
        { error: "Address was not found." },
        { status: 404 },
      );
    return Response.json({ removed: true });
  } catch (error) {
    return apiError(error);
  }
}
export async function PATCH(request:Request,{params}:{params:Promise<{id:string}>}){
  try{
    if(!await orderingActor("Corner Deli"))return unauthorized();
    const {id:customerId}=await params,b=await request.json() as Record<string,unknown>,addressId=String(b.addressId||"");
    if(!addressId)return Response.json({error:"Choose an address to edit."},{status:400});
    const line1=String(b.line1||"").trim(),city=String(b.city||"").trim(),state=String(b.state||"").trim(),postalCode=String(b.postalCode||"").trim();
    if(!line1||!city||!state||!postalCode)return Response.json({error:"Verify the street, city, state, and ZIP code."},{status:400});
    const rows=await getSql()`UPDATE ordering_customer_addresses SET label=${String(b.label||"Delivery").trim()},line1=${line1},line2=${String(b.line2||"").trim()},city=${city},state=${state},postal_code=${postalCode},standardized_address=${String(b.standardizedAddress||"").trim()},provider=${String(b.provider||"")},provider_reference_id=${String(b.providerReferenceId||"")},latitude=${b.latitude==null?null:Number(b.latitude)},longitude=${b.longitude==null?null:Number(b.longitude)},last_used_at=NOW(),updated_at=NOW() WHERE id=${addressId} AND customer_id=${customerId} AND active=TRUE RETURNING id`;
    if(!rows[0])return Response.json({error:"Address was not found."},{status:404});
    return Response.json({addressId});
  }catch(error){return apiError(error)}
}
