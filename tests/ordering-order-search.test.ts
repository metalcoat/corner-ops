import assert from "node:assert/strict";
import test from "node:test";
import { OrderSearchInputError, parseOrderSearch } from "../src/lib/order-search-filters";

const parse = (query: string) => parseOrderSearch(new URLSearchParams(query), "2026-11-04");

test("order search defaults to the last 7 days and presets count today as day 1", () => {
  assert.deepEqual([parse("").from, parse("").to], ["2026-10-29", "2026-11-04"]);
  assert.deepEqual([parse("days=1").from, parse("days=1").to], ["2026-11-04", "2026-11-04"]);
  assert.equal(parse("days=30").from, "2026-10-06");
  assert.equal(parse("days=7&from=2026-01-01").from, "2026-10-29");
});

test("order search accepts a custom range, either way round, up to a year", () => {
  assert.deepEqual([parse("from=2026-10-10&to=2026-10-01").from, parse("from=2026-10-10&to=2026-10-01").to], ["2026-10-01", "2026-10-10"]);
  assert.equal(parse("from=2026-10-10").to, "2026-10-10");
  assert.throws(() => parse("from=2025-01-01&to=2026-11-04"), OrderSearchInputError);
  assert.throws(() => parse("from=2026-02-30"), OrderSearchInputError);
});

test("order search cleans phone, card and order number input and ignores unknown filters", () => {
  const filters = parse("phone=%2B1 (315) 555-0123&last4=4242&number=%23A12&serviceType=delivery&channel=ai_phone&payment=owes&tender=cash");
  assert.equal(filters.phone, "3155550123");
  assert.equal(filters.last4, "4242");
  assert.equal(filters.number, "A12");
  assert.deepEqual([filters.serviceType, filters.channel, filters.payment, filters.tender], ["delivery", "ai_phone", "owes", "cash"]);
  const loose = parse("serviceType=boat&channel=fax&payment=maybe&tender=iou");
  assert.deepEqual([loose.serviceType, loose.channel, loose.payment, loose.tender], ["", "", "", ""]);
  assert.throws(() => parse("last4=42"), OrderSearchInputError);
  assert.throws(() => parse("phone=5"), OrderSearchInputError);
});
