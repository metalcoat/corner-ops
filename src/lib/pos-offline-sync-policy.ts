// Pure rules shared by the POS offline queue, the offline-sync route, and the
// online-order alert poller. Kept free of runtime imports so it can be unit
// tested directly.

export type OfflineSyncOutcome = "synced" | "retry" | "conflict";

/**
 * Classify an offline-sync HTTP response. Network-ish and session failures
 * retry automatically; any other 4xx is a business conflict that will not fix
 * itself, so the queue parks it for staff review instead of resending forever.
 */
export function classifyOfflineSyncStatus(status: number): OfflineSyncOutcome {
  if (status >= 200 && status < 300) return "synced";
  if (status === 401 || status === 403 || status === 408 || status === 425 || status === 429) return "retry";
  if (status >= 400 && status < 500) return "conflict";
  return "retry";
}

const SUBMITTED_ORDER_STATUSES = new Set(["sent_to_kitchen", "in_progress", "ready", "completed"]);

/**
 * Whether an order created by an earlier offline-sync attempt already reached
 * the kitchen (for example the submit succeeded but its result was never
 * recorded, and the kitchen has since started it).
 */
export function offlineOrderAlreadySubmitted(status: unknown): boolean {
  return SUBMITTED_ORDER_STATUSES.has(String(status || ""));
}

/** Idempotency keys are client UUIDs; anything else is ignored. */
export function readIdempotencyKey(value: unknown): string | null {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key) ? key : null;
}

export type OnlineAlertState = {
  initialized: boolean;
  /** Every online order id this device has already observed. */
  known: Set<string>;
  /** New online orders that staff have not acknowledged yet. */
  pending: Set<string>;
};

export function createOnlineAlertState(): OnlineAlertState {
  return { initialized: false, known: new Set(), pending: new Set() };
}

/**
 * Fold the latest list of waiting online order ids into the alert state.
 * The first poll only establishes a baseline. Orders that left the waiting
 * list (kitchen opened/started them) no longer need an alert.
 * Returns ids that are new since the previous poll.
 */
export function reconcileOnlineAlerts(state: OnlineAlertState, waitingIds: readonly string[]): string[] {
  const waiting = new Set(waitingIds);
  if (!state.initialized) {
    waiting.forEach((id) => state.known.add(id));
    state.initialized = true;
    return [];
  }
  for (const id of [...state.pending]) if (!waiting.has(id)) state.pending.delete(id);
  const fresh = [...waiting].filter((id) => !state.known.has(id));
  for (const id of fresh) {
    state.known.add(id);
    state.pending.add(id);
  }
  return fresh;
}

/**
 * Wrap a poller so a slow request is never overlapped by the next interval
 * tick. Calls made while one is in flight resolve immediately as skipped.
 */
export function singleFlight<T>(task: () => Promise<T>): () => Promise<T | undefined> {
  let running = false;
  return async () => {
    if (running) return undefined;
    running = true;
    try {
      return await task();
    } finally {
      running = false;
    }
  };
}
