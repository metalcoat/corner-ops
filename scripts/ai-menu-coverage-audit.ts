#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";
localValidationEnv();

async function main(){
  const [{getSql},{orderingMenuWithVariants},{createAiDraft,menuCatalog,AiToolError}]=await Promise.all([import("../src/lib/db"),import("../src/lib/ordering-menu-variants"),import("../src/lib/ordering-ai-tools")]);
  const sql=getSql(),actor={id:"menu-coverage-audit",name:"AI Menu Coverage Audit",type:"employee" as const,role:"employee" as const},catalog=await orderingMenuWithVariants("Corner Deli","pos"),items=catalog.flatMap(category=>category.items).filter(item=>item.available),report:any[]=[];
  for(const item of items){
    const failures:string[]=[],requiredGroups=item.modifiers.filter(group=>group.presentationContext==="ordinary"&&group.minSelections>0),modifierSelections:Record<string,string[]>={};
    for(const group of requiredGroups){const choices=group.options.filter(option=>option.available);if(choices.length<group.minSelections)failures.push(`required group ${group.name} has only ${choices.length} available choices`);else modifierSelections[group.id]=choices.slice(0,group.minSelections).map(option=>option.id)}
    const variants=item.variants.filter(variant=>variant.available!==false),variant=variants.find(row=>row.defaultVariant)||variants[0];
    if(item.variants.length&&!variants.length)failures.push("no available variants");
    const found=(await menuCatalog("Corner Deli",new Date(),item.name)).flatMap(category=>category.items).some(candidate=>candidate.id===item.id);
    if(!found)failures.push("canonical name is not retrievable");
    if(!Number.isInteger(item.basePriceCents)||item.basePriceCents<0)failures.push("base price is invalid");
    let priced:any;
    if(!failures.length)try{priced=await createAiDraft({business:"Corner Deli",actor,service:"pickup",items:[{itemId:item.id,variantId:variant?.id||null,quantity:1,modifierSelections}]});if(!priced.lines?.some((line:any)=>line.item_id===item.id))failures.push("priced line did not retain menu ID")}catch(error){failures.push(`pricing failed: ${error instanceof Error?error.message:"unknown error"}`)}finally{if(priced?.id)await sql`DELETE FROM ordering_orders WHERE id=${priced.id}`}
    try{await createAiDraft({business:"Corner Deli",actor,service:"pickup",items:[{itemId:item.id,variantId:variant?.id||null,quantity:1,modifierSelections:{...modifierSelections,"00000000-0000-0000-0000-000000000000":["00000000-0000-0000-0000-000000000001"]}}]});failures.push("invalid modifier was accepted")}catch(error){if(!(error instanceof AiToolError)||error.code!=="INVALID_MODIFIER")failures.push("invalid modifier did not return INVALID_MODIFIER")}
    if((item.variants.length>1&&!item.variants.some(row=>row.defaultVariant))||requiredGroups.length){try{await createAiDraft({business:"Corner Deli",actor,service:"pickup",items:[{itemId:item.id,quantity:1}]});failures.push("incomplete item was accepted")}catch(error){if(!(error instanceof AiToolError)||!["INVALID_VARIANT","INVALID_MODIFIER"].includes(error.code))failures.push("incomplete item returned the wrong error")}}
    report.push({itemId:item.id,name:item.name,variants:variants.map(row=>row.name),requiredGroups:requiredGroups.map(group=>group.name),optionalGroups:item.modifiers.filter(group=>group.minSelections===0).map(group=>group.name),status:failures.length?"failed":"passed",failures});
  }
  const failed=report.filter(row=>row.status==="failed");console.log(JSON.stringify({business:"Corner Deli",authoritativeSource:"orderingMenuWithVariants(database)",activeItems:items.length,passed:items.length-failed.length,failed:failed.length,failures:failed,items:report},null,2));if(failed.length)process.exitCode=1;
}
main().catch(error=>{console.error(error);process.exitCode=1});
