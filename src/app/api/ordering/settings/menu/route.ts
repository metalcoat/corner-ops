import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";

const roles = new Set(["Owner", "Co-Owner", "Manager"]);
async function manager() {
  const session = await getSession();
  return session && roles.has(session.role) && session.businesses.includes("Corner Deli") ? session : null;
}

export async function GET() {
  const session = await manager();
  if (!session) return NextResponse.json({ error: "Manager access required." }, { status: 403 });
  await ensureOrderingMenuOverrideSchema();
  const sql = getSql();
  const [categories, items, modifiers] = await Promise.all([
    sql`SELECT c.id,c.name imported_name,c.display_name imported_display_name,c.parent_id imported_parent_id,c.sort_order imported_sort_order,o.display_name,o.parent_id,o.parent_id_overridden,o.sort_order,o.visible FROM ordering_menu_categories c LEFT JOIN ordering_category_overrides o ON o.category_id=c.id WHERE c.business='Corner Deli' ORDER BY COALESCE(o.sort_order,c.sort_order),c.name`,
    sql`SELECT i.id,i.name imported_name,i.category_id imported_category_id,i.sort_order imported_sort_order,o.display_name,o.category_id,o.sort_order,o.visible FROM ordering_menu_items i LEFT JOIN ordering_item_overrides o ON o.item_id=i.id WHERE i.business='Corner Deli' ORDER BY i.name`,
    sql`SELECT link.item_id,i.name item_name,g.id group_id,g.name group_name,p.context,p.parent_group_id,p.parent_option_ids,p.sort_order FROM ordering_menu_item_modifier_groups link JOIN ordering_menu_items i ON i.id=link.item_id JOIN ordering_modifier_groups g ON g.id=link.group_id LEFT JOIN ordering_modifier_presentation_overrides p ON p.item_id=link.item_id AND p.group_id=link.group_id WHERE i.business='Corner Deli' ORDER BY i.name,COALESCE(p.sort_order,link.sort_order),g.name`,
  ]);
  return NextResponse.json({ categories, items, modifiers });
}

