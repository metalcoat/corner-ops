import assert from "node:assert/strict";
import test from "node:test";
import { secretStrengthError } from "../src/lib/secret-strength";

test("rejects the old static CI-style placeholder credential", () => {
  assert.match(
    secretStrengthError("github-actions-employment-key-placeholder-1234567890", "KEY") || "",
    /placeholder/i,
  );
});

test("rejects repetitive low-diversity key material", () => {
  assert.ok(secretStrengthError("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "KEY"));
});

test("accepts random-looking 32-byte-plus key material", () => {
  assert.equal(secretStrengthError("lQ5gI+vQ03T9DUcP9tm9mF7cMRerKj2AVh7d5R4tzws=", "KEY"), null);
});
