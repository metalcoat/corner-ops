#!/usr/bin/env node
// A failure partway through a multi-step save must undo the earlier steps.
// Receives a purchase order whose second line cannot be stocked and checks the first line's stock went back out.
// Runs outside a wrapping transaction on purpose: a wrapper hides queries that skip the real one. Fixtures are deleted after.
import assert from "node:assert/strict";
import { localValidationEnv } from "./validation-env";

localValidationEnv();
const TAG = "rollback-validation";

async function main(): Promise<void> {
  const { getSql } = await import("../src/lib/db");
  const { inventoryAction } = await import("../src/lib/ordering-inventory");
  const sql = getSql();
  const employee = (await sql`SELECT id FROM employees WHERE business='Corner Deli' ORDER BY created_at LIMIT 1`)[0];
  assert.ok(employee, "an employee to record the receiving");
  const manager = { id: String(employee.id), name: "Rollback Check", type: "employee" as const, role: "manager" as const };
  const created: { supplier?: string; items: string[]; po?: string } = { items: [] };
  try {
    created.supplier = String((await inventoryAction({ action: "save_supplier", name: `${TAG} supplier` }, manager)).id);
    for (const name of ["first", "second"]) created.items.push(String((await inventoryAction({ action: "save_item", name: `${TAG} ${name}`, baseUnit: "each" }, manager)).id));
    const lines = created.items.map((itemId) => ({ itemId, quantityCases: 1, caseQuantity: 12, caseUnit: "case", casePriceCents: 1200 }));
    created.po = String((await inventoryAction({ action: "create_po", supplierId: created.supplier, lines }, manager)).id);
    // The second line's remaining stock rounds to zero, which the movements table refuses.
    await sql`UPDATE ordering_inventory_purchase_order_lines SET received_cases=0.999,case_quantity=0.001 WHERE purchase_order_id=${created.po} AND inventory_item_id=${created.items[1]}`;

    await assert.rejects(inventoryAction({ action: "receive_po", id: created.po }, manager));
    const stocked = await sql`SELECT inventory_item_id FROM ordering_inventory_movements WHERE source='purchase_order' AND details->>'purchaseOrderId'=${created.po}`;
    assert.deepEqual(stocked, [], "the first line's stock must be undone when the second line fails");
    const first = (await sql`SELECT received_cases FROM ordering_inventory_purchase_order_lines WHERE purchase_order_id=${created.po} AND inventory_item_id=${created.items[0]}`)[0];
    assert.equal(Number(first.received_cases), 0);
    assert.notEqual((await sql`SELECT status FROM ordering_inventory_purchase_orders WHERE id=${created.po}`)[0].status, "received");
    console.log(JSON.stringify({ failedReceiveLeftNothingBehind: true }, null, 2));
  } finally {
    if (created.po) {
      await sql`DELETE FROM ordering_inventory_movements WHERE source='purchase_order' AND details->>'purchaseOrderId'=${created.po}`;
      await sql`DELETE FROM ordering_inventory_purchase_orders WHERE id=${created.po}`;
    }
    for (const id of created.items) await sql`DELETE FROM ordering_inventory_items WHERE id=${id}`;
    if (created.supplier) await sql`DELETE FROM ordering_inventory_suppliers WHERE id=${created.supplier}`;
  }
}

main().then(() => process.exit(0), (error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
