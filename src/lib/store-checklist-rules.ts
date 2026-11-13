// Pure rules for the store checklists and deli salad log (no database): which list the screen opens on,
// how long a PIN keeps someone signed in on the shared screen, and what a day's history says was missed.
import { BUSINESS_DAY_START_HOUR, STORE_TIME_ZONE } from "./business-day";

/** After a PIN, the screen stays on that person this long since their last tap, so they can tick several in a row. */
export const CHECKLIST_WORKER_IDLE_MS = 3 * 60 * 1000;
export const CHECKLIST_LIMITS = { lists: 12, itemsPerList: 60, salads: 40, fryers: 12, labelChars: 80, noteChars: 200, sizeChars: 40, reasonChars: 120, howToChars: 600, countFields: 12, countLabelChars: 40, countMax: 99999 };

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

/** Count fields can be a grid, one row per size: "Small · On hand", "Small · Made today", "Jumbo · On hand"… */
export const COUNT_SIZE_SEPARATOR = " · ";
export function splitCountField(field: string): { size: string; column: string } {
  const at = field.indexOf(COUNT_SIZE_SEPARATOR);
  return at < 0 ? { size: "", column: field } : { size: field.slice(0, at), column: field.slice(at + COUNT_SIZE_SEPARATOR.length) };
}
const isMade = (field: string) => /^made\b/i.test(splitCountField(field).column);

/** The numbers typed for a count job: whole numbers 0 … 99,999. "On hand" is required; a blank "Made …" is 0. */
export function parseCounts(fields: string[], value: unknown): Record<string, number> {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const counts: Record<string, number> = {};
  for (const field of fields) {
    const raw = input[field];
    const blank = raw === undefined || raw === null || String(raw).trim() === "";
    const number = blank && isMade(field) ? 0 : typeof raw === "number" ? raw : blank ? Number.NaN : Number(String(raw).trim());
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
 * The counted things (sub rolls, buns, dough by size…) for one day: each list's "On hand" in list order, so start /
 * shift change / close read across, and everything entered as "Made …" added up. A grid count gives one row per
 * size; numbers saved before a job became a grid (plain "On hand") still show, as their own row.
 */
export function summarizeCounts(lists: Array<{ id: string; name: string; position: number }>, items: HistoryItem[], checks: HistoryCheck[]): CountRow[] {
  const counted = items.filter((item) => item.countFields?.length);
  const keyOf = (item: HistoryItem) => item.countKey || item.label.toLowerCase();
  const order = [...lists].sort((a, b) => a.position - b.position);
  const sorted = [...counted].sort((a, b) => (order.findIndex((list) => list.id === a.checklistId) - order.findIndex((list) => list.id === b.checklistId)) || a.position - b.position);
  const rows = new Map<string, CountRow & { lists: string[] }>();
  const sizesOf = (fields: string[]) => [...new Set(fields.map((field) => splitCountField(field).size))];
  // Rows first (every size any list asks for, and any size found in what was saved), so a missing count shows as a gap.
  for (const item of sorted) {
    const check = checks.find((entry) => entry.itemId === item.id && !entry.undoneAt);
    const base = item.label.replace(/\s+count$/i, "");
    for (const size of sizesOf([...item.countFields!, ...Object.keys(check?.counts || {})])) {
      const key = size ? `${keyOf(item)}:${size}` : keyOf(item);
      if (!rows.has(key)) rows.set(key, { key, label: size ? `${base} – ${size}` : base, cells: [], made: 0, lists: [] });
    }
  }
  for (const item of sorted) {
    const list = order.find((entry) => entry.id === item.checklistId)?.name || "";
    const check = checks.find((entry) => entry.itemId === item.id && !entry.undoneAt);
    for (const row of rows.values()) {
      if (!row.key.startsWith(keyOf(item)) || (row.key !== keyOf(item) && !row.key.startsWith(`${keyOf(item)}:`)) || row.lists.includes(list)) continue;
      const size = row.key === keyOf(item) ? "" : row.key.slice(keyOf(item).length + 1);
      const entries = Object.entries(check?.counts || {}).filter(([field]) => splitCountField(field).size === size);
      const onHand = entries.find(([field]) => !isMade(field));
      row.lists.push(list);
      row.cells.push({ list, onHand: onHand ? onHand[1] : null, by: entries.length ? check!.employeeName : null });
      for (const [field, value] of entries) if (isMade(field)) row.made += value;
    }
  }
  // A plain row left over from before the grid, with nothing in it on this day, says nothing; drop it.
  return [...rows.values()]
    .filter((row) => row.made || row.cells.some((cell) => cell.onHand !== null) || ![...rows.keys()].some((key) => key.startsWith(`${row.key}:`)))
    .map(({ lists: _lists, ...row }) => [...rows.keys()].some((key) => key.startsWith(`${row.key}:`)) ? { ...row, label: `${row.label} (all sizes)` } : row);
}

/** "Tue 10:42 AM" for a store time (today and yesterday say so). */
export function whenLabel(iso: string, now = new Date()): string {
  const day = (at: Date) => at.toLocaleDateString("en-CA", { timeZone: STORE_TIME_ZONE });
  const at = new Date(iso);
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: STORE_TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(at);
  const yesterday = new Date(now.getTime() - 24 * 3600e3);
  if (day(at) === day(now)) return `Today ${clock}`;
  if (day(at) === day(yesterday)) return `Yesterday ${clock}`;
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: STORE_TIME_ZONE, weekday: "short", ...(now.getTime() - at.getTime() > 6 * 24 * 3600e3 ? { month: "short", day: "numeric" } : {}) }).format(at);
  return `${weekday} ${clock}`;
}

