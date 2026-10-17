/**
 * Entrance walk-ins (door chime): pure rules shared by the detector route and the
 * store dashboard, kept free of database code so they can be unit tested.
 */

/** One person (or one group) walking in counts once; repeat detections inside this window are dropped. */
export const DOOR_CHIME_COOLDOWN_SECONDS = 10;
/** A walk-in with no POS order started within this long counts as missed. */
export const DOOR_SERVE_MISSED_SECONDS = 10 * 60;

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

export type WalkIn = { id: number; detectedAt: string };
export type CounterOrder = { id: string; displayNumber: string; createdAt: string };
export type MatchedWalkIn = WalkIn & {
  status: "served" | "missed" | "waiting";
  order: CounterOrder | null;
  waitSeconds: number | null;
};

/**
 * Time to first interaction: each POS order started is matched to the oldest
 * walk-in still waiting (first come, first served). Walk-ins with no order within
 * DOOR_SERVE_MISSED_SECONDS are missed; newer ones are still waiting.
 */
export function matchWalkInsToOrders(walkIns: readonly WalkIn[], orders: readonly CounterOrder[], nowIso: string): MatchedWalkIn[] {
  const ms = (iso: string) => new Date(iso).getTime();
  const limit = DOOR_SERVE_MISSED_SECONDS * 1000;
  const sortedWalkIns = [...walkIns].sort((a, b) => ms(a.detectedAt) - ms(b.detectedAt) || a.id - b.id);
  const result = new Map<number, MatchedWalkIn>();
  const queue: WalkIn[] = [];
  let next = 0;
  for (const order of [...orders].sort((a, b) => ms(a.createdAt) - ms(b.createdAt))) {
    const at = ms(order.createdAt);
    while (next < sortedWalkIns.length && ms(sortedWalkIns[next].detectedAt) <= at) queue.push(sortedWalkIns[next++]);
    while (queue.length && at - ms(queue[0].detectedAt) > limit) {
      const missed = queue.shift()!;
      result.set(missed.id, { ...missed, status: "missed", order: null, waitSeconds: null });
    }
    const served = queue.shift();
    if (served) result.set(served.id, { ...served, status: "served", order, waitSeconds: Math.round((at - ms(served.detectedAt)) / 1000) });
  }
  const now = ms(nowIso);
  for (const walkIn of [...queue, ...sortedWalkIns.slice(next)])
    result.set(walkIn.id, { ...walkIn, status: now - ms(walkIn.detectedAt) > limit ? "missed" : "waiting", order: null, waitSeconds: null });
  return sortedWalkIns.map((walkIn) => result.get(walkIn.id)!);
}

/** Dashboard numbers for today's walk-ins. `hourOf` maps a timestamp to the store's local hour. */
export function summarizeWalkIns(matched: readonly MatchedWalkIn[], hourOf: (iso: string) => number) {
  const waits = matched.flatMap((walkIn) => (walkIn.waitSeconds === null ? [] : [walkIn.waitSeconds])).sort((a, b) => a - b);
  const middle = waits.length >> 1;
  const byHour = new Map<number, number>();
  for (const walkIn of matched) byHour.set(hourOf(walkIn.detectedAt), (byHour.get(hourOf(walkIn.detectedAt)) ?? 0) + 1);
  return {
    walkIns: matched.length,
    served: waits.length,
    missed: matched.filter((walkIn) => walkIn.status === "missed").length,
    waiting: matched.filter((walkIn) => walkIn.status === "waiting").length,
    averageSeconds: waits.length ? Math.round(waits.reduce((sum, seconds) => sum + seconds, 0) / waits.length) : null,
    medianSeconds: waits.length ? Math.round(waits.length % 2 ? waits[middle] : (waits[middle - 1] + waits[middle]) / 2) : null,
    longestSeconds: waits.length ? waits[waits.length - 1] : null,
    byHour: [...byHour].sort(([a], [b]) => a - b).map(([hour, count]) => ({ hour, count })),
  };
}
