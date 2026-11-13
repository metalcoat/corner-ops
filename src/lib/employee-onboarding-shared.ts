/** Onboarding constants safe to import from client pages (no node: modules). */
export const STORE_PHONE = "315-393-2271";
export const TEAM_APP_APK_URL = "https://dev.ordercornerdeli.com/downloads/corner-deli-team.apk";

/** waiting = theirs to do now; locked = theirs, after an earlier step; manager = waiting on the store. */
export type OnboardingStepStatus = "done" | "waiting" | "locked" | "manager" | "optional";
/** waived: an owner marked it done by hand ("Bypassed by … on …" is the detail). */
export type OnboardingStep = { key: string; label: string; status: OnboardingStepStatus; detail: string; waived?: boolean };
