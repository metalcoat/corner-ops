import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";
import type { OrderingBusiness } from "@/lib/ordering-core";
import type { OrderingActor } from "@/lib/ordering-route-auth";
import { canManagePos } from "@/lib/ordering-route-auth";
import { ensureOrderingBarcodeSchema } from "@/lib/ordering-barcode-schema";

export type BarcodeFormat = "upc_a" | "ean_8" | "ean_13" | "gtin_14" | "code_128_text";
export type BarcodeMapping = { id:string; business:OrderingBusiness; barcode:string; barcodeFormat:BarcodeFormat; itemId:string; variantId:string|null; itemName:string; variantName:string|null; active:boolean; updatedAt:string };

const configuredFormats: ReadonlyArray<{ format:BarcodeFormat; pattern:RegExp }> = [
  { format:"ean_8", pattern:/^\d{8}$/ }, { format:"upc_a", pattern:/^\d{12}$/ },
  { format:"ean_13", pattern:/^\d{13}$/ }, { format:"gtin_14", pattern:/^\d{14}$/ },
  { format:"code_128_text", pattern:/^[\x21-\x7E]{4,64}$/ },
];

export class BarcodeError extends Error { constructor(message:string, public status=400) { super(message); } }
export function normalizeBarcode(value:string):string { return value.trim(); }
export function identifyBarcodeFormat(value:string):BarcodeFormat {
  const barcode=normalizeBarcode(value);
  const match=configuredFormats.find(candidate=>candidate.pattern.test(barcode));
  if(!match) throw new BarcodeError("Barcode does not match an enabled UPC, EAN, GTIN, or Code 128 text pattern.");
  return match.format;
}
function requireManager(actor:OrderingActor){if(!canManagePos(actor))throw new BarcodeError("Manager or owner authorization is required.",403)}
function view(row:Record<string,unknown>):BarcodeMapping{return{id:String(row.id),business:String(row.business) as OrderingBusiness,barcode:String(row.barcode),barcodeFormat:String(row.barcode_format) as BarcodeFormat,itemId:String(row.item_id),variantId:row.variant_id?String(row.variant_id):null,itemName:String(row.item_name),variantName:row.variant_name?String(row.variant_name):null,active:Boolean(row.active),updatedAt:new Date(String(row.updated_at)).toISOString()}}

export async function listBarcodeMappings(business:OrderingBusiness, query=""):Promise<BarcodeMapping[]> {
  await ensureOrderingBarcodeSchema(); const sql=getSql(),search=`%${query.trim()}%`;
  const rows=await sql`SELECT mapping.*,item.name item_name,variant.name variant_name FROM ordering_barcode_mappings mapping JOIN ordering_menu_items item ON item.id=mapping.item_id LEFT JOIN ordering_menu_item_variants variant ON variant.id=mapping.variant_id WHERE mapping.business=${business} AND (${query.trim()}='' OR mapping.barcode ILIKE ${search} OR item.name ILIKE ${search} OR variant.name ILIKE ${search}) ORDER BY mapping.active DESC,mapping.updated_at DESC LIMIT 250`;
  return rows.map(view);
}
export async function resolveBarcode(business:OrderingBusiness,value:string):Promise<BarcodeMapping|null>{
  const barcode=normalizeBarcode(value); identifyBarcodeFormat(barcode); await ensureOrderingBarcodeSchema(); const sql=getSql();
  const rows=await sql`SELECT mapping.*,item.name item_name,variant.name variant_name FROM ordering_barcode_mappings mapping JOIN ordering_menu_items item ON item.id=mapping.item_id AND item.business=mapping.business LEFT JOIN ordering_menu_item_variants variant ON variant.id=mapping.variant_id AND variant.item_id=item.id WHERE mapping.business=${business} AND mapping.barcode=${barcode} AND mapping.active=TRUE`;
  return rows[0]?view(rows[0]):null;
}
export async function saveBarcodeMapping(input:{business:OrderingBusiness;id?:string;barcode:string;itemId:string;variantId?:string|null;active?:boolean;actor:OrderingActor}):Promise<BarcodeMapping>{
  requireManager(input.actor); const barcode=normalizeBarcode(input.barcode),format=identifyBarcodeFormat(barcode); await ensureOrderingBarcodeSchema(); const sql=getSql();
  const target=(await sql`SELECT item.id,variant.id variant_id FROM ordering_menu_items item LEFT JOIN ordering_menu_item_variants variant ON variant.id=${input.variantId||null} AND variant.item_id=item.id WHERE item.id=${input.itemId} AND item.business=${input.business}`)[0];
  if(!target || (input.variantId && !target.variant_id))throw new BarcodeError("The item or variant was not found in this business.",404);
  const before=input.id?(await sql`SELECT * FROM ordering_barcode_mappings WHERE id=${input.id} AND business=${input.business}`)[0]:null;
  if(input.id&&!before)throw new BarcodeError("Barcode mapping was not found.",404);
  const id=input.id||randomUUID(),active=input.active!==false;
  if(active){const duplicate=(await sql`SELECT id FROM ordering_barcode_mappings WHERE business=${input.business} AND barcode=${barcode} AND active=TRUE AND id<>${id}`)[0];if(duplicate)throw new BarcodeError("That barcode already has an active mapping in this business.",409)}
  try { await sql`INSERT INTO ordering_barcode_mappings(id,business,barcode,barcode_format,item_id,variant_id,active,created_by,updated_by) VALUES(${id},${input.business},${barcode},${format},${input.itemId},${input.variantId||null},${active},${input.actor.id},${input.actor.id}) ON CONFLICT(id) DO UPDATE SET barcode=EXCLUDED.barcode,barcode_format=EXCLUDED.barcode_format,item_id=EXCLUDED.item_id,variant_id=EXCLUDED.variant_id,active=EXCLUDED.active,updated_at=NOW(),updated_by=EXCLUDED.updated_by WHERE ordering_barcode_mappings.business=EXCLUDED.business`; }
  catch(error){if(String(error).includes("ordering_barcode_one_active_idx"))throw new BarcodeError("That barcode already has an active mapping in this business.",409);throw error}
  const after=(await sql`SELECT * FROM ordering_barcode_mappings WHERE id=${id}`)[0];
  const action=!before?"created":before.active!==after.active?(after.active?"activated":"deactivated"):"updated";
  await sql`INSERT INTO ordering_barcode_audit(id,mapping_id,business,action,barcode,before_state,after_state,actor_id,actor_name,actor_role) VALUES(${randomUUID()},${id},${input.business},${action},${barcode},${before?JSON.stringify(before):null}::jsonb,${JSON.stringify(after)}::jsonb,${input.actor.id},${input.actor.name},${input.actor.role||"employee"})`;
  return (await listBarcodeMappings(input.business,barcode)).find(row=>row.id===id)!;
}
