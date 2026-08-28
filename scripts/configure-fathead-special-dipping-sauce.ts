#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const FATHEAD_SPECIAL = "ee59d259-fe3f-45c7-b736-32b1d8429215";
const DIPPING_SAUCES = "8718a11f-fe77-4745-877c-48a7bf17b6ab";

async function main() {
  const { getSql } = await import("../src/lib/db");
  const { ensureOrderingMenuOverrideSchema } = await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  const sql = getSql();

  await sql`
    INSERT INTO ordering_modifier_presentation_overrides (
      item_id, group_id, context, included_choice_count, presentation_style, updated_by
    )
    VALUES (
      ${FATHEAD_SPECIAL}, ${DIPPING_SAUCES}, 'ordinary', 1, 'grid',
      'fathead-special-included-sauce'
    )
    ON CONFLICT (item_id, group_id) DO UPDATE
    SET context = EXCLUDED.context,
        included_choice_count = EXCLUDED.included_choice_count,
        presentation_style = EXCLUDED.presentation_style,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
  `;

  console.log(JSON.stringify({
    item: "Fathead Special",
    modifierGroup: "Dipping Sauces (4oz)",
    includedChoices: 1,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
