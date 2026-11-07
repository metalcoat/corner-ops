import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pos = readFileSync(join(process.cwd(), "src/app/pos/pos-client.tsx"), "utf8");

test("saved-address auto-select stays off while the new address editor is open", () => {
  const effect = pos.match(/useEffect\(\(\) => \{\s*if \(\s*serviceType !== "delivery" \|\|[\s\S]*?void chooseSavedAddress\(customer\.addresses\[0\]\);\s*\}, \[([\s\S]*?)\]\);/);
  assert.ok(effect, "auto-select effect not found");
  assert.match(effect[0], /deliveryEditorOpen \|\|/);
  assert.match(effect[1], /deliveryEditorOpen/);
});

test("ADD NEW ADDRESS and CLEAR empty the street address", () => {
  assert.match(pos, /setDeliveryAddress\(""\);[\s\S]{0,600}setDeliveryEditorOpen\(true\);[\s\S]{0,200}\+ ADD NEW ADDRESS/);
  assert.match(pos, /className="posAddressClear"[^>]*onClick=\{\(\)=>changeDeliveryAddress\(""\)\}/);
});
