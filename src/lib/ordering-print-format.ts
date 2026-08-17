import { getSql } from "@/lib/db";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";

export type PrintableModifier = { name: string; printOrder: number; header: boolean; print: boolean };
export type PrintableLine = { quantity: number; header: string; modifiers: PrintableModifier[] };

export function formatKitchenLines(lines: PrintableLine[]): string[] {
  const output: string[] = [];
  for (const line of lines) {
    const headers = line.modifiers.filter((modifier) => modifier.print && modifier.header).sort((a,b)=>a.printOrder-b.printOrder).map((modifier)=>modifier.name);
    output.push(`${line.quantity > 1 ? `${line.quantity}x ` : ""}${line.header}${headers.length ? ` - ${headers.join(" - ")}` : ""}`);
    for (const modifier of line.modifiers.filter((value) => value.print && !value.header).sort((a,b)=>a.printOrder-b.printOrder||a.name.localeCompare(b.name))) output.push(`  ${modifier.name.toUpperCase()}`);
  }
  return output;
}

export async function snapshotAndFormatOrder(orderId: string): Promise<string[]> {
  await ensureOrderingMenuOverrideSchema();
  const sql = getSql();
  await sql`
    UPDATE ordering_order_items line SET item_print_name_snapshot=COALESCE(
      (SELECT NULLIF(print_name,'') FROM ordering_item_variant_print_overrides WHERE variant_id=line.variant_id),
      (SELECT NULLIF(print_name,'') FROM ordering_item_overrides WHERE item_id=line.item_id),
      NULLIF(line.variant_name_snapshot,''),line.item_name_snapshot)
    WHERE line.order_id=${orderId}
  `;
  await sql`
    UPDATE ordering_order_item_modifiers modifier SET
      option_print_name_snapshot=COALESCE((SELECT NULLIF(print_name,'') FROM ordering_modifier_option_print_overrides WHERE option_id=modifier.option_id),modifier.option_name_snapshot),
      print_order_snapshot=COALESCE((SELECT print_order FROM ordering_modifier_option_print_overrides WHERE option_id=modifier.option_id),(SELECT print_order FROM ordering_modifier_presentation_overrides WHERE item_id=(SELECT item_id FROM ordering_order_items WHERE id=modifier.order_item_id) AND group_id=modifier.group_id),0),
      header_modifier_snapshot=COALESCE((SELECT header_modifier FROM ordering_modifier_presentation_overrides WHERE item_id=(SELECT item_id FROM ordering_order_items WHERE id=modifier.order_item_id) AND group_id=modifier.group_id),FALSE)
    WHERE modifier.order_item_id IN (SELECT id FROM ordering_order_items WHERE order_id=${orderId})
  `;
  const rows = await sql`SELECT id,quantity,COALESCE(NULLIF(item_print_name_snapshot,''),item_name_snapshot) header FROM ordering_order_items WHERE order_id=${orderId} ORDER BY sort_order,created_at,id`;
  const printable: PrintableLine[] = [];
  for (const row of rows) {
    const modifiers = await sql`SELECT COALESCE(NULLIF(option_print_name_snapshot,''),option_name_snapshot) name,print_order_snapshot,header_modifier_snapshot,print_on_ticket FROM ordering_order_item_modifiers WHERE order_item_id=${row.id}`;
    printable.push({ quantity:Number(row.quantity),header:String(row.header),modifiers:modifiers.map((modifier)=>({name:String(modifier.name),printOrder:Number(modifier.print_order_snapshot),header:Boolean(modifier.header_modifier_snapshot),print:Boolean(modifier.print_on_ticket)})) });
  }
  return formatKitchenLines(printable);
}
