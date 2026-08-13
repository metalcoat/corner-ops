import { getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { formatKitchenLines } from "@/lib/ordering-print-format";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !["Owner","Co-Owner","Manager"].includes(session.role) || !session.businesses.includes("Corner Deli")) return Response.json({error:"Manager access required."},{status:403});
  await ensureOrderingMenuOverrideSchema();
  const body = await request.json() as { itemId?: unknown; variantId?: unknown; modifierOptionIds?: unknown[] };
  const sql = getSql();
  const item = (await sql`SELECT COALESCE(NULLIF(variant_print.print_name,''),NULLIF(item_override.print_name,''),NULLIF(variant.name,''),menu.name) header FROM ordering_menu_items menu LEFT JOIN ordering_item_overrides item_override ON item_override.item_id=menu.id LEFT JOIN ordering_menu_item_variants variant ON variant.id=${body.variantId ? String(body.variantId) : null} AND variant.item_id=menu.id LEFT JOIN ordering_item_variant_print_overrides variant_print ON variant_print.variant_id=variant.id WHERE menu.id=${String(body.itemId || "")} AND menu.business='Corner Deli'`)[0];
  if (!item) return Response.json({error:"Menu item not found."},{status:404});
  const ids = (body.modifierOptionIds || []).map(String);
  const modifiers = ids.length ? await sql`SELECT COALESCE(NULLIF(option_print.print_name,''),option.name) name,COALESCE(option_print.print_order,presentation.print_order,0) print_order,COALESCE(presentation.header_modifier,FALSE) header FROM ordering_modifier_options option JOIN ordering_menu_item_modifier_groups link ON link.group_id=option.group_id AND link.item_id=${String(body.itemId || "")} LEFT JOIN ordering_modifier_option_print_overrides option_print ON option_print.option_id=option.id LEFT JOIN ordering_modifier_presentation_overrides presentation ON presentation.item_id=link.item_id AND presentation.group_id=link.group_id WHERE option.id=ANY(${ids}::uuid[])` : [];
  const lines = formatKitchenLines([{quantity:1,header:String(item.header),modifiers:modifiers.map((modifier)=>({name:String(modifier.name),printOrder:Number(modifier.print_order),header:Boolean(modifier.header),print:true}))}]);
  return Response.json({ lines, preview: lines.join("\n") });
}
