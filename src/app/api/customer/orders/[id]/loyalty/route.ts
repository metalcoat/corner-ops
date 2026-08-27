import { readCustomerOrderingSession } from "@/lib/customer-ordering-session";
import { getSql } from "@/lib/db";
import { requestLoyaltyRedemption } from "@/lib/ordering-loyalty";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = readCustomerOrderingSession(request);
  if (!session?.customerId || !session.authenticatedAt)
    return Response.json({ error: "Sign in to use a loyalty reward." }, { status: 401 });
  try {
    const { id: orderId } = await context.params;
    const body = (await request.json()) as { programId?: string };
    const sql = getSql();
    const [order] = await sql`
      SELECT id FROM ordering_orders
      WHERE id=${orderId} AND customer_id=${session.customerId} AND business='Corner Deli' AND status='draft'
    `;
    if (!order) throw new Error("This checkout is no longer available for loyalty redemption.");
    const [program] = await sql`
      SELECT id,reward_rule FROM ordering_loyalty_programs
      WHERE id=${String(body.programId || "")} AND business='Corner Deli' AND active=TRUE
    `;
    if (!program) throw new Error("That loyalty reward is unavailable.");
    const rule = program.reward_rule as { variantIds?: string[]; itemIds?: string[]; categoryIds?: string[] };
    const [line] = await sql`
      SELECT line.id
      FROM ordering_order_items line
      JOIN ordering_menu_items item ON item.id=line.item_id
      WHERE line.order_id=${orderId}
        AND (line.variant_id=ANY(${rule.variantIds || []}::uuid[])
          OR line.item_id=ANY(${rule.itemIds || []}::uuid[])
          OR item.category_id=ANY(${rule.categoryIds || []}::uuid[]))
      ORDER BY line.sort_order,line.created_at,line.id LIMIT 1
    `;
    if (!line) throw new Error("Add an eligible Jumbo Thin pizza before using this reward.");
    const applications = await requestLoyaltyRedemption({
      orderId,
      orderItemId: String(line.id),
      programId: String(program.id),
      actor: { id: session.customerId, name: "Online customer", type: "web" },
    });
    const [updated] = await sql`
      SELECT discount_cents,total_cents,amount_due_cents FROM ordering_orders WHERE id=${orderId}
    `;
    return Response.json({ applications, order: updated });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Reward could not be applied." }, { status: 409 });
  }
}
