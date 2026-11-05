import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanAccountInput, defaultStatementPeriod, houseChargeBlocker, houseChargeSlipLines, houseEntryDelta, runningBalance, statementPeriod, statementPrintLines, statementTotals,
} from "../src/lib/ordering-house-account-rules";
import { orderTrail } from "../src/lib/ordering-order-trail";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("an active account can be charged; on hold and closed accounts can't", () => {
  assert.equal(houseChargeBlocker({ status: "active", balanceCents: 0, creditLimitCents: null, amountCents: 1250 }), null);
  assert.match(houseChargeBlocker({ status: "hold", balanceCents: 0, creditLimitCents: null, amountCents: 1250 }) || "", /on hold/);
  assert.match(houseChargeBlocker({ status: "closed", balanceCents: 0, creditLimitCents: null, amountCents: 1250 }) || "", /closed/);
});

test("the credit limit caps the tab, counting what's already owed", () => {
  assert.equal(houseChargeBlocker({ status: "active", balanceCents: 8000, creditLimitCents: 10000, amountCents: 2000 }), null);
  const over = houseChargeBlocker({ status: "active", balanceCents: 8000, creditLimitCents: 10000, amountCents: 2001 }) || "";
  assert.match(over, /\$100\.00 limit/);
  assert.match(over, /only \$20\.00 more/);
  assert.match(houseChargeBlocker({ status: "active", balanceCents: 0, creditLimitCents: 0, amountCents: 1 }) || "", /limit/);
});

test("charges add to the balance; payments, credits and reversals take off", () => {
  assert.equal(houseEntryDelta("charge", 1250), 1250);
  assert.equal(houseEntryDelta("payment", 1250), -1250);
  assert.equal(houseEntryDelta("credit", 500), -500);
  assert.equal(houseEntryDelta("reversal", 1250), -1250);
  assert.equal(houseEntryDelta("adjustment", 300), 300);
  assert.equal(houseEntryDelta("adjustment", -300), -300);
});

