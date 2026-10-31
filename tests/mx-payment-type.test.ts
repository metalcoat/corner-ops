import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const merchant = readFileSync(join(process.cwd(), "src/lib/mx-merchant.ts"), "utf8");
const dialog = readFileSync(join(process.cwd(), "src/components/mx-keyed-payment-dialog.tsx"), "utf8");

// MX's FTS review (Oct 2026): every transaction carries the right paymentType, and full refunds use DELETE ?force=true.
test("every MX Checkout POST carries a paymentType", () => {
  const posts = merchant.match(/body:JSON\.stringify\(\{merchantId,tenderType:"Card",[^}]*/g) || [];
  assert.equal(posts.length, 3);
  for (const body of posts) assert.match(body, /paymentType:"(Sale|Return)"/);
  assert.match(merchant, /paymentType:"Sale",amount:\(input\.amountCents\/100\)\.toFixed\(2\),tip:/);
  assert.match(merchant, /paymentType:"Return",amount:\(-input\.amountCents\/100\)/);
  assert.match(dialog, /paymentType: "Sale"/);
});

test("full refunds and voids use DELETE /payment/{id}?force=true", () => {
  assert.match(merchant, /mxFetch\(`\/payment\/\$\{encodeURIComponent\(paymentId\)\}\?force=true`,\{method:"DELETE"\}\)/);
});
