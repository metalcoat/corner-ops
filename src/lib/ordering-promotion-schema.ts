import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let ready: Promise<void> | null = null;

export function ensureOrderingPromotionSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await ensureOrderingPosSchema();
  })().catch((error) => { ready = null; throw error; });
  return ready;
}
