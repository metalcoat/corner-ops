#!/usr/bin/env node
import {randomUUID} from "node:crypto";
import * as XLSX from "xlsx";
import {localValidationEnv} from "./validation-env";
localValidationEnv();

const mode=process.argv[2],path=process.argv[3]||"/home/chris/Corner-Deli-AI-Menu.xlsx";
const clean=(value:unknown,max=5000)=>String(value??"").trim().slice(0,max);
const normalize=(value:string)=>value.toLocaleLowerCase().replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").trim();
const splitAliases=(value:unknown)=>[...new Set(clean(value).split(";").map(alias=>alias.trim()).filter(Boolean))];

async function main(){
  const [{getSql,withTransaction},{orderingMenuWithVariants},{ensureOrderingMenuEditorSchema},{ensureOrderingVariantSchema},{BUSINESS_ITEM_ALIASES,spokenKey}]=await Promise.all([import("../src/lib/db"),import("../src/lib/ordering-menu-variants"),import("../src/lib/ordering-menu-editor-schema"),import("../src/lib/ordering-variant-schema"),import("../src/lib/ordering-ai-tools")]);
  await Promise.all([ensureOrderingMenuEditorSchema(),ensureOrderingVariantSchema()]);const sql=getSql();
  if(mode==="export"){
    const menu=await orderingMenuWithVariants("Corner Deli","pos"),rows=menu.flatMap(category=>category.items.filter(item=>item.available).map(item=>({
      category:category.displayName,item_id:item.id,item_name:item.name,description:item.description||"",ai_aliases:[...new Set([...item.aliases,...(BUSINESS_ITEM_ALIASES[spokenKey(item.name)]||[])])].join("; "),variants:item.variants.filter(variant=>variant.available).map(variant=>variant.name).join("; "),modifier_groups:item.modifiers.map(group=>`${group.name}${group.minSelections>0?" (required)":""}: ${group.options.filter(option=>option.available).map(option=>option.name).join(" | ")}`).join("\n"),base_price:(item.basePriceCents/100).toFixed(2),available:item.available?"yes":"no"
    })));
    const book=XLSX.utils.book_new(),instructions=XLSX.utils.aoa_to_sheet([["Corner Deli AI Menu Editor"],["Edit only description and ai_aliases on the Menu sheet."],["Separate aliases with semicolons. Aliases resolve to the existing item_id and never create products."],["Do not change item_id. Import rejects missing, unknown, duplicate, or renamed IDs."],["Descriptions and aliases become available to phone ordering after import and deployment."]]),sheet=XLSX.utils.json_to_sheet(rows);
    sheet["!cols"]=[{wch:24},{wch:38},{wch:36},{wch:70},{wch:55},{wch:45},{wch:110},{wch:12},{wch:10}];sheet["!autofilter"]={ref:sheet["!ref"]!};XLSX.utils.book_append_sheet(book,instructions,"Instructions");XLSX.utils.book_append_sheet(book,sheet,"Menu");XLSX.writeFile(book,path);console.log(JSON.stringify({mode,path,items:rows.length,editableColumns:["description","ai_aliases"]},null,2));return;
  }
  if(mode!=="import")throw new Error("Usage: npm run menu:ai-workbook -- export [path] OR import [path]");
  const book=XLSX.readFile(path),sheet=book.Sheets.Menu;if(!sheet)throw new Error("Workbook is missing the Menu sheet.");const rows=XLSX.utils.sheet_to_json<Record<string,unknown>>(sheet,{defval:""});if(!rows.length)throw new Error("The Menu sheet is empty.");
  const current=await sql`SELECT id,name FROM ordering_menu_items WHERE business='Corner Deli' AND active=TRUE`,byId=new Map(current.map(row=>[String(row.id),String(row.name)])),seen=new Set<string>();
  for(const row of rows){const id=clean(row.item_id),name=clean(row.item_name);if(!id||seen.has(id)||byId.get(id)!==name)throw new Error(`Invalid, duplicate, or renamed item row: ${name||id}`);seen.add(id)}
  if(seen.size!==byId.size)throw new Error(`Workbook contains ${seen.size} items but the current menu contains ${byId.size}; export a fresh workbook before importing.`);
  await withTransaction(async()=>{const tx=getSql();for(const row of rows){const id=clean(row.item_id),description=clean(row.description),aliases=splitAliases(row.ai_aliases);await tx`UPDATE ordering_menu_items SET description=${description},updated_at=NOW() WHERE id=${id} AND business='Corner Deli'`;await tx`INSERT INTO ordering_menu_local_fields(business,entity_type,entity_id,field_name,updated_by) VALUES('Corner Deli','item',${id},'description','ai-menu-workbook') ON CONFLICT(entity_type,entity_id,field_name) DO UPDATE SET updated_by=EXCLUDED.updated_by,updated_at=NOW()`;await tx`UPDATE ordering_menu_item_aliases SET active=FALSE WHERE item_id=${id}`;for(const alias of aliases){const normalized=normalize(alias);if(!normalized||normalized===normalize(String(row.item_name)))continue;await tx`INSERT INTO ordering_menu_item_aliases(id,item_id,alias,normalized_alias,active) VALUES(${randomUUID()},${id},${alias},${normalized},TRUE) ON CONFLICT(item_id,normalized_alias) DO UPDATE SET alias=EXCLUDED.alias,active=TRUE`}}});
  console.log(JSON.stringify({mode,path,updatedItems:rows.length,aliases:rows.reduce((sum,row)=>sum+splitAliases(row.ai_aliases).length,0)},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1});
