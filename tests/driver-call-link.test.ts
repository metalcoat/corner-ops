import test from "node:test";
import assert from "node:assert/strict";
import { callLink, validCallLinkTemplate } from "../src/lib/driver-call-link.js";

test("the default call link dials the customer's digits", () => {
  assert.equal(callLink("tel:{phone}", "(315) 393-1234"), "tel:3153931234");
  assert.equal(callLink("", "+1 315-393-1234"), "tel:%2B13153931234");
  assert.equal(callLink("tel:{phone}", ""), null);
});

test("only dialer-style call links are accepted", () => {
  assert.ok(validCallLinkTemplate("tel:{phone}"));
  assert.ok(validCallLinkTemplate("sip:{phone}@pbx.example.com"));
  assert.ok(validCallLinkTemplate("https://deli.3cx.us/webclient/#/call?phone={phone}"));
  assert.ok(!validCallLinkTemplate("javascript:alert('{phone}')"));
  assert.ok(!validCallLinkTemplate("data:text/html,{phone}"));
  assert.ok(!validCallLinkTemplate("tel:3153931234"));
});

test("an unsafe saved template falls back to tel:", () => {
  assert.equal(callLink("javascript:alert('{phone}')", "3153931234"), "tel:3153931234");
});
