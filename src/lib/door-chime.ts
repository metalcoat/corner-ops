import { getSql } from "@/lib/db";
import { toIsoTimestamp } from "@/lib/timestamp-values";
import {
  DOOR_CHIME_COOLDOWN_SECONDS,
  matchWalkInsToOrders,
  summarizeWalkIns,
  type DoorChimeEventInput,
} from "@/lib/door-chime-policy";

let schemaPromise: Promise<void> | null = null;

/** Mirrors db/migrations/0013_door_chime_events.sql for databases that haven't run it (dev). */
export function ensureDoorChimeSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

/**
 * Records a walk-in unless the same camera already reported one within the cooldown,
 * so a detector that reports one person (or a group) several times counts once.
 * Test events skip the cooldown and are left out of the dashboard.
 */
export async function recordDoorChimeEvent(event: DoorChimeEventInput): Promise<{ recorded: boolean; id: number | null }> {
  await ensureDoorChimeSchema();
  const cooldown = event.kind === "test" ? 0 : DOOR_CHIME_COOLDOWN_SECONDS;
  const rows = await getSql()`
    INSERT INTO door_chime_events (business, camera, kind)
    SELECT ${event.business}, ${event.camera}, ${event.kind}
    WHERE NOT EXISTS (
      SELECT 1 FROM door_chime_events
      WHERE business = ${event.business} AND camera = ${event.camera}
        AND kind <> 'test'
        AND detected_at > NOW() - make_interval(secs => ${cooldown})
    )
    RETURNING id
  `;
  return rows[0] ? { recorded: true, id: Number(rows[0].id) } : { recorded: false, id: null };
}

/** POS orders count as the first interaction; online, kiosk and AI-phone orders don't involve a walk-in. */
const COUNTER_ORDER_SOURCES = ["pos"];

const storeHour = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" });

/** Today's walk-ins (store time), each matched to the first POS order started after it, for the store dashboard. */
export async function doorWalkInDashboard(business: DoorChimeEventInput["business"]) {
  await ensureDoorChimeSchema();
  const sql = getSql();
  const [walkInRows, orderRows, nowRows] = await Promise.all([
    sql`
      SELECT id, detected_at FROM door_chime_events
      WHERE business = ${business} AND kind <> 'test'
        AND detected_at >= ((NOW() AT TIME ZONE 'America/New_York')::date AT TIME ZONE 'America/New_York')
      ORDER BY detected_at
      LIMIT 1000
    `,
    sql`
      SELECT id, display_number, created_at FROM ordering_orders
      WHERE business = ${business} AND source = ANY(${COUNTER_ORDER_SOURCES})
        AND created_at >= ((NOW() AT TIME ZONE 'America/New_York')::date AT TIME ZONE 'America/New_York')
      ORDER BY created_at
      LIMIT 2000
    `,
    sql`SELECT NOW() AS now`,
  ]);
  const matched = matchWalkInsToOrders(
    walkInRows.map((row) => ({ id: Number(row.id), detectedAt: toIsoTimestamp(row.detected_at) || "" })),
    orderRows.map((row) => ({ id: String(row.id), displayNumber: String(row.display_number || ""), createdAt: toIsoTimestamp(row.created_at) || "" })),
    toIsoTimestamp(nowRows[0].now) || new Date().toISOString(),
  );
  return {
    summary: summarizeWalkIns(matched, (iso) => Number(storeHour.format(new Date(iso))) % 24),
    walkIns: matched.reverse().slice(0, 60),
  };
}

/** The newest walk-in (tests included) for the TV greeter, or null when there's none in the last minute. */
export async function latestDoorWalkIn(business: DoorChimeEventInput["business"]) {
  await ensureDoorChimeSchema();
  const row = (await getSql()`
    SELECT id, kind, EXTRACT(EPOCH FROM NOW() - detected_at)::float AS age_seconds
    FROM door_chime_events
    WHERE business = ${business} AND detected_at > NOW() - INTERVAL '60 seconds'
    ORDER BY id DESC
    LIMIT 1
  `)[0];
  return row ? { id: Number(row.id), kind: String(row.kind), ageSeconds: Math.round(Number(row.age_seconds)) } : null;
}

/** Old rows are only history; keep 90 days for comparing walk-ins week to week. */
export async function pruneDoorChimeEvents() {
  await ensureDoorChimeSchema();
  await getSql()`DELETE FROM door_chime_events WHERE detected_at < NOW() - INTERVAL '90 days'`;
}
