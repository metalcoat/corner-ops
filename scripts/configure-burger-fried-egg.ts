#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main() {
  const { getSql } = await import("../src/lib/db");
  const sql = getSql();
  const rows = await sql`
    UPDATE ordering_modifier_options option
    SET price_delta_cents = 175, updated_at = NOW()
    FROM ordering_modifier_groups modifier_group
    WHERE modifier_group.id = option.group_id
      AND modifier_group.business = 'Corner Deli'
      AND modifier_group.name = 'Burger Toppings'
      AND modifier_group.active = TRUE
      AND option.name IN ('Egg', 'Fried Egg')
      AND option.active = TRUE
    RETURNING option.id, modifier_group.id AS group_id, option.name, option.price_delta_cents
  `;

  if (rows.length === 0) {
    throw new Error("No active burger fried egg options were found");
  }

  console.log(JSON.stringify({ updated: rows.length, options: rows }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
