/**
 * Entrance "door chime": pure rules shared by the server route and the POS
 * poller, kept free of database and browser code so they can be unit tested.
 */

/** One person walking in rings once; repeat detections inside this window are dropped. */
export const DOOR_CHIME_COOLDOWN_SECONDS = 10;
/** The POS poller only asks for events this recent, so a device that wakes up late never rings for old walk-ins. */
export const DOOR_CHIME_RECENT_SECONDS = 30;
/** How long the on-screen "customer walked in" notice stays up. */
export const DOOR_CHIME_NOTICE_MS = 8_000;

export const DOOR_CHIME_KINDS = ["person", "line_crossing", "motion", "test"] as const;
export type DoorChimeKind = (typeof DOOR_CHIME_KINDS)[number];

export type DoorChimeEventInput = { business: "Corner Deli" | "Tiki"; camera: string; kind: DoorChimeKind };

/** Validates the detector's POST body. Throws a readable error for anything unexpected. */
export function parseDoorChimeEvent(body: unknown): DoorChimeEventInput {
  const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const business = value.business === undefined ? "Corner Deli" : value.business;
  if (business !== "Corner Deli" && business !== "Tiki") throw new Error("Unknown business.");
  const camera = String(value.camera ?? "entrance").trim().slice(0, 40) || "entrance";
  if (!/^[A-Za-z0-9 _.-]+$/.test(camera)) throw new Error("Camera names may use letters, numbers, spaces, dots, dashes and underscores.");
  const kind = String(value.kind ?? "person");
  if (!(DOOR_CHIME_KINDS as readonly string[]).includes(kind)) throw new Error(`Kind must be one of ${DOOR_CHIME_KINDS.join(", ")}.`);
  return { business, camera, kind: kind as DoorChimeKind };
}

export type DoorChimeState = { initialized: boolean; lastId: number };

export function createDoorChimeState(): DoorChimeState {
  return { initialized: false, lastId: 0 };
}

/**
 * Fold the latest recent door events into the poller state. The first poll only
 * sets a baseline (a screen that just opened doesn't ring for someone who walked
 * in 20 seconds ago). Returns the ids that are new since the previous poll.
 */
export function reconcileDoorEvents(state: DoorChimeState, ids: readonly number[]): number[] {
  const newest = ids.reduce((max, id) => Math.max(max, id), 0);
  if (!state.initialized) {
    state.initialized = true;
    state.lastId = newest;
    return [];
  }
  const fresh = ids.filter((id) => id > state.lastId).sort((a, b) => a - b);
  state.lastId = Math.max(state.lastId, newest);
  return fresh;
}

/** A walk-in nobody has greeted yet chimes again (and the bar turns red) at each of these ages. */
export const DOOR_GREET_REMINDER_SECONDS = [30, 60, 90, 120] as const;
/** Not greeted within this long counts as a missed customer on the dashboard. */
export const DOOR_GREET_MISSED_SECONDS = 120;
/** Ungreeted walk-ins stay on the POS bar this long; after that they only show on the dashboard. */
export const DOOR_GREET_OPEN_MINUTES = 10;

export const DOOR_GREET_OUTCOMES = ["greeted", "not_customer"] as const;
export type DoorGreetOutcome = (typeof DOOR_GREET_OUTCOMES)[number];

/** Validates a POS tap on the walk-in bar. */
export function parseDoorGreet(body: unknown): { ids: number[]; outcome: DoorGreetOutcome } {
  const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const ids = Array.isArray(value.ids) ? [...new Set(value.ids.map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  if (!ids.length || ids.length > 50) throw new Error("Choose the walk-ins to mark.");
  const outcome = String(value.outcome ?? "greeted");
  if (!(DOOR_GREET_OUTCOMES as readonly string[]).includes(outcome)) throw new Error("Outcome must be greeted or not_customer.");
  return { ids, outcome: outcome as DoorGreetOutcome };
}

/**
 * Which waiting walk-ins are due another chime: each reminder age rings once per
 * walk-in. `rung` remembers how many reminders each id has had.
 */
export function dueGreetReminders(rung: Map<number, number>, waiting: readonly { id: number; ageSeconds: number }[]): number[] {
  const waitingIds = new Set(waiting.map((event) => event.id));
  for (const id of [...rung.keys()]) if (!waitingIds.has(id)) rung.delete(id);
  const due: number[] = [];
  for (const event of waiting) {
    const reached = DOOR_GREET_REMINDER_SECONDS.filter((age) => event.ageSeconds >= age).length;
    const already = rung.get(event.id) ?? 0;
    if (reached > already) due.push(event.id);
    rung.set(event.id, Math.max(already, reached));
  }
  return due;
}

export type DoorGreetRow = { detectedAt: string; greetedAt: string | null; outcome: string | null; ageSeconds: number };

/** The dashboard's numbers for today's walk-ins ("not a customer" taps are left out). */
export function summarizeDoorGreets(rows: readonly DoorGreetRow[]) {
  const customers = rows.filter((row) => row.outcome !== "not_customer");
  const waits = customers
    .filter((row) => row.outcome === "greeted" && row.greetedAt)
    .map((row) => Math.max(0, (new Date(row.greetedAt!).getTime() - new Date(row.detectedAt).getTime()) / 1000));
  const sorted = [...waits].sort((a, b) => a - b);
  const median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  return {
    walkIns: customers.length,
    greeted: waits.length,
    waiting: customers.filter((row) => !row.outcome && row.ageSeconds < DOOR_GREET_MISSED_SECONDS).length,
    missed:
      waits.filter((seconds) => seconds > DOOR_GREET_MISSED_SECONDS).length +
      customers.filter((row) => !row.outcome && row.ageSeconds >= DOOR_GREET_MISSED_SECONDS).length,
    notCustomer: rows.length - customers.length,
    averageSeconds: waits.length ? Math.round(waits.reduce((sum, seconds) => sum + seconds, 0) / waits.length) : null,
    medianSeconds: median === null ? null : Math.round(median),
    longestSeconds: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
  };
}
