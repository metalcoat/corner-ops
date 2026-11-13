import { getSql } from "@/lib/db";
import { lineSnapshot, sameLine, type LineSnapshot, type SavedLine } from "@/lib/ordering-line-edit-rules";

/**
 * Lines of a reopened order the kitchen already has: the lines it had when it was reopened, plus the
 * replacement for any of those lines edited since (the kitchen gets that change as a CHANGED ticket).
 * Null when the order is not reopened for changes.
 */
export async function reopenedSentItemIds(order: { id?: unknown; status?: unknown; submitted_at?: unknown }): Promise<string[] | null> {
  if (!order.submitted_at || order.status !== "draft") return null;
  const sql = getSql();
  const reopen = (await sql`SELECT details,created_at FROM ordering_order_events WHERE order_id=${String(order.id)} AND event_type='order_reopened_for_additions' ORDER BY created_at DESC LIMIT 1`)[0];
  if (!reopen) return null;
  const edits = await sql`SELECT details->>'newItemId' new_item_id FROM ordering_order_events WHERE order_id=${String(order.id)} AND event_type='order_item_edited' AND created_at>=${reopen.created_at} AND (details->>'rootSent')::boolean`;
  return [...((reopen.details?.existingItemIds as string[] | undefined) || []).map(String), ...edits.map((row) => String(row.new_item_id))];
}

/** A line as stored, with the modifier and combo rows the snapshot and the item screen need. */
export async function loadSavedLine(itemId: string): Promise<SavedLine & { id: string; order_id: string; sort_order: number; custom_item: boolean; line_total_cents: number }> {
  const sql = getSql();
  const line = (await sql`SELECT * FROM ordering_order_items WHERE id=${itemId}`)[0];
  if (!line) throw new Error("Order item was not found.");
  const modifiers = await sql`SELECT group_id,option_id,group_name_snapshot,option_name_snapshot,option_print_name_snapshot,quantity,amount,selection_state,pizza_topping_portion,pizza_topping_amount,print_on_ticket FROM ordering_order_item_modifiers WHERE order_item_id=${itemId} ORDER BY created_at,id`;
  const combos = await sql`SELECT combo_id,group_id,option_id FROM ordering_order_item_combo_selections WHERE order_item_id=${itemId} ORDER BY created_at,id`;
  return { ...line, modifiers, combo_selections: combos } as never;
}

/**
 * For Send after a reopen: the CHANGED tickets owed to the kitchen, and the replacement lines that must
 * not print again as new items. A replacement that was itself edited or voided again is skipped here;
 * its later edit or its void covers it.
 */
export async function pendingLineEdits(orderId: string, since: unknown) {
  const sql = getSql();
  const events = await sql`SELECT details FROM ordering_order_events WHERE order_id=${orderId} AND event_type='order_item_edited' AND created_at>=${since as string} ORDER BY created_at,id`;
  const replacedAgain = new Set(events.map((event) => String(event.details.oldItemId)));
  const sentReplacementIds = events.filter((event) => event.details.rootSent).map((event) => String(event.details.newItemId));
  const changes: Array<{ before: LineSnapshot; after: LineSnapshot }> = [];
  for (const event of events) {
    const details = event.details as { newItemId: string; rootSent: boolean; before: LineSnapshot };
    if (!details.rootSent || replacedAgain.has(String(details.newItemId))) continue;
    const line = await loadSavedLine(String(details.newItemId));
    const after = lineSnapshot(line);
    // Voided since, or changed back to what the kitchen already has: nothing to tell it.
    if (after.quantity < 1 || sameLine(details.before, after)) continue;
    changes.push({ before: details.before, after });
  }
  return { sentReplacementIds, changes };
}
