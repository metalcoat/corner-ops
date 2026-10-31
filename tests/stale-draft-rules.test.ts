import assert from "node:assert/strict";
import test from "node:test";
import { draftAgeLabel, parseStaleDraftSettings, stationShowsStaleDrafts } from "../src/lib/stale-draft-rules";

test("stale drafts: settings are validated", () => {
  assert.deepEqual(parseStaleDraftSettings({ minutes: 10, stations: [" Deli-Back-1 ", "deli-back-1", ""] }), { minutes: 10, stations: ["deli-back-1"] });
  assert.throws(() => parseStaleDraftSettings({ minutes: 2.5, stations: [] }), /whole number/);
  assert.throws(() => parseStaleDraftSettings({ minutes: 241, stations: [] }), /240/);
  assert.throws(() => parseStaleDraftSettings({ minutes: 10 }), /stations/);
});

test("stale drafts: only the chosen stations show it, and 0 minutes turns it off", () => {
  const settings = { minutes: 10, stations: ["deli-back-1"] };
  assert.equal(stationShowsStaleDrafts(settings, "DELI-BACK-1"), true);
  assert.equal(stationShowsStaleDrafts(settings, "deli-upfront"), false);
  assert.equal(stationShowsStaleDrafts({ ...settings, minutes: 0 }, "deli-back-1"), false);
});

test("stale drafts: age reads naturally", () => {
  const now = new Date("2026-10-30T12:00:00Z");
  assert.equal(draftAgeLabel("2026-10-30T11:48:30Z", now), "11 min ago");
  assert.equal(draftAgeLabel("2026-10-30T10:30:00Z", now), "1 hr 30 min ago");
  assert.equal(draftAgeLabel("2026-10-28T12:00:00Z", now), "2 days ago");
});
