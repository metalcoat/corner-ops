/**
 * Dev-only test mode for sign-in and verification codes: when the dev server sets
 * DEV_SHOW_SMS_CODES=true and has no Telnyx settings, codes are shown on screen
 * instead of texted. Never on when Telnyx is configured (production), so a stray
 * setting can't expose codes there.
 */
export function smsCodesShownOnScreen(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEV_SHOW_SMS_CODES?.trim() === "true" && !env.TELNYX_API_KEY?.trim() && env.APP_ENV?.trim().toLowerCase() !== "production";
}
