from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
def read(p): return (ROOT/p).read_text()
def write(p,t): (ROOT/p).write_text(t)
def rep(p,o,n):
    t=read(p); c=t.count(o)
    if c!=1: raise RuntimeError(f'{p}: expected 1 match, got {c}: {o[:120]!r}')
    write(p,t.replace(o,n,1))
def sub(p,pat,n):
    t=read(p); out,c=re.subn(pat,lambda _m:n,t,count=1,flags=re.S)
    if c!=1: raise RuntimeError(f'{p}: expected 1 regex match, got {c}: {pat[:120]}')
    write(p,out)

# CO-038: optimistic concurrency for schedule edits.
rep('src/lib/schedule-actions.ts','import { getSql } from "@/lib/db";\n','import { getSql } from "@/lib/db";\nimport { ConflictError } from "@/lib/http";\n')
rep('src/lib/schedule-actions.ts','  acknowledgePendingTimeOff?: boolean;\n}) {','  acknowledgePendingTimeOff?: boolean;\n  expectedUpdatedAt?: string | null;\n}) {')
old='''  await sql`
    UPDATE schedule_shifts SET
      employee_id = ${employeeId},
      position = ${clean(input.position ?? current.position, 100)},
      starts_at = ${start.toISOString()},
      ends_at = ${end.toISOString()},
      meal_break_start = ${meals.mealBreakStart},
      meal_break_minutes = ${meals.mealBreakMinutes},
      extra_meal_break_start = ${meals.extraMealBreakStart},
      extra_meal_break_minutes = ${meals.extraMealBreakMinutes},
      status = ${status},
      notes = ${clean(input.notes ?? current.notes, 1000)},
      published_at = CASE
        WHEN ${status} = 'Draft' THEN NULL
        WHEN ${status} IN ('Published', 'Open') THEN COALESCE(published_at, NOW())
        ELSE published_at
      END,
      updated_at = NOW()
    WHERE id = ${input.id}
  `;

  return { id: input.id };
'''
new='''  const expectedUpdatedAt = input.expectedUpdatedAt
    ? new Date(input.expectedUpdatedAt).toISOString()
    : null;
  const updated = await sql`
    UPDATE schedule_shifts SET
      employee_id = ${employeeId},
      position = ${clean(input.position ?? current.position, 100)},
      starts_at = ${start.toISOString()},
      ends_at = ${end.toISOString()},
      meal_break_start = ${meals.mealBreakStart},
      meal_break_minutes = ${meals.mealBreakMinutes},
      extra_meal_break_start = ${meals.extraMealBreakStart},
      extra_meal_break_minutes = ${meals.extraMealBreakMinutes},
      status = ${status},
      notes = ${clean(input.notes ?? current.notes, 1000)},
      published_at = CASE
        WHEN ${status} = 'Draft' THEN NULL
        WHEN ${status} IN ('Published', 'Open') THEN COALESCE(published_at, NOW())
        ELSE published_at
      END,
      updated_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business}
      AND (${expectedUpdatedAt}::timestamptz IS NULL OR updated_at = ${expectedUpdatedAt}::timestamptz)
    RETURNING id, updated_at
  ` as unknown as Array<{ id: string; updated_at: string }>;
  if (!updated[0]) {
    throw new ConflictError("This shift changed after you opened it. Reload the schedule and apply your change again.");
  }

  return { id: input.id, updatedAt: String(updated[0].updated_at) };
'''
rep('src/lib/schedule-actions.ts',old,new)
rep('src/lib/workforce.ts','    publishedAt: row.published_at ? String(row.published_at) : null,\n','    publishedAt: row.published_at ? String(row.published_at) : null,\n    updatedAt: row.updated_at ? String(row.updated_at) : null,\n')
rep('src/app/api/workforce/route.ts','import { apiError, unauthorized } from "@/lib/http";\n','import { apiError, ConflictError, unauthorized } from "@/lib/http";\n')
rep('src/app/api/workforce/route.ts','  if (candidate?.code) return apiError(error);\n','  if (candidate?.code || error instanceof ConflictError) return apiError(error);\n')
rep('src/app/api/workforce/route.ts','          acknowledgePendingTimeOff: body.acknowledgePendingTimeOff === true,\n        }));','          acknowledgePendingTimeOff: body.acknowledgePendingTimeOff === true,\n          expectedUpdatedAt: body.expectedUpdatedAt ? String(body.expectedUpdatedAt) : null,\n        }));')
rep('src/app/ops/workforce/schedule-board.tsx','  publishedAt?: string | null;\n};','  publishedAt?: string | null;\n  updatedAt?: string | null;\n};')
rep('src/app/ops/workforce/schedule-board.tsx','      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n    }, editor.shift ?','      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n      expectedUpdatedAt: editor.shift?.updatedAt || null,\n    }, editor.shift ?')
rep('src/app/ops/workforce/schedule-board.tsx','      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n    }, "Shift moved and marked for publishing.");','      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n      expectedUpdatedAt: shift.updatedAt || null,\n    }, "Shift moved and marked for publishing.");')

