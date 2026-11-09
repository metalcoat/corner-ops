// Store checklists and the deli salad log (db/migrations/0049). The in-store screen (/pos/checklists) ticks
// items and logs salad batches as whoever last typed their PIN there; managers edit the lists in POS Settings or
// the manager portal and read the history in the manager portal. Lists start over each 4 AM business day.
import { getSql, withTransaction } from "@/lib/db";
import { businessDayBoundary } from "@/lib/business-day";
import { businessDateOf } from "@/lib/ordering-registers";
import { constantTimeEqual, hmacSignature } from "@/lib/security-keys";
import { toIsoTimestamp, toIsoTimestampOrEmpty } from "@/lib/timestamp-values";
import {
  CHECKLIST_LIMITS, CHECKLIST_WORKER_IDLE_MS, cleanText, decodeWorker, encodeWorker, parseOpensAtHour, summarizeChecklistDay, tallyByEmployee,
  type ChecklistWorker, type HistoryCheck, type HistoryItem, type HistoryList,
} from "@/lib/store-checklist-rules";

const BUSINESS = "Corner Deli";
const sign = (body: string) => hmacSignature(body, "store-checklist-worker");

/** A fresh pass for the person who just typed their PIN (or just tapped something): good for a few idle minutes. */
export function workerPass(worker: Omit<ChecklistWorker, "expiresAt">) {
  const full = { ...worker, expiresAt: Date.now() + CHECKLIST_WORKER_IDLE_MS };
  return { worker: full, token: encodeWorker(full, sign) };
}

export function workerFromPass(token: unknown): ChecklistWorker | null {
  return decodeWorker(token, sign, constantTimeEqual);
}

/** The employee must still be active; their current name is what gets recorded. */
export async function confirmWorker(worker: ChecklistWorker): Promise<ChecklistWorker> {
  const row = (await getSql()`SELECT name,pos_role FROM employees WHERE id=${worker.employeeId} AND business=${BUSINESS} AND active=TRUE LIMIT 1`)[0];
  if (!row) throw new Error("That employee is no longer active. Type your PIN again.");
  return { ...worker, name: String(row.name), role: row.pos_role === "manager" || row.pos_role === "owner" ? row.pos_role : "employee" };
}

const iso = (value: unknown) => toIsoTimestamp(value);
const date = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10));

function toCheck(row: Record<string, any>): HistoryCheck & { employeeId: string } {
  return {
    id: Number(row.id), businessDate: date(row.business_date), checklistId: String(row.checklist_id), itemId: String(row.item_id),
    itemLabel: String(row.item_label), employeeId: String(row.employee_id), employeeName: String(row.employee_name),
    checkedAt: toIsoTimestampOrEmpty(row.checked_at), bulk: Boolean(row.bulk),
    undoneAt: iso(row.undone_at), undoneByName: row.undone_by_name ? String(row.undone_by_name) : null, undoReason: row.undo_reason ? String(row.undo_reason) : null,
  };
}

export type SaladBatch = {
  id: number; businessDate: string; saladId: string; saladName: string; employeeId: string; employeeName: string; madeAt: string;
  batchSize: string; notes: string; voidedAt: string | null; voidedByName: string | null; voidReason: string | null;
};
function toBatch(row: Record<string, any>): SaladBatch {
  return {
    id: Number(row.id), businessDate: date(row.business_date), saladId: String(row.salad_id), saladName: String(row.salad_name),
    employeeId: String(row.employee_id), employeeName: String(row.employee_name), madeAt: toIsoTimestampOrEmpty(row.made_at),
    batchSize: String(row.batch_size || ""), notes: String(row.notes || ""),
    voidedAt: iso(row.voided_at), voidedByName: row.voided_by_name ? String(row.voided_by_name) : null, voidReason: row.void_reason ? String(row.void_reason) : null,
  };
}

