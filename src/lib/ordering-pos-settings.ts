import { getSql } from "@/lib/db";
import { ensureOrderingCustomerSchema } from "@/lib/ordering-customer-schema";
import type { OrderingBusiness } from "@/lib/ordering-core";

export const BUSINESS_TIMEZONE = "America/New_York";
export const ONLINE_ORDER_ALERT_SOUNDS = [
  "kitchen_ring",
  "horn",
  "air_horn",
  "cha_ching",
  "buzzer",
  "telephone",
  "soft_chime",
  "off",
] as const;
export type OnlineOrderAlertSound = (typeof ONLINE_ORDER_ALERT_SOUNDS)[number];

export async function getPosSettings(business: OrderingBusiness) {
  await ensureOrderingCustomerSchema();
  const rows =
    await getSql()`SELECT pos_idle_lock_seconds,online_order_alert_sound,online_order_alert_volume,business_timezone,updated_at FROM ordering_business_settings WHERE business=${business}`;
  const sound = String(rows[0]?.online_order_alert_sound || "kitchen_ring");
  return {
    business,
    posIdleLockSeconds: Number(rows[0]?.pos_idle_lock_seconds ?? 60),
    onlineOrderAlertSound: (ONLINE_ORDER_ALERT_SOUNDS.includes(
      sound as OnlineOrderAlertSound,
    )
      ? sound
      : "kitchen_ring") as OnlineOrderAlertSound,
    onlineOrderAlertVolume: Number(rows[0]?.online_order_alert_volume ?? 100),
    businessTimezone: String(rows[0]?.business_timezone || BUSINESS_TIMEZONE),
    updatedAt: rows[0]?.updated_at,
  };
}

export async function savePosSettings(
  business: OrderingBusiness,
  value: number,
  soundValue: unknown,
  volumeValue: unknown,
  actor: string,
) {
  const seconds = Math.trunc(value);
  if (seconds !== 0 && (seconds < 15 || seconds > 3600))
    throw new Error(
      "Auto-lock must be disabled or between 15 and 3600 seconds.",
    );
  const sound = String(soundValue || "kitchen_ring") as OnlineOrderAlertSound;
  if (!ONLINE_ORDER_ALERT_SOUNDS.includes(sound))
    throw new Error("Choose a valid online-order alert sound.");
  const volume = Math.trunc(Number(volumeValue));
  if (!Number.isFinite(volume) || volume < 10 || volume > 100)
    throw new Error("Alert volume must be between 10 and 100 percent.");
  await ensureOrderingCustomerSchema();
  await getSql()`UPDATE ordering_business_settings SET pos_idle_lock_seconds=${seconds},online_order_alert_sound=${sound},online_order_alert_volume=${volume},updated_by=${actor},updated_at=NOW() WHERE business=${business}`;
  return getPosSettings(business);
}

export async function savePosIdleLockSeconds(
  business: OrderingBusiness,
  value: number,
  actor: string,
) {
  const current = await getPosSettings(business);
  return savePosSettings(
    business,
    value,
    current.onlineOrderAlertSound,
    current.onlineOrderAlertVolume,
    actor,
  );
}
