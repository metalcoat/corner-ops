import { randomUUID } from "node:crypto";
import { recordAuditEvent } from "@/lib/audit";
import { normalizePosition, roleGroupForPosition } from "@/lib/business-positions";
import { getSql } from "@/lib/db";
import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { ensureEmployeeProfileSchema } from "@/lib/employee-profile";
import { clearEmployeeSession, createEmployeeSession, getEmployeeSession } from "@/lib/employee-auth";
import {
  inviteUsable,
  newOnboardingToken,
  onboardingChecklist,
  onboardingComplete,
  onboardingExpiry,
  onboardingLink,
  onboardingSmsLogOnly,
  onboardingSmsText,
  onboardingTokenHash,
  validOnboardingTokenShape,
  type OnboardingStep,
} from "@/lib/employee-onboarding-rules";
import { assertEmployeePinAvailable, employeePinUpdate, isEmployeePinUniqueViolation } from "@/lib/employee-pin-security";
import { recordEmployeePinAudit } from "@/lib/employee-pin-audit";
import { validateEmployeePin } from "@/lib/employee-pin";
import { getCornerDeliHandbook } from "@/lib/employee-handbook";
import { assignOnboardingPacket, assignRateChange, getEmploymentFormProfile } from "@/lib/employment-forms";
import { ensureEmployeeDirectDepositElection } from "@/lib/direct-deposit";
import { ConflictError, ValidationError } from "@/lib/http";
import { normalizeSmsPhone } from "@/lib/phone";
import { employeeKey } from "@/lib/payroll-relief-timesheet";
import { deliverSms } from "@/lib/sms-notifications";
import { cornerOpsBaseUrl } from "@/lib/transactional-email";
import type { Business } from "@/lib/types";

export type EmployeeOnboardingSmsInput = {
  id: string;
  business: Business;
  name: string;
  phone: string;
  smsOptIn: boolean;
  pin: string;
};

function employeeGivenName(value: string): string {
  return value.trim().split(/\s+/)[0] || "there";
}

/** Older "create with a PIN" text, still used by the employee-directory create action. */
export async function sendEmployeeOnboardingSms(input: EmployeeOnboardingSmsInput) {
  const baseUrl = cornerOpsBaseUrl(input.business);
  if (!baseUrl) {
    return {
      provider: "telnyx" as const,
      configured: false,
      sent: 0,
      failed: 1,
      missingPhone: 0,
      notOptedIn: input.smsOptIn ? 0 : 1,
      skipped: 0,
      failures: [{ employeeId: input.id, message: "APP_URL or EMPLOYEE_APP_URL is not configured." }],
      accepted: [],
    };
  }

  const employeeHubUrl = `${baseUrl}/employee?business=${encodeURIComponent(input.business)}`;
  const formsUrl = `${baseUrl}/employee/forms`;

  return deliverSms({
    recipients: [{ id: input.id, name: input.name, phone: input.phone, smsOptIn: input.smsOptIn }],
    text: () => [
      `${input.business}: Welcome, ${employeeGivenName(input.name)}!`,
      `Sign in to Corner Ops Employee Hub: ${employeeHubUrl}`,
      `Your PIN is ${input.pin}.`,
      `Complete your required new-hire forms here: ${formsUrl}`,
      "This includes your New York pay-rate/payday notice, federal W-4, New York IT-2104, I-9, and meal-period acknowledgment.",
      "Questions? Send management a message in Corner Ops. Do not reply here except STOP to opt out.",
    ].join("\n"),
  });
}

type EmployeeRow = {
  id: string; business: Business; name: string; phone: string; sms_opt_in: boolean; position: string;
  hourly_rate: string | number; pin_enabled: boolean; active: boolean;
};

type InviteRow = {
  id: string; business: Business; employee_id: string; created_by: string; created_at: Date | string;
  expires_at: Date | string; revoked_at: Date | string | null; opened_at: Date | string | null;
  account_set_at: Date | string | null; sms_status: string; sms_detail: string;
};

const asDate = (value: Date | string | null): Date | null => value ? new Date(value) : null;

