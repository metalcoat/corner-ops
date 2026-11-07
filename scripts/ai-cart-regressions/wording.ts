// Wording regressions from Chris's dev test call 2026-11-06 19:41 (e2745ff7): the goodbye came out "Your pickup
// should be ready in Give us 30 minutes for pickup.", the readback said "Jumbo Thin Pizza", and the AI asked two
// questions at once and read all ten wing sauces aloud. Run: npx tsx scripts/ai-cart-regressions/wording.ts
import assert from "node:assert/strict";
import { loadHarness } from "./harness";

async function main() {
  const h = await loadHarness();
  const prompt = await import("../../src/lib/openai-phone-prompt");
  try {
    await h.check("pickup goodbye reads naturally from every wait message", () => {
      assert.equal(prompt.pickupClosing("Give us 30 minutes for pickup."), "Give us 30 minutes, and it'll be ready. Thanks for calling—see you then!");
      assert.equal(prompt.pickupClosing("ASAP for the next opening. We open Fri 10:30 AM; Give us 30 minutes for pickup."), "Give us 30 minutes, and it'll be ready. Thanks for calling—see you then!");
      assert.equal(prompt.pickupClosing("about 15 to 20 minutes"), "It'll be ready in about 15 to 20 minutes. Thanks for calling—see you then!");
      for (const wait of ["Give us 30 minutes for pickup.", "", "ASAP ordering is not available right now."])
        assert.doesNotMatch(prompt.pickupClosing(wait), /ready in give us|for pickup\. thanks|not available/i);
    });
    await h.check("pizza lines are said the way callers say them, without house defaults", () => {
      assert.equal(h.cart.spokenLine("Pizza", 'Jumbo Thin 16"', [{ name: "Regular Cooked" }, { name: "Classic Sauce" }]), "jumbo pizza");
      assert.equal(h.cart.spokenLine("Pizza", 'Jumbo Thin 16"', [{ name: "Classic Sauce" }, { name: "Pepperoni" }, { name: "Sausage" }]), "jumbo pizza with Pepperoni, Sausage");
      assert.equal(h.cart.spokenLine("Pizza", 'Jumbo Thick 16"', []), "jumbo thick pizza");
    });
    await h.check("prompt: one question per turn, choices asked plainly, nothing re-asked", () => {
      const text = prompt.buildPhoneInstructions({ callId: "w", callerPhone: "3155550142", lineLabel: "TEST", settings: { mode: "shadow", maxUpsells: 1 } as any, business: { pickupWait: "Give us 30 minutes for pickup.", deliveryWait: "", pickupAvailable: true, deliveryAvailable: true, upsells: [] } });
      assert.match(text, /one question at a time and wait, never two in one turn/);
      assert.match(text, /without listing the options/);
      assert.match(text, /Never ask again for something the caller already answered/);
      assert.match(text, /Give us 30 minutes, and it'll be ready/);
      assert.doesNotMatch(text, /ready in Give us/);
    });
  } finally {
    await h.cleanup();
  }
  h.summary();
  process.exit(process.exitCode || 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
