import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const merchant = readFileSync(join(process.cwd(), "src/lib/mx-merchant.ts"), "utf8");
const dialog = readFileSync(join(process.cwd(), "src/components/mx-keyed-payment-dialog.tsx"), "utf8");

// MX's FTS review (Oct 2026): every transaction carries the right paymentType, and full refunds use DELETE ?force=true.
test("every MX Checkout POST carries a paymentType", () => {
  // Inspect POST request bodies, excluding PUT adjustments of an existing sale.
  const source = ts.createSourceFile("mx-merchant.ts", merchant, ts.ScriptTarget.Latest, true);
  const posts: ts.ObjectLiteralExpression[] = [];
  const property = (object: ts.ObjectLiteralExpression, name: string) => object.properties.find(
    (entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry) && entry.name.getText(source) === name,
  );
  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      const method = property(node, "method")?.initializer;
      const body = property(node, "body")?.initializer;
      if (method && ts.isStringLiteral(method) && method.text === "POST" && body && ts.isCallExpression(body) && body.expression.getText(source) === "JSON.stringify") {
        const value = body.arguments[0];
        if (value && ts.isObjectLiteralExpression(value) && property(value, "tenderType")?.initializer.getText(source) === '"Card"') posts.push(value);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(posts.length, 3);
  for (const body of posts) assert.match(property(body, "paymentType")?.initializer.getText(source) || "", /^"(Sale|Return)"$/);
  assert.match(merchant, /paymentType:"Sale",amount:\(input\.amountCents\/100\)\.toFixed\(2\),tip:/);
  assert.match(merchant, /paymentType:"Return",amount:\(-input\.amountCents\/100\)/);
  assert.match(dialog, /paymentType: "Sale"/);
});

test("full refunds and voids use DELETE /payment/{id}?force=true", () => {
  assert.match(merchant, /mxFetch\(`\/payment\/\$\{encodeURIComponent\(paymentId\)\}\?force=true`,\{method:"DELETE"\}\)/);
});
