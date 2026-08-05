import { getSql } from "@/lib/db";
import { ensureThreeCxCdrSchema } from "@/lib/three-cx-cdr";

const TIME_ZONE = "America/New_York";

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

type LostCall = {
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

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
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

function dateBoundary(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Choose a valid date range.");
  const [year, month, day] = value.split("-").map(Number);
  return localPartsToUtc(year, month, day, 0, 0, 0);
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
  return value.split(/[^0-9]+/).filter(Boolean).some((token) => token === target);
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

function queueRecord(row: StoredCdr, queue: string): boolean {
  const values = [
    row.toNo,
    row.toDn,
    row.dialNo,
    row.finalNumber,
    row.finalDn,
    row.chain,
    row.toDisplayName,
    row.finalDisplayName,
  ].join(" ");
  return endpointMatches(values, queue);
}

function groupKey(row: StoredCdr): string {
  return row.historyId || row.callId || row.recordKey;
}

function entityLooksHuman(row: StoredCdr): boolean {
  return /extension|user|agent/.test(`${row.toType} ${row.finalType}`.toLowerCase());
}

function callerNumber(rows: StoredCdr[]): string {
  const ordered = [...rows].sort((left, right) => (left.startedAt?.getTime() || 0) - (right.startedAt?.getTime() || 0));
  for (const row of ordered) {
    for (const candidate of [row.fromNo, row.fromDn, row.fromDisplayName]) {
      const phone = normalizePhone(candidate);
      if (phone.length >= 7) return phone;
    }
  }
  return clean(ordered[0]?.fromNo || ordered[0]?.fromDisplayName, 100);
}

function involvesExtension(row: StoredCdr, extension: string): boolean {
  return endpointMatches([
    row.fromNo,
    row.toNo,
    row.dialNo,
    row.finalNumber,
    row.fromDn,
    row.toDn,
    row.finalDn,
    row.chain,
  ].join(" "), extension);
}

function externalPhones(row: StoredCdr): string[] {
  return [row.fromNo, row.toNo, row.dialNo, row.finalNumber]
    .map(normalizePhone)
    .filter((value) => value.length >= 7);
}

function elapsedSeconds(row: StoredCdr): number {
  if (row.durationSeconds > 0) return row.durationSeconds;
  if (row.startedAt && row.endedAt) return Math.max(0, (row.endedAt.getTime() - row.startedAt.getTime()) / 1000);
  return 0;
}

function chooseQueueLeg(rows: StoredCdr[]): StoredCdr {
  return [...rows].sort((left, right) => {
    const missedDifference = Number(Boolean(right.missedQueueCalls)) - Number(Boolean(left.missedQueueCalls));
    if (missedDifference) return missedDifference;
    const durationDifference = elapsedSeconds(right) - elapsedSeconds(left);
    if (durationDifference) return durationDifference;
    return (right.endedAt?.getTime() || 0) - (left.endedAt?.getTime() || 0);
  })[0];
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
  const grouped = new Map<string, StoredCdr[]>();
  for (const record of records) {
    const key = groupKey(record);
    const existing = grouped.get(key) || [];
    existing.push(record);
    grouped.set(key, existing);
  }

  const candidates: Array<{ group: StoredCdr[]; queueRows: StoredCdr[]; leg: StoredCdr; drop: Date; began: Date; waitSeconds: number }> = [];
  for (const group of grouped.values()) {
    const queueRows = group.filter((row) => queueRecord(row, config.queue));
    if (!queueRows.length) continue;

    const leg = chooseQueueLeg(queueRows);
    const began = queueRows
      .map((row) => row.startedAt)
      .filter((value): value is Date => Boolean(value))
      .sort((left, right) => left.getTime() - right.getTime())[0] || leg.startedAt;
    const drop = queueRows
      .map((row) => row.endedAt)
      .filter((value): value is Date => Boolean(value))
      .sort((left, right) => right.getTime() - left.getTime())[0] || leg.endedAt || leg.startedAt;
    if (!began || !drop || drop < start || drop >= end) continue;

    const polledWithoutAnswer = queueRows.some((row) => Boolean(row.missedQueueCalls.trim()));
    const queueAnswered = queueRows.some((row) => Boolean(row.answeredAt));
    const humanAnswered = group.some((row) => Boolean(row.answeredAt) && entityLooksHuman(row));
    if (!polledWithoutAnswer && (queueAnswered || humanAnswered)) continue;

    const waitSeconds = Math.max(
      0,
      ...queueRows.map(elapsedSeconds),
      (drop.getTime() - began.getTime()) / 1000,
    );
    candidates.push({ group, queueRows, leg, drop, began, waitSeconds });
  }

  let ignored = 0;
  const calls: LostCall[] = [];
  for (const candidate of candidates) {
    if (candidate.waitSeconds <= config.ignoreSeconds) {
      ignored += 1;
      continue;
    }

    const caller = callerNumber(candidate.group);
    const callback = caller ? records.find((row) => {
      if (!row.answeredAt || !row.startedAt || row.startedAt <= candidate.drop || groupKey(row) === groupKey(candidate.leg)) return false;
      return externalPhones(row).some((phone) => phoneMatches(phone, caller));
    }) : undefined;

    const active = config.extensions.length ? records.filter((row) => {
      if (!row.answeredAt || !row.endedAt || groupKey(row) === groupKey(candidate.leg)) return false;
      if (row.answeredAt > candidate.drop || row.endedAt < candidate.drop) return false;
      return config.extensions.some((extension) => involvesExtension(row, extension));
    }) : [];
    const activeByHistory = new Map<string, StoredCdr>();
    for (const row of active) activeByHistory.set(groupKey(row), row);
    const activeExtensions = config.extensions.filter((extension) => Array.from(activeByHistory.values()).some((row) => involvesExtension(row, extension)));
    const activeCallCount = config.extensions.length ? activeByHistory.size : null;

    let assessment: LostCall["assessment"];
    if (candidate.waitSeconds >= config.issueSeconds && activeCallCount === 0) assessment = "Issue";
    else if (candidate.waitSeconds >= config.issueSeconds && Number(activeCallCount) > 0) assessment = "Busy";
    else if (activeCallCount === 0) assessment = "Review";
    else assessment = "Other lines active";

    const callbackAt = callback?.answeredAt || callback?.startedAt || null;
    const callbackDirection = callback
      ? (phoneMatches(callback.fromNo, caller) ? "Inbound" : "Outbound")
      : null;
    const reasonParts = [candidate.leg.terminationReason, candidate.leg.reasonChanged]
      .map((value) => value.trim())
      .filter(Boolean);

    calls.push({
      historyId: groupKey(candidate.leg),
      droppedAt: candidate.drop.toISOString(),
      caller,
      waitSeconds: Math.round(candidate.waitSeconds),
      activeCallCount,
      activeExtensions,
      callbackAt: callbackAt?.toISOString() || null,
      callbackDirection,
      callbackDelaySeconds: callbackAt ? Math.max(0, Math.round((callbackAt.getTime() - candidate.drop.getTime()) / 1000)) : null,
      resolved: Boolean(callbackAt),
      assessment,
      reason: reasonParts.join(" / ") || "Unanswered queue call",
      chain: candidate.queueRows.map((row) => row.chain).filter(Boolean).join(" | "),
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
    summary: {
      totalAbandoned: candidates.length,
      ignored,
      meaningful,
      unresolved,
      issues,
      busy,
      resolved: meaningful - unresolved,
    },
    coverage: {
      records: records.length,
      latestReceivedAt: latestReceived?.toISOString() || null,
    },
    calls,
  };
}