export async function PATCH(request: Request) {
  const session = await manager();
  if (!session) return NextResponse.json({ error: "Manager access required." }, { status: 403 });
  await ensureOrderingMenuOverrideSchema();
  const body = await request.json() as { targetType?: string; targetId?: string; itemId?: string; field?: string; value?: unknown; reset?: boolean };
  const targetType = String(body.targetType || ""); const targetId = String(body.targetId || ""); const field = String(body.field || "");
  const sql = getSql();
  let previous: unknown = null;
  try {
    if (targetType === "category") {
      const owned = await sql`SELECT id FROM ordering_menu_categories WHERE id=${targetId} AND business='Corner Deli'`; if (!owned.length) throw new Error("Category not found.");
      const row = (await sql`SELECT * FROM ordering_category_overrides WHERE category_id=${targetId}`)[0] || {}; previous = row[field];
      if (field === "display_name") await sql`INSERT INTO ordering_category_overrides(category_id,display_name,updated_by) VALUES(${targetId},${body.reset ? null : String(body.value || "").trim()},${session.email}) ON CONFLICT(category_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      else if (field === "parent_id") {
        const parentId = body.reset ? null : String(body.value || "") || null;
        if (parentId) { const validParent = await sql`SELECT id FROM ordering_menu_categories WHERE id=${parentId} AND business='Corner Deli' AND id<>${targetId}`; if (!validParent.length) throw new Error("Parent category not found."); }
        await sql`INSERT INTO ordering_category_overrides(category_id,parent_id,parent_id_overridden,updated_by) VALUES(${targetId},${parentId},${!body.reset},${session.email}) ON CONFLICT(category_id) DO UPDATE SET parent_id=EXCLUDED.parent_id,parent_id_overridden=EXCLUDED.parent_id_overridden,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      }
      else if (field === "sort_order") await sql`INSERT INTO ordering_category_overrides(category_id,sort_order,updated_by) VALUES(${targetId},${body.reset ? null : Number(body.value)},${session.email}) ON CONFLICT(category_id) DO UPDATE SET sort_order=EXCLUDED.sort_order,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      else if (field === "visible") await sql`INSERT INTO ordering_category_overrides(category_id,visible,updated_by) VALUES(${targetId},${body.reset ? null : Boolean(body.value)},${session.email}) ON CONFLICT(category_id) DO UPDATE SET visible=EXCLUDED.visible,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      else throw new Error("Unsupported category field.");
    } else if (targetType === "item") {
      const owned = await sql`SELECT id FROM ordering_menu_items WHERE id=${targetId} AND business='Corner Deli'`; if (!owned.length) throw new Error("Item not found.");
      const row = (await sql`SELECT * FROM ordering_item_overrides WHERE item_id=${targetId}`)[0] || {}; previous = row[field];
      if (field === "display_name") await sql`INSERT INTO ordering_item_overrides(item_id,display_name,updated_by) VALUES(${targetId},${body.reset ? null : String(body.value || "").trim()},${session.email}) ON CONFLICT(item_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      else if (field === "category_id") {
        const categoryId = body.reset ? null : String(body.value || "") || null;
        if (categoryId) { const validCategory = await sql`SELECT id FROM ordering_menu_categories WHERE id=${categoryId} AND business='Corner Deli'`; if (!validCategory.length) throw new Error("Category not found."); }
        await sql`INSERT INTO ordering_item_overrides(item_id,category_id,updated_by) VALUES(${targetId},${categoryId},${session.email}) ON CONFLICT(item_id) DO UPDATE SET category_id=EXCLUDED.category_id,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      }
      else if (field === "sort_order") await sql`INSERT INTO ordering_item_overrides(item_id,sort_order,updated_by) VALUES(${targetId},${body.reset ? null : Number(body.value)},${session.email}) ON CONFLICT(item_id) DO UPDATE SET sort_order=EXCLUDED.sort_order,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      else if (field === "visible") await sql`INSERT INTO ordering_item_overrides(item_id,visible,updated_by) VALUES(${targetId},${body.reset ? null : Boolean(body.value)},${session.email}) ON CONFLICT(item_id) DO UPDATE SET visible=EXCLUDED.visible,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      else throw new Error("Unsupported item field.");
    } else if (targetType === "modifier") {
      const itemId=String(body.itemId||""); const owned=await sql`SELECT 1 FROM ordering_menu_item_modifier_groups l JOIN ordering_menu_items i ON i.id=l.item_id WHERE l.item_id=${itemId} AND l.group_id=${targetId} AND i.business='Corner Deli'`; if(!owned.length) throw new Error("Modifier relationship not found.");
      const row=(await sql`SELECT * FROM ordering_modifier_presentation_overrides WHERE item_id=${itemId} AND group_id=${targetId}`)[0]||{}; previous=row[field];
      if(field==="context") { const value=body.reset?null:String(body.value||""); if(value && !["ordinary","combo_trigger","dependent","hidden"].includes(value)) throw new Error("Invalid context."); await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,updated_by) VALUES(${itemId},${targetId},${value},${session.email}) ON CONFLICT(item_id,group_id) DO UPDATE SET context=EXCLUDED.context,updated_by=EXCLUDED.updated_by,updated_at=NOW()`; }
      else if(field==="sort_order") await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,sort_order,updated_by) VALUES(${itemId},${targetId},${body.reset?null:Number(body.value)},${session.email}) ON CONFLICT(item_id,group_id) DO UPDATE SET sort_order=EXCLUDED.sort_order,updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
      else throw new Error("Unsupported modifier field.");
    } else throw new Error("Unsupported override target.");
    await sql`INSERT INTO ordering_menu_override_audit(id,business,actor_id,target_type,target_id,field_name,previous_value,new_value) VALUES(${randomUUID()},'Corner Deli',${session.email},${targetType},${targetId},${field},${JSON.stringify(previous ?? null)}::jsonb,${JSON.stringify(body.reset ? null : body.value ?? null)}::jsonb)`;
    return NextResponse.json({ ok: true });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Could not update menu override." }, { status: 400 }); }
}
