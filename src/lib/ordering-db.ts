import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db";

let orderingSchemaPromise: Promise<void> | null = null;

/**
 * Creates the database foundation shared by POS, web, kiosk, and AI ordering.
 *
 * This intentionally lives outside the legacy/core schema initializer so the
 * ordering platform can be developed and validated independently before any
 * production cutover.
 */
export function ensureOrderingSchema(): Promise<void> {
  if (!orderingSchemaPromise) {
    orderingSchemaPromise = (async () => {
      const sql = getSql();

      // Rezku's authoritative category names contain paths separated by " / ".
      // Materialize only those explicit paths; never guess relationships.
      const categoryPaths = await sql`SELECT id, business, name, sort_order FROM ordering_menu_categories WHERE active = TRUE`;
      for (const category of categoryPaths) {
        const parts = String(category.name).split(" / ").map((part) => part.trim()).filter(Boolean);
        if (parts.length < 2) {
          // Fill in a missing display name only: managers rename and re-parent
          // categories in the menu editor, and a restart must not undo that.
          await sql`UPDATE ordering_menu_categories SET display_name = ${parts[0] || String(category.name)}
            WHERE id = ${category.id} AND COALESCE(display_name, '') = ''`;
          // A category that holds items can't be a heading only.
          await sql`UPDATE ordering_menu_categories SET presentation_only = FALSE
            WHERE id = ${category.id} AND presentation_only AND EXISTS (SELECT 1 FROM ordering_menu_items WHERE category_id = ${category.id})`;
          continue;
        }
        const parentName = parts.slice(0, -1).join(" / ");
        const parents = await sql`
          INSERT INTO ordering_menu_categories (id, business, name, display_name, sort_order, active, presentation_only)
          VALUES (${randomUUID()}, ${category.business}, ${parentName}, ${parts[parts.length - 2]}, ${category.sort_order}, TRUE, TRUE)
          ON CONFLICT (business, name) DO UPDATE SET active = TRUE, updated_at = NOW()
          RETURNING id
        `;
        // Only the first time (no parent yet); later edits in the menu editor stand.
        await sql`UPDATE ordering_menu_categories SET parent_id = ${parents[0].id}, display_name = ${parts[parts.length - 1]}, presentation_only = FALSE WHERE id = ${category.id} AND parent_id IS NULL`;
      }

      // Egg already exists as a priced deli modifier. Recorded burger orders
      // require the same choice to be visible through every ordering channel.
      await sql`
        INSERT INTO ordering_modifier_options (
          id, group_id, name, price_delta_cents, available, active, sort_order
        )
        SELECT gen_random_uuid(), burger.id, 'Egg', 175, TRUE, TRUE,
               COALESCE((SELECT MAX(option.sort_order) + 1 FROM ordering_modifier_options option WHERE option.group_id = burger.id), 1)
        FROM ordering_modifier_groups burger
        JOIN ordering_modifier_groups salad ON salad.business = burger.business AND salad.name = 'Salad Egg Mod'
        JOIN ordering_modifier_options egg ON egg.group_id = salad.id AND egg.name = 'Egg' AND egg.active = TRUE
        WHERE burger.business = 'Corner Deli' AND burger.name = 'Burger Toppings'
        ON CONFLICT (group_id, name) DO NOTHING
      `;
      // (Added once; its price and availability are managed in the menu editor afterwards.)
    })().catch((error) => {
      orderingSchemaPromise = null;
      throw error;
    });
  }

  return orderingSchemaPromise;
}