# CO-053 + remaining CO-054 cleanup: missed-call marker/messages are one atomic statement; timestamps are already correct in storage.
rep('src/lib/three-cx-missed-call-messages.ts','import { correctThreeCxCallReport } from "@/lib/three-cx-time-correction";\n','')
rep('src/lib/three-cx-missed-call-messages.ts','  const report = correctThreeCxCallReport(await threeCxDeliCallReport(\n    localDateKey(addDays(now, -1)),\n    localDateKey(addDays(now, 2)),\n  ));','  const report = await threeCxDeliCallReport(\n    localDateKey(addDays(now, -1)),\n    localDateKey(addDays(now, 2)),\n  );')
old=re.search(r'  for \(const call of recentCalls\) \{.*?\n  \}\n\n  return \{',read('src/lib/three-cx-missed-call-messages.ts'),re.S)
if not old: raise RuntimeError('missed-call loop not found')
new='''  for (const call of recentCalls) {
    const message = [
      `Missed call recorded at ${localTime(call.droppedAt)} from ${formatPhone(call.caller)} after ${call.waitSeconds} seconds.`,
      "Corner Ops is tracking missed calls while you are clocked in.",
      "Please answer incoming calls promptly and return this call if it still needs follow-up.",
    ].join(" ");

    const rows = await getSql()`
      WITH marker AS (
        INSERT INTO three_cx_missed_call_notifications (
          id, history_id, dropped_at, caller, wait_seconds
        ) VALUES (
          ${crypto.randomUUID()}, ${call.historyId}, ${call.droppedAt}, ${call.caller}, ${call.waitSeconds}
        )
        ON CONFLICT (history_id) DO NOTHING
        RETURNING history_id
      ),
      latest_rezku_shift AS (
        SELECT DISTINCT ON (LOWER(BTRIM(employee_name)))
          employee_name, clock_in, clock_out
        FROM rezku_shifts
        WHERE clock_in IS NOT NULL
        ORDER BY LOWER(BTRIM(employee_name)), clock_in DESC
      ),
      clocked_in AS (
        SELECT e.id
        FROM employees e
        JOIN latest_rezku_shift r ON LOWER(BTRIM(r.employee_name)) = LOWER(BTRIM(e.name))
        WHERE e.business = 'Corner Deli' AND e.active = TRUE
          AND r.clock_in <= NOW() AND (r.clock_out IS NULL OR r.clock_out > NOW())
          AND r.clock_in >= NOW() - INTERVAL '18 hours'
      ),
      inserted_messages AS (
        INSERT INTO employee_messages (
          id, business, sender_name, recipient_employee_id, message_type, body
        )
        SELECT gen_random_uuid(), 'Corner Deli', 'Corner Ops Call Monitor',
          employee.id, 'Direct', ${message}
        FROM marker CROSS JOIN clocked_in employee
        RETURNING recipient_employee_id
      ),
      updated AS (
        UPDATE three_cx_missed_call_notifications notification
        SET recipient_count = (SELECT COUNT(*) FROM inserted_messages)
        FROM marker
        WHERE notification.history_id = marker.history_id
        RETURNING notification.history_id
      )
      SELECT
        (SELECT COUNT(*)::INTEGER FROM marker) AS inserted,
        COALESCE((SELECT ARRAY_AGG(recipient_employee_id::text) FROM inserted_messages), ARRAY[]::text[]) AS recipient_ids
    ` as unknown as Array<{ inserted: number; recipient_ids: string[] }>;
    const result = rows[0];
    if (!result?.inserted) continue;
    newMissedCalls += 1;
    const recipientIds = Array.isArray(result.recipient_ids) ? result.recipient_ids : [];
    messagesCreated += recipientIds.length;
    for (const employeeId of recipientIds) recipients.add(employeeId);
  }

  return {'''
