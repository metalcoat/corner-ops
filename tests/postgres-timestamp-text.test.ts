import test from "node:test";
import assert from "node:assert/strict";
import { types } from "pg";
import { ensurePostgresStringTimestamps } from "../src/lib/postgres-string-timestamps.js";
import {
  isoJson,
  isoTimestampsDeep,
  isPostgresTimestampText,
  toIsoTimestamp,
  toIsoTimestampOrEmpty,
  toTimestampDate,
  toTimestampMs,
} from "../src/lib/timestamp-values.js";

test("raw PostgreSQL timestamptz text converts to ISO 8601", () => {
  assert.equal(toIsoTimestamp("2026-10-05 12:34:56.123456+00"), "2026-10-05T12:34:56.123Z");
  assert.equal(toIsoTimestamp("2026-10-05 12:34:56+00"), "2026-10-05T12:34:56.000Z");
  assert.equal(toIsoTimestamp("2026-10-05 12:34:56.5+00"), "2026-10-05T12:34:56.500Z");
  assert.equal(toIsoTimestamp("2026-10-05 08:34:56.123-04"), "2026-10-05T12:34:56.123Z");
  assert.equal(toIsoTimestamp("2026-10-05 18:04:56+05:30"), "2026-10-05T12:34:56.000Z");
  assert.equal(toTimestampMs("2026-10-05 12:34:56.123456+00"), Date.UTC(2026, 9, 5, 12, 34, 56, 123));
  assert.equal(toTimestampDate("2026-10-05 12:34:56+00")?.getTime(), Date.UTC(2026, 9, 5, 12, 34, 56));
});

test("timestamp helpers accept Dates and ISO text and reject empty values", () => {
  const date = new Date(Date.UTC(2026, 9, 5, 12, 34, 56, 123));
  assert.equal(toIsoTimestamp(date), "2026-10-05T12:34:56.123Z");
  assert.equal(toIsoTimestamp("2026-10-05T12:34:56.123Z"), "2026-10-05T12:34:56.123Z");
  assert.equal(toIsoTimestamp(null), null);
  assert.equal(toIsoTimestamp(""), null);
  assert.equal(toIsoTimestamp("not a time"), null);
  assert.equal(toIsoTimestampOrEmpty(undefined), "");
  assert.ok(Number.isNaN(toTimestampMs(null)));
});

test("isoTimestampsDeep rewrites only raw timestamptz strings", () => {
  assert.equal(isPostgresTimestampText("2026-10-05 12:34:56.123456+00"), true);
  assert.equal(isPostgresTimestampText("2026-10-05"), false);
  assert.equal(isPostgresTimestampText("2026-10-05 12:34:56"), false);
  const input = {
    createdAt: "2026-10-05 12:34:56.123456+00",
    businessDate: "2026-10-05",
    note: "Ready at 2026-10-05 12:34:56+00 please",
    count: 3,
    items: [{ updatedAt: "2026-10-05 12:34:56+00", name: "Club" }],
    nothing: null,
  };
  assert.deepEqual(isoTimestampsDeep(input), {
    createdAt: "2026-10-05T12:34:56.123Z",
    businessDate: "2026-10-05",
    note: "Ready at 2026-10-05 12:34:56+00 please",
    count: 3,
    items: [{ updatedAt: "2026-10-05T12:34:56.000Z", name: "Club" }],
    nothing: null,
  });
  assert.equal(input.createdAt, "2026-10-05 12:34:56.123456+00", "input is not mutated");
});

test("isoJson responds with ISO timestamps", async () => {
  const response = isoJson({ at: "2026-10-05 12:34:56.123456+00" }, { status: 201 });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { at: "2026-10-05T12:34:56.123Z" });
});

test("pg returns timestamp and timestamptz as raw text, DATE unchanged", () => {
  const dateParserBefore = types.getTypeParser(1082, "text");
  ensurePostgresStringTimestamps();
  assert.equal(types.getTypeParser(1184, "text")("2026-10-05 12:34:56.123456+00"), "2026-10-05 12:34:56.123456+00");
  assert.equal(types.getTypeParser(1114, "text")("2026-10-05 12:34:56.123456"), "2026-10-05 12:34:56.123456");
  assert.equal(types.getTypeParser(1082, "text"), dateParserBefore);
});