/** Everything the in-store screen shows: today's lists with ticks, the salads, and the last few days of batches. */
export async function checklistScreen(now = new Date()) {
  const sql = getSql();
  const today = businessDateOf(now);
  const since = new Date(`${today}T12:00:00Z`);
  since.setUTCDate(since.getUTCDate() - 3);
  const [lists, items, checks, salads, batches] = await Promise.all([
    sql`SELECT id,name,position,opens_at_hour FROM store_checklists WHERE business=${BUSINESS} AND archived_at IS NULL ORDER BY position,created_at`,
    sql`SELECT item.id,item.checklist_id,item.label,item.position FROM store_checklist_items item JOIN store_checklists list ON list.id=item.checklist_id
        WHERE item.business=${BUSINESS} AND item.archived_at IS NULL AND list.archived_at IS NULL ORDER BY item.position,item.created_at`,
    sql`SELECT * FROM store_checklist_checks WHERE business=${BUSINESS} AND business_date=${today} AND undone_at IS NULL`,
    sql`SELECT id,name FROM deli_salads WHERE business=${BUSINESS} AND archived_at IS NULL ORDER BY position,created_at`,
    sql`SELECT * FROM deli_salad_batches WHERE business=${BUSINESS} AND business_date>=${since.toISOString().slice(0, 10)} AND voided_at IS NULL ORDER BY made_at DESC LIMIT 60`,
  ]);
  const ticks = new Map(checks.map((row) => [String(row.item_id), toCheck(row)]));
  return {
    businessDate: today,
    lists: lists.map((list) => ({
      id: String(list.id), name: String(list.name), opensAtHour: Number(list.opens_at_hour),
      items: items.filter((item) => String(item.checklist_id) === String(list.id)).map((item) => {
        const tick = ticks.get(String(item.id));
        return { id: String(item.id), label: String(item.label), check: tick ? { id: tick.id, employeeName: tick.employeeName, checkedAt: tick.checkedAt } : null };
      }),
    })),
    salads: salads.map((salad) => ({ id: String(salad.id), name: String(salad.name) })),
    batches: batches.map(toBatch),
  };
}

/** Ticks items for today as this worker. Items already ticked stay as they were (first tick wins). */
export async function checkItems(itemIds: string[], worker: ChecklistWorker, bulk = false) {
  const ids = [...new Set(itemIds.map(String))].slice(0, CHECKLIST_LIMITS.itemsPerList);
  if (!ids.length) throw new Error("Pick something to check off.");
  const today = businessDateOf(new Date());
  const rows = await getSql()`
    INSERT INTO store_checklist_checks(business,business_date,checklist_id,item_id,item_label,employee_id,employee_name,bulk)
    SELECT ${BUSINESS}::text,${today}::date,item.checklist_id,item.id,item.label,${worker.employeeId}::text,${worker.name}::text,${bulk}::boolean
    FROM store_checklist_items item WHERE item.id=ANY(${ids}::uuid[]) AND item.business=${BUSINESS} AND item.archived_at IS NULL
    ON CONFLICT (item_id,business_date) WHERE undone_at IS NULL DO NOTHING
    RETURNING id`;
  return { checked: rows.length };
}

/** Un-ticks today's tick on an item, keeping who un-ticked it and why. */
export async function uncheckItem(itemId: string, worker: ChecklistWorker, reason: unknown) {
  const why = cleanText(reason, CHECKLIST_LIMITS.reasonChars);
  if (!why) throw new Error("Say why it's being un-checked.");
  const rows = await getSql()`
    UPDATE store_checklist_checks SET undone_at=NOW(),undone_by_id=${worker.employeeId},undone_by_name=${worker.name},undo_reason=${why}
    WHERE business=${BUSINESS} AND item_id=${itemId}::uuid AND business_date=${businessDateOf(new Date())}::date AND undone_at IS NULL RETURNING id`;
  if (!rows.length) throw new Error("That item isn't checked off today.");
}

