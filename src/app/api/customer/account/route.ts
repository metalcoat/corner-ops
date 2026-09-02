import { readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { ensureOrderingLoyaltySchema } from "@/lib/ordering-loyalty-schema";
import { loyaltyHistory, loyaltyStatus } from "@/lib/ordering-loyalty";
import { getSql } from "@/lib/db";
import { addCustomerAddress } from "@/lib/ordering-customers";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const session = readCustomerOrderingSession(request);
  if (!session?.customerId || !session.authenticatedAt)
    return Response.json({ error: "Sign in required." }, { status: 401 });
  await ensureOrderingLoyaltySchema();
  const sql = getSql();
  const [customer] =
    await sql`SELECT id,display_name,first_name,last_name,email FROM ordering_customers WHERE id=${session.customerId} AND active=TRUE`;
  if (!customer)
    return Response.json({ error: "Account not found." }, { status: 404 });
  const range = new URL(request.url).searchParams.get("range") || "180";
  const days = range === "all" ? null : Math.max(1, Math.min(3650, Number(range) || 180));
  const cutoff = days ? new Date(Date.now() - days * 86_400_000).toISOString() : null;
  const [programs, history, orders, phones, addresses] = await Promise.all([
    loyaltyStatus(session.customerId),
    loyaltyHistory(session.customerId, 20),
    sql`
      SELECT orders.id,orders.display_number,orders.status,orders.payment_status,
        orders.service_type,orders.total_cents,orders.created_at,
        COALESCE(jsonb_agg(jsonb_build_object(
          'id',line.id,'name',line.item_name_snapshot,'variant',line.variant_name_snapshot,
          'quantity',line.quantity,'lineTotalCents',line.line_total_cents,
          'modifiers',COALESCE((
            SELECT jsonb_agg(modifier.option_name_snapshot ORDER BY modifier.created_at,modifier.id)
            FROM ordering_order_item_modifiers modifier
            WHERE modifier.order_item_id=line.id AND modifier.selection_state IN ('selected','extra')
          ),'[]'::jsonb)
        ) ORDER BY line.sort_order,line.created_at,line.id) FILTER (WHERE line.id IS NOT NULL),'[]'::jsonb) items
      FROM ordering_orders orders
      LEFT JOIN ordering_order_items line ON line.order_id=orders.id
      WHERE orders.customer_id=${session.customerId}
        AND (${cutoff}::timestamptz IS NULL OR orders.created_at >= ${cutoff}::timestamptz)
      GROUP BY orders.id
      ORDER BY orders.created_at DESC
      LIMIT 200
    `,
    sql`SELECT id,label,display_phone,is_primary FROM ordering_customer_phones WHERE customer_id=${session.customerId} ORDER BY is_primary DESC,created_at`,
    sql`SELECT id,label,line1,line2,city,state,postal_code,is_primary FROM ordering_customer_addresses WHERE customer_id=${session.customerId} AND active=TRUE ORDER BY is_primary DESC,last_used_at DESC NULLS LAST,created_at`,
  ]);
  return Response.json({ customer, programs, history, orders, phones, addresses, paymentMethods: [], paymentProvider: "mx" });
}

export async function PATCH(request: Request) {
  try {
    const session = readCustomerOrderingSession(request);
    if (!session?.customerId || !session.authenticatedAt) return Response.json({ error: "Sign in required." }, { status: 401 });
    const body = await request.json() as Record<string, unknown>, sql = getSql(), action = String(body.action || "profile");
    if (action === "profile") {
      const firstName = String(body.firstName || "").trim(), lastName = String(body.lastName || "").trim();
      if (!firstName && !lastName) throw new Error("Enter at least a first or last name.");
      await sql`UPDATE ordering_customers SET first_name=${firstName},last_name=${lastName},display_name=${`${firstName} ${lastName}`.trim()},updated_at=NOW() WHERE id=${session.customerId} AND active=TRUE`;
    } else if (action === "addAddress") {
      await addCustomerAddress({ business: "Corner Deli", customerId: session.customerId, label: String(body.label || "Home"), line1: String(body.line1 || ""), line2: String(body.line2 || ""), city: String(body.city || ""), state: String(body.state || ""), postalCode: String(body.postalCode || ""), isPrimary: Boolean(body.isPrimary) });
    } else if (action === "removeAddress") {
      await sql`UPDATE ordering_customer_addresses SET active=FALSE,is_primary=FALSE,updated_at=NOW() WHERE id=${String(body.addressId || "")} AND customer_id=${session.customerId}`;
      await sql`UPDATE ordering_customer_addresses SET is_primary=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM ordering_customer_addresses WHERE customer_id=${session.customerId} AND active=TRUE ORDER BY last_used_at DESC NULLS LAST,created_at LIMIT 1) AND NOT EXISTS(SELECT 1 FROM ordering_customer_addresses WHERE customer_id=${session.customerId} AND active=TRUE AND is_primary=TRUE)`;
    } else throw new Error("Unknown account update.");
    return Response.json({ updated: true });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Account could not be updated." }, { status: 400 }); }
}
