import { getSql } from "@/lib/db";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";

export const BUSINESS_TIMEZONE = "America/New_York";

export async function getPosSettings(business: OrderingBusiness) {
  await ensureOrderingCustomerSchema();
  const rows = await getSql()`SELECT pos_idle_lock_seconds,business_timezone,updated_at FROM ordering_business_settings WHERE business=${business}`;
  return { business, posIdleLockSeconds: Number(rows[0]?.pos_idle_lock_seconds ?? 60), businessTimezone: String(rows[0]?.business_timezone || BUSINESS_TIMEZONE), updatedAt: rows[0]?.updated_at };
}

export async function savePosIdleLockSeconds(business: OrderingBusiness, value: number, actor: string) {
  const seconds = Math.trunc(value);
  if (seconds !== 0 && (seconds < 15 || seconds > 3600)) throw new Error("Auto-lock must be disabled or between 15 and 3600 seconds.");
  await ensureOrderingCustomerSchema();
  await getSql()`UPDATE ordering_business_settings SET pos_idle_lock_seconds=${seconds},updated_by=${actor},updated_at=NOW() WHERE business=${business}`;
  return getPosSettings(business);
}