export async function logSaladBatch(saladId: string, worker: ChecklistWorker, input: { batchSize?: unknown; notes?: unknown } = {}) {
  const row = (await getSql()`
    INSERT INTO deli_salad_batches(business,business_date,salad_id,salad_name,employee_id,employee_name,batch_size,notes)
    SELECT ${BUSINESS}::text,${businessDateOf(new Date())}::date,salad.id,salad.name,${worker.employeeId}::text,${worker.name}::text,
      ${cleanText(input.batchSize, CHECKLIST_LIMITS.sizeChars)}::text,${cleanText(input.notes, CHECKLIST_LIMITS.noteChars)}::text
    FROM deli_salads salad WHERE salad.id=${saladId}::uuid AND salad.business=${BUSINESS} AND salad.archived_at IS NULL
    RETURNING *`)[0];
  if (!row) throw new Error("That salad isn't on the list any more.");
  return toBatch(row);
}

/** Size and notes can be added to a batch from the last few days. */
export async function updateSaladBatch(id: number, input: { batchSize?: unknown; notes?: unknown }) {
  const row = (await getSql()`
    UPDATE deli_salad_batches SET batch_size=${cleanText(input.batchSize, CHECKLIST_LIMITS.sizeChars)},notes=${cleanText(input.notes, CHECKLIST_LIMITS.noteChars)}
    WHERE id=${id} AND business=${BUSINESS} AND voided_at IS NULL AND made_at>NOW()-INTERVAL '3 days' RETURNING *`)[0];
  if (!row) throw new Error("That batch can't be changed any more.");
  return toBatch(row);
}

export async function voidSaladBatch(id: number, worker: ChecklistWorker, reason: unknown) {
  const why = cleanText(reason, CHECKLIST_LIMITS.reasonChars) || "Tapped by mistake";
  const rows = await getSql()`
    UPDATE deli_salad_batches SET voided_at=NOW(),voided_by_name=${worker.name},void_reason=${why}
    WHERE id=${id} AND business=${BUSINESS} AND voided_at IS NULL AND made_at>NOW()-INTERVAL '3 days' RETURNING id`;
  if (!rows.length) throw new Error("That batch can't be removed any more.");
}

// ---- Manager setup ----

export type SetupKind = "list" | "item" | "salad";

export async function checklistSetup() {
  const sql = getSql();
  const [lists, items, salads] = await Promise.all([
    sql`SELECT id,name,position,opens_at_hour,archived_at FROM store_checklists WHERE business=${BUSINESS} ORDER BY position,created_at`,
    sql`SELECT id,checklist_id,label,position,placeholder,archived_at FROM store_checklist_items WHERE business=${BUSINESS} ORDER BY position,created_at`,
    sql`SELECT id,name,position,placeholder,archived_at FROM deli_salads WHERE business=${BUSINESS} ORDER BY position,created_at`,
  ]);
  return {
    lists: lists.map((list) => ({
      id: String(list.id), name: String(list.name), opensAtHour: Number(list.opens_at_hour), active: !list.archived_at,
      items: items.filter((item) => String(item.checklist_id) === String(list.id)).map((item) => ({ id: String(item.id), label: String(item.label), placeholder: Boolean(item.placeholder), active: !item.archived_at })),
    })),
    salads: salads.map((salad) => ({ id: String(salad.id), name: String(salad.name), placeholder: Boolean(salad.placeholder), active: !salad.archived_at })),
    limits: CHECKLIST_LIMITS,
  };
}

