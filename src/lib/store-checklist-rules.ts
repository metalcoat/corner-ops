// Pure rules for the store checklists and deli salad log (no database): which list the screen opens on,
// how long a PIN keeps someone signed in on the shared screen, and what a day's history says was missed.
import { BUSINESS_DAY_START_HOUR, STORE_TIME_ZONE } from "./business-day";

/** After a PIN, the screen stays on that person this long since their last tap, so they can tick several in a row. */
export const CHECKLIST_WORKER_IDLE_MS = 3 * 60 * 1000;
export const CHECKLIST_LIMITS = { lists: 12, itemsPerList: 60, salads: 40, labelChars: 80, noteChars: 200, sizeChars: 40, reasonChars: 120, howToChars: 600, countFields: 3, countLabelChars: 24, countMax: 99999 };

export type ChecklistWorker = { employeeId: string; name: string; role: "employee" | "manager" | "owner"; expiresAt: number };

/** Hour of the business day: 4 = 4 AM … 23 = 11 PM, 24 = midnight … 27 = 3 AM. */
export function businessHour(at: Date): number {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: STORE_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(at));
  return hour < BUSINESS_DAY_START_HOUR ? hour + 24 : hour;
}

/** The list whose start hour most recently passed; before any has, the earliest. */
export function defaultChecklistId(lists: Array<{ id: string; opensAtHour: number }>, at: Date): string | null {
  if (!lists.length) return null;
  const hour = businessHour(at);
  const started = lists.filter((list) => list.opensAtHour <= hour);
  const pool = started.length ? started : lists;
  return pool.reduce((best, list) => (started.length ? list.opensAtHour >= best.opensAtHour : list.opensAtHour < best.opensAtHour) ? list : best).id;
}

export function cleanText(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Business hour for the settings form: "7 PM" ⇄ 19, "1 AM" ⇄ 25. */
export function hourLabel(hour: number): string {
  const clock = hour % 24;
  return `${clock % 12 || 12} ${clock < 12 ? "AM" : "PM"}`;
}

export function parseOpensAtHour(value: unknown): number {
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < BUSINESS_DAY_START_HOUR || hour > BUSINESS_DAY_START_HOUR + 23) throw new Error("Pick an hour between 4 AM and 3 AM.");
  return hour;
}

/** Short-lived pass that says who is ticking on the shared screen. sign() is an HMAC supplied by the caller. */
export function encodeWorker(worker: ChecklistWorker, sign: (body: string) => string): string {
  const body = Buffer.from(JSON.stringify(worker), "utf8").toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeWorker(token: unknown, sign: (body: string) => string, equal: (a: string, b: string) => boolean, now = Date.now()): ChecklistWorker | null {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature || !equal(sign(body), signature)) return null;
  try {
    const worker = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ChecklistWorker;
    if (!worker.employeeId || !worker.name || !(worker.expiresAt > now)) return null;
    return { employeeId: String(worker.employeeId), name: String(worker.name), role: worker.role === "manager" || worker.role === "owner" ? worker.role : "employee", expiresAt: worker.expiresAt };
  } catch {
    return null;
  }
}

/**
 * A YouTube how-to link as an embeddable player URL, or null when it isn't a YouTube video link. Accepts
 * youtube.com/watch?v=…, youtu.be/…, /shorts/…, /embed/… and /live/… over https only.
 */
