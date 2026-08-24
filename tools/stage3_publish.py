from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path): return (ROOT / path).read_text()
def write(path, text): (ROOT / path).write_text(text)
def rep(path, old, new):
    text = read(path); count = text.count(old)
    if count != 1: raise RuntimeError(f"{path}: expected 1 match, got {count}: {old[:100]!r}")
    write(path, text.replace(old, new, 1))
def sub(path, pattern, replacement):
    text = read(path); out, count = re.subn(pattern, lambda _m: replacement, text, count=1, flags=re.S)
    if count != 1: raise RuntimeError(f"{path}: expected 1 regex match, got {count}: {pattern[:100]}")
    write(path, out)

# One authoritative owner UI, no global fetch/confirm monkey-patching.
rep(
    'src/app/ops/layout.tsx',
    'import SchedulePublishConfirmFix from "./schedule-publish-confirm-fix";\n',
    '',
)
rep(
    'src/app/ops/layout.tsx',
    '  return <>\n    <SchedulePublishConfirmFix />\n    {children}\n  </>;\n',
    '  return <>{children}</>;\n',
)
for dead in [
    'src/app/ops/schedule-publish-confirm-fix.tsx',
    'src/app/api/workforce/week-publish/route.ts',
    'src/app/api/workforce/week-publish-v2/route.ts',
]:
    target = ROOT / dead
    if target.exists(): target.unlink()

rep(
    'src/app/ops/workforce/schedule-board.tsx',
    '    if (!window.confirm(`${actionLabel} for ${business}? This will notify all active employees.`)) return;\n',
    '    if (!window.confirm(`${actionLabel} for ${business}? Only employees whose schedule changed will be notified; an explicit resend notifies currently assigned employees again.`)) return;\n',
)

# Parse the canonical API response so delivery failures are visible instead of hidden in JSONB.
rep(
    'src/app/ops/workforce/page.tsx',
    '''      if (!response.ok) throw new Error(await responseMessage(response));
      if (businessRef.current === actionBusiness) {
        await load(actionBusiness);
        if (businessRef.current === actionBusiness) setNotice(success);
      }
''',
    '''      const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (!response.ok) throw new Error(String(payload?.error || `Request failed (${response.status}).`));
      if (businessRef.current === actionBusiness) {
        await load(actionBusiness);
        if (businessRef.current === actionBusiness) {
          const email = payload?.email as { configured?: boolean; sent?: number; failed?: number; missingEmail?: number } | undefined;
          const sms = payload?.sms as { configured?: boolean; sent?: number; failed?: number; missingPhone?: number; notOptedIn?: number } | undefined;
          const duplicate = Boolean(payload?.duplicate);
          const delivery = email || sms
            ? [
                email ? `Email ${email.configured === false ? "not configured" : `${email.sent || 0} sent, ${email.failed || 0} failed, ${email.missingEmail || 0} missing`}` : "",
                sms ? `SMS ${sms.configured === false ? "not configured" : `${sms.sent || 0} sent, ${sms.failed || 0} failed, ${sms.missingPhone || 0} missing, ${sms.notOptedIn || 0} opted out`}` : "",
              ].filter(Boolean).join(" · ")
            : "";
          setNotice(`${duplicate ? "Schedule publish already processed." : success}${delivery ? ` ${delivery}.` : ""}`);
        }
      }
      return payload;
''',
)