/** Adds or changes a list, item or salad. Renaming clears the placeholder tag. */
export async function saveSetupEntry(input: { kind?: unknown; id?: unknown; name?: unknown; checklistId?: unknown; active?: unknown; opensAtHour?: unknown }, actor: string) {
  const kind = input.kind as SetupKind;
  if (!["list", "item", "salad"].includes(kind)) throw new Error("Unknown kind.");
  const name = cleanText(input.name, CHECKLIST_LIMITS.labelChars);
  if (!name) throw new Error(kind === "item" ? "Write what needs doing." : "Give it a name.");
  const id = input.id ? String(input.id) : "";
  const active = input.active === undefined ? true : Boolean(input.active);
  const sql = getSql();
  return withTransaction(async () => {
    if (kind === "list") {
      const hour = parseOpensAtHour(input.opensAtHour ?? 4);
      if (id) {
        const rows = await sql`UPDATE store_checklists SET name=${name},opens_at_hour=${hour},archived_at=CASE WHEN ${active}::boolean THEN NULL ELSE COALESCE(archived_at,NOW()) END,updated_by=${actor},updated_at=NOW() WHERE id=${id}::uuid AND business=${BUSINESS} RETURNING id`;
        if (!rows.length) throw new Error("That list no longer exists.");
        return;
      }
      const count = Number((await sql`SELECT COUNT(*)::int n FROM store_checklists WHERE business=${BUSINESS}`)[0].n);
      if (count >= CHECKLIST_LIMITS.lists) throw new Error(`At most ${CHECKLIST_LIMITS.lists} lists.`);
      await sql`INSERT INTO store_checklists(business,name,opens_at_hour,position,updated_by) SELECT ${BUSINESS}::text,${name}::text,${hour}::int,COALESCE(MAX(position),0)+10,${actor}::text FROM store_checklists WHERE business=${BUSINESS}`;
      return;
    }
    if (kind === "item") {
      if (id) {
        const rows = await sql`UPDATE store_checklist_items SET placeholder=placeholder AND label=${name},label=${name},archived_at=CASE WHEN ${active}::boolean THEN NULL ELSE COALESCE(archived_at,NOW()) END,updated_by=${actor},updated_at=NOW() WHERE id=${id}::uuid AND business=${BUSINESS} RETURNING id`;
        if (!rows.length) throw new Error("That item no longer exists.");
        return;
      }
      const listId = String(input.checklistId || "");
      const list = (await sql`SELECT id FROM store_checklists WHERE id=${listId}::uuid AND business=${BUSINESS}`)[0];
      if (!list) throw new Error("Pick a list.");
      const count = Number((await sql`SELECT COUNT(*)::int n FROM store_checklist_items WHERE checklist_id=${listId}::uuid AND archived_at IS NULL`)[0].n);
      if (count >= CHECKLIST_LIMITS.itemsPerList) throw new Error(`At most ${CHECKLIST_LIMITS.itemsPerList} items on a list.`);
      await sql`INSERT INTO store_checklist_items(checklist_id,business,label,position,updated_by) SELECT ${listId}::uuid,${BUSINESS}::text,${name}::text,COALESCE(MAX(position),0)+10,${actor}::text FROM store_checklist_items WHERE checklist_id=${listId}::uuid`;
      return;
    }
    if (id) {
      const rows = await sql`UPDATE deli_salads SET placeholder=placeholder AND name=${name},name=${name},archived_at=CASE WHEN ${active}::boolean THEN NULL ELSE COALESCE(archived_at,NOW()) END,updated_by=${actor},updated_at=NOW() WHERE id=${id}::uuid AND business=${BUSINESS} RETURNING id`;
      if (!rows.length) throw new Error("That salad no longer exists.");
      return;
    }
    const count = Number((await sql`SELECT COUNT(*)::int n FROM deli_salads WHERE business=${BUSINESS} AND archived_at IS NULL`)[0].n);
    if (count >= CHECKLIST_LIMITS.salads) throw new Error(`At most ${CHECKLIST_LIMITS.salads} salads.`);
    await sql`INSERT INTO deli_salads(business,name,position,updated_by) SELECT ${BUSINESS}::text,${name}::text,COALESCE(MAX(position),0)+10,${actor}::text FROM deli_salads WHERE business=${BUSINESS}`;
  });
}

