import assert from "node:assert/strict";
import test from "node:test";
import {
  assertHelcimTransactionMatches,
  helcimCanonicalJson,
  sha256,
  validateHelcimPayResponse,
} from "../src/lib/helcim";

const approved = {
  transactionId: "1234567",
  status: "APPROVED",
  type: "purchase",
  amount: 42.5,
  currency: "USD",
};

test("accepts Helcim's record of an approved purchase for the exact amount", () => {
  assert.doesNotThrow(() =>
    assertHelcimTransactionMatches(approved, "1234567", 4250),
  );
});

test("rejects declined, mismatched, or substituted transactions", () => {
  for (const [transaction, reference, cents] of [
    [{ ...approved, status: "DECLINED" }, "1234567", 4250],
    [{ ...approved, type: "refund" }, "1234567", 4250],
    [{ ...approved, amount: 1 }, "1234567", 4250],
    [{ ...approved, currency: "CAD" }, "1234567", 4250],
    [approved, "7654321", 4250],
  ] as const)
    assert.throws(() =>
      assertHelcimTransactionMatches(transaction, reference, cents),
    );
});

test("a browser cannot sign an approval without the server-held secret", () => {
  const data = { status: "APPROVED", type: "purchase", amount: "42.50" };
  const serverSecret = "server-only-secret";
  const forgedHash = sha256(helcimCanonicalJson(data) + "guessed-secret");
  assert.throws(() => validateHelcimPayResponse(data, forgedHash, serverSecret));
  const realHash = sha256(helcimCanonicalJson(data) + serverSecret);
  assert.doesNotThrow(() =>
    validateHelcimPayResponse(data, realHash, serverSecret),
  );
});
