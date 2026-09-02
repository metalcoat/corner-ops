import { createHash } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import { parseThreeCxTimestamp } from "@/lib/three-cx-time";

const TIME_ZONE = "America/New_York";

export type ThreeCxCdrInput = Record<string, unknown>;

type StoredCdr = {
  id: string;
  recordKey: string;
  historyId: string;
  callId: string;
  durationSeconds: number;
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  terminationReason: string;
  fromNo: string;
  toNo: string;
  fromDn: string;
  toDn: string;
  dialNo: string;
  reasonChanged: string;
  finalNumber: string;
  finalDn: string;
  chain: string;
  fromType: string;
  toType: string;
  finalType: string;
  fromDisplayName: string;
  toDisplayName: string;
  finalDisplayName: string;
  missedQueueCalls: string;
  receivedAt: Date;
};

export type ThreeCxLostCall = {
  historyId: string;
  droppedAt: string;
  caller: string;
  waitSeconds: number;
  activeCallCount: number | null;
  activeExtensions: string[];
  callbackAt: string | null;
  callbackDirection: "Inbound" | "Outbound" | null;
  callbackDelaySeconds: number | null;
  resolved: boolean;
  assessment: "Issue" | "Busy" | "Review" | "Other lines active";
  reason: string;
  chain: string;
};

let schemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationSeconds(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return 0;
    return value > 0 && value < 1 ? value * 86_400 : value;
  }
  const text = clean(value, 100).toLowerCase();
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) return numberValue(text);
  const colon = text.match(/^(\d+):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?$/);
  if (colon) {
    if (colon[3] !== undefined) return Number(colon[1]) * 3600 + Number(colon[2]) * 60 + Number(colon[3]);
    return Number(colon[1]) * 60 + Number(colon[2]);
  }
  let seconds = 0;
  const hours = text.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)/);
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)/);
  const secs = text.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)/);
  if (hours) seconds += Number(hours[1]) * 3600;
  if (minutes) seconds += Number(minutes[1]) * 60;
  if (secs) seconds += Number(secs[1]);
  return seconds;
}

function getOffsetMilliseconds(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  ) - date.getTime();
}

function localPartsToUtc(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  let timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let index = 0; index < 2; index += 1) {
    timestamp = Date.UTC(year, month - 1, day, hour, minute, second) - getOffsetMilliseconds(new Date(timestamp), TIME_ZONE);
  }
  return new Date(timestamp);
}

function parseDate(value: unknown): Date | null {
  return parseThreeCxTimestamp(value);
}

function dateBoundary(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid date range.");
  const [year, month, day] = value.split("-").map(Number);
  return localPartsToUtc(year, month, day, 0, 0, 0);
}

function field(record: ThreeCxCdrInput, ...names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null && String(record[name]).trim() !== "") return record[name];
    const normalized = name.replace(/[-_\s]/g, "").toLowerCase();
    const key = Object.keys(record).find((candidate) => candidate.replace(/[-_\s]/g, "").toLowerCase() === normalized);
    if (key && record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== "") return record[key];
  }
  return "";
}

function normalizePhone(value: unknown): string {
  let digits = clean(value, 100).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length > 10) digits = digits.slice(-10);
  return digits;
}

function phoneMatches(left: string, right: string): boolean {
  const a = normalizePhone(left);
  const b = normalizePhone(right);
  if (!a || !b) return false;
  return a === b || (a.length >= 7 && b.length >= 7 && a.slice(-7) === b.slice(-7));
}

function endpointMatches(value: string, endpoint: string): boolean {
  const target = endpoint.replace(/\D/g, "");
  if (!target) return false;
  const tokens = value.split(/[^0-9]+/).filter(Boolean);
  return tokens.some((token) => token === target);
}

function settings() {
  const queue = clean(process.env.THREE_CX_DELI_QUEUE || "90", 30);
  const extensions = clean(process.env.THREE_CX_DELI_EXTENSIONS || "", 2000)
    .split(/[\s,;|]+/)
    .map((value) => value.replace(/\D/g, ""))
    .filter(Boolean);
  return {
    queue,
    extensions: Array.from(new Set(extensions)),
    ignoreSeconds: Math.max(0, numberValue(process.env.THREE_CX_IGNORE_SECONDS || 4)),
    issueSeconds: Math.max(1, numberValue(process.env.THREE_CX_ISSUE_SECONDS || 30)),
  };
}

async function createSchema(): Promise<void> {
  await ensureSchema();
  const sql = getSql();
}