# Publication row metadata includes idempotency and delivery state.
rep(
    'src/lib/business-schedule-publication.ts',
    'import { Resend } from "resend";\n',
    'import { Resend } from "resend";\nimport { schedulePublicationIdempotencyKey, scheduleStateHash } from "@/lib/schedule-publication-key";\n',
)
sub(
    'src/lib/business-schedule-publication.ts',
    r'type PublicationRow = \{.*?\n\};',
    '''type PublicationRow = {
  id: string;
  details: unknown;
  published_at: string;
  delivery_status: string;
  email_sent_count: number;
  email_missing_count: number;
  email_failed_count: number;
  email_configured: boolean;
  sms_sent_count: number;
  sms_missing_count: number;
  sms_failed_count: number;
  sms_configured: boolean;
};''',
)
sub(
    'src/lib/business-schedule-publication.ts',
    r'export async function publishBusinessScheduleWeek\(input: \{.*?\n\}\s*$',
    r'''export async function publishBusinessScheduleWeek(input: {
  business: Business;
  weekStart: string;
  actor: string;
}) {
  await ensureStaffNotificationSchema();
  const weekEnd = addDays(input.weekStart, 6);
  const sql = getSql();

  const shifts = await sql`
    SELECT s.id, s.employee_id, e.name AS employee_name, s.position,
      s.starts_at, s.ends_at, s.meal_break_start, s.meal_break_minutes,
      s.extra_meal_break_start, s.extra_meal_break_minutes, s.notes, s.status
    FROM schedule_shifts s
    LEFT JOIN employees e ON e.id = s.employee_id
    WHERE s.business = ${input.business}
      AND s.starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
      AND s.starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
      AND s.status <> 'Cancelled'
    ORDER BY s.starts_at, e.name
  ` as unknown as ScheduleShiftRow[];
  if (!shifts.length) throw new Error("There are no shifts to publish for this week.");

  const draftRows = shifts.filter((shift) => shift.status === "Draft");
  const priorPublications = await sql`
    SELECT id, details, published_at, delivery_status,
      email_sent_count, email_missing_count, email_failed_count, email_configured,
      sms_sent_count, sms_missing_count, sms_failed_count, sms_configured
    FROM schedule_publications
    WHERE business = ${input.business} AND week_start = ${input.weekStart}
    ORDER BY published_at DESC
    LIMIT 1
  ` as unknown as PublicationRow[];
  const priorPublication = priorPublications[0] || null;
  const isResend = Boolean(priorPublication) && draftRows.length === 0;
  const mode: "initial" | "changes" | "resend" = !priorPublication ? "initial" : isResend ? "resend" : "changes";
  const scheduleVerb = mode === "initial" ? "published" : mode === "resend" ? "resent" : "updated";

  const currentSchedules = employeeScheduleSignatures(shifts);
  const previousSchedules = storedEmployeeSchedules(priorPublication?.details);
  const assignedEmployeeIds = new Set(shifts.flatMap((shift) => shift.employee_id ? [shift.employee_id] : []));
  const draftEmployeeIds = new Set(draftRows.flatMap((shift) => shift.employee_id ? [shift.employee_id] : []));
  const affectedEmployeeIds = new Set<string>();
  if (!priorPublication || isResend) {
    for (const employeeId of assignedEmployeeIds) affectedEmployeeIds.add(employeeId);
  } else if (Object.keys(previousSchedules).length) {
    const employeeIds = new Set([...Object.keys(previousSchedules), ...Object.keys(currentSchedules)]);
    for (const employeeId of employeeIds) {
      if ((previousSchedules[employeeId] || "") !== (currentSchedules[employeeId] || "")) affectedEmployeeIds.add(employeeId);
    }
  } else {
    for (const employeeId of draftEmployeeIds) affectedEmployeeIds.add(employeeId);
  }

  const allContacts = await activeContacts(input.business);
  const contacts = allContacts.filter((employee) => affectedEmployeeIds.has(employee.id));
  const openShifts = shifts.filter((shift) => !shift.employee_id);
  const rangeLabel = `${dateLabel(input.weekStart)} through ${dateLabel(weekEnd)}`;
  const hubUrl = employeeHubUrl(input.business);
  const accessInstruction = pinInstruction(input.business);
  const stateHash = scheduleStateHash(shifts);
  const priorDetails = publicationDetails(priorPublication?.details);
  const priorStateHash = String(priorDetails.scheduleHash || "");
  const priorAgeMs = priorPublication ? Date.now() - new Date(priorPublication.published_at).getTime() : Number.POSITIVE_INFINITY;

  if (isResend && priorPublication && priorStateHash === stateHash && priorAgeMs >= 0 && priorAgeMs < 120_000) {
    return {
      publicationId: priorPublication.id,
      duplicate: true,
      weekStart: input.weekStart,
      weekEnd,
      publishedShifts: shifts.length,
      activeEmployees: allContacts.length,
      affectedEmployees: contacts.length,
      openShifts: openShifts.length,
      mode,
      deliveryStatus: priorPublication.delivery_status,
      email: {
        configured: priorPublication.email_configured,
        sent: Number(priorPublication.email_sent_count || 0),
        failed: Number(priorPublication.email_failed_count || 0),
        missingEmail: Number(priorPublication.email_missing_count || 0),
      },
      sms: {
        configured: priorPublication.sms_configured,
        sent: Number(priorPublication.sms_sent_count || 0),
        failed: Number(priorPublication.sms_failed_count || 0),
        missingPhone: Number(priorPublication.sms_missing_count || 0),
        notOptedIn: 0,
      },
    };
  }

  const idempotencyKey = schedulePublicationIdempotencyKey({
    business: input.business,
    weekStart: input.weekStart,
    previousPublicationId: priorPublication?.id || null,
    stateHash,
    mode,
  });
  const publicationId = crypto.randomUUID();
  const baseDetails = {
    scheduleHash: stateHash,
    employeeSchedules: currentSchedules,
    affectedEmployeeIds: Array.from(affectedEmployeeIds),
    notificationRecipientIds: contacts.map((employee) => employee.id),
    openShiftCount: openShifts.length,
    mode,
    hubUrl,
    pinInstruction: accessInstruction,
  };

  const reserved = await sql`
    INSERT INTO schedule_publications (
      id, business, week_start, week_end, published_by, shift_count,
      active_employee_count, email_sent_count, email_missing_count,
      email_failed_count, email_configured, sms_sent_count, sms_missing_count,
      sms_failed_count, sms_configured, details, idempotency_key, delivery_status
    ) VALUES (
      ${publicationId}, ${input.business}, ${input.weekStart}, ${weekEnd}, ${input.actor}, ${shifts.length},
      ${contacts.length}, 0, 0, 0, FALSE, 0, 0, 0, FALSE,
      ${JSON.stringify(baseDetails)}::jsonb, ${idempotencyKey}, 'Pending'
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  ` as unknown as Array<{ id: string }>;

  if (!reserved[0]) {
    const existing = await sql`
      SELECT id, delivery_status, email_sent_count, email_missing_count, email_failed_count, email_configured,
        sms_sent_count, sms_missing_count, sms_failed_count, sms_configured
      FROM schedule_publications WHERE idempotency_key = ${idempotencyKey} LIMIT 1
    ` as unknown as PublicationRow[];
    const row = existing[0];
    return {
      publicationId: row?.id || null,
      duplicate: true,
      weekStart: input.weekStart,
      weekEnd,
      publishedShifts: shifts.length,
      activeEmployees: allContacts.length,
      affectedEmployees: contacts.length,
      openShifts: openShifts.length,
      mode,
      deliveryStatus: row?.delivery_status || "Pending",
      email: { configured: Boolean(row?.email_configured), sent: Number(row?.email_sent_count || 0), failed: Number(row?.email_failed_count || 0), missingEmail: Number(row?.email_missing_count || 0) },
      sms: { configured: Boolean(row?.sms_configured), sent: Number(row?.sms_sent_count || 0), failed: Number(row?.sms_failed_count || 0), missingPhone: Number(row?.sms_missing_count || 0), notOptedIn: 0 },
    };
  }

  const messageQueries = contacts.map((employee) => sql`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, ${employee.id}, 'Direct',
      ${`Your ${input.business} schedule was ${scheduleVerb} for ${rangeLabel}.${hubUrl ? ` Review it in the Employee Portal: ${hubUrl}` : " Review it in the Employee Hub."}`}
    )
  `);

  try {
    await sql.transaction([
      sql`
        UPDATE schedule_shifts SET
          status = CASE WHEN employee_id IS NULL THEN 'Open' ELSE 'Published' END,
          published_at = NOW(), updated_at = NOW()
        WHERE business = ${input.business}
          AND starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
          AND starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
          AND status <> 'Cancelled'
      `,
      ...messageQueries,
      sql`UPDATE schedule_publications SET delivery_status = 'Sending' WHERE id = ${publicationId}`,
    ]);
  } catch (error) {
    await sql`
      UPDATE schedule_publications SET delivery_status = 'Failed',
        details = details || ${JSON.stringify({ transactionError: error instanceof Error ? error.message : String(error) })}::jsonb,
        delivery_completed_at = NOW()
      WHERE id = ${publicationId}
    `;
    throw error;
  }

  const email = await deliverEmails({
    recipients: contacts,
    subject: `${input.business} schedule ${scheduleVerb}: ${dateLabel(input.weekStart)}–${dateLabel(weekEnd)}`,
    text: (employee) => {
      const employeeShifts = shifts.filter((shift) => shift.employee_id === employee.id);
      const schedule = employeeShifts.length
        ? employeeShifts.map((shift) => `- ${shiftLabel(shift)}`).join("\n")
        : "- You are not currently scheduled for this week.";
      return [
        `Hi ${clean(employee.name, 120).split(/\s+/)[0] || "there"},`,
        "",
        `Your ${input.business} schedule for ${rangeLabel} was ${scheduleVerb}.`,
        "",
        "Your current schedule:",
        schedule,
        hubUrl ? `\nOpen the ${input.business} Employee Portal: ${hubUrl}` : "",
        accessInstruction,
        "",
        "This email was sent by Corner Ops.",
      ].filter(Boolean).join("\n");
    },
  });
  const sms = await deliverSms({
    recipients: contacts,
    text: (employee) => {
      const employeeShifts = shifts.filter((shift) => shift.employee_id === employee.id);
      const schedule = employeeShifts.length ? employeeShifts.map(compactShiftLabel).join("; ") : "No shifts currently assigned.";
      return [
        `${clean(employee.name, 120).split(/\s+/)[0] || "Your"}, your ${input.business} schedule was ${scheduleVerb} for ${dateLabel(input.weekStart)}-${dateLabel(weekEnd)}.`,
        `Shifts: ${schedule}`,
        hubUrl ? `Portal: ${hubUrl}` : "Open Employee Hub to review.",
        accessInstruction,
        "Reply STOP to opt out.",
      ].join(" ");
    },
  });

  const deliveryStatus = email.failed || sms.failed || !email.configured || !sms.configured ? "CompletedWithWarnings" : "Completed";
  const finalDetails = {
    ...baseDetails,
    emailFailures: email.failures,
    emailSkipped: email.skipped,
    smsFailures: sms.failures,
    smsNotOptedIn: sms.notOptedIn,
    smsSkipped: sms.skipped,
  };
  await sql`
    UPDATE schedule_publications SET
      email_sent_count = ${email.sent}, email_missing_count = ${email.missingEmail},
      email_failed_count = ${email.failed}, email_configured = ${email.configured},
      sms_sent_count = ${sms.sent}, sms_missing_count = ${sms.missingPhone},
      sms_failed_count = ${sms.failed}, sms_configured = ${sms.configured},
      details = ${JSON.stringify(finalDetails)}::jsonb,
      delivery_status = ${deliveryStatus}, delivery_completed_at = NOW()
    WHERE id = ${publicationId}
  `;

  return {
    publicationId,
    weekStart: input.weekStart,
    weekEnd,
    publishedShifts: shifts.length,
    activeEmployees: allContacts.length,
    affectedEmployees: contacts.length,
    affectedEmployeeIds: contacts.map((employee) => employee.id),
    openShifts: openShifts.length,
    email,
    sms,
    hubUrl,
    mode,
    deliveryStatus,
  };
}
''',
)

print('Stage 3 publish transformations applied')
