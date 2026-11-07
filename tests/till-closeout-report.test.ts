import assert from "node:assert/strict";
import test from "node:test";
import { buildCloseoutEmail, closeoutDiscrepancies, type TillCloseout } from "../src/lib/till-closeout-report";
import { defaultTillSettings, emptyCounts, planCloseout } from "../src/lib/till-reset-rules";

const drawer = (partial: Record<string, number>) => ({ ...emptyCounts(), ...partial });
const closeout = (counted: ReturnType<typeof drawer>, bag: ReturnType<typeof drawer> | null, terminalKey: string, extra: Partial<TillCloseout> = {}): TillCloseout => {
  const plan = planCloseout(counted, bag, defaultTillSettings({ terminalKey }));
  const total = Object.entries(counted).reduce((s, [k, n]) => s + n * ({ pennies: 1, nickels: 5, dimes: 10, quarters: 25, ones: 100, fives: 500, tens: 1000, twenties: 2000, fifties: 5000, hundreds: 10000 } as Record<string, number>)[k], 0);
  return { closedBy: "Maria", closedAt: "2026-10-30T01:50:00Z", counted, checksCents: 0, countedCents: total, expectedCents: total, overShortCents: 0, resetTargetCents: plan.targetCents, leftCents: plan.leaveCents, resetNote: "", plan, ...extra };
};

test("nightly email: front, back and bag in one table; OK when nothing is off", () => {
  const front = closeout(drawer({ quarters: 40, ones: 40, fives: 10, tens: 6, twenties: 4 }), null, "upfront-register");
  const back = closeout(drawer({ ones: 20, twenties: 3 }), drawer({ quarters: 8, ones: 28, fives: 6 }), "back-register");
  const email = buildCloseoutEmail({ businessDate: "2026-10-29", tills: [{ name: "upfront-register", label: "Front till", closeout: front }, { name: "back-register", label: "Back till", closeout: back }] });
  assert.equal(email.subject, "Till closeout Thu, Oct 29 — OK");
  assert.match(email.text, /Columns: Front till \| Back till \| Change bag/);
  assert.match(email.text, /\$1: 40 = \$40\.00 \| 20 = \$20\.00 \| 28 = \$28\.00/);
  assert.match(email.text, /Left in till \/ bag: \$100\.00 \| \$0\.00 \| \$60\.00/);
  assert.match(email.html, /<th[^>]*>Change bag<\/th>/);
  assert.match(email.html, /No discrepancies/);
  assert.doesNotMatch(email.text, /Pennies/);
});

test("nightly email: discrepancies table lists over/short, minimums, bag off and a till not closed", () => {
  const front = closeout(drawer({ quarters: 8, ones: 30, fives: 4, tens: 6 }), null, "upfront-register", { overShortCents: -500, expectedCents: 11700 });
  const back = closeout(drawer({ ones: 20, twenties: 3 }), drawer({ quarters: 8, ones: 18, fives: 6 }), "back-register");
  const rows = closeoutDiscrepancies([{ name: "upfront-register", label: "Front till", closeout: front }, { name: "back-register", label: "Back till", closeout: back }]);
  assert.deepEqual(rows.map((r) => [r.where, r.amountCents]), [["Front till", -500], ["Front till", -300], ["Front till", -500], ["Change bag", -1000]]);
  assert.match(rows[1].issue, /Quarters below minimum/);
  const missing = buildCloseoutEmail({ businessDate: "2026-10-30", tills: [{ name: "upfront-register", label: "Front till", closeout: front }, { name: "back-register", label: "Back till", closeout: null }], note: "Claude (dev test)" });
  assert.equal(missing.subject, "[Claude (dev test)] Till closeout Fri, Oct 30 — 4 to check");
  assert.match(missing.text, /- Back till: Not closed out/);
  assert.match(missing.html, /<td[^>]*>Not closed out<\/td><td[^>]*>—<\/td>/);
});
