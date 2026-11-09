import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  businessHour, cleanVideoUrl, decodeWorker, defaultChecklistId, encodeWorker, hourLabel, parseCountFields, parseCounts, parseOpensAtHour,
  summarizeChecklistDay, summarizeCounts, tallyByEmployee, youtubeEmbedUrl, agoLabel, whenLabel,
  type HistoryCheck,
} from "../src/lib/store-checklist-rules";
import { businessDayBoundary } from "../src/lib/business-day";

const sign = (body: string) => createHmac("sha256", "test-secret").update(body).digest("base64url");
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// 2026-11-09 is EST (UTC-5).
const eastern = (hour: number, day = 9) => new Date(Date.UTC(2026, 10, day, hour + 5));

test("checklists: business hours run 4 AM to 3 AM", () => {
  assert.equal(businessHour(eastern(4)), 4);
  assert.equal(businessHour(eastern(21)), 21);
  assert.equal(businessHour(eastern(1, 10)), 25);
  assert.equal(hourLabel(19), "7 PM");
  assert.equal(hourLabel(24), "12 AM");
  assert.equal(hourLabel(25), "1 AM");
  assert.equal(parseOpensAtHour("27"), 27);
  assert.throws(() => parseOpensAtHour(3), /between 4 AM and 3 AM/);
  assert.throws(() => parseOpensAtHour(28));
});

test("checklists: the screen opens on the list for the time of day", () => {
  const lists = [{ id: "closing", opensAtHour: 19 }, { id: "opening", opensAtHour: 4 }, { id: "midday", opensAtHour: 13 }];
  assert.equal(defaultChecklistId(lists, eastern(7)), "opening");
  assert.equal(defaultChecklistId(lists, eastern(14)), "midday");
  assert.equal(defaultChecklistId(lists, eastern(22)), "closing");
  // After midnight is still the night before: Closing.
  assert.equal(defaultChecklistId(lists, eastern(1, 10)), "closing");
  // Before any list's hour, the earliest one.
  assert.equal(defaultChecklistId([{ id: "late", opensAtHour: 12 }, { id: "later", opensAtHour: 18 }], eastern(6)), "late");
  assert.equal(defaultChecklistId([], eastern(6)), null);
});

test("checklists: the PIN pass is signed and runs out", () => {
  const now = Date.UTC(2026, 10, 9, 20);
  const token = encodeWorker({ employeeId: "e1", name: "Sam Smith", role: "employee", expiresAt: now + 60_000 }, sign);
  assert.deepEqual(decodeWorker(token, sign, equal, now), { employeeId: "e1", name: "Sam Smith", role: "employee", expiresAt: now + 60_000 });
  assert.equal(decodeWorker(token, sign, equal, now + 60_001), null);
  const [body, signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ employeeId: "boss", name: "Boss", role: "owner", expiresAt: now + 60_000 })).toString("base64url");
  assert.equal(decodeWorker(`${forged}.${signature}`, sign, equal, now), null);
  assert.equal(decodeWorker(`${body}.`, sign, equal, now), null);
  assert.equal(decodeWorker(undefined, sign, equal, now), null);
});

const check = (itemId: string, name: string, extra: Partial<HistoryCheck> = {}): HistoryCheck => ({
  id: Math.floor(Math.random() * 1e6), businessDate: "2026-11-08", checklistId: "close", itemId, itemLabel: itemId, employeeName: name,
  checkedAt: "2026-11-09T02:40:00.000Z", bulk: false, undoneAt: null, undoneByName: null, undoReason: null, ...extra,
});