/** "just now", "25 min ago", "3 hours ago", "2 days ago". */
export function agoLabel(iso: string, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const storeDay = (at: Date) => at.toLocaleDateString("en-CA", { timeZone: STORE_TIME_ZONE });
/** Whole store calendar days from one moment to another (made yesterday evening = 1 day this morning). */
export function daysOld(iso: string, now = new Date()): number {
  return Math.max(0, Math.round((Date.parse(`${storeDay(now)}T12:00:00Z`) - Date.parse(`${storeDay(new Date(iso))}T12:00:00Z`)) / 86_400_000));
}

/** "Sun 11/8 10:42 AM" */
export function madeLabel(iso: string): string {
  const at = new Date(iso);
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: STORE_TIME_ZONE, ...options }).format(at);
  return `${part({ weekday: "short" })} ${part({ month: "numeric", day: "numeric" })} ${part({ hour: "numeric", minute: "2-digit" })}`;
}

/** "Today", "1 day", "3 days" */
export function ageLabel(iso: string, now = new Date()): string {
  const days = daysOld(iso, now);
  return days === 0 ? "Today" : `${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * A salad good for N days (made counts as day 1): "last" on its last good day, "past" after it, otherwise "ok".
 * No setting = no highlight.
 */
export function saladFreshness(iso: string, goodForDays: number | null | undefined, now = new Date()): "ok" | "last" | "past" | null {
  if (!goodForDays) return null;
  const days = daysOld(iso, now);
  return days >= goodForDays ? "past" : days === goodForDays - 1 ? "last" : "ok";
}

export function parseGoodForDays(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("Good for: pick 1 to 30 days, or leave it empty.");
  return days;
}

const SIZE_ORDER = ["small", "medium", "regular", "large", "jumbo", "thick"];

/** Saved numbers in a line: "On hand 12 · Made today 40", or for a grid "Small 5 · Regular 8 (+2 made) · …". */
export function formatCounts(counts: Record<string, number> | null | undefined): string {
  if (!counts) return "";
  const parts: string[] = [];
  const sizes = new Map<string, { onHand?: number; made: number }>();
  for (const [field, value] of Object.entries(counts)) {
    const { size, column } = splitCountField(field);
    if (!size) { parts.push(`${column} ${value}`); continue; }
    const entry = sizes.get(size) || sizes.set(size, { made: 0 }).get(size)!;
    if (isMade(field)) entry.made += value;
    else entry.onHand = value;
  }
  // Saved numbers come back from the database in its own key order: put them back in a reading order.
  parts.sort((a, b) => Number(/^made\b/i.test(a)) - Number(/^made\b/i.test(b)));
  const rank = (size: string) => { const at = SIZE_ORDER.indexOf(size.toLowerCase()); return at < 0 ? SIZE_ORDER.length : at; };
  for (const [size, entry] of [...sizes].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))) parts.push(`${size} ${entry.onHand ?? "—"}${entry.made ? ` (+${entry.made} made)` : ""}`);
  return parts.join(" · ");
}

/** The sizes of a grid count job ("Small", "Regular", …) with their columns, or null for a plain count. */
export function countGrid(fields: string[]): { sizes: string[]; columns: string[] } | null {
  if (!fields.length || !fields.every((field) => splitCountField(field).size)) return null;
  return {
    sizes: [...new Set(fields.map((field) => splitCountField(field).size))],
    columns: [...new Set(fields.map((field) => splitCountField(field).column))],
  };
}

export type CountPlan = { minimums: Record<string, number>; leftoverSize: string };

/**
 * What to make now, per size, to get back to each size's minimum on hand; the leftover size (thin Jumbo for
 * dough) takes the rest of the batch. A size not counted yet suggests nothing. When a batch's exact yield is
 * known (Chris will weigh one), the leftover can become a number: add it here and keep the same rows.
 */
export function suggestMake(sizes: string[], onHand: Record<string, number | null | undefined>, plan: CountPlan) {
  return sizes.map((size) => {
    const minimum = plan.minimums[size];
    const have = onHand[size];
    if (size === plan.leftoverSize) return { size, minimum: null, make: null, leftover: true };
    if (minimum === undefined || minimum === null) return { size, minimum: null, make: null, leftover: false };
    return { size, minimum, make: have === null || have === undefined ? null : Math.max(0, minimum - have), leftover: false };
  });
}

/** Minimums typed in the editor: whole numbers 0 … 999 per size; blank = no minimum. */
export function parsePlan(sizes: string[], input: { minimums?: unknown; leftoverSize?: unknown }): CountPlan {
  const raw = input.minimums && typeof input.minimums === "object" ? (input.minimums as Record<string, unknown>) : {};
  const minimums: Record<string, number> = {};
  for (const size of sizes) {
    const value = raw[size];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    const number = Number(String(value).trim());
    if (!Number.isInteger(number) || number < 0 || number > 999) throw new Error(`Minimum for ${size}: a whole number, or blank.`);
    minimums[size] = number;
  }
  const leftoverSize = String(input.leftoverSize ?? "").trim();
  if (leftoverSize && !sizes.includes(leftoverSize)) throw new Error("Pick one of the sizes for the rest of the batch.");
  if (leftoverSize) delete minimums[leftoverSize];
  return { minimums, leftoverSize };
}

/** Last night's on-hand numbers that fit this morning's count fields (Made fields are never carried over). */
export function carryOverOnHand(fields: string[], previous: Record<string, number> | null | undefined): Record<string, number> {
  const carried: Record<string, number> = {};
  for (const field of fields) if (!isMade(field) && previous && typeof previous[field] === "number") carried[field] = previous[field];
  return carried;
}
