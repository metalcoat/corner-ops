import assert from "node:assert/strict";
import test from "node:test";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  businessHour, decodeWorker, defaultChecklistId, encodeWorker, hourLabel, parseOpensAtHour, summarizeChecklistDay, tallyByEmployee,
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
