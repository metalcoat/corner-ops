import assert from "node:assert/strict";
import test from "node:test";
import { isTeamHost, teamRoute } from "../src/lib/team-domain-routing";

test("both team hosts use the same login driven workspace", () => {
  assert.equal(isTeamHost("team.ordercornerdeli.com"), true);
  assert.equal(isTeamHost("team.atthedocks.com"), true);
  assert.equal(isTeamHost("dev.ordercornerdeli.com"), false);
  assert.equal(isTeamHost("ordercornerdeli.com"), false);
});

test("team hosts show team pages and keep ordering closed", () => {
  assert.equal(teamRoute("/"), "home");
  assert.equal(teamRoute("/ops/people"), "home");
  for (const path of ["/employee/messages", "/ops/messages", "/ops/payroll-control", "/ops/workforce", "/signin", "/api/employee/session", "/_next/static/app.js"]) {
    assert.equal(teamRoute(path), "allow", path);
  }
  for (const path of ["/order", "/pos", "/ops/banking", "/api/order", "/api/ordering/checkout", "/api/pos/tickets"]) {
    assert.equal(teamRoute(path), "deny", path);
  }
});
