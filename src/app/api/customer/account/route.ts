import { readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { ensureOrderingLoyaltySchema } from "@/lib/ordering-loyalty-schema";
import { loyaltyHistory, loyaltyStatus } from "@/lib/ordering-loyalty";
import { getSql } from "@/lib/db";
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
  const [programs, history, orders] = await Promise.all([
    loyaltyStatus(session.customerId),
    loyaltyHistory(session.customerId, 20),
    sql`SELECT id,display_number,status,payment_status,service_type,total_cents,created_at FROM ordering_orders WHERE customer_id=${session.customerId} ORDER BY created_at DESC LIMIT 25`,
  ]);
  return Response.json({ customer, programs, history, orders });
}
