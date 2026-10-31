import { getSql } from "@/lib/db";
import { smsBypassActive } from "@/lib/online-order-verification";
import { toTimestampDate } from "@/lib/timestamp-values";

/** When the manager's "skip the texted code" switch runs out, or null when it's off. */
export async function smsVerificationBypassUntil(business = "Corner Deli"): Promise<Date | null> {
  const row = (await getSql()`SELECT sms_verification_bypass_until FROM ordering_business_ordering_settings WHERE business=${business} LIMIT 1`)[0];
  const until = toTimestampDate(row?.sms_verification_bypass_until ?? null);
  return smsBypassActive(until) ? until : null;
}
