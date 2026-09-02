from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one match in {path}, found {count}: {old[:160]!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


publication = "src/lib/business-schedule-publication.ts"

replace_once(
    publication,
    "  const publicationId = crypto.randomUUID();",
    "  let publicationId = crypto.randomUUID();",
)

replace_once(
    publication,
    '''  if (!reserved[0]) {
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
''',
    '''  if (!reserved[0]) {
    const existing = await sql`
      SELECT id, details, published_at, delivery_status,
        email_sent_count, email_missing_count, email_failed_count, email_configured,
        sms_sent_count, sms_missing_count, sms_failed_count, sms_configured
      FROM schedule_publications WHERE idempotency_key = ${idempotencyKey} LIMIT 1
    ` as unknown as PublicationRow[];
    const row = existing[0];
    const reservationAgeMs = row?.published_at
      ? Date.now() - new Date(row.published_at).getTime()
      : Number.POSITIVE_INFINITY;
    const resumeStalledPublication = Boolean(
      row?.id
      && draftRows.length > 0
      && (row.delivery_status === "Failed" || reservationAgeMs >= 15_000),
    );

    if (!resumeStalledPublication) {
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

    publicationId = row.id;
    await sql.transaction([
      sql`DELETE FROM schedule_publication_deliveries WHERE publication_id = ${publicationId}`,
      sql`
        UPDATE schedule_publications SET
          published_by = ${input.actor},
          shift_count = ${shifts.length},
          active_employee_count = ${contacts.length},
          email_sent_count = 0,
          email_missing_count = ${emailMissingCount},
          email_failed_count = 0,
          email_configured = ${emailConfigured},
          sms_sent_count = 0,
          sms_missing_count = 0,
          sms_failed_count = 0,
          sms_configured = FALSE,
          details = ${JSON.stringify({
            ...baseDetails,
            recoveredStalledAttempt: true,
            recoveredAt: new Date().toISOString(),
          })}::jsonb,
          delivery_status = 'Pending',
          published_at = NOW()
        WHERE id = ${publicationId}
      `,
    ]);
  }
''',
)

replace_once(
    publication,
    '''  const messageQueries = contacts.map((employee) => sql`
    INSERT INTO employee_messages (
      id, business, sender_name, recipient_employee_id, message_type, body
    ) VALUES (
      ${crypto.randomUUID()}, ${input.business}, ${input.actor}, ${employee.id}, 'Direct',
      ${`Your ${input.business} schedule was ${scheduleVerb} for ${rangeLabel}.${hubUrl ? ` Review it in the Employee Portal: ${hubUrl}` : " Review it in the Employee Hub."}`}
    )
  `);
''',
    '''  const messageQueries = contacts.map((employee) => {
    const messageId = crypto.randomUUID();
    return sql`
      WITH inserted AS (
        INSERT INTO employee_messages (
          id, business, conversation_key, sender_name,
          recipient_employee_id, message_type, body
        ) VALUES (
          ${messageId}::uuid, ${input.business}, ${`owner:${employee.id}`}, ${input.actor},
          ${employee.id}::uuid, 'Conversation',
          ${`Your ${input.business} schedule was ${scheduleVerb} for ${rangeLabel}.${hubUrl ? ` Review it in the Employee Portal: ${hubUrl}` : " Review it in the Employee Hub."}`}
        )
        RETURNING id
      )
      INSERT INTO employee_message_recipients (message_id, employee_id)
      SELECT inserted.id, ${employee.id}::uuid
      FROM inserted
      ON CONFLICT (message_id, employee_id) DO NOTHING
    `;
  });
''',
)

page = "src/app/ops/workforce/page.tsx"
replace_once(
    page,
    '''sms ? `SMS ${sms.configured === false ? "not configured" : `${sms.sent || 0} sent, ${sms.failed || 0} failed, ${sms.missingPhone || 0} missing, ${sms.notOptedIn || 0} opted out`}` : "",''',
    '''sms ? `SMS ${sms.configured === false ? "unavailable; schedule publication is not blocked" : `${sms.sent || 0} sent, ${sms.failed || 0} failed, ${sms.missingPhone || 0} missing, ${sms.notOptedIn || 0} opted out`}` : "",''',
)

Path("tests/schedule-publication-recovery.test.ts").write_text('''import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("schedule publication messages use the threaded message schema", () => {
  const publication = source("src/lib/business-schedule-publication.ts");
  assert.match(publication, /conversation_key/);
  assert.match(publication, /'Conversation'/);
  assert.match(publication, /INSERT INTO employee_message_recipients/);
  assert.match(publication, /owner:\$\{employee\.id\}/);
  assert.doesNotMatch(publication, /recipient_employee_id, message_type, body\n    \) VALUES \([\s\S]*'Direct'/);
});

test("a failed idempotency reservation is resumed while a draft still exists", () => {
  const publication = source("src/lib/business-schedule-publication.ts");
  assert.match(publication, /let publicationId = crypto\.randomUUID\(\)/);
  assert.match(publication, /resumeStalledPublication/);
  assert.match(publication, /draftRows\.length > 0/);
  assert.match(publication, /row\.delivery_status === "Failed"/);
  assert.match(publication, /recoveredStalledAttempt: true/);
});

test("SMS configuration status is explicitly non-blocking in the manager notice", () => {
  const page = source("src/app/ops/workforce/page.tsx");
  assert.match(page, /SMS unavailable; schedule publication is not blocked/);
});
''', encoding="utf-8")
