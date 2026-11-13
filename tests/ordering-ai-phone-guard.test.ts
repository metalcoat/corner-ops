import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPhoneOrderId,
  isPhoneMcpTool,
  redactCallerCustomer,
  resolvePhoneCustomerId,
  tenDigitPhone,
} from "../src/lib/ordering-ai-phone-guard";

test("phone MCP executes only the advertised phone tools", () => {
  for (const name of ["price_order", "menu_search", "customer_lookup", "get_draft", "hold", "send", "request_human_handoff"])
    assert.equal(isPhoneMcpTool(name), true, name);
  for (const name of ["create_draft", "update_draft", "attach_delivery_address", "menu_browse", "describe_capabilities", ""])
    assert.equal(isPhoneMcpTool(name), false, name);
});

test("caller lookup result exposes only id, first name, and last four digits", () => {
  const row = {
    id: "c1",
    first_name: " Ann ",
    normalized_phone: "+13155551234",
    last_name: "Smith",
    email: "ann@example.com",
    notes: "VIP",
    addresses: [{ line1: "1 Main" }],
  };
  assert.deepEqual(redactCallerCustomer(row), { customerId: "c1", firstName: "Ann", phoneLast4: "1234" });
});

test("tenDigitPhone accepts only full NANP numbers", () => {
  assert.equal(tenDigitPhone("+1 (315) 555-1234"), "3155551234");
  assert.equal(tenDigitPhone("3155551234"), "3155551234");
  assert.equal(tenDigitPhone("555"), "");
  assert.equal(tenDigitPhone(null), "");
});

test("model-supplied customerId must belong to the call", () => {
  assert.equal(resolvePhoneCustomerId("victim", { callerMatchIds: ["mine"] }), undefined);
  assert.equal(resolvePhoneCustomerId("victim", { orderCustomerId: "bound" }), "bound");
  assert.equal(resolvePhoneCustomerId("victim", { callCustomerId: "call" }), "call");
  assert.equal(resolvePhoneCustomerId("mine", { callerMatchIds: ["mine", "spouse"] }), "mine");
  assert.equal(resolvePhoneCustomerId("bound", { orderCustomerId: "bound" }), "bound");
  assert.equal(resolvePhoneCustomerId("", {}), undefined);
});

test("order tools are always bound to the call's own order", () => {
  const args: Record<string, unknown> = { orderId: "someone-else" };
  assert.deepEqual(bindPhoneOrderId("send", args, "call-order"), { ok: true });
  assert.equal(args.orderId, "call-order");
  const noOrder: Record<string, unknown> = { orderId: "someone-else" };
  assert.deepEqual(bindPhoneOrderId("get_draft", noOrder, null), { ok: false });
  assert.equal(noOrder.orderId, undefined);
  const priceArgs: Record<string, unknown> = { orderId: "someone-else" };
  assert.deepEqual(bindPhoneOrderId("price_order", priceArgs, "call-order"), { ok: true });
  assert.equal(priceArgs.orderId, undefined);
});