function eastern(value: Date | string | null): string | null {
  const date = asDate(value);
  if (!date) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function businessDisplayName(business: Business): string {
  return business === "Tiki" ? "At the Docks" : "Corner Deli";
}

async function employeeRow(business: Business, employeeId: string): Promise<EmployeeRow> {
  const rows = await getSql()`
    SELECT id, business, name, phone, sms_opt_in, position, hourly_rate, pin_enabled, active
    FROM employees WHERE business = ${business} AND id = ${employeeId} LIMIT 1
  ` as unknown as EmployeeRow[];
  if (!rows[0]) throw new ValidationError("Employee not found.");
  return rows[0];
}

/**
 * Add employee: name and mobile (role and rate optional). The employee starts with no PIN; they pick
 * one on their setup page. The forms packet and direct-deposit election are assigned here so the
 * new hire finds them waiting.
 */
export async function createOnboardingEmployee(input: {
  business: Business;
  name: string;
  phone: string;
  smsConsent: boolean;
  position?: string;
  hourlyRate?: number;
  actor: string;
  actorName: string;
}) {
  await ensureEmployeeProfileSchema();
  await ensureEmployeeDirectorySchema();
  const sql = getSql();
  const name = String(input.name || "").trim().replace(/\s+/g, " ").slice(0, 120);
  if (!name) throw new ValidationError("Enter the new hire's name.");
  const phone = normalizeSmsPhone(input.phone);
  if (!phone) throw new ValidationError("Enter the new hire's mobile number.");
  if (!input.smsConsent) throw new ValidationError("Confirm the new hire agreed to get texts before sending the setup link.");
  const position = normalizePosition(input.business, input.position || (input.business === "Tiki" ? "Bartender" : "Pizza"));
  const roleGroup = roleGroupForPosition(input.business, position);
  const hourlyRate = Math.max(0, Number(input.hourlyRate || 0));

  const duplicate = await sql`SELECT id, active FROM employees WHERE business = ${input.business} AND LOWER(BTRIM(name)) = LOWER(${name}) LIMIT 1` as unknown as Array<{ id: string; active: boolean }>;
  if (duplicate[0]) throw new ConflictError(duplicate[0].active ? `${name} is already on the team. Open them on Team to resend their text.` : `${name} is an inactive employee. Reactivate them on Team instead.`);

  const id = randomUUID();
  // No PIN yet: a unique placeholder fills the required pin_hash and pin_enabled stays off, so nobody can sign in as them.
  await sql`
    INSERT INTO employees (id, business, name, phone, sms_opt_in, sms_consent_updated_at, pin_hash, pin_enabled, position, role_group, counts_for_tips, hourly_rate, tipped_rate, active)
    VALUES (${id}, ${input.business}, ${name}, ${phone}, TRUE, NOW(), ${`onboarding-pending:${id}`}, FALSE, ${position}, ${roleGroup}, TRUE, ${hourlyRate}, 0, TRUE)
  `;
  await recordAuditEvent({ business: input.business, action: "employee-added-for-onboarding", actor: input.actor, entityType: "employee", entityId: id, details: { name, position, hourlyRateSet: hourlyRate > 0 } });

  const paperwork = await assignNewHirePaperwork({ business: input.business, employeeId: id, hourlyRateSet: hourlyRate > 0, actor: input.actor, actorName: input.actorName });
  const invite = await issueOnboardingInvite({ business: input.business, employeeId: id, actor: input.actor });
  return { employee: { id, name, phone, position }, paperwork, invite };
}

async function assignNewHirePaperwork(input: { business: Business; employeeId: string; hourlyRateSet: boolean; actor: string; actorName: string }) {
  const notes: string[] = [];
  await ensureEmployeeDirectDepositElection({ business: input.business, employeeId: input.employeeId, actor: input.actor }).catch((error) => {
    notes.push(`Direct deposit not assigned: ${error instanceof Error ? error.message : String(error)}`);
  });
  const profile = await getEmploymentFormProfile(input.business);
  if (!profile.legalName || !profile.ein || !profile.address || !profile.phone || !profile.payday) {
    notes.push("Forms not assigned: complete the employer profile on Paperwork, then assign the packet.");
    return { formsAssigned: 0, notes };
  }
  const forms = await assignOnboardingPacket({
    business: input.business,
    employeeId: input.employeeId,
    hireDate: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    actor: input.actor,
    employerSignature: input.actorName,
    skipPayNotice: !input.hourlyRateSet,
  });
  if (!input.hourlyRateSet) notes.push("Pay notice waits until you set an hourly rate.");
  return { formsAssigned: forms.length, notes };
}

/** New link for one employee: older links stop working, then one text goes out (or is logged off production). */
export async function issueOnboardingInvite(input: { business: Business; employeeId: string; actor: string }) {
  const employee = await employeeRow(input.business, input.employeeId);
  if (!employee.active) throw new ValidationError("Reactivate this employee before sending a setup text.");
  if (!employee.phone) throw new ValidationError("Add a mobile number for this employee first.");
  const sql = getSql();
  const token = newOnboardingToken();
  const id = randomUUID();
  const expiresAt = onboardingExpiry();
  await sql`UPDATE employee_onboarding_invites SET revoked_at = NOW() WHERE business = ${input.business} AND employee_id = ${input.employeeId} AND revoked_at IS NULL`;
  await sql`
    INSERT INTO employee_onboarding_invites (id, business, employee_id, token_hash, created_by, expires_at)
    VALUES (${id}, ${input.business}, ${input.employeeId}, ${onboardingTokenHash(token)}, ${input.actor}, ${expiresAt})
  `;
  const baseUrl = cornerOpsBaseUrl(input.business);
  const link = baseUrl ? onboardingLink(baseUrl, token) : "";
  const text = onboardingSmsText({ name: employee.name, link, businessName: businessDisplayName(input.business) });

  let status = "sent";
  let detail = "";
  let devLink: string | null = null;
  if (!link) {
    status = "failed";
    detail = "APP_URL or EMPLOYEE_APP_URL is not configured.";
  } else if (onboardingSmsLogOnly(employee.phone)) {
    status = "logged";
    detail = "Not texted: SMS is in log-only mode here.";
    devLink = link;
    console.info(`[onboarding-sms] log-only, to ${employee.phone}:\n${text}`);
  } else {
    const result = await deliverSms({ recipients: [{ id: employee.id, name: employee.name, phone: employee.phone, smsOptIn: true }], text: () => text });
    if (!result.sent) {
      status = "failed";
      detail = result.failures[0]?.message || (result.configured ? "The text was not accepted." : "SMS is not configured.");
    }
  }
  await sql`UPDATE employee_onboarding_invites SET sms_status = ${status}, sms_detail = ${detail.slice(0, 300)} WHERE id = ${id}`;
  await recordAuditEvent({ business: input.business, action: "onboarding-link-texted", actor: input.actor, entityType: "employee", entityId: input.employeeId, details: { inviteId: id, status, detail, expiresAt: expiresAt.toISOString() } });
  return { status, detail, expiresAt: expiresAt.toISOString(), devLink, text: text.replace(link || "\u0000", "<personal link>") };
}

async function inviteByToken(token: unknown): Promise<(InviteRow & { employee: EmployeeRow }) | null> {
  if (!validOnboardingTokenShape(token)) return null;
  const rows = await getSql()`
    SELECT * FROM employee_onboarding_invites WHERE token_hash = ${onboardingTokenHash(token)} LIMIT 1
  ` as unknown as InviteRow[];
  const invite = rows[0];
  if (!invite) return null;
  const employee = await employeeRow(invite.business, invite.employee_id).catch(() => null);
  return employee ? { ...invite, employee } : null;
}

function usable(invite: InviteRow, employee: EmployeeRow) {
  return employee.active && inviteUsable({ expiresAt: new Date(invite.expires_at), revokedAt: asDate(invite.revoked_at) });
}

/** What the setup page shows for a link. Only a signed-in new hire sees their checklist. */
export async function onboardingWelcome(token: unknown) {
  const invite = await inviteByToken(token);
  if (!invite || !usable(invite, invite.employee)) return { valid: false as const };
  if (!invite.opened_at) await getSql()`UPDATE employee_onboarding_invites SET opened_at = NOW() WHERE id = ${invite.id}`;
  const session = await getEmployeeSession();
  const signedIn = Boolean(session && session.employeeId === invite.employee_id);
  return {
    valid: true as const,
    business: invite.business,
    businessName: businessDisplayName(invite.business),
    firstName: employeeGivenName(invite.employee.name),
    accountSet: invite.employee.pin_enabled,
    signedIn,
    steps: signedIn ? await employeeSteps(invite.business, invite.employee_id) : [],
  };
}

/** The new hire picks a PIN on their link; that turns on sign-in and signs this device in. */
export async function completeOnboardingAccount(input: { token: unknown; pin: unknown; pinConfirm: unknown; userAgent: string }) {
  const invite = await inviteByToken(input.token);
  if (!invite || !usable(invite, invite.employee)) throw new ValidationError("This setup link has expired. Ask your manager to resend it.");
  if (invite.employee.pin_enabled) throw new ConflictError("Your account is already set up. Sign in with your PIN.");
  const pin = validateEmployeePin(invite.business, input.pin, "Your");
  if (String(input.pinConfirm ?? "").trim() !== pin) throw new ValidationError("The two PINs don't match.");
  if (/^(\d)\1+$/.test(pin) || "0123456789".includes(pin) || "9876543210".includes(pin)) throw new ValidationError("Choose a PIN that isn't all one number or a straight run.");
  await assertEmployeePinAvailable({ business: invite.business, pin, employeeName: "That", excludeEmployeeId: invite.employee_id }).catch(() => {
    throw new ConflictError("That PIN is taken. Please choose a different one.");
  });
  const record = employeePinUpdate(invite.business, pin, invite.employee.name);
  try {
    await getSql()`
      UPDATE employees SET pin_hash = ${record.hash}, pin_salt = ${record.salt}, pin_hash_version = ${record.version},
        pin_fingerprint = ${record.fingerprint}, pin_enabled = TRUE, session_version = session_version + 1, updated_at = NOW()
      WHERE id = ${invite.employee_id} AND business = ${invite.business} AND pin_enabled = FALSE
    `;
  } catch (error) {
    if (isEmployeePinUniqueViolation(error)) throw new ConflictError("That PIN is taken. Please choose a different one.");
    throw error;
  }
  await getSql()`UPDATE employee_onboarding_invites SET account_set_at = NOW() WHERE id = ${invite.id}`;
  await recordEmployeePinAudit({ employeeId: invite.employee_id, business: invite.business, action: "pin_assigned", actor: "employee onboarding link" });
  await createEmployeeSession(invite.business, pin, { label: "Onboarding link", userAgent: input.userAgent });
  return onboardingWelcome(input.token);
}

/** Signing in again from the setup link (PIN already chosen). The PIN must belong to the link's employee. */
export async function signInFromOnboardingLink(input: { token: unknown; pin: unknown; userAgent: string }) {
  const invite = await inviteByToken(input.token);
  if (!invite || !usable(invite, invite.employee)) throw new ValidationError("This setup link has expired. Sign in from the Employee Hub instead.");
  const session = await createEmployeeSession(invite.business, String(input.pin ?? ""), { label: "Onboarding link", userAgent: input.userAgent });
  if (session.employeeId !== invite.employee_id) {
    await clearEmployeeSession();
    throw new ValidationError("That PIN isn't for this setup link.");
  }
  return onboardingWelcome(input.token);
}

type Facts = Parameters<typeof onboardingChecklist>[0];

async function onboardingFacts(business: Business, employeeId: string): Promise<Facts & { name: string; invite: InviteRow | null }> {
  const sql = getSql();
  const employee = await employeeRow(business, employeeId);
  const handbook = getCornerDeliHandbook();
  const [invites, forms, handbookRows, deposits, sessions, relief] = await Promise.all([
    sql`SELECT * FROM employee_onboarding_invites WHERE business = ${business} AND employee_id = ${employeeId} ORDER BY created_at DESC LIMIT 1` as unknown as Promise<InviteRow[]>,
    sql`SELECT form_type, status FROM employment_forms WHERE business = ${business} AND employee_id = ${employeeId} AND status <> 'Superseded'` as unknown as Promise<Array<{ form_type: string; status: string }>>,
    sql`SELECT 1 FROM employee_handbook_acknowledgments WHERE employee_id = ${employeeId} AND business = ${business} AND handbook_version = ${handbook.version} AND content_hash = ${handbook.contentHash} LIMIT 1` as unknown as Promise<unknown[]>,
    sql`SELECT status FROM direct_deposit_elections WHERE business = ${business} AND employee_id = ${employeeId} AND status <> 'Superseded'` as unknown as Promise<Array<{ status: string }>>,
    sql`SELECT COUNT(*)::int n FROM employee_app_sessions WHERE employee_id = ${employeeId} AND device_label <> 'Onboarding link'` as unknown as Promise<Array<{ n: number }>>,
    business === "Corner Deli"
      ? sql`SELECT ee_num FROM payroll_relief_employees WHERE business = ${business} AND employee_key = ${employeeKey(employee.name)} LIMIT 1` as unknown as Promise<Array<{ ee_num: string }>>
      : Promise.resolve([] as Array<{ ee_num: string }>),
  ]);
  const invite = invites[0] || null;
  const signed = forms.filter((form) => form.status !== "Assigned");
  return {
    name: employee.name,
    invite,
    textStatus: invite?.sms_status || "pending",
    textSentAt: eastern(invite?.created_at ?? null),
    linkExpiresAt: eastern(invite?.expires_at ?? null),
    linkUsable: Boolean(invite && usable(invite, employee)),
    accountSet: employee.pin_enabled,
    formsAssigned: forms.length,
    formsSigned: signed.length,
    formsAwaitingEmployer: forms.filter((form) => form.status === "Employer Review" || (form.form_type === "I9" && form.status === "Employee Signed")).length,
    handbookRequired: business === "Corner Deli",
    handbookAcknowledged: handbookRows.length > 0,
    directDeposit: deposits.some((row) => row.status === "Completed") ? "completed" : deposits.length ? "assigned" : "none",
    appSignIns: Number(sessions[0]?.n || 0),
    payrollReliefApplies: business === "Corner Deli",
    payrollReliefEeNum: relief[0]?.ee_num || null,
    hourlyRateSet: Number(employee.hourly_rate) > 0,
  };
}

export async function onboardingStatus(business: Business, employeeId: string) {
  const facts = await onboardingFacts(business, employeeId);
  const steps = onboardingChecklist(facts);
  return {
    employeeId,
    name: facts.name,
    hasInvite: Boolean(facts.invite),
    linkExpiresAt: facts.linkExpiresAt,
    textStatus: facts.textStatus,
    textDetail: facts.invite?.sms_detail || "",
    complete: onboardingComplete(steps),
    steps,
  };
}

/** Everyone who got a setup link and isn't finished, newest first, for the Team page. */
export async function listOnboardingInProgress(business: Business) {
  const rows = await getSql()`
    SELECT DISTINCT ON (i.employee_id) i.employee_id, i.created_at
    FROM employee_onboarding_invites i JOIN employees e ON e.id = i.employee_id
    WHERE i.business = ${business} AND e.active = TRUE AND i.created_at > NOW() - INTERVAL '60 days'
    ORDER BY i.employee_id, i.created_at DESC
  ` as unknown as Array<{ employee_id: string; created_at: string }>;
  const statuses = await Promise.all(rows
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map((row) => onboardingStatus(business, row.employee_id)));
  return statuses.filter((status) => !status.complete);
}

/** The new hire's own list on the setup page: where each step lives in the Employee Hub. */
async function employeeSteps(business: Business, employeeId: string): Promise<OnboardingStep[]> {
  const facts = await onboardingFacts(business, employeeId);
  const steps: OnboardingStep[] = [
    { key: "account", label: "Employee account", status: facts.accountSet ? "done" : "waiting", detail: facts.accountSet ? "Your PIN is set." : "Choose your PIN." },
    {
      key: "forms",
      label: "New-hire forms",
      status: !facts.formsAssigned ? "manager" : facts.formsSigned >= facts.formsAssigned ? "done" : "waiting",
      detail: !facts.formsAssigned ? "Your manager hasn't assigned your forms yet." : `${facts.formsSigned} of ${facts.formsAssigned} done: W-4, IT-2104, I-9 and the rest.`,
    },
  ];
  if (facts.handbookRequired) steps.push({ key: "handbook", label: "Employee handbook", status: facts.handbookAcknowledged ? "done" : "waiting", detail: facts.handbookAcknowledged ? "Signed." : "Read it and sign at the bottom." });
  steps.push({ key: "deposit", label: "Direct deposit (optional)", status: facts.directDeposit === "completed" ? "done" : "optional", detail: facts.directDeposit === "completed" ? "Submitted." : "Get paid straight to your bank account." });
  steps.push({ key: "app", label: "Schedule app", status: facts.appSignIns > 0 ? "done" : "waiting", detail: facts.appSignIns > 0 ? "You're signed in on the app." : "Install the app and sign in with your PIN." });
  return steps;
}

/** Pay tab: save the rate and send the NY new-hire pay notice that Add employee held back. */
export async function sendNewHirePayNotice(input: { business: Business; employeeId: string; hourlyRate: number; tippedRate: number; actor: string; actorName: string }) {
  const hourlyRate = Number(input.hourlyRate);
  const tippedRate = Math.max(0, Number(input.tippedRate || 0));
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) throw new ValidationError("Enter the hourly rate.");
  await getSql()`UPDATE employees SET hourly_rate = ${hourlyRate}, tipped_rate = ${tippedRate}, updated_at = NOW() WHERE id = ${input.employeeId} AND business = ${input.business}`;
  const previous = await getSql()`SELECT 1 FROM employment_forms WHERE business = ${input.business} AND employee_id = ${input.employeeId} AND form_type = 'PAY_NOTICE' LIMIT 1` as unknown as unknown[];
  return assignRateChange({
    business: input.business,
    employeeId: input.employeeId,
    effectiveDate: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    hourlyRate,
    tippedRate,
    actor: input.actor,
    employerSignature: input.actorName,
    noticeKind: previous.length ? "rate-change" : "new-hire",
  });
}