export async function ensureThreeCxCdrSchema(): Promise<void> {
  if (!schemaPromise) schemaPromise = createSchema().catch((error) => { schemaPromise = null; throw error; });
  return schemaPromise;
}

function normalizedInput(record: ThreeCxCdrInput) {
  const historyId = clean(field(record, "historyid", "history-id", "history_id"), 160);
  const callId = clean(field(record, "callid", "call-id", "call_id"), 160);
  const startedAt = parseDate(field(record, "time-start", "time_start", "startedAt"));
  const answeredAt = parseDate(field(record, "time-answered", "time_answered", "answeredAt"));
  const endedAt = parseDate(field(record, "time-end", "time_end", "endedAt"));
  const fromNo = clean(field(record, "from-no", "from_no", "fromNo"), 160);
  const toNo = clean(field(record, "to-no", "to_no", "toNo"), 160);
  const dialNo = clean(field(record, "dial-no", "dial_no", "dialNo"), 160);
  const finalNumber = clean(field(record, "final-number", "final_number", "finalNumber"), 160);
  const keySource = [
    historyId, callId, startedAt?.toISOString() || "", endedAt?.toISOString() || "", fromNo, toNo, dialNo, finalNumber,
  ].join("|");
  return {
    recordKey: createHash("sha256").update(keySource || JSON.stringify(record)).digest("hex"),
    historyId,
    callId,
    durationSeconds: durationSeconds(field(record, "duration", "durationSeconds")),
    startedAt,
    answeredAt,
    endedAt,
    terminationReason: clean(field(record, "reason-terminated", "reason_terminated", "terminationReason"), 400),
    fromNo,
    toNo,
    fromDn: clean(field(record, "from-dn", "from_dn", "fromDn"), 300),
    toDn: clean(field(record, "to-dn", "to_dn", "toDn"), 300),
    dialNo,
    reasonChanged: clean(field(record, "reason-changed", "reason_changed", "reasonChanged"), 400),
    finalNumber,
    finalDn: clean(field(record, "final-dn", "final_dn", "finalDn"), 300),
    chain: clean(field(record, "chain"), 4000),
    fromType: clean(field(record, "from-type", "from_type", "fromType"), 100),
    toType: clean(field(record, "to-type", "to_type", "toType"), 100),
    finalType: clean(field(record, "final-type", "final_type", "finalType"), 100),
    fromDisplayName: clean(field(record, "from-dispname", "from_display_name", "fromDisplayName"), 300),
    toDisplayName: clean(field(record, "to-dispname", "to_display_name", "toDisplayName"), 300),
    finalDisplayName: clean(field(record, "final-dispname", "final_display_name", "finalDisplayName"), 300),
    missedQueueCalls: clean(field(record, "missed-queue-calls", "missed_queue_calls", "missedQueueCalls"), 4000),
    raw: record,
  };
}

export async function ingestThreeCxCdr(records: ThreeCxCdrInput[]) {
  await ensureThreeCxCdrSchema();
  if (!records.length) throw new Error("No 3CX CDR records were supplied.");
  if (records.length > 500) throw new Error("A maximum of 500 CDR records may be submitted at once.");
  let accepted = 0;
  for (const record of records) {
    const row = normalizedInput(record);
    if (!row.startedAt && !row.endedAt && !row.historyId && !row.callId) continue;
    await getSql()`
      INSERT INTO three_cx_cdr_records (
        id, record_key, history_id, call_id, duration_seconds, started_at, answered_at, ended_at,
        termination_reason, from_no, to_no, from_dn, to_dn, dial_no, reason_changed,
        final_number, final_dn, chain, from_type, to_type, final_type,
        from_display_name, to_display_name, final_display_name, missed_queue_calls, raw
      ) VALUES (
        ${crypto.randomUUID()}, ${row.recordKey}, ${row.historyId}, ${row.callId}, ${row.durationSeconds},
        ${row.startedAt?.toISOString() || null}, ${row.answeredAt?.toISOString() || null}, ${row.endedAt?.toISOString() || null},
        ${row.terminationReason}, ${row.fromNo}, ${row.toNo}, ${row.fromDn}, ${row.toDn}, ${row.dialNo}, ${row.reasonChanged},
        ${row.finalNumber}, ${row.finalDn}, ${row.chain}, ${row.fromType}, ${row.toType}, ${row.finalType},
        ${row.fromDisplayName}, ${row.toDisplayName}, ${row.finalDisplayName}, ${row.missedQueueCalls}, ${JSON.stringify(row.raw)}::jsonb
      )
      ON CONFLICT (record_key) DO UPDATE SET
        duration_seconds = EXCLUDED.duration_seconds,
        answered_at = COALESCE(EXCLUDED.answered_at, three_cx_cdr_records.answered_at),
        ended_at = COALESCE(EXCLUDED.ended_at, three_cx_cdr_records.ended_at),
        termination_reason = EXCLUDED.termination_reason,
        final_number = EXCLUDED.final_number,
        final_dn = EXCLUDED.final_dn,
        chain = EXCLUDED.chain,
        missed_queue_calls = EXCLUDED.missed_queue_calls,
        raw = EXCLUDED.raw,
        received_at = NOW()
    `;
    accepted += 1;
  }
  return { accepted };
}

