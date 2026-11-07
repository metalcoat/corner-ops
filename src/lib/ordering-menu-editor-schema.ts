import { ensureOrderingMenuOverrideSchema } from "@/lib/ordering-menu-overrides";

let promise: Promise<void> | null = null;

/** Local field ownership prevents a later bootstrap import from overwriting a
 * deliberate Corner Ops edit while retaining the imported payload for reset. */
export function ensureOrderingMenuEditorSchema(): Promise<void> {
  if (!promise) promise = (async () => {
    await ensureOrderingMenuOverrideSchema();
  })().catch(error => { promise = null; throw error; });
  return promise;
}
