#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const TWO_OUNCE_DIPPINGS = "84160fd0-05f9-4114-b405-be82d8d0a47d";
const FOUR_OUNCE_DIPPINGS = "8718a11f-fe77-4745-877c-48a7bf17b6ab";
const INCLUDED_TWO_OUNCE_ITEMS = [
  "53b52bd7-b60e-4895-8cca-ad9914175fdc", // Breaded Cauliflower
  "2eb46364-83d2-4439-acf7-bdf36486bda6", // Breaded Mushrooms
  "17e99198-1d21-43e8-9160-fb41ed33c70e", // Deep Fried Cheese Curd
  "491026e1-ff45-433f-bedb-304e333eeb32", // Mac & Cheese Bites (6)
  "38faaa24-c8f0-4747-aff8-4aecfb6f4211", // Pop Corn Chicken
];
const VARIETY_ITEMS = [
  "a3558cf4-1f00-4678-83a3-18864ca91dd5", // Variety for Four
  "e4117b19-df7e-4700-b073-73dc4899029c", // Variety for TWO
];

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingMenuOverrideSchema } = await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();

  await withTransaction(async () => {
    const sql = getSql();
    for (const itemId of INCLUDED_TWO_OUNCE_ITEMS) {
      await sql`
        INSERT INTO ordering_modifier_presentation_overrides (
          item_id, group_id, context, included_choice_count, presentation_style, updated_by
        ) VALUES (
          ${itemId}, ${TWO_OUNCE_DIPPINGS}, 'ordinary', 1, 'grid', 'appetizer-included-sauces'
        )
        ON CONFLICT (item_id, group_id) DO UPDATE
        SET context = EXCLUDED.context,
            included_choice_count = 1,
            presentation_style = EXCLUDED.presentation_style,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
      `;
    }

    const marinara = (await sql`
      SELECT id FROM ordering_modifier_options
      WHERE group_id = ${FOUR_OUNCE_DIPPINGS}
        AND name = 'Marinara (4oz)'
        AND active = TRUE
      LIMIT 1
    `)[0];
    if (!marinara) throw new Error("The 4oz Marinara dipping sauce was not found");

    for (const itemId of VARIETY_ITEMS) {
      await sql`
        INSERT INTO ordering_modifier_presentation_overrides (
          item_id, group_id, context, included_choice_count, presentation_style, updated_by
        ) VALUES (
          ${itemId}, ${FOUR_OUNCE_DIPPINGS}, 'ordinary', 1, 'grid', 'appetizer-included-sauces'
        )
        ON CONFLICT (item_id, group_id) DO UPDATE
        SET context = EXCLUDED.context,
            included_choice_count = 1,
            presentation_style = EXCLUDED.presentation_style,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
      `;
      await sql`
        INSERT INTO ordering_menu_item_modifier_defaults (
          id, item_id, option_id, default_selected, included_quantity, active
        ) VALUES (gen_random_uuid(), ${itemId}, ${marinara.id}, TRUE, 1, TRUE)
        ON CONFLICT (item_id, option_id) DO UPDATE
        SET default_selected = TRUE, included_quantity = 1, active = TRUE, updated_at = NOW()
      `;
    }
  });

  console.log(JSON.stringify({
    firstSauceIncludedItems: INCLUDED_TWO_OUNCE_ITEMS.length,
    varietyItems: VARIETY_ITEMS.length,
    varietyDefault: "Marinara (4oz)",
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