function mapStored(row: Record<string, unknown>): StoredCdr {
  const date = (value: unknown) => value ? new Date(String(value)) : null;
  return {
    id: String(row.id),
    recordKey: String(row.record_key),
    historyId: String(row.history_id || ""),
    callId: String(row.call_id || ""),
    durationSeconds: numberValue(row.duration_seconds),
    startedAt: date(row.started_at),
    answeredAt: date(row.answered_at),
    endedAt: date(row.ended_at),
    terminationReason: String(row.termination_reason || ""),
    fromNo: String(row.from_no || ""),
    toNo: String(row.to_no || ""),
    fromDn: String(row.from_dn || ""),
    toDn: String(row.to_dn || ""),
    dialNo: String(row.dial_no || ""),
    reasonChanged: String(row.reason_changed || ""),
    finalNumber: String(row.final_number || ""),
    finalDn: String(row.final_dn || ""),
    chain: String(row.chain || ""),
    fromType: String(row.from_type || ""),
    toType: String(row.to_type || ""),
    finalType: String(row.final_type || ""),
    fromDisplayName: String(row.from_display_name || ""),
    toDisplayName: String(row.to_display_name || ""),
    finalDisplayName: String(row.final_display_name || ""),
    missedQueueCalls: String(row.missed_queue_calls || ""),
    receivedAt: new Date(String(row.received_at)),
  };
}

function isDeliQueueRecord(row: StoredCdr, queue: string): boolean {
  const entityType = `${row.toType} ${row.finalType}`.toLowerCase();
  const values = [row.toNo, row.toDn, row.dialNo, row.finalNumber, row.finalDn, row.chain].join(" ");
  return endpointMatches(values, queue) && (entityType.includes("queue") || endpointMatches(`${row.toNo} ${row.dialNo} ${row.finalNumber}`, queue));
}

function isAbandoned(row: StoredCdr): boolean {
  if (row.answeredAt) return false;
  const reason = `${row.terminationReason} ${row.reasonChanged}`.toLowerCase();
  if (/continued|replaced|transfer|redirect/.test(reason)) return false;
  return /src|source|abandon|cancel|no.?answer|timeout|terminated|failed|lost/.test(reason) || Boolean(row.endedAt);
}

function callerNumber(row: StoredCdr): string {
  const candidates = [row.fromNo, row.fromDn, row.fromDisplayName];
  for (const candidate of candidates) {
    const phone = normalizePhone(candidate);
    if (phone.length >= 7) return phone;
  }
  return clean(row.fromNo || row.fromDisplayName, 100);
}

function involvesExtension(row: StoredCdr, extension: string): boolean {
  return endpointMatches([row.fromNo, row.toNo, row.dialNo, row.finalNumber, row.fromDn, row.toDn, row.finalDn, row.chain].join(" "), extension);
}

function externalPhones(row: StoredCdr): string[] {
  return [row.fromNo, row.toNo, row.dialNo, row.finalNumber]
    .map(normalizePhone)
    .filter((value) => value.length >= 7);
}

