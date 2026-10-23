import { ensureOrderingPosSchema } from "@/lib/ordering-pos-schema";

let hardwareSchemaPromise: Promise<void> | null = null;

export function ensureOrderingHardwareSchema(): Promise<void> {
  if (!hardwareSchemaPromise) hardwareSchemaPromise = (async () => {
    await ensureOrderingPosSchema();
  })().catch(error => { hardwareSchemaPromise = null; throw error; });
  return hardwareSchemaPromise;
}
