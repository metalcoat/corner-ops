import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// iPads only show the number keyboard when the field asks for it.
test("POS phone fields ask for the phone keyboard", () => {
  assert.match(source("src/app/pos/pos-client.tsx"), /type="tel"\s+required\s+inputMode="tel"\s+autoComplete="tel"\s+placeholder="315-555-1212"/);
  const customers = source("src/app/pos/deli/customers/customers-client.tsx");
  assert.match(customers, /type="tel" inputMode="tel" autoComplete="tel"\s+placeholder="Phone"/);
  assert.match(customers, /type="tel" inputMode="tel" autoComplete="tel"\s+placeholder="Phone number"/);
});

test("POS gift card and ZIP fields ask for the number keyboard", () => {
  assert.match(source("src/app/pos/pos-client.tsx"), /inputMode="numeric"\s+ref=\{giftCardInputRef\}\s+data-barcode-context="gift-card"/);
  assert.match(source("src/app/pos/deli/customers/customers-client.tsx"), /inputMode="numeric" autoComplete="postal-code"\s+placeholder="ZIP"/);
});