export async function threeCxDeliCallReport(startText: string, endText: string) {
  await ensureThreeCxCdrSchema();
  const start = dateBoundary(startText);
  const end = dateBoundary(endText);
  if (end <= start) throw new Error("End date must be after start date.");
  const queryStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const queryEnd = new Date(end.getTime() + 7 * 24 * 60 * 60 * 1000);
  const rows = await getSql()`
    SELECT id, record_key, history_id, call_id, duration_seconds, started_at, answered_at, ended_at,
      termination_reason, from_no, to_no, from_dn, to_dn, dial_no, reason_changed,
      final_number, final_dn, chain, from_type, to_type, final_type,
      from_display_name, to_display_name, final_display_name, missed_queue_calls, received_at
    FROM three_cx_cdr_records
    WHERE COALESCE(ended_at, started_at, received_at) >= ${queryStart.toISOString()}
      AND COALESCE(started_at, ended_at, received_at) < ${queryEnd.toISOString()}
    ORDER BY COALESCE(ended_at, started_at, received_at)
  ` as unknown as Array<Record<string, unknown>>;
  const records = rows.map(mapStored);
  const config = settings();
  const candidates = records.filter((row) => {
    const drop = row.endedAt || row.startedAt;
    return drop && drop >= start && drop < end && isDeliQueueRecord(row, config.queue) && isAbandoned(row);
  });

  let ignored = 0;
  const calls: ThreeCxLostCall[] = [];
  for (const abandoned of candidates) {
    const drop = abandoned.endedAt || abandoned.startedAt;
    const began = abandoned.startedAt;
    if (!drop || !began) continue;
    const waitSeconds = Math.max(0, abandoned.durationSeconds || (drop.getTime() - began.getTime()) / 1000);
    if (waitSeconds <= config.ignoreSeconds) {
      ignored += 1;
      continue;
    }
    const caller = callerNumber(abandoned);
    const callback = records.find((row) => {
      if (!row.answeredAt || !row.startedAt || row.startedAt <= drop || row.historyId === abandoned.historyId) return false;
      return externalPhones(row).some((phone) => phoneMatches(phone, caller));
    });
    const active = config.extensions.length ? records.filter((row) => {
      if (!row.answeredAt || !row.endedAt || row.historyId === abandoned.historyId) return false;
      if (row.answeredAt > drop || row.endedAt < drop) return false;
      return config.extensions.some((extension) => involvesExtension(row, extension));
    }) : [];
    const activeByHistory = new Map<string, StoredCdr>();
    for (const row of active) activeByHistory.set(row.historyId || row.recordKey, row);
    const activeExtensions = config.extensions.filter((extension) => Array.from(activeByHistory.values()).some((row) => involvesExtension(row, extension)));
    const activeCallCount = config.extensions.length ? activeByHistory.size : null;
    let assessment: ThreeCxLostCall["assessment"];
    if (waitSeconds >= config.issueSeconds && activeCallCount === 0) assessment = "Issue";
    else if (waitSeconds >= config.issueSeconds && Number(activeCallCount) > 0) assessment = "Busy";
    else if (activeCallCount === 0) assessment = "Review";
    else assessment = "Other lines active";
    const callbackAt = callback?.answeredAt || callback?.startedAt || null;
    const callbackDirection = callback
      ? (phoneMatches(callback.fromNo, caller) ? "Inbound" : "Outbound")
      : null;
    calls.push({
      historyId: abandoned.historyId || abandoned.recordKey,
      droppedAt: drop.toISOString(),
      caller,
      waitSeconds: Math.round(waitSeconds),
      activeCallCount,
      activeExtensions,
      callbackAt: callbackAt?.toISOString() || null,
      callbackDirection,
      callbackDelaySeconds: callbackAt ? Math.max(0, Math.round((callbackAt.getTime() - drop.getTime()) / 1000)) : null,
      resolved: Boolean(callbackAt),
      assessment,
      reason: abandoned.terminationReason || abandoned.reasonChanged || "Unanswered queue call",
      chain: abandoned.chain,
    });
  }
  calls.sort((left, right) => right.droppedAt.localeCompare(left.droppedAt));
  const meaningful = calls.length;
  const unresolved = calls.filter((call) => !call.resolved).length;
  const issues = calls.filter((call) => !call.resolved && call.assessment === "Issue").length;
  const busy = calls.filter((call) => !call.resolved && call.assessment === "Busy").length;
  const latestReceived = records.reduce<Date | null>((latest, row) => !latest || row.receivedAt > latest ? row.receivedAt : latest, null);
  return {
    range: { start: startText, end: endText },
    settings: {
      queue: config.queue,
      extensions: config.extensions,
      ignoreSeconds: config.ignoreSeconds,
      issueSeconds: config.issueSeconds,
      concurrencyConfigured: config.extensions.length > 0,
    },
    summary: { totalAbandoned: candidates.length, ignored, meaningful, unresolved, issues, busy, resolved: meaningful - unresolved },
    coverage: { records: records.length, latestReceivedAt: latestReceived?.toISOString() || null },
    calls,
  };
}
