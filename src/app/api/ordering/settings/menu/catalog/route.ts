import { NextResponse } from "next/server";
import { isAuthorizationResponse, orderingManagerActor } from "@/lib/ordering-route-auth";
import { getSql } from "@/lib/db";
import { ensureOrderingMenuEditorSchema } from "@/lib/ordering-menu-editor-schema";
import { menuDependencies, mutateMenu } from "@/lib/ordering-menu-editor";
import type { OrderingBusiness } from "@/lib/ordering-core";

async function authorize(request:Request){const business=(new URL(request.url).searchParams.get("business")||"Corner Deli") as OrderingBusiness;const session=await orderingManagerActor(business);return isAuthorizationResponse(session)?session:{session,business}}

export async function GET(request:Request){
  const auth=await authorize(request);if(auth instanceof Response)return auth;
  await ensureOrderingMenuEditorSchema();const sql=getSql(),business=auth.business;
  const [categories,items,variants,groups,options,links,sources,localFields]=await Promise.all([
    sql`SELECT id,name,display_name,sort_order,active,parent_id,presentation_only FROM ordering_menu_categories WHERE business=${business} ORDER BY sort_order,name`,
    sql`SELECT id,category_id,name,description,base_price_cents,taxable,available,active,sort_order FROM ordering_menu_items WHERE business=${business} ORDER BY category_id,sort_order,name`,
    sql`SELECT v.id,v.item_id,v.name,v.base_price_cents,v.default_variant,v.available,v.active,v.sort_order,COALESCE(p.print_name,v.name) print_name FROM ordering_menu_item_variants v JOIN ordering_menu_items i ON i.id=v.item_id LEFT JOIN ordering_item_variant_print_overrides p ON p.variant_id=v.id WHERE i.business=${business} ORDER BY v.item_id,v.sort_order,v.name`,
    sql`SELECT id,name,prompt,min_selections,max_selections,allow_option_quantity,active,sort_order FROM ordering_modifier_groups WHERE business=${business} ORDER BY sort_order,name`,
    sql`SELECT o.id,o.group_id,o.name,o.price_delta_cents,o.available,o.active,o.sort_order,COALESCE(p.print_name,o.name) print_name,p.print_order FROM ordering_modifier_options o JOIN ordering_modifier_groups g ON g.id=o.group_id LEFT JOIN ordering_modifier_option_print_overrides p ON p.option_id=o.id WHERE g.business=${business} ORDER BY o.group_id,o.sort_order,o.name`,
    sql`SELECT l.item_id,l.group_id,l.sort_order FROM ordering_menu_item_modifier_groups l JOIN ordering_menu_items i ON i.id=l.item_id WHERE i.business=${business} ORDER BY l.item_id,l.sort_order`,
    sql`SELECT entity_type,internal_id,source,source_id,source_payload FROM ordering_menu_source_map WHERE business=${business}`,
    sql`SELECT entity_type,entity_id,field_name FROM ordering_menu_local_fields WHERE business=${business}`,
  ]);
  return NextResponse.json({business,categories,items,variants,groups,options,links,sources,localFields});
}

export async function POST(request:Request){
  const auth=await authorize(request);if(auth instanceof Response)return auth;
  try{const body=await request.json();const result=body.action==="dependencies"?await menuDependencies(auth.business,body.entity,body.id):await mutateMenu({id:auth.session.id,business:auth.business},body);return NextResponse.json(result)}
  catch(error){const message=error instanceof Error?error.message:"Menu update failed.";return NextResponse.json({error:message},{status:/duplicate key|unique/i.test(message)?409:400})}
}
