import { randomUUID } from "node:crypto";
import { getSql, withTransaction } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import { ensureOrderingMenuEditorSchema } from "@/lib/ordering-menu-editor-schema";

type Entity = "category"|"item"|"variant"|"modifier_group"|"modifier_option";
type Actor = { id:string; business:OrderingBusiness };
const clean=(v:unknown,max=500)=>String(v??"").trim().slice(0,max);
const cents=(v:unknown)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<0)throw new Error("Price must be a non-negative integer number of cents.");return n};
const integer=(v:unknown)=>{const n=Number(v);if(!Number.isSafeInteger(n))throw new Error("A whole number is required.");return n};

async function own(actor:Actor,entity:Entity,id:string,fields:string[]) {
  const sql=getSql();
  for(const field of fields) await sql`INSERT INTO ordering_menu_local_fields(business,entity_type,entity_id,field_name,updated_by) VALUES(${actor.business},${entity},${id},${field},${actor.id}) ON CONFLICT(entity_type,entity_id,field_name) DO UPDATE SET updated_by=EXCLUDED.updated_by,updated_at=NOW()`;
}
async function audit(actor:Actor,entity:Entity,id:string,action:string,before:unknown,after:unknown,reason=""){
  await getSql()`INSERT INTO ordering_menu_override_audit(id,business,actor_id,target_type,target_id,field_name,previous_value,new_value,reason) VALUES(${randomUUID()},${actor.business},${actor.id},${entity},${id},${action},${JSON.stringify(before??null)}::jsonb,${JSON.stringify(after??null)}::jsonb,${clean(reason,500)})`;
}
async function category(id:string,business:OrderingBusiness){return (await getSql()`SELECT * FROM ordering_menu_categories WHERE id=${id} AND business=${business}`)[0]}
async function item(id:string,business:OrderingBusiness){return (await getSql()`SELECT * FROM ordering_menu_items WHERE id=${id} AND business=${business}`)[0]}
async function group(id:string,business:OrderingBusiness){return (await getSql()`SELECT * FROM ordering_modifier_groups WHERE id=${id} AND business=${business}`)[0]}
async function variant(id:string,business:OrderingBusiness){return (await getSql()`SELECT v.* FROM ordering_menu_item_variants v JOIN ordering_menu_items i ON i.id=v.item_id WHERE v.id=${id} AND i.business=${business}`)[0]}
async function option(id:string,business:OrderingBusiness){return (await getSql()`SELECT o.* FROM ordering_modifier_options o JOIN ordering_modifier_groups g ON g.id=o.group_id WHERE o.id=${id} AND g.business=${business}`)[0]}

export async function menuDependencies(business:OrderingBusiness,entity:Entity,id:string){
  await ensureOrderingMenuEditorSchema(); const sql=getSql();
  const promotions=await sql`SELECT id,name FROM ordering_promotions WHERE business=${business} AND active=TRUE AND (rule::text LIKE ${`%${id}%`}) ORDER BY name`;
  const loyalty=await sql`SELECT id,name FROM ordering_loyalty_programs WHERE business=${business} AND active=TRUE AND (qualifying_rule::text LIKE ${`%${id}%`} OR reward_rule::text LIKE ${`%${id}%`}) ORDER BY name`;
  return {promotions:promotions.map(r=>({id:r.id,name:r.name})),loyalty:loyalty.map(r=>({id:r.id,name:r.name}))};
}

