import assert from "node:assert/strict";
import test from "node:test";
import { codedHistoryBaseKey, nextOccurrence, parseAccountingMoney } from "../src/lib/accounting-import-utils.js";
import { assertBalancedJournalLines, journalDifference } from "../src/lib/journal-integrity.js";

test("accounting money parser handles parentheses, trailing minus, CR and DR", () => {
  assert.equal(parseAccountingMoney("(1,250.00)"), -1250);
  assert.equal(parseAccountingMoney("1250.00-"), -1250);
  assert.equal(parseAccountingMoney("1250 DR"), -1250);
  assert.equal(parseAccountingMoney("1250 CR"), 1250);
});

test("coded history identity is content-based and occurrence-stable", () => {
  const key = codedHistoryBaseKey({ externalItemId: "history:abc", date: "2026-08-20", description: "SYSCO 123", signedAmount: -500, accountCode: "5000" });
  const occurrence = new Map<string, number>();
  assert.equal(nextOccurrence(occurrence, key), 1);
  assert.equal(nextOccurrence(occurrence, key), 2);
  assert.equal(key, codedHistoryBaseKey({ externalItemId: "history:abc", date: "2026-08-20", description: "  sysco   123 ", signedAmount: -500, accountCode: "5000" }));
});

test("journal balance uses integer cents", () => {
  const lines = [{ debit: 100, credit: 0 }, { debit: 0, credit: 33.33 }, { debit: 0, credit: 66.67 }];
  assert.equal(journalDifference(lines), 0);
  assert.doesNotThrow(() => assertBalancedJournalLines(lines));
  assert.throws(() => assertBalancedJournalLines([{ debit: 100, credit: 0 }, { debit: 0, credit: 99.99 }]));
});
