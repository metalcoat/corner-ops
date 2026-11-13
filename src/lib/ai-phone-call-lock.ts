import { AsyncLocalStorage } from "node:async_hooks";

// One cart writer at a time per phone call: Gemini's price_order and Claude's own cart fixes (2026-11-07) both
// go through this, so a fix can compare the cart it checked with the cart it's about to change without Gemini
// writing in between. In-process only: the app runs as one Node process. Re-entrant, because a fix applies its
// changes through the same price_order handler while it holds the lock.

const tails = new Map<string, Promise<unknown>>();
const held = new AsyncLocalStorage<Set<string>>();

export async function withCallCartLock<T>(callId: string, work: () => Promise<T>): Promise<T> {
  const mine = held.getStore();
  if (!callId || mine?.has(callId)) return work();
  const previous = tails.get(callId) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => current);
  tails.set(callId, tail);
  await previous.catch(() => undefined);
  try {
    return await held.run(new Set([...(mine || []), callId]), work);
  } finally {
    release();
    if (tails.get(callId) === tail) tails.delete(callId);
  }
}
