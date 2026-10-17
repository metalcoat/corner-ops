import { getSql } from "@/lib/db";
import { DOOR_CHIME_COOLDOWN_SECONDS, DOOR_CHIME_RECENT_SECONDS, type DoorChimeEventInput } from "@/lib/door-chime-policy";

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

/** Walk-ins from the last few seconds, for the POS poller. */
export async function listRecentDoorChimeEvents(business: DoorChimeEventInput["business"]) {
  await ensureDoorChimeSchema();
  const rows = await getSql()`
    SELECT id, camera, kind, detected_at
    FROM door_chime_events
    WHERE business = ${business} AND detected_at > NOW() - make_interval(secs => ${DOOR_CHIME_RECENT_SECONDS})
    ORDER BY id
    LIMIT 20
  `;
  return rows.map((row) => ({ id: Number(row.id), camera: String(row.camera), kind: String(row.kind), detectedAt: row.detected_at }));
}

/** Old rows are only history; keep a week for checking how often the door rang. */
export async function pruneDoorChimeEvents() {
  await ensureDoorChimeSchema();
  await getSql()`DELETE FROM door_chime_events WHERE detected_at < NOW() - INTERVAL '7 days'`;
}
