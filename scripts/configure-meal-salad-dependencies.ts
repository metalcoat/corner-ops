#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const SALAD = "616994ef-6c0a-4f3f-b787-38abc7a481c9";
const SMALL_DRESSING = "f1500000-0000-4000-8000-000000000001";
const LARGE_DRESSING = "f1500000-0000-4000-8000-000000000002";
const SMALL_CRUMBLY = "ffe07150-85f5-4f6c-9c24-019de8a1f562";
const LARGE_CRUMBLY = "2d69bb22-8f82-40c8-b278-3feeb13d1e66";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingMenuOverrideSchema } =
    await import("../src/lib/ordering-menu-overrides");
  await ensureOrderingMenuOverrideSchema();
  let configured = 0;
  await withTransaction(async () => {
    const sql = getSql();
    await sql`UPDATE ordering_modifier_groups SET allow_option_quantity=TRUE,max_selections=6,updated_at=NOW() WHERE id IN (${SMALL_DRESSING},${LARGE_DRESSING})`;
    await sql`UPDATE ordering_modifier_options SET name=regexp_replace(name,'\\s*\\(On Salad\\)$','','i')||' (On Salad)',price_delta_cents=75,updated_at=NOW() WHERE group_id=${SMALL_DRESSING} AND name NOT ILIKE 'No Dressing%'`;
    await sql`UPDATE ordering_modifier_options SET price_delta_cents=0,updated_at=NOW() WHERE group_id=${SMALL_DRESSING} AND name ILIKE 'No Dressing%'`;
    await sql`UPDATE ordering_modifier_options SET price_delta_cents=175,updated_at=NOW() WHERE group_id=${LARGE_DRESSING}`;

    const saladOptions =
      await sql`SELECT id,name FROM ordering_modifier_options WHERE group_id=${SALAD} AND active=TRUE AND available=TRUE`;
    const smallIds = saladOptions
      .filter((row) => /^SM Tossed Sal$/i.test(String(row.name)))
      .map((row) => row.id);
    const largeIds = saladOptions
      .filter((row) => /^(?:LG|Roni) Tossed Sal$/i.test(String(row.name)))
      .map((row) => row.id);
    const items = await sql`
      SELECT item.id
      FROM ordering_menu_items item
      JOIN ordering_menu_item_modifier_groups link ON link.item_id=item.id AND link.group_id=${SALAD}
      LEFT JOIN ordering_item_overrides item_override ON item_override.item_id=item.id
      WHERE item.business='Corner Deli' AND item.active=TRUE
        AND COALESCE(item_override.visible,TRUE)=TRUE
    `;
    for (const item of items) {
      for (const [groupId, order] of [
        [SMALL_DRESSING, 20],
        [LARGE_DRESSING, 21],
        [SMALL_CRUMBLY, 22],
        [LARGE_CRUMBLY, 23],
      ] as const) {
        await sql`INSERT INTO ordering_menu_item_modifier_groups(id,item_id,group_id,sort_order) VALUES(gen_random_uuid(),${item.id},${groupId},${order}) ON CONFLICT(item_id,group_id) DO UPDATE SET sort_order=EXCLUDED.sort_order`;
      }
      for (const [groupId, parentOptionIds, order, included] of [
        [SMALL_DRESSING, smallIds, 20, 1],
        [LARGE_DRESSING, largeIds, 21, 1],
        [SMALL_CRUMBLY, smallIds, 22, null],
        [LARGE_CRUMBLY, largeIds, 23, null],
      ] as const) {
        await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,parent_group_id,parent_option_ids,presentation_style,component_order,included_choice_count,updated_by)
          VALUES(${item.id},${groupId},'dependent',${SALAD},${parentOptionIds},'staged',${order},${included},'meal-salad-dependencies')
          ON CONFLICT(item_id,group_id) DO UPDATE SET context='dependent',parent_group_id=${SALAD},parent_option_ids=${parentOptionIds},presentation_style='staged',component_order=${order},included_choice_count=${included},updated_by='meal-salad-dependencies',updated_at=NOW()`;
      }
      await sql`INSERT INTO ordering_modifier_presentation_overrides(item_id,group_id,context,updated_by)
        SELECT ${item.id},group_id,'hidden','meal-salad-dependencies'
        FROM ordering_menu_item_modifier_groups link
        JOIN ordering_modifier_groups legacy ON legacy.id=link.group_id
        WHERE link.item_id=${item.id} AND legacy.name IN ('Choose Dressing','Dressing/Options')
          AND link.group_id NOT IN (${SMALL_DRESSING},${LARGE_DRESSING})
        ON CONFLICT(item_id,group_id) DO UPDATE SET context='hidden',updated_by='meal-salad-dependencies',updated_at=NOW()`;
      configured += 1;
    }
  });
  console.log(
    JSON.stringify(
      {
        configuredMeals: configured,
        fishFryIncluded: true,
        smallDressingSuffix: "(On Salad)",
        smallAdditionalDressingCents: 75,
        largeAdditionalDressingCents: 175,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
