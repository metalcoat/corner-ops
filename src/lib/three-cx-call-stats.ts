// Today's deli phone numbers for the staff status monitor: calls into the deli
// queue, how long they rang, which were missed and whether we called back, and
// for every long ring or missed call, who was on the clock at that moment.
import { getSql } from "@/lib/db";
import { ensureThreeCxCdrSchema } from "@/lib/three-cx-cdr";
import {
  callerNumber,
  callReportSettings,
  elapsedSeconds,
  entityLooksHuman,
  externalPhones,
  groupKey,
  involvesExtension,
  localPartsToUtc,
  mapStored,
  phoneMatches,
  queueRecord,
  type StoredCdr,
} from "@/lib/three-cx-calls-report";

export type OnClock = { name: string; position: string };
export type CallEvent = {
  id: string;
  at: string;
  /** Last four digits only: the board is on a monitor customers can see. */
  callerLast4: string;
  ringSeconds: number;
  outcome: "answered" | "missed";
  answeredBy: string;
  calledBackAt: string | null;
  otherCallsActive: number | null;
  onClock: OnClock[];
};
export type CallStats = {
  since: string;
  total: number;
  answered: number;
  missed: number;
  missedNotCalledBack: number;
  quickHangups: number;
  answerRate: number | null;
  avgRingSeconds: number | null;
  longestRingSeconds: number | null;
  longRingSeconds: number;
  longRings: number;
  aiPhoneOrders: number;
  byHour: Array<{ hour: number; calls: number; missed: number }>;
  ringingNow: Array<{ since: string; callerLast4: string }>;
  /** Missed calls and long rings, newest first. */
  attention: CallEvent[];
  dataAsOf: string | null;
};

const TZ = "America/New_York";
function localParts(date: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) };
}
/** Business day starts at 4am Eastern, like the sales reports. */
export function businessDayStart(now: Date) {
  const p = localParts(now);
  const start = localPartsToUtc(p.year, p.month, p.day, 4, 0, 0);
  return start > now ? new Date(start.getTime() - 86_400_000) : start;
}

let cache: { at: number; value: CallStats } | null = null;

/** Cached for 30 seconds: the board polls every 10 and the CDR feed is not faster than that. */
export async function deliCallStats(now = new Date()): Promise<CallStats> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const value = await computeCallStats(now);
  cache = { at: Date.now(), value };
  return value;
}

