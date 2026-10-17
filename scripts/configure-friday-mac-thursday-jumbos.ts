#!/usr/bin/env node
import { localValidationEnv } from "./validation-env";

localValidationEnv();

const PROMOTION_ID = "d3000000-0000-4000-8000-000000000004";

async function main() {
  const { getSql, withTransaction } = await import("../src/lib/db");
  const { ensureOrderingPromotionSchema } = await import("../src/lib/ordering-promotion-schema");
  const { ensureOrderingTimingSchema } = await import("../src/lib/ordering-timing-schema");
  await Promise.all([ensureOrderingPromotionSchema(), ensureOrderingTimingSchema()]);

  const result = await withTransaction(async () => {
    const sql = getSql();
    const macOptions = await sql`
      SELECT option.id
      FROM ordering_modifier_options option
      JOIN ordering_modifier_groups modifier_group ON modifier_group.id = option.group_id
      WHERE modifier_group.business = 'Corner Deli'
        AND LOWER(option.name) = 'mac and cheese'
        AND option.active = TRUE
    `;
    if (!macOptions.length) throw new Error("No Mac and Cheese side options were found.");
    for (const option of macOptions) {
      await sql`
        INSERT INTO ordering_menu_availability_rules(
          id,business,target_type,target_id,enabled,days_of_week,updated_by
        ) VALUES(
          gen_random_uuid(),'Corner Deli','modifier_option',${option.id},TRUE,ARRAY[5]::smallint[],'friday-mac-thursday-jumbos'
        )
        ON CONFLICT(business,target_type,target_id) DO UPDATE SET
          enabled=TRUE,days_of_week=ARRAY[5]::smallint[],starts_at=NULL,ends_at=NULL,
          valid_from=NULL,valid_through=NULL,updated_by=EXCLUDED.updated_by,updated_at=NOW()
      `;
    }

    const jumboVariants = await sql`
      SELECT variant.id
      FROM ordering_menu_item_variants variant
      JOIN ordering_menu_items item ON item.id = variant.item_id
      WHERE item.business = 'Corner Deli'
        AND item.name = 'Pizza'
        AND variant.name ILIKE 'Jumbo%'
        AND item.active = TRUE AND variant.active = TRUE
    `;
    if (!jumboVariants.length) throw new Error("No Jumbo Pizza variants were found.");
    const rule = {
      components: [{ id: "jumbo-pizza", quantity: 1, variantIds: jumboVariants.map((row) => String(row.id)) }],
      repeatable: true,
      daysOfWeek: [4],
      startDate: null,
      endDate: null,
      startTime: null,
      endTime: null,
      serviceTypes: [],
      channels: [],
      includedDates: [],
      excludedDates: [],
    };
    const adjustment = { bundlePriceCents: 0, amountOffCents: 300, percentBasisPoints: 0, modifierAllowances: [] };
    await sql`
      INSERT INTO ordering_promotions(
        id,business,name,customer_label,internal_description,promotion_type,priority,rule,adjustment,
        active,automatic,stackable,stackable_with_loyalty,exclusive_group,created_by,version
      ) VALUES(
        ${PROMOTION_ID},'Corner Deli','Thursday Jumbo Pizza','Thursday Jumbo — $3 Off',
        'Automatically takes $3 off each Jumbo Thin or Jumbo Thick Pizza on Thursdays.',
        'amount_off',100,${JSON.stringify(rule)}::jsonb,${JSON.stringify(adjustment)}::jsonb,
        TRUE,TRUE,FALSE,FALSE,'pizza-base','friday-mac-thursday-jumbos',1
      )
      ON CONFLICT(id) DO UPDATE SET
        name=EXCLUDED.name,customer_label=EXCLUDED.customer_label,
        internal_description=EXCLUDED.internal_description,promotion_type=EXCLUDED.promotion_type,
        priority=EXCLUDED.priority,rule=EXCLUDED.rule,adjustment=EXCLUDED.adjustment,
        active=TRUE,automatic=TRUE,stackable=FALSE,stackable_with_loyalty=FALSE,
        exclusive_group=EXCLUDED.exclusive_group,version=ordering_promotions.version+1,updated_at=NOW()
    `;
    return { macOptions: macOptions.length, jumboVariants: jumboVariants.length };
  });

  console.log(JSON.stringify({
    fridayOnly: { item: "Mac and Cheese side option", weekday: "Friday", configuredOptions: result.macOptions },
    promotion: { label: "Thursday Jumbo — $3 Off", weekday: "Thursday", discountCents: 300, eligibleVariants: result.jumboVariants },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
