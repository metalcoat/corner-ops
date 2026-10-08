import assert from "node:assert/strict";
import { menuAvailabilityRuleAllows } from "../src/lib/ordering-menu-availability";

const fridayOnly = { days_of_week: [5], starts_at: null, ends_at: null, valid_from: null, valid_through: null };
assert.equal(menuAvailabilityRuleAllows(fridayOnly, new Date("2026-08-14T16:00:00Z")), true);
assert.equal(menuAvailabilityRuleAllows(fridayOnly, new Date("2026-08-15T16:00:00Z")), false);
const lunchFriday = { ...fridayOnly, starts_at: "11:00:00", ends_at: "14:00:00" };
assert.equal(menuAvailabilityRuleAllows(lunchFriday, new Date("2026-08-14T17:00:00Z")), true);
assert.equal(menuAvailabilityRuleAllows(lunchFriday, new Date("2026-08-14T19:00:00Z")), false);
console.log("Scheduled menu availability validation passed.");
