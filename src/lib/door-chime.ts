import { getSql } from "@/lib/db";
import { toIsoTimestamp } from "@/lib/timestamp-values";
import {
  DOOR_CHIME_COOLDOWN_SECONDS,
  DOOR_CHIME_RECENT_SECONDS,
  DOOR_GREET_OPEN_MINUTES,
  summarizeDoorGreets,
  type DoorChimeEventInput,
  type DoorGreetOutcome,
} from "@/lib/door-chime-policy";

let schemaPromise: Promise<void> | null = null;

/** Mirrors db/migrations/0013_door_chime_events.sql for databases that haven't run it (dev). */
export function ensureDoorChimeSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS door_chime_events (
          id BIGSERIAL PRIMARY KEY,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          camera TEXT NOT NULL DEFAULT 'entrance',
          kind TEXT NOT NULL DEFAULT 'person',
          detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`ALTER TABLE door_chime_events ADD COLUMN IF NOT EXISTS greeted_at TIMESTAMPTZ`;
      await sql`ALTER TABLE door_chime_events ADD COLUMN IF NOT EXISTS outcome TEXT CHECK (outcome IN ('greeted', 'not_customer'))`;
      await sql`ALTER TABLE door_chime_events ADD COLUMN IF NOT EXISTS greeted_by_employee_id TEXT`;
      await sql`ALTER TABLE door_chime_events ADD COLUMN IF NOT EXISTS greeted_by_name TEXT`;
      await sql`CREATE INDEX IF NOT EXISTS idx_door_chime_events_recent ON door_chime_events (business, detected_at DESC)`;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

/**
 * Records a walk-in unless the same camera already rang within the cooldown, so a
 * detector that reports one person several times still chimes once.
 * Test events skip the cooldown.
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

/**
 * For the POS poller: walk-ins from the last few seconds (to chime) plus any that
 * nobody has greeted yet (to keep the bar up). Ages come from the database clock so
 * a tablet with the wrong time still turns the bar red on time.
 */
export async function listRecentDoorChimeEvents(business: DoorChimeEventInput["business"]) {
  await ensureDoorChimeSchema();
  const rows = await getSql()`
    SELECT id, camera, kind, detected_at, outcome,
      EXTRACT(EPOCH FROM NOW() - detected_at)::float AS age_seconds
    FROM door_chime_events
    WHERE business = ${business} AND kind <> 'test'
      AND (
        detected_at > NOW() - make_interval(secs => ${DOOR_CHIME_RECENT_SECONDS})
        OR (outcome IS NULL AND detected_at > NOW() - make_interval(mins => ${DOOR_GREET_OPEN_MINUTES}))
      )
    UNION ALL
    SELECT id, camera, kind, detected_at, 'greeted', EXTRACT(EPOCH FROM NOW() - detected_at)::float
    FROM door_chime_events
    WHERE business = ${business} AND kind = 'test' AND detected_at > NOW() - make_interval(secs => ${DOOR_CHIME_RECENT_SECONDS})
    ORDER BY id
    LIMIT 40
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    camera: String(row.camera),
    kind: String(row.kind),
    detectedAt: toIsoTimestamp(row.detected_at),
    waiting: !row.outcome,
    ageSeconds: Math.round(Number(row.age_seconds)),
  }));
}

/** Staff tapped GREETED (or NOT A CUSTOMER) on the walk-in bar; the first tap wins. */
export async function markDoorChimeEvents(
  business: DoorChimeEventInput["business"],
  ids: number[],
  outcome: DoorGreetOutcome,
  actor: { id: string; name: string },
) {
  await ensureDoorChimeSchema();
  const rows = await getSql()`
    UPDATE door_chime_events
    SET greeted_at = NOW(), outcome = ${outcome}, greeted_by_employee_id = ${actor.id}, greeted_by_name = ${actor.name}
    WHERE business = ${business} AND id = ANY(${ids}) AND outcome IS NULL AND kind <> 'test'
    RETURNING id
  `;
  return rows.map((row) => Number(row.id));
}

/** Today's walk-ins (store time) and how long each waited to be greeted, for the store dashboard. */
export async function doorGreetDashboard(business: DoorChimeEventInput["business"]) {
  await ensureDoorChimeSchema();
  const rows = await getSql()`
    SELECT id, detected_at, greeted_at, outcome, greeted_by_name,
      EXTRACT(EPOCH FROM NOW() - detected_at)::float AS age_seconds
    FROM door_chime_events
    WHERE business = ${business} AND kind <> 'test'
      AND detected_at >= ((NOW() AT TIME ZONE 'America/New_York')::date AT TIME ZONE 'America/New_York')
    ORDER BY detected_at DESC
    LIMIT 500
  `;
  const walkIns = rows.map((row) => ({
    id: Number(row.id),
    detectedAt: toIsoTimestamp(row.detected_at) || "",
    greetedAt: toIsoTimestamp(row.greeted_at),
    outcome: row.outcome ? String(row.outcome) : null,
    greetedBy: row.greeted_by_name ? String(row.greeted_by_name) : null,
    ageSeconds: Math.round(Number(row.age_seconds)),
  }));
  return { summary: summarizeDoorGreets(walkIns), walkIns: walkIns.slice(0, 40) };
}

/** Old rows are only history; keep a week for checking how often the door rang. */
export async function pruneDoorChimeEvents() {
  await ensureDoorChimeSchema();
  await getSql()`DELETE FROM door_chime_events WHERE detected_at < NOW() - INTERVAL '7 days'`;
}
