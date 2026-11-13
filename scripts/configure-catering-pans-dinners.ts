#!/usr/bin/env node
// Catering > Pans & Dinners: a spaghetti and meatball pan that feeds 8 ($43, sausage/onion/pepper add-ons)
// and turkey dinners sold by the dinner with a 20 minimum ($15 each, so 20 is $300). Safe to rerun.
import { localValidationEnv } from "./validation-env";
localValidationEnv();

const CATERING = "1bc57b3e-bb88-42b9-b3cb-080c542e9d8e";
const CATEGORY = "510c3ffd-adcd-4c0b-a7da-ccfd514e821b";
const PAN = "7f77f314-35e4-4a09-b9c4-85b232d444e9";
const PAN_ADD_ONS = "bd5d3383-b35d-4f1f-a79e-5aa3f264cffb";
const TURKEY = "081446c1-ccd0-4565-8fce-5767a337431c";
const addOns = [
  ["0c767992-ad36-4553-b612-a03e28970268", "Add Sausage", 800],
  ["3890bf4d-50f6-4e6c-8986-4960e5a9b4f9", "Add Onions", 300],
  ["6d3b70c0-5fd5-4be3-a309-ff88d408fce9", "Add Peppers", 300],
] as const;
const TURKEY_DINNER_CENTS = 1500, TURKEY_MINIMUM = 20, TURKEY_MAXIMUM = 150;

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  await withTransaction(async () => {
    const sql = getSql();
    await sql`INSERT INTO ordering_menu_categories(id,business,name,display_name,parent_id,sort_order,active,presentation_only) VALUES(${CATEGORY},'Corner Deli','Catering / Pans & Dinners','Pans & Dinners',${CATERING},131,TRUE,FALSE)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,display_name=EXCLUDED.display_name,parent_id=EXCLUDED.parent_id,active=TRUE,updated_at=NOW()`;

    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,description,base_price_cents,taxable,available,active,sort_order) VALUES(${PAN},'Corner Deli',${CATEGORY},'Spaghetti & Meatball Pan','Feeds 8.',4300,TRUE,TRUE,TRUE,0)
      ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id,name=EXCLUDED.name,description=EXCLUDED.description,base_price_cents=EXCLUDED.base_price_cents,active=TRUE,updated_at=NOW()`;
    await sql`INSERT INTO ordering_modifier_groups(id,business,name,prompt,min_selections,max_selections,allow_option_quantity,active,sort_order) VALUES(${PAN_ADD_ONS},'Corner Deli','Pan Add-ons','Add to the pan',0,${addOns.length},FALSE,TRUE,0)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,prompt=EXCLUDED.prompt,min_selections=0,max_selections=EXCLUDED.max_selections,active=TRUE,updated_at=NOW()`;
    for (let index = 0; index < addOns.length; index += 1) {
      const [id, name, cents] = addOns[index];
      await sql`INSERT INTO ordering_modifier_options(id,group_id,name,price_delta_cents,available,active,sort_order) VALUES(${id},${PAN_ADD_ONS},${name},${cents},TRUE,TRUE,${index})
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,price_delta_cents=EXCLUDED.price_delta_cents,active=TRUE,updated_at=NOW()`;
    }
    await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) VALUES(gen_random_uuid(),${PAN},${PAN_ADD_ONS},0) ON CONFLICT(item_id,group_id) DO NOTHING`;

    await sql`INSERT INTO ordering_menu_items(id,business,category_id,name,description,base_price_cents,taxable,available,active,sort_order) VALUES(${TURKEY},'Corner Deli',${CATEGORY},'Turkey Dinners',${`${TURKEY_MINIMUM} dinner minimum, $${TURKEY_DINNER_CENTS / 100} per dinner.`},${TURKEY_DINNER_CENTS * TURKEY_MINIMUM},TRUE,TRUE,TRUE,1)
      ON CONFLICT(id) DO UPDATE SET category_id=EXCLUDED.category_id,name=EXCLUDED.name,description=EXCLUDED.description,base_price_cents=EXCLUDED.base_price_cents,active=TRUE,updated_at=NOW()`;
    // One size per dinner count, so nobody can ring up fewer than the minimum.
    await sql`DELETE FROM ordering_menu_item_variants WHERE item_id=${TURKEY} AND NOT EXISTS(SELECT 1 FROM ordering_order_items WHERE variant_id=ordering_menu_item_variants.id)`;
    await sql`UPDATE ordering_menu_item_variants SET active=FALSE,default_variant=FALSE,updated_at=NOW() WHERE item_id=${TURKEY}`;
    for (let dinners = TURKEY_MINIMUM; dinners <= TURKEY_MAXIMUM; dinners += 1) {
      await sql`INSERT INTO ordering_menu_item_variants(id,item_id,name,base_price_cents,default_variant,available,active,sort_order,metadata) VALUES(gen_random_uuid(),${TURKEY},${`${dinners} dinners`},${dinners * TURKEY_DINNER_CENTS},${dinners === TURKEY_MINIMUM},TRUE,TRUE,${dinners},${JSON.stringify({ feeds: dinners })}::jsonb)`;
    }
  });
  console.log(JSON.stringify({ category: "Catering / Pans & Dinners", spaghettiPanCents: 4300, addOns: addOns.map(([, name, cents]) => `${name} +${cents}`), turkeyDinners: `${TURKEY_MINIMUM}-${TURKEY_MAXIMUM} at ${TURKEY_DINNER_CENTS} each` }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