export async function computeCallStats(now = new Date()): Promise<CallStats> {
  await ensureThreeCxCdrSchema();
  const sql = getSql();
  const start = businessDayStart(now);
  const config = callReportSettings();
  const longRing = config.issueSeconds;
  const rows = (await sql`SELECT id, record_key, history_id, call_id, duration_seconds, started_at, answered_at, ended_at,
      termination_reason, from_no, to_no, from_dn, to_dn, dial_no, reason_changed, final_number, final_dn, chain, from_type, to_type, final_type,
      from_display_name, to_display_name, final_display_name, missed_queue_calls, received_at
    FROM three_cx_cdr_records WHERE event_at >= ${new Date(start.getTime() - 3_600_000).toISOString()} AND event_at < ${new Date(now.getTime() + 600_000).toISOString()}
    ORDER BY event_at`) as unknown as Array<Record<string, unknown>>;
  const records = rows.map(mapStored);
  const groups = new Map<string, StoredCdr[]>();
  for (const record of records) groups.set(groupKey(record), [...(groups.get(groupKey(record)) ?? []), record]);

  const shifts = (await sql`SELECT employee_name,COALESCE(NULLIF(position,''),role_group) position,clock_in,clock_out FROM time_entries
    WHERE business='Corner Deli' AND clock_in < ${now.toISOString()} AND (clock_out IS NULL OR clock_out > ${start.toISOString()})`) as unknown as Array<{ employee_name: string; position: string; clock_in: Date; clock_out: Date | null }>;
  const onClockAt = (at: Date): OnClock[] =>
    shifts
      .filter((s) => new Date(s.clock_in) <= at && (!s.clock_out || new Date(s.clock_out) >= at))
      .map((s) => ({ name: String(s.employee_name), position: String(s.position || "") }))
      .filter((s, i, all) => all.findIndex((o) => o.name === s.name) === i)
      .sort((a, b) => a.name.localeCompare(b.name));

  type Call = { id: string; began: Date; end: Date; ring: number; answered: boolean; answeredBy: string; caller: string; group: StoredCdr[] };
  const calls: Call[] = [];
  let quickHangups = 0;
  for (const [id, group] of groups) {
    const queueRows = group.filter((row) => queueRecord(row, config.queue));
    if (!queueRows.length) continue;
    const began = queueRows.map((r) => r.startedAt).filter((d): d is Date => Boolean(d)).sort((a, b) => a.getTime() - b.getTime())[0];
    if (!began || began < start || began > now) continue;
    const answeredLeg = group
      .filter((row) => row.answeredAt && entityLooksHuman(row))
      .sort((a, b) => a.answeredAt!.getTime() - b.answeredAt!.getTime())[0];
    const end = queueRows.map((r) => r.endedAt).filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? began;
    if (answeredLeg?.answeredAt) {
      calls.push({ id, began, end, ring: Math.max(0, (answeredLeg.answeredAt.getTime() - began.getTime()) / 1000), answered: true, answeredBy: answeredLeg.finalDisplayName || answeredLeg.toDisplayName || answeredLeg.finalDn || answeredLeg.toDn, caller: callerNumber(group), group });
      continue;
    }
    const wait = Math.max(0, ...queueRows.map(elapsedSeconds), (end.getTime() - began.getTime()) / 1000);
    if (wait <= config.ignoreSeconds) {
      quickHangups++;
      continue;
    }
    calls.push({ id, began, end, ring: wait, answered: false, answeredBy: "", caller: callerNumber(group), group });
  }

  const event = (call: Call): CallEvent => {
    const callback = !call.answered && call.caller
      ? records.find((row) => row.answeredAt && row.startedAt && row.startedAt > call.end && groupKey(row) !== call.id && externalPhones(row).some((p) => phoneMatches(p, call.caller)))
      : undefined;
    const busy = config.extensions.length
      ? new Set(records.filter((row) => row.answeredAt && row.endedAt && groupKey(row) !== call.id && row.answeredAt <= call.end && row.endedAt >= call.began && config.extensions.some((ext) => involvesExtension(row, ext))).map(groupKey)).size
      : null;
    return {
      id: call.id,
      at: call.began.toISOString(),
      callerLast4: call.caller.replace(/\D/g, "").slice(-4),
      ringSeconds: Math.round(call.ring),
      outcome: call.answered ? "answered" : "missed",
      answeredBy: call.answeredBy,
      calledBackAt: callback ? (callback.answeredAt ?? callback.startedAt)!.toISOString() : null,
      otherCallsActive: busy,
      onClock: onClockAt(call.began),
    };
  };

  const answered = calls.filter((c) => c.answered), missed = calls.filter((c) => !c.answered);
  const attention = calls
    .filter((c) => !c.answered || c.ring >= longRing)
    .sort((a, b) => b.began.getTime() - a.began.getTime())
    .slice(0, 12)
    .map(event);
  const missedEvents = missed.map(event);
  const byHour = new Map<number, { hour: number; calls: number; missed: number }>();
  for (const call of calls) {
    const hour = localParts(call.began).hour;
    const slot = byHour.get(hour) ?? { hour, calls: 0, missed: 0 };
    slot.calls++;
    if (!call.answered) slot.missed++;
    byHour.set(hour, slot);
  }

  let ringingNow: CallStats["ringingNow"] = [];
  try {
    ringingNow = ((await sql`SELECT DISTINCT ON (call_id) call_id,caller_phone,started_at,status FROM three_cx_live_calls WHERE updated_at > NOW() - INTERVAL '3 minutes' ORDER BY call_id,updated_at DESC`) as unknown as Array<{ caller_phone: string; started_at: Date; status: string }>)
      .filter((row) => row.status === "ringing")
      .map((row) => ({ since: new Date(row.started_at).toISOString(), callerLast4: String(row.caller_phone).slice(-4) }));
  } catch {
    // Live call table not created yet (no 3CX webhook so far).
  }
  const aiPhoneOrders = Number((await sql`SELECT COUNT(*) n FROM ordering_orders WHERE business='Corner Deli' AND source='ai_phone' AND created_at >= ${start.toISOString()} AND status NOT IN ('draft','cancelled')`)[0]?.n ?? 0);
  const latest = records.reduce<Date | null>((max, row) => (!max || row.receivedAt > max ? row.receivedAt : max), null);

  return {
    since: start.toISOString(),
    total: calls.length,
    answered: answered.length,
    missed: missed.length,
    missedNotCalledBack: missedEvents.filter((e) => !e.calledBackAt).length,
    quickHangups,
    answerRate: calls.length ? Math.round((answered.length / calls.length) * 100) : null,
    avgRingSeconds: answered.length ? Math.round(answered.reduce((sum, c) => sum + c.ring, 0) / answered.length) : null,
    longestRingSeconds: calls.length ? Math.round(Math.max(...calls.map((c) => c.ring))) : null,
    longRingSeconds: longRing,
    longRings: answered.filter((c) => c.ring >= longRing).length,
    aiPhoneOrders,
    byHour: [...byHour.values()].sort((a, b) => a.hour - b.hour),
    ringingNow,
    attention,
    dataAsOf: latest?.toISOString() ?? null,
  };
}
