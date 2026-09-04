#!/usr/bin/env node
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";

localValidationEnv();

async function main() {
  const [{ ensureOrderingAiSchema }, { getSql }, tools, sideband] = await Promise.all([
    import("../src/lib/ordering-ai-schema"),
    import("../src/lib/db"),
    import("../src/lib/ordering-ai-tools"),
    import("../src/lib/openai-phone-sideband"),
  ]);
  const { AiToolError, compositeModifierEffects, priceSpokenOrder } = tools;
  const { applyPendingModifierAnswer, incrementalSpokenCart } = sideband;
  await ensureOrderingAiSchema();
  const sql = getSql();
  const actor = {
    id: "natural-alias-regression",
    name: "Natural Alias Regression",
    type: "employee" as const,
    role: "employee" as const,
  };
  const created: string[] = [];

  async function price(name: string): Promise<Record<string, any>> {
    const result = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      items: [{ name, quantity: 1 }],
    });
    created.push(result.id);
    const modifiers = await sql`
      SELECT option_name_snapshot
      FROM ordering_order_item_modifiers
      WHERE order_item_id IN (
        SELECT id FROM ordering_order_items WHERE order_id=${result.id}
      )
    `;
    return {
      ...result,
      modifierNames: modifiers.map((row) =>
        String(row.option_name_snapshot),
      ) as string[],
    };
  }

  async function expectError(name: string, message: RegExp) {
    await assert.rejects(
      () => price(name),
      (error: unknown) =>
        error instanceof AiToolError &&
        message.test(`${error.message} ${error.remedy}`),
      name,
    );
  }

  try {
    let result = await price("cheeseburger");
    assert.equal(result.lines[0].item_name_snapshot, "Cheeseburger (1/4lbs)");

    const burgerWithUpsoldFries = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      items: [
        {
          name: "Cactus Burger",
          quantity: 1,
          modifiers: [{ name: "Large Fry" }],
        },
      ],
    });
    created.push(burgerWithUpsoldFries.id);
    assert.ok(
      burgerWithUpsoldFries.lines.some(
        (line: Record<string, any>) =>
          line.item_name_snapshot === "Cactus Burger",
      ),
      "The burger upsell must preserve the Cactus Burger line.",
    );
    assert.ok(
      burgerWithUpsoldFries.lines.some(
        (line: Record<string, any>) =>
          line.item_name_snapshot === "Large French Fries",
      ),
      "A fry supplied as a burger modifier must become a separate French Fries line.",
    );

    result = await price("salt and vinegar chips");
    assert.equal(
      result.lines[0].item_name_snapshot,
      "Humpty Dumpty Salt & Vinegar",
    );

    result = await price("large fries with nacho");
    assert.equal(result.lines[0].item_name_snapshot, "Large French Fries");
    assert.ok(result.modifierNames.includes("Nacho Cheese on Side"));
    await expectError("fries with nacho", /Small or large/i);

    const nachoWithoutJalapenos = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      items: [
        {
          name: "Nacho Supreme",
          quantity: 1,
          modifiers: [{ name: "Remove Jalapenos" }],
        },
      ],
    });
    created.push(nachoWithoutJalapenos.id);
    const nachoModifiers = await sql`
      SELECT modifier.option_name_snapshot
      FROM ordering_order_item_modifiers modifier
      JOIN ordering_order_items item ON item.id=modifier.order_item_id
      WHERE item.order_id=${nachoWithoutJalapenos.id}
    `;
    assert.ok(
      nachoModifiers.some(
        (row) => String(row.option_name_snapshot) === "No Jalapenos",
      ),
      "Remove jalapenos must resolve to the canonical No Jalapenos modifier.",
    );

    await assert.rejects(
      () =>
        priceSpokenOrder({
          business: "Corner Deli",
          actor,
          service: "pickup",
          items: [
            { name: "Turkey", variant: "Full Sub", quantity: 1 },
          ],
        }),
      (error: unknown) =>
        error instanceof AiToolError &&
        error.code === "FOLLOW_UP_REQUIRED" &&
        error.message === "Mayo, Russian, oil, or shakers?",
      "Cold subs must ask the condiment group first.",
    );
    await assert.rejects(
      () =>
        priceSpokenOrder({
          business: "Corner Deli",
          actor,
          service: "pickup",
          items: [
            {
              name: "Turkey",
              variant: "Full Sub",
              quantity: 1,
              modifiers: [{ name: "Mayo" }],
            },
          ],
        }),
      (error: unknown) =>
        error instanceof AiToolError &&
        error.code === "FOLLOW_UP_REQUIRED" &&
        error.message === "Lettuce, tomato, onions, or hot peppers?",
      "Cold subs must ask vegetables second.",
    );
    await assert.rejects(
      () =>
        priceSpokenOrder({
          business: "Corner Deli",
          actor,
          service: "pickup",
          items: [
            {
              name: "Turkey",
              variant: "Full Sub",
              quantity: 1,
              modifiers: [{ name: "Mayo" }, { name: "Lettuce" }],
            },
          ],
        }),
      (error: unknown) =>
        error instanceof AiToolError &&
        error.message === "American, Swiss, or Provolone?",
      "Cold subs must ask the store's cheese question third without unrelated choices.",
    );

    const turkeyWithRawOnions = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      items: [
        {
          name: "Turkey",
          variant: "Full Sub",
          quantity: 1,
          modifiers: [
            { name: "Mayo" },
            { name: "Raw Onions" },
            { name: "Provolone" },
          ],
        },
      ],
    });
    created.push(turkeyWithRawOnions.id);
    const turkeyModifiers = await sql`
      SELECT modifier.option_name_snapshot
      FROM ordering_order_item_modifiers modifier
      JOIN ordering_order_items item ON item.id=modifier.order_item_id
      WHERE item.order_id=${turkeyWithRawOnions.id}
    `;
    assert.ok(
      turkeyModifiers.some(
        (row) => String(row.option_name_snapshot) === "Onion",
      ),
      "Raw onions must resolve directly to the Turkey sub's canonical Onion modifier.",
    );

    const hamburgerSteak = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      items: [
        {
          name: "Hamburger Steak",
          quantity: 1,
          modifiers: [
            { name: "Italian" },
            { name: "Mushrooms" },
            { name: "Onions" },
          ],
        },
      ],
    });
    created.push(hamburgerSteak.id);
    const hamburgerSteakModifiers = await sql`
      SELECT modifier.option_name_snapshot
      FROM ordering_order_item_modifiers modifier
      JOIN ordering_order_items item ON item.id=modifier.order_item_id
      WHERE item.order_id=${hamburgerSteak.id}
    `;
    assert.ok(
      ["Mushrooms", "Onions"].every((name) =>
        hamburgerSteakModifiers.some(
          (row) => String(row.option_name_snapshot) === name,
        ),
      ),
      "Hamburger Steak toppings must resolve through its own multi-select group.",
    );
    const pendingMashed = await applyPendingModifierAnswer({
      orderId: hamburgerSteak.id,
      pendingItem: {
        customerRequest: "Hamburger Steak",
        missingRequiredFields: ["mashed size"],
      },
      customerText: "small",
      operation: "add",
      targetItem: "",
      items: [
        {
          name: "Hamburger Steak",
          quantity: 1,
          modifiers: [{ name: "Small Mashed" }],
        },
      ],
    });
    assert.ok(
      pendingMashed.items[0].modifiers?.some(
        (modifier) => modifier.name === "Italian (On Salad)",
      ),
      "Mashed-size follow-up must retain the dressing already selected on Hamburger Steak (Meal).",
    );

    const hamburgerSteakMashed = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      customerText: "hamburger steak with small mashed potatoes",
      items: [
        {
          name: "Hamburger Steak",
          quantity: 1,
          modifiers: [{ name: "Italian" }],
        },
      ],
    });
    created.push(hamburgerSteakMashed.id);
    const hamburgerSteakMashedModifiers = await sql`
      SELECT modifier.option_name_snapshot
      FROM ordering_order_item_modifiers modifier
      JOIN ordering_order_items item ON item.id=modifier.order_item_id
      WHERE item.order_id=${hamburgerSteakMashed.id}
    `;
    assert.ok(
      hamburgerSteakMashedModifiers.some(
        (row) => String(row.option_name_snapshot) === "Small Mashed",
      ),
      "Hamburger Steak must accept mashed potatoes from natural customer wording even if the provider omits the modifier.",
    );

    const hamburgerSteakNaturalToppings = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      items: [
        {
          name: "Hamburger Steak",
          quantity: 1,
          modifiers: [
            { name: "Italian" },
            { name: "Small Mashed" },
            { name: "Mushrooms (On Burger/Steak)" },
            { name: "Cooked Onions (On Burger/Steak)" },
            { name: "Cooked Peppers (On Burger/Steak)" },
          ],
        },
      ],
    });
    created.push(hamburgerSteakNaturalToppings.id);
    const naturalToppings = await sql`
      SELECT modifier.option_name_snapshot
      FROM ordering_order_item_modifiers modifier
      JOIN ordering_order_items item ON item.id=modifier.order_item_id
      WHERE item.order_id=${hamburgerSteakNaturalToppings.id}
    `;
    assert.ok(
      naturalToppings.some((row) => String(row.option_name_snapshot) === "Onions") &&
        naturalToppings.some((row) => String(row.option_name_snapshot) === "Peppers"),
      "Hamburger Steak spoken cooked onions and sweet peppers must resolve to canonical options.",
    );

    const hamburgerSteakAll = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      customerText: "all of them",
      items: [
        {
          name: "Hamburger Steak",
          quantity: 1,
          modifiers: [{ name: "Italian" }, { name: "Small Mashed" }],
        },
      ],
    });
    created.push(hamburgerSteakAll.id);
    const allToppings = await sql`
      SELECT modifier.option_name_snapshot
      FROM ordering_order_item_modifiers modifier
      JOIN ordering_order_items item ON item.id=modifier.order_item_id
      WHERE item.order_id=${hamburgerSteakAll.id}
    `;
    assert.ok(
      ["Mushrooms", "Onions", "Peppers"].every((name) =>
        allToppings.some((row) => String(row.option_name_snapshot) === name),
      ),
      "All of them must select all three Hamburger Steak toppings.",
    );

    result = await price("small salad ranch");
    assert.equal(result.lines[0].item_name_snapshot, "SM Tossed Sal");
    assert.ok(
      result.modifierNames.some((name: string) =>
        /Ranch.*On Salad/i.test(name),
      ),
    );
    result = await price("small salad italian");
    assert.ok(
      result.modifierNames.some((name: string) =>
        /Italian.*On Salad/i.test(name),
      ),
    );

    await expectError("hot turkey with mashed", /Small or medium/i);
    result = await price("hot turkey with small salad ranch medium mashed");
    assert.equal(
      result.required_follow_up,
      "Gravy on the mashed potatoes?",
    );
    assert.ok(
      result.modifierNames.some((name: string) => /Medium Mashed/i.test(name)),
    );
    await expectError("hot turkey with medium mashed and gravy", /dressing/i);
    result = await price(
      "hot turkey with small salad ranch medium mashed and gravy",
    );
    assert.ok(
      result.modifierNames.some((name: string) => /Medium Mashed/i.test(name)),
    );
    assert.ok(
      result.modifierNames.some((name: string) => /^Gravy$/i.test(name)),
    );

    const reconstructedMeal = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      items: [
        {
          name: "Hot Roast Beef",
          quantity: 1,
          modifiers: [
            { name: "Italian (On Salad)" },
            { name: "Small Mashed" },
            { name: "Gravy on Mashed" },
          ],
        },
      ],
    });
    created.push(reconstructedMeal.id);
    const reconstructedWithWings = await incrementalSpokenCart(
      reconstructedMeal.id,
      "add",
      "",
      [
        {
          name: "Boneless Wings",
          variant: "30 Wings",
          quantity: 1,
          modifiers: [{ name: "Mild" }],
        },
      ],
    );
    const repricedReconstructedMeal = await priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      orderId: reconstructedMeal.id,
      items: reconstructedWithWings,
    });
    assert.ok(
      repricedReconstructedMeal.lines.some(
        (line: Record<string, any>) => line.item_name_snapshot === "Boneless Wings",
      ),
      "Reconstructed mashed-and-gravy meals must not poison later cart additions.",
    );

    for (const provider of ["openai", "gemini"]) {
      const initial = await priceSpokenOrder({
        business: "Corner Deli",
        actor: { ...actor, id: `${provider}-pending-regression` },
        service: "pickup",
        items: [
          {
            name: "Hot Turkey",
            quantity: 1,
            modifiers: [{ name: "Italian Dressing" }],
          },
        ],
      });
      created.push(initial.id);
      let sizePending: Record<string, any> | null = null;
      await assert.rejects(
        () =>
          priceSpokenOrder({
            business: "Corner Deli",
            actor,
            service: "pickup",
            orderId: initial.id,
            items: [
              {
                name: "Hot Turkey",
                quantity: 1,
                modifiers: [
                  { name: "Italian Dressing" },
                  { name: "Mashed Potatoes" },
                ],
              },
            ],
          }),
        (error: unknown) => {
          if (!(error instanceof AiToolError)) return false;
          sizePending = error.details.pendingItem as Record<string, any>;
          return error.code === "FOLLOW_UP_REQUIRED";
        },
      );
      const sized = await applyPendingModifierAnswer({
        orderId: initial.id,
        pendingItem: sizePending,
        customerText: "Yes, small mashed, yep.",
        operation: "replace_item",
        targetItem: "Hot Turkey",
        items: [],
      });
      const withMashed = await priceSpokenOrder({
        business: "Corner Deli",
        actor,
        service: "pickup",
        orderId: initial.id,
        items: sized.items,
      });
      assert.equal(withMashed.required_follow_up, "Gravy on the mashed potatoes?");
      const gravy = await applyPendingModifierAnswer({
        orderId: initial.id,
        pendingItem: withMashed.pending_item,
        customerText: "Yes, please.",
        operation: "replace_item",
        targetItem: "Hot Turkey",
        items: [],
      });
      const complete = await priceSpokenOrder({
        business: "Corner Deli",
        actor,
        service: "pickup",
        orderId: initial.id,
        items: gravy.items,
        resolvedPendingQuestions: gravy.resolvedPendingQuestions,
      });
      assert.equal(complete.pending_item, undefined);
      const canonical = await sql`
        SELECT modifier.option_id
        FROM ordering_order_item_modifiers modifier
        JOIN ordering_order_items item ON item.id=modifier.order_item_id
        WHERE item.order_id=${initial.id}
      `;
      const ids = canonical.map((row) => String(row.option_id));
      assert.ok(ids.includes("97782954-b940-44d3-918a-7176cf2ae3c7"));
      assert.ok(ids.includes("80386108-1095-49d2-907a-ad2b8f1a3997"));
    }

    for (const phrase of ["12 wings mild", "12 bone in mild"]) {
      result = await price(phrase);
      assert.equal(result.lines[0].item_name_snapshot, "Wings");
      assert.equal(result.lines[0].variant_name_snapshot, "12 Wings");
      assert.ok(result.modifierNames.includes("Mild"));
    }
    for (const phrase of [
      "12 wings mild with blue cheese and celery",
      "12 wings mild ranch and celery",
    ]) {
      result = await price(phrase);
      assert.equal(result.lines[0].item_name_snapshot, "Wings");
      assert.ok(result.modifierNames.includes("Mild"));
      assert.ok(
        result.modifierNames.some((name: string) => /Celery/i.test(name)),
      );
    }
    result = await price("12 boneless hot with blue cheese");
    assert.equal(result.lines[0].item_name_snapshot, "Boneless Wings");
    assert.ok(result.modifierNames.includes("Hot"));
    assert.ok(
      result.modifierNames.some((name: string) => /Blue Cheese/i.test(name)),
    );
    for (const phrase of [
      "12 wings mild extra sauce",
      "12 mild wings make them saucy",
    ]) {
      result = await price(phrase);
      assert.ok(result.modifierNames.includes("Mild"));
      assert.ok(
        result.modifierNames.some((name: string) => /Mild.*4oz/i.test(name)),
      );
    }
    result = await price("12 mild wings with extra hot sauce");
    assert.ok(result.modifierNames.includes("Mild"));
    assert.ok(
      result.modifierNames.some((name: string) => /Hot.*4oz/i.test(name)),
    );

    result = await price("large pizza");
    assert.equal(result.lines[0].variant_name_snapshot, 'Jumbo Thin 16"');
    result = await price("medium pizza");
    assert.equal(result.lines[0].variant_name_snapshot, 'Regular 14"');

    for (const phrase of ["mozz sticks", "cheese sticks"]) {
      result = await price(phrase);
      assert.equal(result.lines[0].item_name_snapshot, "Mozzarella Sticks");
    }
    await expectError("tots", /Small or large/i);

    await expectError("poutine", /Small or large/i);
    await expectError("poutine fries", /Small or large/i);
    result = await price("small poutine");
    assert.equal(result.lines[0].item_name_snapshot, "Small French Fries");
    assert.ok(
      result.modifierNames.some((name: string) => /Poutine/i.test(name)),
    );
    result = await price("large poutine");
    assert.equal(result.lines[0].item_name_snapshot, "Large French Fries");
    assert.ok(
      result.modifierNames.some((name: string) => /Poutine/i.test(name)),
    );
    await expectError("curly poutine", /Small or large/i);
    await expectError("waffle fry poutine", /Small or large/i);
    await expectError("tater tot poutine", /Small or large/i);

    for (const phrase of [
      "large poutine fries",
      "large fries with cheese and gravy",
    ]) {
      result = await price(phrase);
      assert.equal(result.lines[0].item_name_snapshot, "Large French Fries");
      assert.ok(
        result.modifierNames.some((name: string) => /Poutine/i.test(name)),
      );
    }
    for (const phrase of [
      "large tot poutine",
      "large tots with gravy and cheese",
    ]) {
      result = await price(phrase);
      assert.equal(result.lines[0].item_name_snapshot, "Large Tater Tots");
      assert.ok(
        result.modifierNames.some((name: string) => /Poutine/i.test(name)),
      );
    }
    result = await price("large curly poutine");
    assert.equal(result.lines[0].item_name_snapshot, "Large Curly Fries");
    assert.ok(
      result.modifierNames.some((name: string) => /Poutine/i.test(name)),
    );
    result = await price("large curly fries with cheese and gravy");
    assert.equal(result.lines[0].item_name_snapshot, "Large Curly Fries");
    assert.ok(
      result.modifierNames.some((name: string) => /Poutine/i.test(name)),
    );

    assert.deepEqual(compositeModifierEffects(["Cheese", "Gravy"], "poutine"), [
      "Cheese",
      "Gravy",
    ]);
    console.log(JSON.stringify({ status: "passed", assertions: 32 }));
  } finally {
    if (created.length)
      await sql`DELETE FROM ordering_orders WHERE id = ANY(${created})`;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
