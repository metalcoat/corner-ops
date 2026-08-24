from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[1]
def read(p): return (ROOT/p).read_text()
def write(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
    t=read(p); c=t.count(o)
    if c!=1: raise RuntimeError(f'{p}: expected one exact match, got {c}: {o[:120]!r}')
    write(p,t.replace(o,n,1))
def sub(p,pat,n):
    t=read(p); out,c=re.subn(pat,lambda _m:n,t,count=1,flags=re.S)
    if c!=1: raise RuntimeError(f'{p}: expected one regex match, got {c}: {pat[:120]}')
    write(p,out)

p='src/lib/business-schedule-publication.ts'
# External delivery leaves the publish request path. SMS stays dormant until a provider is configured.
rep(p,'import { deliverSms, type SmsRecipient } from "@/lib/sms-notifications";\n','import type { SmsRecipient } from "@/lib/sms-notifications";\n')

# Queue snapshot fields are calculated before the publication row is reserved.
anchor='''  const idempotencyKey = schedulePublicationIdempotencyKey({
    business: input.business,
    weekStart: input.weekStart,
    previousPublicationId: priorPublication?.id || null,
    stateHash,
    mode,
  });
  const publicationId = crypto.randomUUID();
'''
insert='''  const idempotencyKey = schedulePublicationIdempotencyKey({
    business: input.business,
    weekStart: input.weekStart,
    previousPublicationId: priorPublication?.id || null,
    stateHash,
    mode,
  });
  const publicationId = crypto.randomUUID();
  const emailConfigured = Boolean(emailConfiguration());
  const emailMissingCount = contacts.filter((employee) => !clean(employee.email, 255)).length;
  const emailContacts = contacts.filter((employee) => clean(employee.email, 255));
  const emailSubject = `${input.business} schedule ${scheduleVerb}: ${dateLabel(input.weekStart)}–${dateLabel(weekEnd)}`;
  const emailBody = (employee: EmployeeContact) => {
    const employeeShifts = shifts.filter((shift) => shift.employee_id === employee.id);
    const schedule = employeeShifts.length
      ? employeeShifts.map((shift) => `- ${shiftLabel(shift)}`).join("\\n")
      : "- You are not currently scheduled for this week.";
    return [
      `Hi ${clean(employee.name, 120).split(/\\s+/)[0] || "there"},`,
      "",
      `Your ${input.business} schedule for ${rangeLabel} was ${scheduleVerb}.`,
      "",
      "Your current schedule:", schedule,
      hubUrl ? `\\nOpen the ${input.business} Employee Portal: ${hubUrl}` : "",
      accessInstruction, "", "This email was sent by Corner Ops.",
    ].filter(Boolean).join("\\n");
  };
'''
rep(p,anchor,insert)

rep(p,'''      ${publicationId}, ${input.business}, ${input.weekStart}, ${weekEnd}, ${input.actor}, ${shifts.length},
      ${contacts.length}, 0, 0, 0, FALSE, 0, 0, 0, FALSE,
      ${JSON.stringify(baseDetails)}::jsonb, ${idempotencyKey}, 'Pending'
''','''      ${publicationId}, ${input.business}, ${input.weekStart}, ${weekEnd}, ${input.actor}, ${shifts.length},
      ${contacts.length}, 0, ${emailMissingCount}, 0, ${emailConfigured}, 0, 0, 0, FALSE,
      ${JSON.stringify(baseDetails)}::jsonb, ${idempotencyKey}, 'Pending'
''')

# Add immutable email jobs to the same DB transaction as shift status and in-app messages.
rep(p,'''  const messageQueries = contacts.map((employee) => sql`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, ${employee.id}, 'Direct',
      ${`Your ${input.business} schedule was ${scheduleVerb} for ${rangeLabel}.${hubUrl ? ` Review it in the Employee Portal: ${hubUrl}` : " Review it in the Employee Hub."}`}
    )
  `);

  try {
''','''  const messageQueries = contacts.map((employee) => sql`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, ${employee.id}, 'Direct',
      ${`Your ${input.business} schedule was ${scheduleVerb} for ${rangeLabel}.${hubUrl ? ` Review it in the Employee Portal: ${hubUrl}` : " Review it in the Employee Hub."}`}
    )
  `);
  const emailJobQueries = emailContacts.map((employee) => sql`
    INSERT INTO schedule_publication_deliveries (
      id, publication_id, employee_id, channel, destination, subject, body, idempotency_key
    ) VALUES (
      ${crypto.randomUUID()}, ${publicationId}, ${employee.id}, 'Email', ${clean(employee.email, 255)},
      ${emailSubject}, ${emailBody(employee)}, ${`schedule/${publicationId}/${employee.id}/email`}
    )
    ON CONFLICT (publication_id, employee_id, channel) DO NOTHING
  `);

  try {
''')
rep(p,'''      ...messageQueries,
      sql`UPDATE schedule_publications SET delivery_status = 'Sending' WHERE id = ${publicationId}`,
''','''      ...messageQueries,
      ...emailJobQueries,
      sql`UPDATE schedule_publications SET delivery_status = 'Queued' WHERE id = ${publicationId}`,
''')

# Replace provider sends/finalization with a queue-shaped response. Cron/after worker owns delivery state.
pattern=r'''  const email = await deliverEmails\(\{.*?\n  return \{\n    publicationId,.*?\n  \};\n\}'''
replacement='''  return {
    publicationId,
    weekStart: input.weekStart,
    weekEnd,
    publishedShifts: shifts.length,
    activeEmployees: allContacts.length,
    affectedEmployees: contacts.length,
    affectedEmployeeIds: contacts.map((employee) => employee.id),
    openShifts: openShifts.length,
    email: {
      configured: emailConfigured,
      sent: 0,
      failed: 0,
      missingEmail: emailMissingCount,
      queued: emailContacts.length,
    },
    sms: {
      configured: false,
      sent: 0,
      failed: 0,
      missingPhone: 0,
      notOptedIn: contacts.filter((employee) => !employee.smsOptIn).length,
      skipped: contacts.length,
    },
    hubUrl,
    mode,
    deliveryStatus: "Queued",
  };
}'''
sub(p,pattern,replacement)

# Kick the durable worker after the HTTP response; the cron remains the recovery path.
route='src/app/api/workforce/route.ts'
rep(route,'import { canAccessBusiness, getSession } from "@/lib/auth";\n','import { after } from "next/server";\nimport { canAccessBusiness, getSession } from "@/lib/auth";\n')
rep(route,'import { publishValidatedScheduleWeek } from "@/lib/schedule-publish-validation";\n','import { publishValidatedScheduleWeek } from "@/lib/schedule-publish-validation";\nimport { processSchedulePublicationDeliveries } from "@/lib/schedule-publication-delivery";\n')
old='''        return Response.json(await publishValidatedScheduleWeek({
          business,
          weekStart: String(body.weekStart || ""),
          actor: session.displayName,
        }));'''
new='''        const result = await publishValidatedScheduleWeek({
          business,
          weekStart: String(body.weekStart || ""),
          actor: session.displayName,
        });
        if (result.publicationId) {
          after(() => processSchedulePublicationDeliveries({ publicationId: String(result.publicationId), limit: 30 }).catch((error) => {
            console.error("[schedule-delivery] post-response worker failed", error);
          }));
        }
        return Response.json(result);'''
rep(route,old,new)

# UI names queued mail distinctly instead of pretending it has already been sent.
page='src/app/ops/workforce/page.tsx'
rep(page,'const email = payload?.email as { configured?: boolean; sent?: number; failed?: number; missingEmail?: number } | undefined;','const email = payload?.email as { configured?: boolean; sent?: number; failed?: number; missingEmail?: number; queued?: number } | undefined;')
rep(page,'email ? `Email ${email.configured === false ? "not configured" : `${email.sent || 0} sent, ${email.failed || 0} failed, ${email.missingEmail || 0} missing`}` : "",','email ? `Email ${email.queued ? `${email.queued} queued` : email.configured === false ? "not configured" : `${email.sent || 0} sent, ${email.failed || 0} failed, ${email.missingEmail || 0} missing`}` : "",')

print('Stage 6 durable schedule delivery transformations applied')
