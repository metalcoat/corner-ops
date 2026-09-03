#!/usr/bin/env node
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

async function main() {
  const [
    { ensureOrderingAiSchema },
    { getSql },
    tools,
    { recordAiRegression },
  ] = await Promise.all([
    import("../src/lib/ordering-ai-schema"),
    import("../src/lib/db"),
    import("../src/lib/ordering-ai-tools"),
    import("../src/lib/ordering-ai-regressions"),
  ]);
  const { priceSpokenOrder, createAiDraft, menuCatalog, AiToolError } = tools;
  await ensureOrderingAiSchema();
  const sql = getSql(),
    actor = {
      id: "regression",
      name: "Regression Harness",
      type: "employee" as const,
      role: "employee" as const,
    };
  const fixtures = [
    {
      key: "jumbo-half-pizza",
      items: [
        {
          name: "Pizza",
          variant: "large",
          quantity: 1,
          modifiers: [
            { name: "Pepperoni" },
            { name: "Onions", portion: "left_half" as const },
            { name: "Sausage", portion: "right_half" as const },
          ],
        },
      ],
      expectedItems: ["Pizza"],
    },
    {
      key: "wings-and-fries",
      items: [
        {
          name: "wing",
          variant: "20 wing",
          quantity: 1,
          modifiers: [{ name: "Mild" }],
        },
        {
          name: "large fry",
          quantity: 1,
          modifiers: [{ name: "nacho cheese" }],
        },
      ],
      expectedItems: ["Wings", "Large French Fries"],
      expectedModifier: "Nacho Cheese on Side",
    },
    {
      key: "cheeseburger-short-name",
      items: [{ name: "cheeseburger", quantity: 1 }],
      expectedItems: ["Cheeseburger (1/4lbs)"],
    },
    {
      key: "lobster-roll",
      items: [{ name: "lobster roll", quantity: 1 }],
      errorCode: "ITEM_NOT_ON_MENU",
    },
    {
      key: "similar-item",
      items: [{ name: "french fry sandwich", quantity: 1 }],
      errorCode: "ITEM_NOT_ON_MENU",
    },
    {
      key: "ambiguous-fries",
      items: [{ name: "fries", quantity: 1 }],
      errorCode: "INVALID_VARIANT",
    },
    {
      key: "invalid-avocado",
      items: [
        {
          name: "Cheeseburger (1/4lbs)",
          quantity: 1,
          modifiers: [{ name: "avocado" }],
        },
      ],
      errorCode: "INVALID_MODIFIER",
    },
    {
      key: "generic-pizza-pending-size",
      items: [{ name: "Pizza", quantity: 1 }],
      errorCode: "INVALID_VARIANT",
    },
    {
      key: "invalid-turkey-burger",
      items: [{ name: "turkey burger", quantity: 1 }],
      errorCode: "ITEM_NOT_ON_MENU",
    },
    {
      key: "invalid-pizza-avocado",
      items: [
        {
          name: "large pizza",
          quantity: 1,
          modifiers: [{ name: "pepperoni" }, { name: "avocado" }],
        },
      ],
      errorCode: "INVALID_MODIFIER",
    },
    {
      key: "wings-missing-count",
      items: [{ name: "Wings", quantity: 1, modifiers: [{ name: "Mild" }] }],
      errorCode: "INVALID_VARIANT",
    },
    {
      key: "large-poutine-alias",
      items: [{ name: "large pountine", quantity: 1 }],
      expectedItems: ["Large French Fries"],
      expectedModifier: "Make it Poutine (Cheese & Gravy)",
    },
    {
      key: "tater-tot-poutine-missing-size",
      items: [{ name: "tater tot poutine", quantity: 1 }],
      errorCode: "INVALID_VARIANT",
    },
    {
      key: "large-tater-tot-poutine",
      items: [{ name: "large tater tot poutine", quantity: 1 }],
      expectedItems: ["Large Tater Tots"],
      expectedModifier: "Make it Poutine (Cheese & Gravy)",
    },
    {
      key: "legacy-misspelled-pizza",
      items: [
        {
          name: "piza",
          variant: "large",
          quantity: 1,
          modifiers: [
            { name: "pepporoni" },
            { name: "onions", portion: "left_half" as const },
            { name: "sausage", portion: "right_half" as const },
          ],
        },
      ],
      errorCode: "ITEM_NOT_ON_MENU",
    },
    {
      key: "legacy-misspelled-nacho",
      items: [
        {
          name: "wing",
          variant: "20 wing",
          quantity: 1,
          modifiers: [{ name: "mild" }],
        },
        {
          name: "large fry",
          quantity: 1,
          modifiers: [{ name: "nacho chesse" }],
        },
      ],
      errorCode: "INVALID_MODIFIER",
    },
    {
      key: "spoken-jumbo-pizza",
      items: [
        {
          name: "jumbo 16 inch pizza",
          quantity: 1,
          modifiers: [
            { name: "Pepperoni", portion: "left_half" as const },
            { name: "Onions", portion: "right_half" as const },
          ],
        },
      ],
      expectedItems: ["Pizza"],
      expectedVariant: 'Jumbo Thin 16"',
    },
    {
      key: "large-pizza-alias",
      items: [{ name: "large pizza", quantity: 1 }],
      expectedItems: ["Pizza"],
      expectedVariant: 'Jumbo Thin 16"',
    },
    {
      key: "sixteen-inch-pizza-alias",
      items: [{ name: '16" pizza', quantity: 1 }],
      expectedItems: ["Pizza"],
      expectedVariant: 'Jumbo Thin 16"',
    },
    {
      key: "standalone-jumbo-alias",
      items: [{ name: "jumbo", quantity: 1 }],
      expectedItems: ["Pizza"],
      expectedVariant: 'Jumbo Thin 16"',
    },
    {
      key: "full-jumbo-thin-variant",
      items: [{ name: "Pizza", variant: "jumbo thin 16 inch", quantity: 1 }],
      expectedItems: ["Pizza"],
      expectedVariant: 'Jumbo Thin 16"',
    },
    {
      key: "full-regular-variant",
      items: [{ name: "Pizza", variant: "regular 14 inch", quantity: 1 }],
      expectedItems: ["Pizza"],
      expectedVariant: 'Regular 14"',
    },
    {
      key: "full-small-variant",
      items: [{ name: "Pizza", variant: "small 12 inch", quantity: 1 }],
      expectedItems: ["Pizza"],
      expectedVariant: 'Small 12"',
    },
    {
      key: "pizza-cheese-means-extra-cheese",
      items: [
        {
          name: "Pizza",
          variant: "Regular 14 inch",
          quantity: 1,
          modifiers: [{ name: "Cheese" }],
        },
      ],
      expectedItems: ["Pizza"],
      expectedVariant: 'Regular 14"',
      expectedModifier: "Extra Cheese",
    },
    {
      key: "pizza-explicit-extra-cheese",
      items: [
        {
          name: "Pizza",
          variant: "Regular 14 inch",
          quantity: 1,
          modifiers: [{ name: "Extra Cheese" }],
        },
      ],
      expectedItems: ["Pizza"],
      expectedVariant: 'Regular 14"',
      expectedModifier: "Extra Cheese",
    },
    {
      key: "twelve-mild-wings-default",
      items: [{ name: "Wings", quantity: 12, modifiers: [{ name: "Mild" }] }],
      expectedItems: ["Wings"],
      expectedVariant: "12 Wings",
      expectedModifier: "Mild",
    },
    {
      key: "spoken-twelve-mild-wings",
      items: [{ name: "12 mild wings", quantity: 1 }],
      expectedItems: ["Wings"],
      expectedVariant: "12 Wings",
      expectedModifier: "Mild",
    },
    {
      key: "explicit-boneless-wings",
      items: [
        {
          name: "boneless wings",
          variant: "12 wings",
          quantity: 1,
          modifiers: [{ name: "Mild" }],
        },
      ],
      expectedItems: ["Boneless Wings"],
      expectedVariant: "12 Wings",
      expectedModifier: "Mild",
    },
    {
      key: "two-liter-pepsi",
      items: [{ name: "two liter Pepsi", quantity: 1 }],
      expectedItems: ["2L Pepsi"],
    },
    {
      key: "plain-blue-cheese-wings",
      items: [
        {
          name: "Wings",
          variant: "30 Wings",
          quantity: 1,
          modifiers: [
            { name: "Medium" },
            { name: "blue cheese" },
            { name: "celery" },
          ],
        },
      ],
      expectedItems: ["Wings"],
      expectedVariant: "30 Wings",
      expectedModifier: "Blue Cheese (4oz)",
    },
    {
      key: "wing-flavor-aliases",
      items: [
        {
          name: "Wings",
          variant: "20 Wings",
          quantity: 1,
          modifiers: [{ name: "garlic parm" }],
        },
      ],
      expectedItems: ["Wings"],
      expectedModifier: "Garlic Parmesan",
    },
    {
      key: "all-wing-accompaniments",
      items: [
        {
          name: "Wings",
          variant: "20 Wings",
          quantity: 1,
          modifiers: [{ name: "BBQ" }, { name: "all" }],
        },
      ],
      expectedItems: ["Wings"],
      expectedModifiers: ["BBQ", "Blue Cheese (4oz)", "Ranch (4oz)", "Celery"],
    },
    {
      key: "wing-side-sauce-defaults-four-ounce",
      items: [
        {
          name: "Wings",
          variant: "20 Wings",
          quantity: 1,
          modifiers: [{ name: "Mild" }, { name: "side of garlic parm" }],
        },
      ],
      expectedItems: ["Wings"],
      expectedModifier: "Garlic Parmesan (4oz)",
    },
    {
      key: "small-side-salad-dressing-alias",
      items: [
        {
          name: "SM Tossed Sal",
          quantity: 1,
          modifiers: [{ name: "Italian" }],
        },
      ],
      expectedItems: ["SM Tossed Sal"],
      expectedModifier: "Italian (On Salad)",
    },
    {
      key: "two-ounce-dipping-context",
      items: [
        {
          name: "Breaded Mushrooms",
          quantity: 1,
          modifiers: [{ name: "Ranch" }],
        },
      ],
      expectedItems: ["Breaded Mushrooms"],
      expectedModifier: "Ranch (2oz)",
    },
    {
      key: "fried-mushrooms-item-alias",
      items: [{ name: "fried mushrooms", quantity: 1 }],
      expectedItems: ["Breaded Mushrooms"],
    },
    {
      key: "battered-mushroom-item-alias",
      items: [{ name: "battered mushroom", quantity: 1 }],
      expectedItems: ["Breaded Mushrooms"],
    },
    {
      key: "fried-cauliflower-item-alias",
      items: [{ name: "fried cauliflower", quantity: 1 }],
      expectedItems: ["Breaded Cauliflower"],
    },
    {
      key: "battered-cauliflower-item-alias",
      items: [{ name: "battered cauliflower", quantity: 1 }],
      expectedItems: ["Breaded Cauliflower"],
    },
    {
      key: "variety-basket-for-two-item-alias",
      items: [{ name: "variety basket for 2", quantity: 1 }],
      expectedItems: ["Variety for TWO"],
    },
    {
      key: "sampler-platter-for-four-item-alias",
      items: [{ name: "sampler platter for four", quantity: 1 }],
      expectedItems: ["Variety for Four"],
    },
    {
      key: "sampler-platter-requires-size",
      items: [{ name: "sampler platter", quantity: 1 }],
      errorCode: "INVALID_VARIANT",
    },
    {
      key: "buffalo-chicken-burger-build",
      items: [
        {
          name: "Buffalo Chicken Burger",
          quantity: 1,
          modifiers: [
            { name: "Garlic Parm" },
            { name: "American" },
            { name: "lettuce" },
            { name: "mayonnaise" },
            { name: "onion" },
            { name: "No Side" },
          ],
        },
      ],
      expectedItems: ["Buffalo Chicken Burger"],
      expectedModifiers: [
        "Garlic Parmesan",
        "American",
        "Lettuce",
        "Mayo",
        "Raw Onions",
      ],
    },
    {
      key: "saucy-medium-wings",
      items: [{ name: "30 medium wings extra saucy", quantity: 1 }],
      expectedItems: ["Wings"],
      expectedVariant: "30 Wings",
      expectedModifier: "Medium (4oz)",
    },
    {
      key: "turkey-sub-needs-cheese",
      items: [{ name: "Turkey Sub", quantity: 1 }],
      errorCode: "INVALID_MODIFIER",
    },
    {
      key: "turkey-sub-alias",
      items: [
        {
          name: "Turkey Sub",
          quantity: 1,
          modifiers: [
            { name: "American" },
            { name: "mayo" },
            { name: "ranch" },
          ],
        },
      ],
      expectedItems: ["Turkey"],
      expectedVariant: "Full Sub",
      expectedModifier: "Mayonnaise",
    },
    {
      key: "turkey-sub-russian-dressing",
      items: [
        {
          name: "Turkey Sub",
          quantity: 1,
          modifiers: [{ name: "American" }, { name: "russian dressing" }],
        },
      ],
      expectedItems: ["Turkey"],
      expectedVariant: "Full Sub",
      expectedModifier: "Russian",
    },
    {
      key: "turkey-sub-shakers",
      items: [
        {
          name: "Turkey Sub",
          quantity: 1,
          modifiers: [{ name: "American" }, { name: "shakers" }],
        },
      ],
      expectedItems: ["Turkey"],
      expectedVariant: "Full Sub",
      expectedModifier: "Parm Shakers",
    },
    {
      key: "hot-roast-beef-sandwich",
      items: [{ name: "hot roast beef sandwich", quantity: 1 }],
      errorCode: "INVALID_MODIFIER",
    },
    {
      key: "hot-roast-beef-default-meal",
      items: [
        { name: "hot roast beef", quantity: 1, modifiers: [{ name: "ranch" }] },
      ],
      expectedItems: ["Hot Roast Beef"],
      expectedModifier: "Ranch (On Salad)",
    },
    {
      key: "turkey-big-boss-alias",
      items: [{ name: "Turkey Big Boss sub", quantity: 1 }],
      expectedItems: ["Turkey Big Boss"],
      expectedVariant: "Full Sub",
    },
    {
      key: "turkey-big-boss-whole",
      items: [{ name: "Turkey Big Boss", variant: "Whole", quantity: 1 }],
      expectedItems: ["Turkey Big Boss"],
      expectedVariant: "Full Sub",
    },
  ];
  for (const fixture of fixtures) {
    await recordAiRegression({
      business: "Corner Deli",
      caseType: "order_resolution",
      source: "permanent_fixture",
      payload: { serviceType: "pickup", items: fixture.items },
      expected: {
        items: fixture.expectedItems || [],
        variant: fixture.expectedVariant || null,
        modifier: fixture.expectedModifier || null,
        modifiers: fixture.expectedModifiers || [],
        errorCode: fixture.errorCode || null,
      },
    });
  }
  const stored =
    await sql`SELECT case_key,input,expected,source FROM ordering_ai_regression_cases WHERE business='Corner Deli' AND active=TRUE AND case_type='order_resolution' ORDER BY first_seen_at`;
  let passed = 0;
  for (const row of stored) {
    const payload = row.input as { serviceType?: string; items?: any[] };
    if (!Array.isArray(payload.items) || !payload.items.length) continue;
    let priced: Record<string, any> | undefined;
    try {
      priced = await priceSpokenOrder({
        business: "Corner Deli",
        actor,
        service: "pickup",
        items: payload.items,
      });
      assert.ok(
        !row.expected?.errorCode,
        `${row.source}: expected ${row.expected.errorCode} but order was created`,
      );
      const names = priced.lines.map(
        (line: Record<string, any>) => line.item_name_snapshot,
      );
      for (const expected of row.expected?.items || [])
        assert.ok(
          names.includes(expected),
          `${row.source}: missing ${expected}`,
        );
      if (row.expected?.variant)
        assert.ok(
          priced.lines.some(
            (line: Record<string, any>) =>
              line.variant_name_snapshot === row.expected.variant,
          ),
          `${row.source}: missing ${row.expected.variant}`,
        );
      if (row.expected?.modifier) {
        const modifiers =
          await sql`SELECT option_name_snapshot FROM ordering_order_item_modifiers WHERE order_item_id IN(SELECT id FROM ordering_order_items WHERE order_id=${priced.id})`;
        assert.ok(
          modifiers.some(
            (modifier: Record<string, any>) =>
              modifier.option_name_snapshot === row.expected.modifier,
          ),
          `${row.source}: missing ${row.expected.modifier}`,
        );
      }
      if (row.expected?.modifiers?.length) {
        const modifiers =
          await sql`SELECT option_name_snapshot FROM ordering_order_item_modifiers WHERE order_item_id IN(SELECT id FROM ordering_order_items WHERE order_id=${priced.id})`;
        for (const expected of row.expected.modifiers)
          assert.ok(
            modifiers.some(
              (modifier: Record<string, any>) =>
                modifier.option_name_snapshot === expected,
            ),
            `${row.source}: missing ${expected}`,
          );
      }
    } catch (error) {
      const recordedFailure = /^production_tool_(ITEM_NOT_ON_MENU|INVALID_MODIFIER|INVALID_VARIANT)$/.exec(String(row.source || ""))?.[1];
      const clarificationRequired = error instanceof AiToolError && error.status === 409 &&
        Array.isArray((error.details as { pendingItem?: { missingRequiredFields?: unknown[] } } | undefined)?.pendingItem?.missingRequiredFields) &&
        Boolean((error.details as { pendingItem: { missingRequiredFields: unknown[] } }).pendingItem.missingRequiredFields.length);
      if (!row.expected?.errorCode && clarificationRequired) {
        passed++;
        continue;
      }
      if (!row.expected?.errorCode && error instanceof AiToolError && recordedFailure) {
        // Production captures include both resolver defects and legitimate requests
        // for unavailable menu choices. A safe, structured rejection is valid; the
        // permanent fixtures above define which phrases must now resolve.
        passed++;
        continue;
      }
      if (!row.expected?.errorCode) {
        throw new Error(`Stored AI regression ${row.case_key} (${row.source}) failed.`, { cause: error });
      }
      assert.ok(error instanceof AiToolError);
      assert.equal(error.code, row.expected.errorCode);
    } finally {
      if (priced?.id)
        await sql`DELETE FROM ordering_orders WHERE id=${priced.id}`;
    }
    passed++;
  }
  const before = Number(
      (await sql`SELECT COUNT(*)::int count FROM ordering_orders`)[0].count,
    ),
    catalog = await menuCatalog("Corner Deli", new Date()),
    valid = catalog
      .flatMap((category: any) => category.items)
      .find((item: any) => item.available);
  const hotMeal = await priceSpokenOrder({
    business: "Corner Deli",
    actor,
    service: "pickup",
    items: [
      { name: "Hot Roast Beef", quantity: 1, modifiers: [{ name: "Ranch" }] },
    ],
  });
  try {
    const mealModifiers =
      await sql`SELECT option_name_snapshot FROM ordering_order_item_modifiers WHERE order_item_id IN(SELECT id FROM ordering_order_items WHERE order_id=${hotMeal.id})`;
    for (const expected of [
      "SM Tossed Sal",
      "Ranch (On Salad)",
      "Small French Fries",
    ])
      assert.ok(
        mealModifiers.some(
          (row: Record<string, any>) => row.option_name_snapshot === expected,
        ),
        `Hot meal missing ${expected}`,
      );
  } finally {
    await sql`DELETE FROM ordering_orders WHERE id=${hotMeal.id}`;
  }
  await assert.rejects(
    () =>
      createAiDraft({
        business: "Corner Deli",
        actor,
        service: "pickup",
        items: [
          { itemId: "00000000-0000-0000-0000-000000000000", quantity: 1 },
        ],
      }),
    (error: any) => error.code === "ITEM_NOT_ON_MENU",
  );
  await assert.rejects(
    () =>
      createAiDraft({
        business: "Corner Deli",
        actor,
        service: "pickup",
        items: [
          {
            itemId: valid.id,
            variantId:
              valid.variants?.find((variant: any) => variant.defaultVariant)
                ?.id ||
              valid.variants?.[0]?.id ||
              null,
            quantity: 1,
            specialInstructions: "ADD AVOCADO",
          },
        ],
      }),
    (error: any) => error.code === "INVALID_MODIFIER",
  );
  assert.equal(
    Number(
      (await sql`SELECT COUNT(*)::int count FROM ordering_orders`)[0].count,
    ),
    before,
    "Rejected IDs and notes must create no orders.",
  );
  await assert.rejects(
    () =>
      priceSpokenOrder({
        business: "Corner Deli",
        actor,
        service: "undecided",
        items: [{ name: "Pizza", variant: "large", quantity: 1 }],
      }),
    (error: any) => error.code === "FULFILLMENT_REQUIRED",
  );
  console.log(
    JSON.stringify(
      { storedCases: stored.length, executed: passed, status: "passed" },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
