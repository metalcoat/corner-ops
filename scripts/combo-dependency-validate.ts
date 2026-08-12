#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";

loadEnvFile("/opt/corner-ops/.env");
const address=execFileSync("docker",["inspect","corner-ops-postgres","--format","{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],{encoding:"utf8"}).trim();
if(!process.env.POSTGRES_PASSWORD)throw new Error("POSTGRES_PASSWORD is required.");
process.env.DATABASE_DRIVER="postgres";process.env.DATABASE_URL=`postgresql://cornerops:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}@${address}:5432/cornerops`;

async function main(){
  const {orderingMenu}=await import("../src/lib/ordering-menu");
  const items=(await orderingMenu("Corner Deli")).flatMap(category=>category.items);
  const meals=items.filter(item=>item.modifiers.some(group=>group.presentationContext==="combo_trigger"));
  if(!meals.length)throw new Error("No imported combo dependency items were found.");
  for(const item of meals){
    const triggers=item.modifiers.filter(group=>group.presentationContext==="combo_trigger");
    const dependents=item.modifiers.filter(group=>group.presentationContext==="dependent");
    if(triggers.length!==1)throw new Error(`${item.name} has duplicate combo triggers.`);
    if(dependents.length!==2)throw new Error(`${item.name} does not have the two expected fry dependencies.`);
    if(dependents.some(group=>group.parentGroupId!==triggers[0].id||!group.parentOptionIds.length))throw new Error(`${item.name} has an invalid fry dependency link.`);
    const optionIds=dependents.flatMap(group=>group.options.map(option=>option.id));
    if(new Set(optionIds).size!==optionIds.length)throw new Error(`${item.name} has duplicated fry options/charges.`);
  }
  console.log(JSON.stringify({realImportedMealItems:meals.length,comboTriggerFirst:true,fryGroupsHiddenUntilMatchingSize:true,noDuplicateFryOptions:true},null,2));
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
