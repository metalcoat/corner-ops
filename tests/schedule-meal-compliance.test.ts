import test from "node:test";
import assert from "node:assert/strict";
import { analyzeShiftMealCompliance, mealRequirements } from "../src/lib/schedule-meal-compliance.js";

const startsAt = "2026-08-24T16:00:00.000Z";
const endsAt = "2026-08-25T00:00:00.000Z";

test("Tiki bartender shifts do not require an off-duty meal", () => {
  const requirements = mealRequirements({
    startsAt,
    endsAt,
    business: "Tiki",
    position: "Bartender",
  });
  assert.deepEqual(requirements, []);

  const analysis = analyzeShiftMealCompliance({
    startsAt,
    endsAt,
    business: "Tiki",
    position: "Bartender",
  });
  assert.equal(analysis.compliant, true);
  assert.equal(analysis.issues.length, 0);
  assert.equal(analysis.paidHours, 8);
});

test("Corner Deli shifts keep the 30-minute meal requirement", () => {
  const requirements = mealRequirements({
    startsAt,
    endsAt,
    business: "Corner Deli",
    position: "Pizza",
  });
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0]?.minimumMinutes, 30);

  const analysis = analyzeShiftMealCompliance({
    startsAt,
    endsAt,
    business: "Corner Deli",
    position: "Pizza",
  });
  assert.equal(analysis.compliant, false);
  assert.equal(analysis.issues.length, 1);
});
