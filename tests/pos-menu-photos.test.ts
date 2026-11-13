import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

// Chris 2026-11-09: candy photos showed online but not on the POS. The POS menu points its buttons at
// /api/ordering/media/<id>; a PIN-signed POS only gets through the proxy for the paths in isDeliPosApi.
test("a POS signed in with a PIN can load menu item photos", () => {
  const proxy = read("src/proxy.ts");
  const posApi = proxy.slice(proxy.indexOf("function isDeliPosApi"), proxy.indexOf("function anyPath"));
  assert.match(posApi, /"media",/);
  assert.match(read("src/lib/ordering-menu.ts"), /'\/api\/ordering\/media\/'\|\|media\.id/);
  const route = read("src/app/api/ordering/media/[id]/route.ts");
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
});