export async function mutateMenu(actor:Actor,input:any){
  await ensureOrderingMenuEditorSchema();
  return withTransaction(async()=>{
    const sql=getSql(), action=clean(input.action,40), entity=input.entity as Entity, id=clean(input.id,80);
    if(action==="create_category"){
      const name=clean(input.name);if(!name)throw new Error("Category name is required.");const newId=randomUUID();
      await sql`INSERT INTO ordering_menu_categories(id,business,name,display_name,sort_order,active,presentation_only) VALUES(${newId},${actor.business},${name},${clean(input.displayName)||name},${integer(input.sortOrder??0)},TRUE,FALSE)`;
      await own(actor,"category",newId,["name","display_name","sort_order","active"]);await audit(actor,"category",newId,"create",null,{name});return {id:newId};
    }
    if(action==="create_item"){
      const cat=await category(clean(input.categoryId,80),actor.business);if(!cat)throw new Error("Category was not found for this business.");const name=clean(input.name);if(!name)throw new Error("Item name is required.");const newId=randomUUID();
      await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,description,base_price_cents,taxable,available,active,sort_order) VALUES(${newId},${actor.business},${cat.id},${name},${clean(input.description,5000)},${cents(input.basePriceCents??0)},TRUE,TRUE,TRUE,${integer(input.sortOrder??0)})`;
      await own(actor,"item",newId,["category_id","name","description","base_price_cents","available","active","sort_order"]);await audit(actor,"item",newId,"create",null,{name,categoryId:cat.id,basePriceCents:cents(input.basePriceCents??0)});return {id:newId};
    }
    if(action==="duplicate_item"){
      const source=await item(id,actor.business);if(!source)throw new Error("Item was not found for this business.");const newId=randomUUID(),name=clean(input.name)||`${source.name} Copy`;
      await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,description,sku,base_price_cents,taxable,available,active,sort_order) VALUES(${newId},${actor.business},${source.category_id},${name},${source.description},'',${source.base_price_cents},${source.taxable},TRUE,TRUE,${Number(source.sort_order)+1})`;
      await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) SELECT gen_random_uuid(),${newId},group_id,sort_order FROM ordering_menu_item_modifier_groups WHERE item_id=${id}`;
      await sql`INSERT INTO ordering_menu_item_modifier_defaults(id,item_id,option_id,default_selected,included_quantity,price_delta_override_cents,available_override,active) SELECT gen_random_uuid(),${newId},option_id,default_selected,included_quantity,price_delta_override_cents,available_override,active FROM ordering_menu_item_modifier_defaults WHERE item_id=${id}`;
      await own(actor,"item",newId,["category_id","name","description","base_price_cents","available","active","sort_order"]);await audit(actor,"item",newId,"duplicate",{sourceId:id},{name});return {id:newId};
    }
    if(action==="create_variant"){
      const parent=await item(clean(input.itemId,80),actor.business);if(!parent)throw new Error("Item was not found for this business.");const name=clean(input.name);if(!name)throw new Error("Variant name is required.");const newId=randomUUID();
      await sql`INSERT INTO ordering_menu_item_variants(id,item_id,name,base_price_cents,available,active,sort_order) VALUES(${newId},${parent.id},${name},${cents(input.basePriceCents??0)},TRUE,TRUE,${integer(input.sortOrder??0)})`;
      await own(actor,"variant",newId,["name","base_price_cents","available","active","sort_order"]);await audit(actor,"variant",newId,"create",null,{name,itemId:parent.id});return {id:newId};
    }
    if(action==="create_modifier_group"){
      const name=clean(input.name);if(!name)throw new Error("Modifier group name is required.");const min=integer(input.minSelections??0),max=integer(input.maxSelections??1);if(min<0||max<1||min>max)throw new Error("Modifier minimum cannot exceed maximum.");const newId=randomUUID();
      await sql`INSERT INTO ordering_modifier_groups(id,business,name,prompt,min_selections,max_selections,active,sort_order) VALUES(${newId},${actor.business},${name},${clean(input.prompt,1000)},${min},${max},TRUE,${integer(input.sortOrder??0)})`;
      if(input.itemId){const parent=await item(clean(input.itemId,80),actor.business);if(!parent)throw new Error("Item was not found for this business.");await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) VALUES(${randomUUID()},${parent.id},${newId},${integer(input.sortOrder??0)})`}
      await own(actor,"modifier_group",newId,["name","prompt","min_selections","max_selections","active","sort_order"]);await audit(actor,"modifier_group",newId,"create",null,{name,min,max});return {id:newId};
    }
    if(action==="create_modifier_option"){
      const parent=await group(clean(input.groupId,80),actor.business);if(!parent)throw new Error("Modifier group was not found for this business.");const name=clean(input.name);if(!name)throw new Error("Modifier option name is required.");const newId=randomUUID();
      await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) VALUES(${newId},${parent.id},${name},${cents(input.priceDeltaCents??0)},TRUE,TRUE,${integer(input.sortOrder??0)})`;
      await own(actor,"modifier_option",newId,["name","price_delta_cents","available","active","sort_order"]);await audit(actor,"modifier_option",newId,"create",null,{name,groupId:parent.id});return {id:newId};
    }
    if(action==="attach_group"||action==="detach_group"){
      const parent=await item(clean(input.itemId,80),actor.business),target=await group(clean(input.groupId,80),actor.business);if(!parent||!target)throw new Error("Item or modifier group was not found for this business.");
      if(action==="attach_group")await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) VALUES(${randomUUID()},${parent.id},${target.id},${integer(input.sortOrder??0)}) ON CONFLICT(item_id,group_id) DO UPDATE SET sort_order=EXCLUDED.sort_order`;
      else await sql`DELETE FROM ordering_menu_item_modifier_groups WHERE item_id=${parent.id} AND group_id=${target.id}`;
      await audit(actor,"item",parent.id,action,{groupId:target.id},action==="attach_group"?{groupId:target.id}:null);return {id:parent.id};
    }
    let before:any;
    if(entity==="category")before=await category(id,actor.business); else if(entity==="item")before=await item(id,actor.business); else if(entity==="variant")before=await variant(id,actor.business); else if(entity==="modifier_group")before=await group(id,actor.business); else if(entity==="modifier_option")before=await option(id,actor.business);
    if(!before)throw new Error("Menu record was not found for this business.");
    if(action==="archive"){
      const deps=await menuDependencies(actor.business,entity,id);if((deps.promotions.length||deps.loyalty.length)&&!input.confirmDependencies)return {requiresConfirmation:true,dependencies:deps};
      if(entity==="category"&&Number((await sql`SELECT COUNT(*) count FROM ordering_menu_items WHERE category_id=${id} AND active=TRUE`)[0].count)>0)throw new Error("Move or archive active items before archiving this category.");
      const table=entity==="category"?"ordering_menu_categories":entity==="item"?"ordering_menu_items":entity==="variant"?"ordering_menu_item_variants":entity==="modifier_group"?"ordering_modifier_groups":"ordering_modifier_options";
      // Table is selected from a closed server-side list; tagged SQL cannot interpolate identifiers.
      if(table==="ordering_menu_categories")await sql`UPDATE ordering_menu_categories SET active=FALSE,updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
      else if(table==="ordering_menu_items")await sql`UPDATE ordering_menu_items SET active=FALSE,available=FALSE,updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
      else if(table==="ordering_menu_item_variants")await sql`UPDATE ordering_menu_item_variants v SET active=FALSE,available=FALSE,updated_at=NOW() FROM ordering_menu_items i WHERE v.id=${id} AND v.item_id=i.id AND i.business=${actor.business}`;
      else if(table==="ordering_modifier_groups")await sql`UPDATE ordering_modifier_groups SET active=FALSE,updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
      else await sql`UPDATE ordering_modifier_options o SET active=FALSE,available=FALSE,updated_at=NOW() FROM ordering_modifier_groups g WHERE o.id=${id} AND o.group_id=g.id AND g.business=${actor.business}`;
      await own(actor,entity,id,["active","available"]);await audit(actor,entity,id,"archive",{active:before.active},{active:false},input.reason);return {id,archived:true};
    }
    if(action==="reset_field"){
      const field=clean(input.field,80),source=(await sql`SELECT source_payload FROM ordering_menu_source_map WHERE business=${actor.business} AND entity_type=${entity} AND internal_id=${id} ORDER BY last_seen_at DESC LIMIT 1`)[0]?.source_payload;
      if(!source)throw new Error("This Corner Ops-native record has no imported value to restore.");
      const sourceKeys:Record<string,string>={name:"name",description:"description",base_price_cents:"basePriceCents",available:"available",sort_order:"sortOrder",min_selections:"minSelections",max_selections:"maxSelections",price_delta_cents:"priceDeltaCents"};
      const key=sourceKeys[field];if(!key||source[key]===undefined)throw new Error("No imported value exists for this field.");
      await sql`DELETE FROM ordering_menu_local_fields WHERE business=${actor.business} AND entity_type=${entity} AND entity_id=${id} AND field_name=${field}`;
      const value=source[key];
      if(entity==="item"&&field==="base_price_cents")await sql`UPDATE ordering_menu_items SET base_price_cents=${cents(value)},updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
      else if(entity==="item"&&field==="name")await sql`UPDATE ordering_menu_items SET name=${clean(value)},updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
      else if(entity==="item"&&field==="description")await sql`UPDATE ordering_menu_items SET description=${clean(value,5000)},updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
      else if(entity==="variant"&&field==="base_price_cents")await sql`UPDATE ordering_menu_item_variants SET base_price_cents=${cents(value)},updated_at=NOW() WHERE id=${id}`;
      else if(entity==="modifier_option"&&field==="price_delta_cents")await sql`UPDATE ordering_modifier_options SET price_delta_cents=${cents(value)},updated_at=NOW() WHERE id=${id}`;
      else throw new Error("Reset is not yet available for this field.");
      await audit(actor,entity,id,`reset_${field}`,before[field],value,input.reason);return {id,reset:field};
    }
    if(action!=="update")throw new Error("Unsupported menu action.");
    const patch=input.patch||{}, fields=Object.keys(patch);if(!fields.length)throw new Error("No changes were supplied.");
    if(entity==="category"){
      const name=patch.name===undefined?before.name:clean(patch.name);if(!name)throw new Error("Category name is required.");const sort=patch.sortOrder===undefined?before.sort_order:integer(patch.sortOrder);
      await sql`UPDATE ordering_menu_categories SET name=${name},display_name=${patch.displayName===undefined?before.display_name:clean(patch.displayName)},sort_order=${sort},active=${patch.active===undefined?before.active:Boolean(patch.active)},updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
    } else if(entity==="item"){
      let categoryId=before.category_id;if(patch.categoryId!==undefined){const cat=await category(clean(patch.categoryId,80),actor.business);if(!cat)throw new Error("Category was not found for this business.");categoryId=cat.id}
      await sql`UPDATE ordering_menu_items SET category_id=${categoryId},name=${patch.name===undefined?before.name:clean(patch.name)},description=${patch.description===undefined?before.description:clean(patch.description,5000)},base_price_cents=${patch.basePriceCents===undefined?before.base_price_cents:cents(patch.basePriceCents)},available=${patch.available===undefined?before.available:Boolean(patch.available)},active=${patch.active===undefined?before.active:Boolean(patch.active)},sort_order=${patch.sortOrder===undefined?before.sort_order:integer(patch.sortOrder)},updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
    } else if(entity==="variant"){
      await sql`UPDATE ordering_menu_item_variants SET name=${patch.name===undefined?before.name:clean(patch.name)},base_price_cents=${patch.basePriceCents===undefined?before.base_price_cents:cents(patch.basePriceCents)},available=${patch.available===undefined?before.available:Boolean(patch.available)},active=${patch.active===undefined?before.active:Boolean(patch.active)},sort_order=${patch.sortOrder===undefined?before.sort_order:integer(patch.sortOrder)},updated_at=NOW() WHERE id=${id}`;
    } else if(entity==="modifier_group"){
      const min=patch.minSelections===undefined?Number(before.min_selections):integer(patch.minSelections),max=patch.maxSelections===undefined?Number(before.max_selections):integer(patch.maxSelections);if(min<0||max<1||min>max)throw new Error("Modifier minimum cannot exceed maximum.");
      await sql`UPDATE ordering_modifier_groups SET name=${patch.name===undefined?before.name:clean(patch.name)},prompt=${patch.prompt===undefined?before.prompt:clean(patch.prompt,1000)},min_selections=${min},max_selections=${max},active=${patch.active===undefined?before.active:Boolean(patch.active)},sort_order=${patch.sortOrder===undefined?before.sort_order:integer(patch.sortOrder)},updated_at=NOW() WHERE id=${id} AND business=${actor.business}`;
    } else {
      await sql`UPDATE ordering_modifier_options o SET name=${patch.name===undefined?before.name:clean(patch.name)},price_delta_cents=${patch.priceDeltaCents===undefined?before.price_delta_cents:cents(patch.priceDeltaCents)},available=${patch.available===undefined?before.available:Boolean(patch.available)},active=${patch.active===undefined?before.active:Boolean(patch.active)},sort_order=${patch.sortOrder===undefined?before.sort_order:integer(patch.sortOrder)},updated_at=NOW() FROM ordering_modifier_groups g WHERE o.id=${id} AND o.group_id=g.id AND g.business=${actor.business}`;
    }
    const map:Record<string,string>={displayName:"display_name",sortOrder:"sort_order",categoryId:"category_id",basePriceCents:"base_price_cents",minSelections:"min_selections",maxSelections:"max_selections",priceDeltaCents:"price_delta_cents"};
    await own(actor,entity,id,fields.map(f=>map[f]||f));await audit(actor,entity,id,"update",Object.fromEntries(fields.map(f=>[f,before[map[f]||f]])),patch,input.reason);return {id};
  });
}
