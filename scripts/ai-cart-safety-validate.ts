import type { SpokenOrderItem } from "../src/lib/ordering-ai-tools";
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

async function main() {
  const [{ getSql }, tools, cart] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/ordering-ai-tools"),
    import("../src/lib/openai-phone-sideband"),
  ]);
  const sql = getSql(),
    created: string[] = [];
  const actor = {
    id: "ai-cart-safety",
    name: "AI cart safety regression",
    type: "employee" as const,
    role: "employee" as const,
  };
  let passed = 0,
    failed = 0;
  async function check(name: string, run: () => unknown | Promise<unknown>) {
    try {
      await run();
      passed++;
      console.log(`PASS ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL ${name}`, error);
    }
  }
  async function price(items: SpokenOrderItem[], orderId?: string) {
    const result = await tools.priceSpokenOrder({
      business: "Corner Deli",
      actor,
      service: "pickup",
      firstName: "Regression",
      callerPhone: "3155550100",
      items,
      orderId,
    });
    if (!orderId) created.push(String(result.id));
    return result;
  }
  async function snapshot(orderId: string) {
    return JSON.stringify({
      order: (await sql`SELECT * FROM ordering_orders WHERE id=${orderId}`)[0],
      lines:
        await sql`SELECT * FROM ordering_order_items WHERE order_id=${orderId} ORDER BY id`,
      modifiers:
        await sql`SELECT mod.* FROM ordering_order_item_modifiers mod JOIN ordering_order_items item ON item.id=mod.order_item_id WHERE item.order_id=${orderId} ORDER BY mod.id`,
    });
  }
  const wing = (flavor: string): SpokenOrderItem => ({
    name: "Wings",
    variant: "12 Wings",
    quantity: 1,
    modifiers: [{ name: flavor }],
  });
  try {
    await check(
      "call replay: 30 medium + 20 hot becomes 20 medium + 10 hot atomically",
      async () => {
        const order = await price([
          { name: "Turkey Big Boss", modifiers: [{ name: "No Tomato" }] },
          {
            name: "large pizza",
            modifiers: [
              { name: "Pepperoni" },
              { name: "Onions", portion: "left_half" },
            ],
          },
          {
            name: "Wings",
            variant: "30 Wings",
            quantity: 1,
            modifiers: [{ name: "Medium" }, { name: "Blue Cheese" }],
          },
          {
            name: "Wings",
            variant: "20 Wings",
            quantity: 1,
            modifiers: [{ name: "Hot" }],
          },
          { name: "Caramel Cheesecake" },
        ]);
        const before = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        const originalWings = before.filter((line) => line.name === "Wings");
        const payload: SpokenOrderItem[] = [
          {
            name: "Wings",
            variant: "20 Wings",
            quantity: 1,
            modifiers: [{ name: "Medium", portion: "whole" }],
          },
          {
            name: "Wings",
            variant: "10 Wings",
            quantity: 1,
            modifiers: [{ name: "Hot", portion: "whole" }],
          },
        ];
        await price(
          await cart.incrementalSpokenCart(
            order.id,
            "replace_item",
            originalWings[0].lineId!,
            payload,
          ),
          order.id,
        );
        const after = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        const wings = after.filter((line) => line.name === "Wings");
        assert.equal(wings.length, 2);
        assert.equal(wings[0].variant, "20 Wings");
        assert.equal(wings[1].variant, "10 Wings");
        assert.deepEqual(
          wings.map((line) => line.lineId),
          originalWings.map((line) => line.lineId),
        );
        assert.ok(
          wings[0].modifiers?.some((mod) => /Blue Cheese/.test(mod.name)),
        );
        assert.deepEqual(
          after.filter((line) => line.name !== "Wings"),
          before.filter((line) => line.name !== "Wings"),
        );
      },
    );
    await check(
      "explicit batch line IDs allow separate flavor changes",
      async () => {
        const order = await price([wing("Mild"), wing("Hot")]);
        const before = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        await price(
          await cart.incrementalSpokenCart(order.id, "replace_item", "", [
            { ...wing("Medium"), lineId: before[0].lineId },
            { ...wing("Suicide"), lineId: before[1].lineId },
          ]),
          order.id,
        );
        const after = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        assert.ok(after[0].modifiers?.some((mod) => mod.name === "Medium"));
        assert.ok(after[1].modifiers?.some((mod) => mod.name === "Suicide"));
      },
    );
    await check(
      "ambiguous wing batch requires line selection and leaves cart unchanged",
      async () => {
        const order = await price([wing("Mild"), wing("Mild")]);
        const before = await snapshot(order.id);
        await assert.rejects(
          cart.incrementalSpokenCart(order.id, "replace_item", "", [
            wing("Mild"),
            wing("Mild"),
          ]),
          (error: any) =>
            error.code === "FOLLOW_UP_REQUIRED" &&
            error.details.cartLines.length === 2,
        );
        assert.equal(await snapshot(order.id), before);
      },
    );
    await check(
      "duplicate stale or invalid batch corrections leave all lines unchanged",
      async () => {
        const order = await price([wing("Mild"), wing("Hot")]);
        const lines = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        const before = await snapshot(order.id);
        for (const edits of [
          [
            { ...wing("Mild"), lineId: lines[0].lineId },
            { ...wing("Hot"), lineId: lines[0].lineId },
          ],
          [
            { ...wing("Mild"), lineId: lines[0].lineId },
            { ...wing("Hot"), lineId: "stale-id" },
          ],
          [
            { ...wing("Medium"), lineId: lines[0].lineId },
            {
              ...wing("Hot"),
              lineId: lines[1].lineId,
              modifiers: [{ name: "avocado" }],
            },
          ],
        ]) {
          await assert.rejects(
            cart.incrementalSpokenCart(order.id, "replace_item", "", edits),
          );
          assert.equal(await snapshot(order.id), before);
        }
      },
    );
    for (const modifier of [
      { name: "No Tomato", remove: false },
      { name: "Tomatoes", remove: true },
      { name: "without tomatoes" },
    ]) {
      await check(
        "initial Turkey Big Boss omission: " + JSON.stringify(modifier),
        async () => {
          const result = await price([
            { name: "Turkey Big Boss", quantity: 1, modifiers: [modifier] },
          ]);
          const line = (
            await cart.incrementalSpokenCart(result.id, "read", "", [])
          )[0];
          assert.ok(
            line.modifiers?.some(
              (mod) =>
                mod.name === "No Tomato" && mod.group === "Big Boss mods",
            ),
          );
        },
      );
      await check(
        "existing Turkey Big Boss omission: " + JSON.stringify(modifier),
        async () => {
          const result = await price([
            { name: "Turkey Big Boss", quantity: 1 },
          ]);
          const line = (
            await cart.incrementalSpokenCart(result.id, "read", "", [])
          )[0];
          const items = await cart.incrementalSpokenCart(
            result.id,
            "replace_item",
            line.lineId!,
            [{ name: "Turkey Big Boss", quantity: 1, modifiers: [modifier] }],
          );
          await price(items, result.id);
          const changed = (
            await cart.incrementalSpokenCart(result.id, "read", "", [])
          )[0];
          assert.equal(changed.lineId, line.lineId);
          assert.ok(
            changed.modifiers?.some(
              (mod) =>
                mod.name === "No Tomato" && mod.group === "Big Boss mods",
            ),
          );
        },
      );
    }
    await check(
      "Big Boss omission survives accompaniment edit and cart repricing",
      async () => {
        const result = await price([
          {
            name: "Turkey Big Boss",
            quantity: 1,
            modifiers: [{ name: "No Tomato" }],
          },
        ]);
        const line = (
          await cart.incrementalSpokenCart(result.id, "read", "", [])
        )[0];
        await price(
          await cart.incrementalSpokenCart(
            result.id,
            "replace_item",
            line.lineId!,
            [{ name: "Turkey Big Boss", modifiers: [{ name: "No Russian" }] }],
          ),
          result.id,
        );
        await price(
          await cart.incrementalSpokenCart(result.id, "add", "", [
            { name: "large fries" },
          ]),
          result.id,
        );
        const after = (
          await cart.incrementalSpokenCart(result.id, "read", "", [])
        ).find((item) => item.lineId === line.lineId)!;
        assert.ok(after.modifiers?.some((mod) => mod.name === "No Tomato"));
        assert.ok(after.modifiers?.some((mod) => mod.name === "No Russian"));
      },
    );
    await check(
      "explicitly removing No Tomato restores the original recipe",
      async () => {
        const result = await price([
          { name: "Turkey Big Boss", modifiers: [{ name: "No Tomato" }] },
        ]);
        const line = (
          await cart.incrementalSpokenCart(result.id, "read", "", [])
        )[0];
        await price(
          await cart.incrementalSpokenCart(
            result.id,
            "replace_item",
            line.lineId!,
            [
              {
                name: "Turkey Big Boss",
                modifiers: [{ name: "No Tomato", remove: true }],
              },
            ],
          ),
          result.id,
        );
        assert.ok(
          !(
            await cart.incrementalSpokenCart(result.id, "read", "", [])
          )[0].modifiers?.some((mod) => mod.name === "No Tomato"),
        );
      },
    );
    await check(
      "unknown or incorrectly scoped omissions cannot change the cart",
      async () => {
        const result = await price([{ name: "Turkey Big Boss" }]);
        const line = (
          await cart.incrementalSpokenCart(result.id, "read", "", [])
        )[0];
        const before = await snapshot(result.id);
        for (const modifier of [
          { name: "avocado", remove: true },
          { name: "No Tomato", group: "Double Cheese" },
        ]) {
          await assert.rejects(
            cart.incrementalSpokenCart(
              result.id,
              "replace_item",
              line.lineId!,
              [{ name: "Turkey Big Boss", modifiers: [modifier] }],
            ),
            (error: any) => error.code === "INVALID_MODIFIER",
          );
          assert.equal(await snapshot(result.id), before);
        }
      },
    );
    await check(
      "removal-only tomato payload resolves for every configured Big Boss",
      async () => {
        for (const name of [
          "Ham Big Boss",
          "Pig Big Boss",
          "Salami Big Boss",
        ]) {
          const result = await price([
            { name, modifiers: [{ name: "Tomatoes", remove: true }] },
          ]);
          assert.ok(
            (
              await cart.incrementalSpokenCart(result.id, "read", "", [])
            )[0].modifiers?.some((mod) => mod.name === "No Tomato"),
          );
        }
      },
    );
    await check(
      "identical wing configurations remain separate addressable lines",
      async () => {
        const order = await price([wing("Mild"), wing("Mild")]);
        const lines = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        assert.equal(lines.length, 2);
        assert.notEqual(lines[0].lineId, lines[1].lineId);
        const edited = await cart.incrementalSpokenCart(
          order.id,
          "replace_item",
          lines[1].lineId!,
          [
            {
              name: "Wings",
              modifiers: [{ name: "Hot", group: "Wing Sauce" }],
            },
          ],
        );
        await price(edited, order.id);
        const after = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        assert.ok(after[0].modifiers?.some((m) => m.name === "Mild"));
        assert.ok(after[1].modifiers?.some((m) => m.name === "Hot"));
      },
    );
    await check(
      "omitted flavor recovers only from the exact edited wing line",
      async () => {
        const order = await price([wing("Mild"), wing("Suicide")]);
        const lines = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        const edited = await cart.incrementalSpokenCart(
          order.id,
          "replace_item",
          lines[1].lineId!,
          [{ name: "Wings", modifiers: [{ name: "Celery" }] }],
        );
        await price(edited, order.id);
        const after = await cart.incrementalSpokenCart(
          order.id,
          "read",
          "",
          [],
        );
        assert.ok(after[0].modifiers?.some((m) => m.name === "Mild"));
        assert.ok(!after[0].modifiers?.some((m) => m.name === "Celery"));
        assert.ok(after[1].modifiers?.some((m) => m.name === "Suicide"));
        assert.ok(!after[1].modifiers?.some((m) => m.name === "Mild"));
        assert.ok(after[1].modifiers?.some((m) => m.name === "Celery"));
      },
    );
    const order = await price([wing("Mild"), wing("Hot")]),
      id = String(order.id);
    const initial = await cart.incrementalSpokenCart(id, "read", "", []);
    assert.equal(initial.length, 2);
    assert.notEqual(initial[0].lineId, initial[1].lineId);
    await check(
      "unknown and wholesale operations reject without changing a populated cart",
      async () => {
        const before = await snapshot(id);
        for (const operation of [undefined, "garbage", "replace_order", null])
          assert.throws(
            () => cart.parseCartOperation(operation),
            (e: any) => e.code === "INVALID_INPUT",
          );
        await assert.rejects(
          cart.incrementalSpokenCart(id, "replace_order" as any, "", []),
        );
        assert.equal(await snapshot(id), before);
      },
    );
    await check("names cannot replace multiple wing lines", async () => {
      await assert.rejects(
        cart.incrementalSpokenCart(id, "replace_item", "Wings", [
          wing("Medium"),
        ]),
      );
    });
    await check(
      "same-size wing edit preserves the other line and stable IDs through repricing",
      async () => {
        const items = await cart.incrementalSpokenCart(
          id,
          "replace_item",
          initial[0].lineId!,
          [
            {
              ...wing("Medium"),
              modifiers: [{ name: "Medium", group: "Wing Sauce" }],
            },
          ],
        );
        await price(items, id);
        const after = await cart.incrementalSpokenCart(id, "read", "", []);
        assert.deepEqual(
          after.map((x) => x.lineId),
          initial.map((x) => x.lineId),
        );
        assert.ok(after[0].modifiers?.some((m) => m.name === "Medium"));
        assert.ok(after[1].modifiers?.some((m) => m.name === "Hot"));
      },
    );
    await check(
      "Mild + blue cheese + celery becomes Hot with accompaniments and extra sauce intact",
      async () => {
        const base = await price([
          {
            ...wing("Mild"),
            modifiers: [
              { name: "Mild" },
              { name: "Blue Cheese (4oz)" },
              { name: "Celery" },
              { name: "Mild Sauce (4oz)" },
            ],
          },
        ]);
        const current = await cart.incrementalSpokenCart(
          base.id,
          "read",
          "",
          [],
        );
        await price(
          await cart.incrementalSpokenCart(
            base.id,
            "replace_item",
            current[0].lineId!,
            [
              {
                name: "Wings",
                modifiers: [{ name: "Hot", group: "Wing Sauce" }],
              },
            ],
          ),
          base.id,
        );
        const after = (
          await cart.incrementalSpokenCart(base.id, "read", "", [])
        )[0];
        for (const name of [
          "Hot",
          "Blue Cheese (4oz)",
          "Celery",
          "Mild Sauce (4oz)",
        ])
          assert.ok(
            after.modifiers?.some((m) => m.name === name),
            name,
          );
        assert.ok(!after.modifiers?.some((m) => m.name === "Mild"));
        await price(
          await cart.incrementalSpokenCart(
            base.id,
            "replace_item",
            after.lineId!,
            [{ name: "Wings", modifiers: [{ name: "Celery", remove: true }] }],
          ),
          base.id,
        );
        const removed = (
          await cart.incrementalSpokenCart(base.id, "read", "", [])
        )[0];
        assert.ok(!removed.modifiers?.some((m) => m.name === "Celery"));
        assert.ok(removed.modifiers?.some((m) => m.name === "Hot"));
      },
    );
    const catalog = await tools.menuCatalog("Corner Deli", new Date(), "Wings");
    const wingItem = catalog
      .flatMap((c) => c.items)
      .find((i) => i.name === "Wings")!;
    const flavors = wingItem.modifiers
      .find((g: any) => g.name === "Wing Sauce")!
      .options.filter((o: any) => o.available);
    assert.ok(flavors.length >= 9);
    for (const flavor of flavors)
      await check(
        `catalog flavor ${flavor.name} survives accompaniment edit`,
        async () => {
          const order = await price([wing(flavor.name)]);
          const line = (
            await cart.incrementalSpokenCart(order.id, "read", "", [])
          )[0];
          const items = await cart.incrementalSpokenCart(
            order.id,
            "replace_item",
            line.lineId!,
            [
              {
                name: "Wings",
                modifiers: [{ name: "Blue Cheese (4oz)" }, { name: "Celery" }],
              },
            ],
          );
          await price(items, order.id);
          assert.ok(
            (
              await cart.incrementalSpokenCart(order.id, "read", "", [])
            )[0].modifiers?.some((m) => m.name === flavor.name),
          );
        },
      );
    for (const phrase of [
      "12 mild wings",
      "mild 12 wings",
      "12 wings mild",
      "a dozen mild wings",
      "two dozen mild wings",
    ])
      await check(`spoken flavor ${phrase}`, async () => {
        const result = await price([{ name: phrase }]);
        const line = (
          await cart.incrementalSpokenCart(result.id, "read", "", [])
        )[0];
        assert.ok(line.modifiers?.some((m) => m.name === "Mild"));
        assert.match(line.variant!, phrase.startsWith("two") ? /24/ : /12/);
      });
    for (const sauce of ["nacho cheese", "gravy"])
      for (const topping of [false, true])
        await check(
          `${sauce} ${topping ? "on fries" : "side default"}`,
          async () => {
            const result = await price([
              {
                name: "large fries",
                modifiers: [
                  { name: topping ? `${sauce} on the fries` : sauce },
                ],
              },
            ]);
            const line = (
              await cart.incrementalSpokenCart(result.id, "read", "", [])
            )[0];
            assert.ok(
              line.modifiers?.some(
                (m) =>
                  m.name.toLowerCase() ===
                  `${sauce} on ${topping ? "fries" : "side"}`,
              ),
            );
          },
        );
    await check(
      "missing fry size is structured follow-up and leaves cart unchanged",
      async () => {
        const before = await snapshot(id);
        await assert.rejects(
          price([{ name: "fries" }], id),
          (e: any) =>
            e.code === "FOLLOW_UP_REQUIRED" &&
            e.message === "Small or large?" &&
            e.details?.pendingItem?.missingRequiredFields?.includes("size"),
        );
        assert.equal(await snapshot(id), before);
      },
    );
    await check(
      "invalid item and modifier are atomic across a populated cart",
      async () => {
        const before = await snapshot(id);
        await assert.rejects(
          price(
            [
              ...initial,
              { name: "large fries", modifiers: [{ name: "avocado" }] },
            ],
            id,
          ),
        );
        assert.equal(await snapshot(id), before);
        await assert.rejects(price([...initial, { name: "lobster roll" }], id));
        assert.equal(await snapshot(id), before);
      },
    );
    for (const sauce of ["nacho cheese", "gravy"])
      await check(
        "explicit put " + sauce + " on them overrides an existing side",
        async () => {
          const order = await price([
            { name: "large fries", modifiers: [{ name: sauce }] },
          ]);
          const line = (
            await cart.incrementalSpokenCart(order.id, "read", "", [])
          )[0];
          const edits = cart.applyFryPlacementSpeech(
            [{ name: "Large French Fries", modifiers: [{ name: sauce }] }],
            "put the " + sauce + " on them",
          );
          await price(
            await cart.incrementalSpokenCart(
              order.id,
              "replace_item",
              line.lineId!,
              edits,
            ),
            order.id,
          );
          const after = (
            await cart.incrementalSpokenCart(order.id, "read", "", [])
          )[0];
          assert.equal(
            after.modifiers?.filter((m) => new RegExp(sauce, "i").test(m.name))
              .length,
            1,
          );
          assert.ok(
            after.modifiers?.some(
              (m) => m.name.toLowerCase() === sauce + " on fries",
            ),
          );
        },
      );
    await check(
      "Russian resolves to salad dressing without a sub-condiment collision",
      async () => {
        const order = await price([{ name: "small salad russian" }]);
        const mods =
          await sql`SELECT mod.group_name_snapshot,mod.option_name_snapshot FROM ordering_order_item_modifiers mod JOIN ordering_order_items item ON item.id=mod.order_item_id WHERE item.order_id=${order.id}`;
        const russian = mods.filter((m) =>
          /Russian/i.test(String(m.option_name_snapshot)),
        );
        assert.equal(russian.length, 1);
        assert.match(String(russian[0].group_name_snapshot), /Dressing/);
        assert.match(String(russian[0].option_name_snapshot), /On Salad/);
      },
    );
    await check(
      "American Swiss and Provolone are scoped to sub cheese",
      async () => {
        for (const name of ["American", "Swiss", "Provolone"]) {
          const order = await price([
            {
              name: "Roast Beef",
              variant: "Full Sub",
              modifiers: [{ name: "everything" }, { name }],
            },
          ]);
          const mods =
            await sql`SELECT mod.group_name_snapshot FROM ordering_order_item_modifiers mod JOIN ordering_order_items item ON item.id=mod.order_item_id WHERE item.order_id=${order.id} AND mod.option_name_snapshot=${name}`;
          assert.equal(mods.length, 1);
          assert.equal(mods[0].group_name_snapshot, "Free Cheese");
        }
      },
    );
    await check(
      "modifier aliases cannot escape an explicit group",
      async () => {
        const before = await snapshot(id);
        await assert.rejects(
          price(
            [
              {
                ...wing("Mild"),
                modifiers: [{ name: "Mild", group: "Dressing" }],
              },
            ],
            id,
          ),
        );
        assert.equal(await snapshot(id), before);
      },
    );
    await check(
      "ambiguous standalone accompaniment cannot select a different wing line",
      async () => {
        const before = await snapshot(id);
        await assert.rejects(
          cart.attachStandaloneModifierAnswer(id, "add", [{ name: "celery" }]),
          (e: any) => e.code === "FOLLOW_UP_REQUIRED",
        );
        assert.equal(await snapshot(id), before);
      },
    );
    await check(
      "extra mild sauce adds a cup without changing the wing flavor",
      async () => {
        const base = await price([wing("Hot")]);
        const line = (
          await cart.incrementalSpokenCart(base.id, "read", "", [])
        )[0];
        const edited = await cart.incrementalSpokenCart(
          base.id,
          "replace_item",
          line.lineId!,
          [{ name: "Wings", modifiers: [{ name: "extra mild sauce" }] }],
        );
        await price(edited, base.id);
        const names = (
          await cart.incrementalSpokenCart(base.id, "read", "", [])
        )[0].modifiers?.map((m) => m.name);
        assert.ok(names?.includes("Hot"));
        assert.ok(names?.includes("Mild Sauce (4oz)"));
        assert.ok(!names?.includes("Mild"));
      },
    );
    for (const phrase of [
      "large fries with nacho cheese on the fries",
      "large fries with gravy on the fries",
    ])
      await check(phrase, async () => {
        const result = await price([{ name: phrase }]);
        assert.ok(
          (
            await cart.incrementalSpokenCart(result.id, "read", "", [])
          )[0].modifiers?.some((m) => m.name.endsWith("on Fries")),
        );
      });
    await check("remove only the requested identical wing line", async () => {
      const current = await cart.incrementalSpokenCart(id, "read", "", []);
      await price(
        await cart.incrementalSpokenCart(
          id,
          "remove_item",
          current[0].lineId!,
          [],
        ),
        id,
      );
      const after = await cart.incrementalSpokenCart(id, "read", "", []);
      assert.equal(after.length, 1);
      assert.equal(after[0].lineId, current[1].lineId);
    });
  } finally {
    for (const id of created)
      await sql`DELETE FROM ordering_orders WHERE id=${id} AND status='draft'`;
  }
  console.log(JSON.stringify({ passed, failed }));
  if (failed) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
