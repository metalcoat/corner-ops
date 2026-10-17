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
