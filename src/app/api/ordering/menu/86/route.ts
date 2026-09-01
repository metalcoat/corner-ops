import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import { unauthorized } from "@/lib/http";
import { ensureOrderingMenuEditorSchema } from "@/lib/ordering-menu-editor-schema";
import { orderingActor } from "@/lib/ordering-route-auth";
import { ensureOrderingTimingSchema } from "@/lib/ordering-timing-schema";
import { ownerNotificationEmails, sendTransactionalEmail } from "@/lib/transactional-email";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const actor = await orderingActor("Corner Deli");
  if (!actor) return unauthorized();
  try {
    const body = await request.json() as { itemId?: unknown };
    const itemId = String(body.itemId || "");
    await Promise.all([ensureOrderingMenuEditorSchema(), ensureOrderingTimingSchema()]);
    const item = await withTransaction(async () => {
      const sql = getSql();
      const row = (await sql`SELECT id,name,available FROM ordering_menu_items WHERE id=${itemId} AND business='Corner Deli' FOR UPDATE`)[0];
      if (!row) throw new Error("Menu item was not found.");
      await sql`UPDATE ordering_menu_items SET available=FALSE,updated_at=NOW() WHERE id=${itemId}`;
      await sql`INSERT INTO ordering_menu_local_fields(business,entity_type,entity_id,field_name,updated_by) VALUES('Corner Deli','item',${itemId},'available',${actor.id}) ON CONFLICT(entity_type,entity_id,field_name) DO UPDATE SET updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      await sql`INSERT INTO ordering_operations_audit(id,business,actor_id,actor_role,action,target_type,target_id,reason,details) VALUES(${randomUUID()},'Corner Deli',${actor.id},${actor.role || "employee"},'menu_item_86ed','item',${itemId},'86ed from POS',${JSON.stringify({ itemName: row.name, actorName: actor.name, previouslyAvailable: row.available })}::jsonb)`;
      return { id: String(row.id), name: String(row.name) };
    });
    const email = await sendTransactionalEmail({
      to: [...new Set([...ownerNotificationEmails(), "crfrary@gmail.com"])],
      subject: `Corner Deli item 86'd: ${item.name}`,
      text: `${actor.name} (${actor.role || "employee"}) 86'd ${item.name} from the POS.\n\nThe item is now unavailable on POS, kiosk, online ordering, and AI phone ordering.`,
      idempotencyKey: `menu-86-${item.id}-${Date.now()}`,
    });
    return Response.json({ item, emailSent: email.sent > 0, emailFailures: email.failures }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The item could not be 86'd." }, { status: 400 });
  }
}