/** Moves a list, item or salad one place up or down by swapping positions with its neighbour. */
export async function moveSetupEntry(kind: SetupKind, id: string, direction: "up" | "down", actor: string) {
  return withTransaction(async () => {
    const sql = getSql();
    const rows = kind === "list"
      ? await sql`SELECT id,position FROM store_checklists WHERE business=${BUSINESS} ORDER BY position,created_at FOR UPDATE`
      : kind === "salad"
        ? await sql`SELECT id,position FROM deli_salads WHERE business=${BUSINESS} ORDER BY position,created_at FOR UPDATE`
        : await sql`SELECT id,position FROM store_checklist_items WHERE checklist_id=(SELECT checklist_id FROM store_checklist_items WHERE id=${id}::uuid) ORDER BY position,created_at FOR UPDATE`;
    const order = rows.map((row) => String(row.id));
    const at = order.indexOf(id);
    const to = direction === "up" ? at - 1 : at + 1;
    if (at < 0) throw new Error("That entry no longer exists.");
    if (to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    // Renumber the whole run so equal or missing positions can't stick.
    for (const [index, rowId] of order.entries()) {
      const position = (index + 1) * 10;
      if (kind === "list") await sql`UPDATE store_checklists SET position=${position},updated_by=${actor},updated_at=NOW() WHERE id=${rowId}::uuid AND position<>${position}`;
      else if (kind === "salad") await sql`UPDATE deli_salads SET position=${position},updated_by=${actor},updated_at=NOW() WHERE id=${rowId}::uuid AND position<>${position}`;
      else await sql`UPDATE store_checklist_items SET position=${position},updated_by=${actor},updated_at=NOW() WHERE id=${rowId}::uuid AND position<>${position}`;
    }
  });
}

// ---- Manager history ----

/** Day-by-day checklists, salad batches and per-person tallies for start…end (business dates, inclusive). */
export async function checklistHistory(range: { start: string; end: string }) {
  const sql = getSql();
  const [lists, items, checks, batches] = await Promise.all([
    sql`SELECT id,name,position,created_at,archived_at FROM store_checklists WHERE business=${BUSINESS}`,
    sql`SELECT id,checklist_id,label,position,created_at,archived_at FROM store_checklist_items WHERE business=${BUSINESS}`,
    sql`SELECT * FROM store_checklist_checks WHERE business=${BUSINESS} AND business_date BETWEEN ${range.start}::date AND ${range.end}::date ORDER BY checked_at`,
    sql`SELECT * FROM deli_salad_batches WHERE business=${BUSINESS} AND business_date BETWEEN ${range.start}::date AND ${range.end}::date ORDER BY made_at DESC`,
  ]);
  const historyLists: HistoryList[] = lists.map((row) => ({ id: String(row.id), name: String(row.name), position: Number(row.position), createdAt: toIsoTimestampOrEmpty(row.created_at), archivedAt: iso(row.archived_at) }));
  const historyItems: HistoryItem[] = items.map((row) => ({ id: String(row.id), checklistId: String(row.checklist_id), label: String(row.label), position: Number(row.position), createdAt: toIsoTimestampOrEmpty(row.created_at), archivedAt: iso(row.archived_at) }));
  const allChecks = checks.map(toCheck);
  const allBatches = batches.map(toBatch);
  const today = businessDateOf(new Date());
  const days: Array<{ businessDate: string; finished: boolean; lists: ReturnType<typeof summarizeChecklistDay>; batches: SaladBatch[] }> = [];
  for (const cursor = new Date(`${range.end}T12:00:00Z`); cursor >= new Date(`${range.start}T12:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() - 1)) {
    const day = cursor.toISOString().slice(0, 10);
    if (day > today) continue;
    const window = { start: businessDayBoundary(day), end: businessDayBoundary(day, true) };
    days.push({
      businessDate: day, finished: day < today,
      lists: summarizeChecklistDay(historyLists, historyItems, allChecks.filter((check) => check.businessDate === day), window),
      batches: allBatches.filter((batch) => batch.businessDate === day),
    });
  }
  return { today, start: range.start, end: range.end, days, people: tallyByEmployee(allChecks, allBatches) };
}