test("the statement starts at the last payment, or the 1st of the month when there's none", () => {
  assert.deepEqual(defaultStatementPeriod({ today: "2026-11-04", lastPaymentDate: "2026-10-20" }), { from: "2026-10-20", to: "2026-11-04" });
  assert.deepEqual(defaultStatementPeriod({ today: "2026-11-04", lastPaymentDate: null }), { from: "2026-11-01", to: "2026-11-04" });
  assert.deepEqual(statementPeriod({ from: "2026-10-01", to: "2026-10-31", today: "2026-11-04" }), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(statementPeriod({ from: "2026-10-31", to: "2026-10-01", today: "2026-11-04" }), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(statementPeriod({ from: "nonsense", to: "", today: "2026-11-04", lastPaymentDate: "2026-10-20" }), { from: "2026-10-20", to: "2026-11-04" });
});

test("each statement line shows the running balance, from the balance before the period", () => {
  const rows = runningBalance(2000, [
    { at: "2026-11-01T16:00:00.000Z", type: "charge", deltaCents: 1250, orderNumber: "101", items: "1x Italian sub" },
    { at: "2026-11-02T16:00:00.000Z", type: "payment", deltaCents: -2000, method: "cash" },
    { at: "2026-11-03T16:00:00.000Z", type: "charge", deltaCents: 900, orderNumber: "140" },
    { at: "2026-11-03T17:00:00.000Z", type: "reversal", deltaCents: -900, orderNumber: "140" },
  ]);
  assert.deepEqual(rows.map((row) => row.balanceCents), [3250, 1250, 2150, 1250]);
  assert.deepEqual(rows.map((row) => row.label), ["Charge", "Payment", "Charge", "Charge reversed"]);
  assert.deepEqual(statementTotals(2000, rows), { openingCents: 2000, chargesCents: 2150, paymentsAndCreditsCents: 2900, closingCents: 1250 });
});

test("the printed statement fits the receipt printer and ends with the balance due", () => {
  const rows = runningBalance(0, [{ at: "2026-11-01T16:00:00.000Z", type: "charge", deltaCents: 1250, orderNumber: "101", items: "1x Italian sub" }]);
  const lines = statementPrintLines({ accountName: "Mike Russell", phone: "(518) 555-0100", from: "2026-11-01", to: "2026-11-04", openingCents: 0, rows, printedBy: "Pat" });
  assert.equal(lines[0], "HOUSE ACCOUNT STATEMENT");
  assert.ok(lines.includes("ACCOUNT: Mike Russell"));
  assert.ok(lines.some((line) => line.includes("ORDER #101")));
  assert.ok(lines.some((line) => line.includes("1x Italian sub")));
  assert.match(lines.find((line) => line.startsWith("BALANCE DUE")) || "", /\$12\.50$/);
  for (const line of lines.filter((line) => /\$\d/.test(line))) assert.ok(line.length <= 32, line);
});

test("the receipt carries a charge slip with the account and the balance after", () => {
  const slip = houseChargeSlipLines({ accountName: "Mike Russell", chargedCents: 1250, balanceAfterCents: 4300 });
  assert.ok(slip.includes("CHARGED TO ACCOUNT"));
  assert.ok(slip.includes("HOUSE ACCOUNT: Mike Russell"));
  assert.ok(slip.includes("CHARGED: $12.50"));
  assert.ok(slip.includes("ACCOUNT BALANCE: $43.00"));
  assert.ok(slip.some((line) => line.startsWith("SIGNATURE")));
});

test("account details are cleaned up and checked", () => {
  assert.deepEqual(cleanAccountInput({ name: "  Mike   Russell ", phone: "518-555-0100", creditLimitCents: 25000 }), { name: "Mike Russell", phone: "(518) 555-0100", email: "", notes: "", creditLimitCents: 25000 });
  assert.equal(cleanAccountInput({ name: "Acme Plumbing", creditLimitCents: "" }).creditLimitCents, null);
  assert.throws(() => cleanAccountInput({ name: "" }), /name/);
  assert.throws(() => cleanAccountInput({ name: "Mike", phone: "12" }), /phone/);
  assert.throws(() => cleanAccountInput({ name: "Mike", email: "nope" }), /email/);
  assert.throws(() => cleanAccountInput({ name: "Mike", creditLimitCents: -5 }), /limit/);
});

test("house-account charges and reversals show on the order's trail", () => {
  const trail = orderTrail({
    createdAt: "2026-11-01T16:00:00.000Z", takenBy: "Sam",
    events: [
      { event_type: "house_account_charged", created_at: "2026-11-01T16:05:00.000Z", actor_name: "Sam", details: { amountCents: 1250, accountName: "Mike Russell", balanceAfterCents: 4300, deviceLabel: "Front register" } },
      { event_type: "house_account_charge_reversed", created_at: "2026-11-01T17:00:00.000Z", actor_name: "Pat", details: { amountCents: 1250, accountName: "Mike Russell", balanceAfterCents: 3050, reason: "Order voided: wrong order" } },
    ],
    payments: [],
  });
  assert.deepEqual(trail.slice(1).map((row) => [row.label, row.who, row.detail]), [
    ["Charged to house account $12.50", "Sam", "Mike Russell · tab balance $43.00 · Front register"],
    ["House-account charge reversed $12.50", "Pat", "Mike Russell · tab balance $30.50 · Order voided: wrong order"],
  ]);
});

// The money paths, checked in the source (the database paths run against the dev server).
test("a house-account payment records a tab charge inside the same transaction as the payment", () => {
  const payments = read("src/lib/ordering-payments.ts");
  assert.match(payments, /export type CheckoutTenderType = "cash" \| "card" \| "gift_card" \| "house_account"/);
  assert.match(payments, /chargeHouseAccount\(\{ accountId: String\(input\.houseAccountId\), orderId: input\.orderId/);
  assert.match(payments, /houseAccountLines \? \{ houseAccountLines \}/);
  assert.match(payments, /house_account" && input\.amountTenderedCents > due/);
});

test("refunds and voids of a house-account order take the charge off the tab", () => {
  const payments = read("src/lib/ordering-payments.ts");
  const voids = read("src/lib/ordering-voids.ts");
  assert.match(payments, /source\.tender_type === "house_account"\) \{\s*try \{\s*await reverseHouseAccountCharge/);
  assert.match(payments, /This was charged to a house account\. Refund it/);
  assert.match(voids, /tender_type='house_account'/);
  assert.match(voids, /clientMutationId: `house-account-void:/);
});

test("the POS offers HOUSE ACCOUNT at checkout, also at phone order-taking stations", () => {
  const pos = read("src/app/pos/pos-client.tsx");
  const route = read("src/app/api/ordering/orders/[id]/payments/route.ts");
  assert.match(pos, /HOUSE ACCOUNT/);
  assert.match(pos, /commitPayment\("house_account", undefined, chargeCents, undefined, houseAccountChoice\.id\)/);
  assert.match(route, /order_taker"&&!\(body\.action===undefined&&body\.tenderType==="house_account"\)/);
  assert.match(route, /houseAccountId: body\.houseAccountId/);
  assert.match(read("src/lib/ordering-hardware.ts"), /payload\.houseAccountLines/);
});

test("any employee signed in at the POS can charge a tab and look one up, with no manager PIN", () => {
  const proxy = read("src/proxy.ts");
  assert.match(proxy, /"house-accounts",\s*\]\.some\(\(part\) => matchesPath\(path, `\/api\/ordering\/\$\{part\}`\)\)/);
  const lookup = read("src/app/api/ordering/house-accounts/[id]/route.ts");
  assert.match(lookup, /orderingActor\("Corner Deli"\)/);
  assert.doesNotMatch(lookup, /houseAccountManager|orderingManagerActor/);
  const houses = read("src/lib/ordering-house-accounts.ts");
  const printer = houses.slice(houses.indexOf("export async function printHouseAccountStatement"));
  assert.doesNotMatch(printer.slice(0, printer.indexOf("\n}\n")), /requireManager/);
  assert.match(read("src/app/pos/deli/deli-pos-shell.tsx"), /\{ label: "Tabs", href: "\/pos\/deli\/house-accounts" \}/);
});
