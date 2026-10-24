#!/usr/bin/env node
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";
localValidationEnv();

async function main() {
  const [{ getSql }, { priceSpokenOrder }, { attachStandaloneModifierAnswer }] =
    await Promise.all([
      import("../src/lib/db"),
      import("../src/lib/ordering-ai-tools"),
      import("../src/lib/openai-phone-sideband"),
    ]);
  const actor = {
    id: "followup-validation",
    name: "Follow-up Validation",
    type: "employee" as const,
    role: "employee" as const,
  };
  const order = await priceSpokenOrder({
    business: "Corner Deli",
    actor,
    service: "pickup",
    callerPhone: "3155550100",
    firstName: "Validation",
    items: [
      {
        name: "Wings",
        variant: "20 Wings",
        quantity: 1,
        modifiers: [{ name: "Mild" }],
      },
      { name: "large fry", quantity: 1 },
    ],
  });
  try {
    const wing = await attachStandaloneModifierAnswer(String(order.id), "add", [
      { name: "blue cheese", quantity: 1 },
    ]);
    const ranch = await attachStandaloneModifierAnswer(
      String(order.id),
      "add",
      [{ name: "ranch", quantity: 1 }],
    );
    const celery = await attachStandaloneModifierAnswer(
      String(order.id),
      "add",
      [{ name: "celery", quantity: 1 }],
    );
    const nacho = await attachStandaloneModifierAnswer(
      String(order.id),
      "add",
      [{ name: "nacho cheese", quantity: 1 }],
    );
    const blueAndCelery = await attachStandaloneModifierAnswer(
      String(order.id),
      "add",
      [{ name: "blue cheese and celery", quantity: 1 }],
    );
    const allSides = await attachStandaloneModifierAnswer(
      String(order.id),
      "add",
      [{ name: "blue cheese, ranch and celery", quantity: 1 }],
    );
    assert.equal(wing?.targetItem, "Wings");
    assert.ok(
      wing?.items[0].modifiers?.some(
        (value) => value.name === "Blue Cheese (4oz)",
      ),
    );
    assert.equal(ranch?.targetItem, "Wings");
    assert.ok(
      ranch?.items[0].modifiers?.some((value) => value.name === "Ranch (4oz)"),
    );
    assert.equal(celery?.targetItem, "Wings");
    assert.ok(
      celery?.items[0].modifiers?.some((value) => value.name === "Celery"),
    );
    assert.equal(nacho?.targetItem, "Large French Fries");
    assert.ok(
      nacho?.items[0].modifiers?.some(
        (value) => value.name === "Nacho Cheese on Side",
      ),
    );
    assert.equal(blueAndCelery?.targetItem, "Wings");
    assert.ok(
      blueAndCelery?.items[0].modifiers?.some((value) =>
        /Blue Cheese/.test(value.name),
      ),
    );
    assert.ok(
      blueAndCelery?.items[0].modifiers?.some(
        (value) => value.name === "Celery",
      ),
    );
    assert.equal(allSides?.targetItem, "Wings");
    assert.ok(
      ["Blue Cheese (4oz)", "Ranch (4oz)", "Celery"].every((name) =>
        allSides?.items[0].modifiers?.some((value) => value.name === name),
      ),
    );
    console.log(
      JSON.stringify(
        {
          blueCheeseAttached: true,
          ranchAttached: true,
          celeryAttached: true,
          nachoCheeseAttached: true,
          coordinatedWingSidesAttached: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await getSql()`DELETE FROM ordering_orders WHERE id=${String(order.id)}`;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