export function youtubeEmbedUrl(value: unknown): string | null {
  let url: URL;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let id = "";
  if (host === "youtu.be") id = url.pathname.split("/")[1] || "";
  else if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host)) {
    const [, first, second] = url.pathname.split("/");
    id = first === "watch" ? url.searchParams.get("v") || "" : ["shorts", "embed", "live"].includes(first) ? second || "" : "";
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1` : null;
}

/** The video link a manager typed, or "" for none; anything that isn't a YouTube video link is refused. */
export function cleanVideoUrl(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (!youtubeEmbedUrl(text)) throw new Error("The video link must be a YouTube link (youtube.com or youtu.be).");
  return text.slice(0, 300);
}

/** Count labels for a job ("On hand, Made today"), or [] for an ordinary job. */
export function parseCountFields(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(",");
  const fields = [...new Set(parts.map((part) => cleanText(part, CHECKLIST_LIMITS.countLabelChars)).filter(Boolean))];
  if (fields.length > CHECKLIST_LIMITS.countFields) throw new Error(`At most ${CHECKLIST_LIMITS.countFields} numbers per job.`);
  return fields;
}

/** The numbers typed for a count job: every field, whole numbers 0 … 99,999. */
export function parseCounts(fields: string[], value: unknown): Record<string, number> {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const counts: Record<string, number> = {};
  for (const field of fields) {
    const raw = input[field];
    const number = typeof raw === "number" ? raw : raw === undefined || raw === null || String(raw).trim() === "" ? Number.NaN : Number(String(raw).trim());
    if (!Number.isInteger(number) || number < 0 || number > CHECKLIST_LIMITS.countMax) throw new Error(`Enter a whole number for “${field}”.`);
    counts[field] = number;
  }
  return counts;
}

export type HistoryList = { id: string; name: string; position: number; createdAt: string; archivedAt: string | null };
export type HistoryItem = {
  id: string; checklistId: string; label: string; position: number; createdAt: string; archivedAt: string | null;
  countFields?: string[]; countKey?: string;
};
export type HistoryCheck = {
  id: number; businessDate: string; checklistId: string; itemId: string; itemLabel: string;
  employeeName: string; checkedAt: string; bulk: boolean; counts?: Record<string, number> | null;
  undoneAt: string | null; undoneByName: string | null; undoReason: string | null;
};
export type DayListSummary = {
  checklistId: string; name: string; done: number; total: number;
  items: Array<{ itemId: string; label: string; check: HistoryCheck | null; undone: HistoryCheck[] }>;
  missed: string[];
};

/** Something counted for a day if it existed before the day ended and wasn't switched off before the day began. */
const liveDuring = (row: { createdAt: string; archivedAt: string | null }, start: number, end: number) =>
  Date.parse(row.createdAt) < end && (!row.archivedAt || Date.parse(row.archivedAt) > start);

/**
 * One business day's lists: each item with its tick (or none) and any un-ticks. Items that were switched off
 * still show when someone ticked them that day.
 */
export function summarizeChecklistDay(
  lists: HistoryList[], items: HistoryItem[], checks: HistoryCheck[], window: { start: Date; end: Date },
): DayListSummary[] {
  const start = window.start.getTime(), end = window.end.getTime();
  // A job moved to another list shows (with its ticks) under the list it is on now.
  const ticked = new Set(checks.map((check) => check.itemId));
  return [...lists].sort((a, b) => a.position - b.position).flatMap((list) => {
    const listItems = items
      .filter((item) => item.checklistId === list.id && (liveDuring(item, start, end) || ticked.has(item.id)))
      .sort((a, b) => a.position - b.position);
    if (!liveDuring(list, start, end) && !listItems.some((item) => ticked.has(item.id))) return [];
    const rows = listItems.map((item) => {
      const mine = checks.filter((check) => check.itemId === item.id);
      return { itemId: item.id, label: item.label, check: mine.find((check) => !check.undoneAt) || null, undone: mine.filter((check) => check.undoneAt) };
    });
    return [{
      checklistId: list.id, name: list.name, total: rows.length, done: rows.filter((row) => row.check).length, items: rows,
      missed: rows.filter((row) => !row.check).map((row) => row.label),
    }];
  });
}

/** Ticks and salad batches per person over a period, most active first. */
export function tallyByEmployee(checks: Array<{ employeeName: string; undoneAt: string | null }>, batches: Array<{ employeeName: string; voidedAt: string | null }>) {
  const people = new Map<string, { name: string; checks: number; undone: number; batches: number }>();
  const person = (name: string) => people.get(name) || people.set(name, { name, checks: 0, undone: 0, batches: 0 }).get(name)!;
  for (const check of checks) {
    if (check.undoneAt) person(check.employeeName).undone += 1;
    else person(check.employeeName).checks += 1;
  }
  for (const batch of batches) if (!batch.voidedAt) person(batch.employeeName).batches += 1;
  return [...people.values()].sort((a, b) => b.checks + b.batches - (a.checks + a.batches) || a.name.localeCompare(b.name));
}

export type CountRow = { key: string; label: string; cells: Array<{ list: string; onHand: number | null; by: string | null }>; made: number };

/**
 * The counted things (sub rolls, buns, dough…) for one day: the first number of each list's count ("On hand") in
 * list order, so start / shift change / close read across, and everything entered as "Made …" added up.
 */
export function summarizeCounts(lists: Array<{ id: string; name: string; position: number }>, items: HistoryItem[], checks: HistoryCheck[]): CountRow[] {
  const counted = items.filter((item) => item.countFields?.length);
  const keyOf = (item: HistoryItem) => item.countKey || item.label.toLowerCase();
  const order = [...lists].sort((a, b) => a.position - b.position);
  const rows = new Map<string, CountRow>();
  for (const item of [...counted].sort((a, b) => (order.findIndex((list) => list.id === a.checklistId) - order.findIndex((list) => list.id === b.checklistId)) || a.position - b.position)) {
    const key = keyOf(item);
    if (!rows.has(key)) rows.set(key, { key, label: item.label.replace(/\s+count$/i, ""), cells: [], made: 0 });
    const row = rows.get(key)!;
    const list = order.find((entry) => entry.id === item.checklistId);
    const check = checks.find((entry) => entry.itemId === item.id && !entry.undoneAt);
    const first = item.countFields![0];
    row.cells.push({ list: list?.name || "", onHand: check?.counts && first in check.counts ? check.counts[first] : null, by: check?.employeeName || null });
    for (const [field, value] of Object.entries(check?.counts || {})) if (/^made\b/i.test(field)) row.made += value;
  }
  return [...rows.values()];
}