text=read('src/lib/three-cx-missed-call-messages.ts')
write('src/lib/three-cx-missed-call-messages.ts',text[:old.start()]+new+text[old.end():])

# CO-070: no literal user identities or startup rewrites of admin choices.
rep('src/lib/users.ts','      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n','      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n      session_version INTEGER NOT NULL DEFAULT 1\n')
start=read('src/lib/users.ts').index('  const ownerEmail = normalizedEmail(process.env.APP_EMAIL || "crfrary@gmail.com");')
end=read('src/lib/users.ts').index('\n}\n\nfunction mapUser',start)
replacement='''  const configuredOwnerEmail = process.env.APP_EMAIL?.trim();
  if (!configuredOwnerEmail) throw new Error("APP_EMAIL is required before user accounts can be initialized.");
  const ownerEmail = normalizedEmail(configuredOwnerEmail);
  await sql`
    INSERT INTO app_users (
      id, email, display_name, role, businesses, legacy_owner, created_by
    ) VALUES (
      ${crypto.randomUUID()}, ${ownerEmail}, 'Owner', 'Owner',
      ARRAY['Corner Deli', 'Tiki']::TEXT[], TRUE, 'System bootstrap'
    )
    ON CONFLICT (email) DO NOTHING
  `;'''
t=read('src/lib/users.ts'); write('src/lib/users.ts',t[:start]+replacement+t[end:])
rep('src/lib/push-notifications.ts','const PUSH_SUBJECT = process.env.PUSH_SUBJECT?.trim() || "mailto:crfrary@gmail.com";','const PUSH_SUBJECT = process.env.PUSH_SUBJECT?.trim() || `mailto:${process.env.APP_EMAIL?.trim() || "admin@invalid.local"}`;')

# CO-093: reject low-entropy placeholder encryption roots while preserving the existing ciphertext/key derivation.
rep('src/lib/employment-forms.ts','import { ensureSchema, getSql } from "@/lib/db";\n','import { ensureSchema, getSql } from "@/lib/db";\nimport { requireStrongSecret } from "@/lib/secret-strength";\n')
rep('src/lib/employment-forms.ts','  const secret = process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY;\n  if (!secret || secret.length < 32) throw new Error("EMPLOYMENT_FORMS_ENCRYPTION_KEY must be configured with at least 32 characters.");\n  return createHash("sha256").update(secret, "utf8").digest();','  const secret = requireStrongSecret(process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY, "EMPLOYMENT_FORMS_ENCRYPTION_KEY");\n  return createHash("sha256").update(secret, "utf8").digest();')
rep('src/lib/direct-deposit.ts','import { ensureSchema, getSql } from "@/lib/db";\n','import { ensureSchema, getSql } from "@/lib/db";\nimport { requireStrongSecret } from "@/lib/secret-strength";\n')
rep('src/lib/direct-deposit.ts','  const secret = process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY;\n  if (!secret || secret.length < 32) throw new Error("EMPLOYMENT_FORMS_ENCRYPTION_KEY must be configured with at least 32 characters.");\n  return createHash("sha256").update(secret, "utf8").digest();','  const secret = requireStrongSecret(process.env.EMPLOYMENT_FORMS_ENCRYPTION_KEY, "EMPLOYMENT_FORMS_ENCRYPTION_KEY");\n  return createHash("sha256").update(secret, "utf8").digest();')

print('Stage 6 core correctness transformations applied')