test("checklists: a day's history shows who did each job, what was missed and un-checks", () => {
  const window = { start: businessDayBoundary("2026-11-08"), end: businessDayBoundary("2026-11-08", true) };
  const lists = [
    { id: "close", name: "Closing", position: 30, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
    { id: "open", name: "Opening", position: 10, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
    // Added after that day: not part of it.
    { id: "new", name: "Shift change", position: 20, createdAt: "2026-11-09T15:00:00Z", archivedAt: null },
  ];
  const items = [
    { id: "mop", checklistId: "close", label: "Mop up front", position: 10, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
    { id: "slicer", checklistId: "close", label: "Clean slicer", position: 20, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
    { id: "lock", checklistId: "close", label: "Lock doors", position: 30, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
    // Switched off before the day: not missed.
    { id: "old", checklistId: "close", label: "Old job", position: 40, createdAt: "2026-11-01T00:00:00Z", archivedAt: "2026-11-05T00:00:00Z" },
    // Switched off later that day: still counts.
    { id: "trash", checklistId: "close", label: "Trash", position: 50, createdAt: "2026-11-01T00:00:00Z", archivedAt: "2026-11-08T20:00:00Z" },
    { id: "fryer", checklistId: "open", label: "Fryers on", position: 10, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
  ];
  const checks = [
    check("mop", "Sam"),
    check("slicer", "Ana", { undoneAt: "2026-11-09T02:50:00Z", undoneByName: "Lee", undoReason: "Not done right" }),
    check("lock", "Lee", { bulk: true }),
  ];
  const [opening, closing] = summarizeChecklistDay(lists, items, checks, window);
  assert.equal(opening.name, "Opening");
  assert.deepEqual([opening.done, opening.total, opening.missed], [0, 1, ["Fryers on"]]);
  assert.equal(closing.name, "Closing");
  assert.deepEqual([closing.done, closing.total], [2, 4]);
  assert.deepEqual(closing.missed, ["Clean slicer", "Trash"]);
  const slicer = closing.items.find((row) => row.itemId === "slicer")!;
  assert.equal(slicer.check, null);
  assert.equal(slicer.undone[0].undoReason, "Not done right");
  assert.equal(closing.items.find((row) => row.itemId === "lock")!.check?.bulk, true);
  assert.equal(summarizeChecklistDay(lists, items, checks, window).some((list) => list.name === "Shift change"), false);
});

test("checklists: tallies by person count jobs, un-checks and salad batches (removed batches don't count)", () => {
  const people = tallyByEmployee(
    [{ employeeName: "Sam", undoneAt: null }, { employeeName: "Sam", undoneAt: "x" }, { employeeName: "Ana", undoneAt: null }],
    [{ employeeName: "Ana", voidedAt: null }, { employeeName: "Ana", voidedAt: null }, { employeeName: "Lee", voidedAt: "x" }],
  );
  assert.deepEqual(people, [
    { name: "Ana", checks: 1, undone: 0, batches: 2 },
    { name: "Sam", checks: 1, undone: 1, batches: 0 },
  ]);
});

test("checklists: migration seeds placeholders once and adds the screen kind", () => {
  const migration = readFileSync("db/migrations/0049_store_checklists.sql", "utf8");
  assert.match(migration, /CHECK \(kind IN \('board', 'labels', 'checklists'\)\)/);
  assert.match(migration, /WHERE NOT EXISTS \(SELECT 1 FROM store_checklists WHERE business = 'Corner Deli'\)/);
  assert.match(migration, /\('Closing', 'Mop up front', 10\)/);
  assert.match(migration, /\('Potato salad', 20, false\)/);
});

test("checklists: 0050 sets the store's real deli salad list in order", () => {
  const migration = readFileSync("db/migrations/0050_deli_salad_list.sql", "utf8");
  assert.match(migration, /\('Macaroni', 10\), \('Potato', 20\), \('Pasta', 30\), \('Green Bean', 40\), \('Brown Bean', 50\), \('Cole Slaw', 60\), \('Antipasto', 70\)/);
  // Tuna and Chicken salad are deleted only when no batch points at them (batches cascade on delete).
  assert.match(migration, /DELETE FROM deli_salads[\s\S]*NOT EXISTS \(SELECT 1 FROM deli_salad_batches/);
});

test("checklists: how-to videos accept YouTube links only", () => {
  const embed = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0&playsinline=1";
  for (const link of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s", "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=abc", "https://www.youtube.com/shorts/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ", " https://www.youtube.com/live/dQw4w9WgXcQ ",
  ]) assert.equal(youtubeEmbedUrl(link), embed, link);
  for (const link of [
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/123456", "javascript:alert(1)", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/channel/UCabcdefghijk", "",
  ]) assert.equal(youtubeEmbedUrl(link), null, link);
  assert.equal(cleanVideoUrl(""), "");
  assert.equal(cleanVideoUrl("https://youtu.be/dQw4w9WgXcQ"), "https://youtu.be/dQw4w9WgXcQ");
  assert.throws(() => cleanVideoUrl("https://vimeo.com/1"), /YouTube/);
});

test("checklists: count jobs need a whole number for every field", () => {
  assert.deepEqual(parseCountFields("On hand, Made today ,"), ["On hand", "Made today"]);
  assert.deepEqual(parseCountFields(""), []);
  assert.deepEqual(parseCountFields(["On hand", "On hand"]), ["On hand"]);
  assert.throws(() => parseCountFields("a,b,c,d"), /At most 3/);
  assert.deepEqual(parseCounts(["On hand", "Made today"], { "On hand": "12", "Made today": 0 }), { "On hand": 12, "Made today": 0 });
  assert.throws(() => parseCounts(["On hand", "Made today"], { "On hand": "12" }), /Made today/);
  assert.throws(() => parseCounts(["On hand"], { "On hand": "-1" }), /whole number/);
  assert.throws(() => parseCounts(["On hand"], { "On hand": "2.5" }), /whole number/);
  assert.throws(() => parseCounts(["On hand"], { "On hand": "100000" }), /whole number/);
  assert.throws(() => parseCounts(["On hand"], undefined), /whole number/);
});

test("checklists: a job moved to another list keeps its ticks there", () => {
  const window = { start: businessDayBoundary("2026-11-08"), end: businessDayBoundary("2026-11-08", true) };
  const lists = [
    { id: "open", name: "Opening", position: 10, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
    { id: "mid", name: "Mid-day", position: 20, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
  ];
  // Ticked on Opening, then moved to Mid-day: the tick still has checklistId "open".
  const items = [{ id: "soda", checklistId: "mid", label: "Stock soda cooler", position: 10, createdAt: "2026-11-01T00:00:00Z", archivedAt: null }];
  const [opening, midday] = summarizeChecklistDay(lists, items, [check("soda", "Sam", { checklistId: "open" })], window);
  assert.equal(opening.total, 0);
  assert.equal(midday.items[0].check?.employeeName, "Sam");
});

test("checklists: counts read across start, shift change and close with everything made added up", () => {
  const lists = [{ id: "close", name: "Closing", position: 30 }, { id: "open", name: "Opening", position: 10 }, { id: "mid", name: "Mid-day", position: 20 }];
  const item = (id: string, checklistId: string, label: string, fields: string[]) => ({ id, checklistId, label, position: 10, createdAt: "2026-11-01T00:00:00Z", archivedAt: null, countFields: fields, countKey: "sub-rolls" });
  const items = [
    item("r3", "close", "Sub rolls count", ["On hand", "Made this shift"]),
    item("r1", "open", "Sub rolls", ["On hand", "Made today"]),
    item("r2", "mid", "Sub rolls count", ["On hand", "Made this shift"]),
    { id: "mop", checklistId: "close", label: "Mop", position: 20, createdAt: "2026-11-01T00:00:00Z", archivedAt: null },
  ];
  const rows = summarizeCounts(lists, items, [
    check("r1", "Sam", { counts: { "On hand": 10, "Made today": 40 } }),
    check("r2", "Ana", { counts: { "On hand": 22, "Made this shift": 12 } }),
    check("r3", "Lee", { counts: { "On hand": 5, "Made this shift": 0 }, undoneAt: "2026-11-09T03:00:00Z" }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "Sub rolls");
  assert.deepEqual(rows[0].cells, [{ list: "Opening", onHand: 10, by: "Sam" }, { list: "Mid-day", onHand: 22, by: "Ana" }, { list: "Closing", onHand: null, by: null }]);
  assert.equal(rows[0].made, 52);
});

test("checklists: 0051 replaces the placeholders with the store's jobs and keeps ticked ones", () => {
  const migration = readFileSync("db/migrations/0051_checklist_real_jobs.sql", "utf8");
  assert.match(migration, /\('Opening', 'Fryers set to 180 °C', 'All fryers 180 °C \(Celsius\), no higher.', false, ARRAY\[\]::text\[\], '', 10\)/);
  for (const list of ["Opening", "Mid-day", "Closing"]) assert.match(migration, new RegExp(`\\('${list}', 'Pizza dough count'`));
  assert.match(migration, /'Stock containers up front and by fryer', '', true/);
  assert.doesNotMatch(migration, /10 pizzas/);
  assert.match(migration, /AND item\.placeholder AND EXISTS \(SELECT 1 FROM store_checklist_checks/);
});

test("checklists: last-made cards say when and how long ago", () => {
  // Mon 2026-11-09 3:00 PM Eastern.
  const now = new Date("2026-11-09T20:00:00Z");
  assert.equal(whenLabel("2026-11-09T15:42:00Z", now), "Today 10:42 AM");
  assert.equal(whenLabel("2026-11-08T23:05:00Z", now), "Yesterday 6:05 PM");
  assert.equal(whenLabel("2026-11-07T15:42:00Z", now), "Sat 10:42 AM");
  assert.equal(whenLabel("2026-10-20T15:42:00Z", now), "Tue, Oct 20 11:42 AM");
  assert.equal(agoLabel("2026-11-09T19:59:30Z", now), "just now");
  assert.equal(agoLabel("2026-11-09T19:35:00Z", now), "25 min ago");
  assert.equal(agoLabel("2026-11-09T18:59:00Z", now), "1 hour ago");
  assert.equal(agoLabel("2026-11-09T15:00:00Z", now), "5 hours ago");
  assert.equal(agoLabel("2026-11-08T19:00:00Z", now), "1 day ago");
  assert.equal(agoLabel("2026-11-07T15:42:00Z", now), "2 days ago");
});

test("checklists: 0052 seeds two fryers once and finalizes the last two placeholder jobs", () => {
  const migration = readFileSync("db/migrations/0052_fryer_oil_log.sql", "utf8");
  assert.match(migration, /\('Fryer 1', 10\), \('Fryer 2', 20\)/);
  assert.match(migration, /WHERE NOT EXISTS \(SELECT 1 FROM store_fryers WHERE business = 'Corner Deli'\)/);
  assert.match(migration, /label = 'Stock containers and lids'/);
  assert.match(migration, /directions on the back of the bag/);
});
