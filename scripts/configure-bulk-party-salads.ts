#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

const CATEGORY="b0175a1a-d540-4eef-a06a-35be2d630001";
const PARENT="f5cb76dd-57f4-4fba-9623-0c607d15d97c";
const salads=[
  ["b0175a1a-d540-4eef-a06a-35be2d630101","Potato Salad",400],
  ["b0175a1a-d540-4eef-a06a-35be2d630102","Pasta Salad",400],
  ["b0175a1a-d540-4eef-a06a-35be2d630103","Mac Salad",400],
  ["b0175a1a-d540-4eef-a06a-35be2d630104","Green Beans",400],
  ["b0175a1a-d540-4eef-a06a-35be2d630105","Cole Slaw",400],
  ["b0175a1a-d540-4eef-a06a-35be2d630106","Baked Beans",400],
  ["b0175a1a-d540-4eef-a06a-35be2d630107","Antipasto",500],
] as const;

async function main(){
  const {getSql,withTransaction}=await import("../src/lib/db");
  await withTransaction(async()=>{const sql=getSql();
    await sql`INSERT INTO ordering_menu_categories(id,business,name,display_name,parent_id,sort_order,active,presentation_only) VALUES(${CATEGORY},'Corner Deli','Salads & Deli / Bulk / Party Salads','Bulk / Party Salads',${PARENT},290,TRUE,FALSE) ON CONFLICT(id) DO UPDATE SET display_name='Bulk / Party Salads',parent_id=${PARENT},sort_order=290,active=TRUE`;
    for(let itemIndex=0;itemIndex<salads.length;itemIndex+=1){const[id,name,rate]=salads[itemIndex];
      await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,description,base_price_cents,taxable,available,active,sort_order) VALUES(${id},'Corner Deli',${CATEGORY},${name},${`${rate/100} dollars per pound. Enter the guest count; portioning is 1/3 lb per person and rounds up to the next 0.25 lb.`},0,TRUE,TRUE,TRUE,${itemIndex}) ON CONFLICT(id) DO UPDATE SET category_id=${CATEGORY},name=${name},description=EXCLUDED.description,base_price_cents=0,available=TRUE,active=TRUE,sort_order=${itemIndex}`;
      for(let people=1;people<=120;people+=1){const pounds=Math.ceil((people/3)*4)/4,price=Math.round(pounds*rate),variantName=`Feeds ${people} · ${pounds.toFixed(2)} lb`;
        await sql`INSERT INTO ordering_menu_item_variants(id,item_id,name,base_price_cents,default_variant,available,active,sort_order,metadata) VALUES(${randomUUID()},${id},${variantName},${price},${people===1},TRUE,TRUE,${people},${JSON.stringify({feeds:people,pounds,pricePerPoundCents:rate,partySalad:true})}::jsonb) ON CONFLICT(item_id,name) DO UPDATE SET base_price_cents=${price},available=TRUE,active=TRUE,sort_order=${people},metadata=EXCLUDED.metadata`;
      }
    }
  });
  console.log("Bulk / Party Salads configured for 1-120 guests.");
}
main().catch(error=>{console.error(error);process.exit(1)});
