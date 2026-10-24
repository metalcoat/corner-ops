import assert from "node:assert/strict";
import test from "node:test";
import { movementEmployeeId } from "../src/lib/inventory-movement-employee";

test("stock movements record an employee only for staff actors", () => {
  assert.equal(movementEmployeeId({ id: "3f2b6c1e-9a4d-4c2e-8b7a-1d2e3f4a5b6c", type: "employee" }), "3f2b6c1e-9a4d-4c2e-8b7a-1d2e3f4a5b6c");
  assert.equal(movementEmployeeId({ id: "web:83c669a047078141", type: "web" }), null);
  assert.equal(movementEmployeeId({ id: "ai_phone:abc", type: "ai_phone" }), null);
  assert.equal(movementEmployeeId({ id: "not-a-uuid", type: "employee" }), null);
});
