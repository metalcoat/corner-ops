/** Onboarding constants safe to import from client pages (no node: modules). */
export const STORE_PHONE = "315-393-2271";
export const TEAM_APP_APK_URL = "https://dev.ordercornerdeli.com/downloads/corner-deli-team.apk";

export type OnboardingStepStatus = "done" | "waiting" | "manager" | "optional";
export type OnboardingStep = { key: string; label: string; status: OnboardingStepStatus; detail: string };
