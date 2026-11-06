import { createHash, randomBytes } from "node:crypto";
import { STORE_PHONE, type OnboardingStep } from "./employee-onboarding-shared";

export { STORE_PHONE, TEAM_APP_APK_URL, type OnboardingStep, type OnboardingStepStatus } from "./employee-onboarding-shared";

/** Pure rules for the new-hire self-setup link; the database side is employee-onboarding.ts. */

export const ONBOARDING_LINK_DAYS = 7;

export function newOnboardingToken(): string {
  return randomBytes(24).toString("base64url");
}

export function onboardingTokenHash(token: string): string {
  return createHash("sha256").update(`employee-onboarding:${token}`, "utf8").digest("hex");
}

export function validOnboardingTokenShape(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{32}$/.test(token);
}

export function onboardingExpiry(now = new Date()): Date {
  return new Date(now.getTime() + ONBOARDING_LINK_DAYS * 24 * 60 * 60 * 1000);
}

export type InviteState = { expiresAt: Date; revokedAt: Date | null };

export function inviteUsable(invite: InviteState | null | undefined, now = new Date()): boolean {
  return Boolean(invite && !invite.revokedAt && invite.expiresAt.getTime() > now.getTime());
}

export function onboardingLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/employee/welcome/${token}`;
}

function givenName(value: string): string {
  return value.trim().split(/\s+/)[0] || "there";
}

/** The one text a new hire gets. Kept under 300 characters (two SMS segments). */
export function onboardingSmsText(input: { name: string; link: string; businessName?: string; storePhone?: string }): string {
  const business = input.businessName || "Corner Deli";
  const phone = input.storePhone || STORE_PHONE;
  return [
    `${business}: Welcome to the team, ${givenName(input.name)}!`,
    `Set up your employee account, new-hire forms, handbook, direct deposit and schedule app here: ${input.link}`,
    `This link is just for you and expires in ${ONBOARDING_LINK_DAYS} days. Questions? Call ${phone}. Reply STOP to opt out.`,
  ].join("\n");
}

/**
 * Whether to only log the text instead of sending it. Production (Telnyx configured, no override) sends.
 * Anywhere else, or with ONBOARDING_SMS_LOG_ONLY=true, the text is logged unless the number is listed
 * in SMS_TEST_NUMBERS (comma-separated, any format).
 */
export function onboardingSmsLogOnly(phone: string, env: Record<string, string | undefined> = process.env): boolean {
  const digits = (value: string) => value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const testNumbers = String(env.SMS_TEST_NUMBERS || "").split(",").map(digits).filter(Boolean);
  if (testNumbers.includes(digits(phone))) return false;
  if (!env.TELNYX_API_KEY?.trim() || !env.TELNYX_FROM_NUMBER?.trim()) return true;
  return env.ONBOARDING_SMS_LOG_ONLY?.trim() === "true";
}

export type OnboardingFacts = {
  textStatus: string;
  textSentAt: string | null;
  linkExpiresAt: string | null;
  linkUsable: boolean;
  accountSet: boolean;
  formsAssigned: number;
  formsSigned: number;
  formsAwaitingEmployer: number;
  handbookRequired: boolean;
  handbookAcknowledged: boolean;
  directDeposit: "none" | "assigned" | "completed";
  appSignIns: number;
  payrollReliefEeNum: string | null;
  payrollReliefApplies: boolean;
  hourlyRateSet: boolean;
};

/** The manager's per-hire checklist, in the order the new hire works through it. */
export function onboardingChecklist(facts: OnboardingFacts): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  const textSent = facts.textStatus === "sent" || facts.textStatus === "logged";
  steps.push({
    key: "text",
    label: "Setup text",
    status: textSent ? (facts.linkUsable || facts.accountSet ? "done" : "manager") : "manager",
    detail: !textSent
      ? (facts.textStatus === "pending" ? "Not sent yet." : `Not sent: ${facts.textStatus}. Use Resend text.`)
      : facts.linkUsable || facts.accountSet
        ? `${facts.textStatus === "logged" ? "Logged (dev, not texted)" : "Sent"}${facts.textSentAt ? ` ${facts.textSentAt}` : ""}.`
        : "The link expired before setup. Use Resend text.",
  });
  steps.push({ key: "account", label: "Account & PIN", status: facts.accountSet ? "done" : "waiting", detail: facts.accountSet ? "PIN chosen; can sign in." : "Waiting for the new hire to open the link and choose a PIN." });
  steps.push({
    key: "forms",
    label: "New-hire forms",
    status: !facts.formsAssigned ? "manager" : facts.formsSigned >= facts.formsAssigned ? (facts.formsAwaitingEmployer ? "manager" : "done") : "waiting",
    detail: !facts.formsAssigned
      ? "No forms assigned. Complete the employer profile on Paperwork, then assign the packet."
      : `${facts.formsSigned} of ${facts.formsAssigned} signed${facts.formsAwaitingEmployer ? `; ${facts.formsAwaitingEmployer} need your I-9 review` : ""}.`,
  });
  if (!facts.hourlyRateSet) steps.push({ key: "pay", label: "Pay rate notice", status: "manager", detail: "Set the hourly rate, then send the NY pay notice from Paperwork." });
  if (facts.handbookRequired) steps.push({ key: "handbook", label: "Handbook", status: facts.handbookAcknowledged ? "done" : "waiting", detail: facts.handbookAcknowledged ? "Read and signed." : "Not signed yet." });
  steps.push({
    key: "deposit",
    label: "Direct deposit",
    status: facts.directDeposit === "completed" ? "done" : "optional",
    detail: facts.directDeposit === "completed" ? "Election submitted." : "Optional; not submitted yet.",
  });
  steps.push({ key: "app", label: "Schedule app", status: facts.appSignIns > 0 ? "done" : "waiting", detail: facts.appSignIns > 0 ? `Signed in on ${facts.appSignIns} device${facts.appSignIns === 1 ? "" : "s"}.` : "Not signed in yet." });
  if (facts.payrollReliefApplies) {
    steps.push({
      key: "payroll",
      label: "Payroll Relief",
      status: facts.payrollReliefEeNum ? "done" : "manager",
      detail: facts.payrollReliefEeNum ? `Matched to EE #${facts.payrollReliefEeNum}.` : "Add them in Payroll Relief, refresh the list on Payroll, then match them.",
    });
  }
  return steps;
}

export function onboardingComplete(steps: OnboardingStep[]): boolean {
  return steps.every((step) => step.status === "done" || step.status === "optional");
}
