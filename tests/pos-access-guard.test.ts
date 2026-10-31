import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalRequestOpen,
  escapeHtml,
  pinAttemptKeys,
  POS_ACCESS_APPROVAL_TTL_MS,
  requestIp,
} from "../src/lib/pos-access-guard";

test("client IP prefers Cloudflare's header over client-controlled X-Forwarded-For", () => {
  const headers = new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
  assert.equal(requestIp(headers), "203.0.113.9");
  assert.equal(requestIp(new Headers({ "x-forwarded-for": "10.0.0.5, 1.1.1.1" })), "10.0.0.5");
  assert.equal(requestIp(new Headers({ "cf-connecting-ip": "::ffff:198.51.100.2" })), "198.51.100.2");
});

test("PIN attempt keys ignore spoofed forwarding headers and include a business-wide key", () => {
  const a = pinAttemptKeys(new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "9.9.9.1" }));
  const b = pinAttemptKeys(new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "9.9.9.2" }));
  assert.equal(a.ipKey, b.ipKey);
  assert.equal(a.businessKey, "business:Corner Deli");
  assert.equal(pinAttemptKeys(new Headers()).ipKey, "ip:local-terminal");
});

test("approval links work only while pending and within 24 hours", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const fresh = new Date(now - 60_000).toISOString();
  assert.equal(approvalRequestOpen({ status: "pending", requested_at: fresh }, now), true);
  assert.equal(approvalRequestOpen({ status: "denied", requested_at: fresh }, now), false);
  assert.equal(approvalRequestOpen({ status: "approved", requested_at: fresh }, now), false);
  assert.equal(approvalRequestOpen({ status: "pending", requested_at: new Date(now - POS_ACCESS_APPROVAL_TTL_MS - 1).toISOString() }, now), false);
  assert.equal(approvalRequestOpen({ status: "pending", requested_at: "garbage" }, now), false);
  assert.equal(approvalRequestOpen(null, now), false);
});

test("escapeHtml neutralizes markup in approval page values", () => {
  assert.equal(escapeHtml(`<b a="1">'&`), "&lt;b a=&quot;1&quot;&gt;&#39;&amp;");
});
