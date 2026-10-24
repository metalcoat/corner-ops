import test from "node:test";
import assert from "node:assert/strict";
import { customerRoute, customerSiteBaseUrl, isCustomerHost } from "../src/lib/customer-domain-routing.js";

test("the ordering site serves customer pages and the customer API only", () => {
  assert.equal(customerRoute("/"), "home");
  for (const path of ["/order", "/order/confirmation", "/menu", "/account/sign-in", "/track/abc", "/privacy", "/terms", "/refund-policy",
    "/api/customer/cart", "/api/customer/orders/1/payments/mx", "/api/health", "/_next/static/x.js", "/corner-deli-logo.png", "/manifest.webmanifest"])
    assert.equal(customerRoute(path), "allow", path);
  for (const path of ["/ops", "/ops/payroll-control", "/pos", "/pos/deli", "/employee", "/signin", "/team", "/scan",
    "/api/ordering/orders", "/api/pos/session", "/api/auth/session", "/api/employee", "/api/cron/scheduler-0700", "/api/push", "/orderx", "/api/customerx"])
    assert.equal(customerRoute(path), "deny", path);
});

test("customer hosts", () => {
  assert.equal(isCustomerHost("ordercornerdeli.com"), true);
  assert.equal(isCustomerHost("WWW.ordercornerdeli.com"), true);
  assert.equal(isCustomerHost("ops.ordercornerdeli.com"), false);
  assert.equal(isCustomerHost("dev.ordercornerdeli.com"), false);
});

test("customer links use CUSTOMER_APP_URL, then the public site in production", () => {
  const saved = { ...process.env };
  try {
    delete process.env.CUSTOMER_APP_URL; delete process.env.APP_ENV;
    assert.equal(customerSiteBaseUrl("http://192.168.1.237:3000"), "http://192.168.1.237:3000");
    process.env.APP_ENV = "production";
    assert.equal(customerSiteBaseUrl("https://team.ordercornerdeli.com"), "https://ordercornerdeli.com");
    process.env.CUSTOMER_APP_URL = "https://dev.ordercornerdeli.com/";
    assert.equal(customerSiteBaseUrl("x"), "https://dev.ordercornerdeli.com");
  } finally { process.env = saved; }
});
