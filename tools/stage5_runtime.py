from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path): return (ROOT / path).read_text()
def write(path, text): (ROOT / path).write_text(text)
def rep(path, old, new):
    text = read(path); count = text.count(old)
    if count != 1: raise RuntimeError(f"{path}: expected 1 match, got {count}: {old[:100]!r}")
    write(path, text.replace(old, new, 1))

# CO-054: 3CX naive timestamps are UTC at ingestion; keep NY conversion only for report date boundaries.
rep('src/lib/three-cx-cdr.ts', 'import { ensureSchema, getSql } from "@/lib/db";\n', 'import { ensureSchema, getSql } from "@/lib/db";\nimport { parseThreeCxTimestamp } from "@/lib/three-cx-time";\n')
old = '''function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = clean(value, 100);
  if (!text || /^0{4}[-/]0{2}[-/]0{2}/.test(text)) return null;
  const local = text.match(/^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?/);
  if (local && !/[zZ]|[+-]\\d{2}:?\\d{2}$/.test(text)) {
    return localPartsToUtc(Number(local[1]), Number(local[2]), Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6] || 0));
  }
  const direct = new Date(text);
  return Number.isNaN(direct.getTime()) ? null : direct;
}
'''
rep('src/lib/three-cx-cdr.ts', old, '''function parseDate(value: unknown): Date | null {
  return parseThreeCxTimestamp(value);
}
''')
rep('src/app/api/deli-board/route.ts', 'import { correctThreeCxCallReport } from "@/lib/three-cx-time-correction";\n', '')
rep('src/app/api/deli-board/route.ts', '        const report = correctThreeCxCallReport(await threeCxDeliCallReport(today, tomorrowDateKey()));', '        const report = await threeCxDeliCallReport(today, tomorrowDateKey());')

# CO-064: handbook acknowledgments must match the actual content hash.
rep('src/lib/employee-handbook.ts', '          UNIQUE (employee_id, handbook_version)\n', '')
rep('src/lib/employee-handbook.ts', '      await getSql()`CREATE INDEX IF NOT EXISTS employee_handbook_ack_business_idx ON employee_handbook_acknowledgments (business, handbook_version, acknowledged_at DESC)`;', '      await getSql()`CREATE UNIQUE INDEX IF NOT EXISTS employee_handbook_ack_employee_hash_unique ON employee_handbook_acknowledgments (employee_id, handbook_version, content_hash)`;\n      await getSql()`CREATE INDEX IF NOT EXISTS employee_handbook_ack_business_idx ON employee_handbook_acknowledgments (business, handbook_version, content_hash, acknowledged_at DESC)`;')
rep('src/lib/employee-handbook.ts', '  await ensureEmployeeHandbookSchema();\n  const rows = await getSql()`\n    SELECT id, employee_id, employee_name, business, handbook_version, content_hash, signature_name, acknowledged_at\n    FROM employee_handbook_acknowledgments\n    WHERE employee_id = ${employeeId} AND business = ${business} AND handbook_version = ${CORNER_DELI_HANDBOOK_VERSION}\n', '  await ensureEmployeeHandbookSchema();\n  const handbook = getCornerDeliHandbook();\n  const rows = await getSql()`\n    SELECT id, employee_id, employee_name, business, handbook_version, content_hash, signature_name, acknowledged_at\n    FROM employee_handbook_acknowledgments\n    WHERE employee_id = ${employeeId} AND business = ${business}\n      AND handbook_version = ${handbook.version} AND content_hash = ${handbook.contentHash}\n')
rep('src/lib/employee-handbook.ts', '  await ensureEmployeeHandbookSchema();\n  const rows = await getSql()`\n    SELECT\n      e.id AS employee_id,', '  await ensureEmployeeHandbookSchema();\n  const handbook = getCornerDeliHandbook();\n  const rows = await getSql()`\n    SELECT\n      e.id AS employee_id,')
rep('src/lib/employee-handbook.ts', '     AND a.handbook_version = ${CORNER_DELI_HANDBOOK_VERSION}\n', '     AND a.handbook_version = ${handbook.version}\n     AND a.content_hash = ${handbook.contentHash}\n')
rep('src/lib/employee-handbook.ts', '    handbookVersion: CORNER_DELI_HANDBOOK_VERSION,\n', '    handbookVersion: handbook.version,\n')

# CO-065: conditional I-9 completeness before accepting signatures.
rep('src/app/api/employee/forms/route.ts', 'import { getEmployeeSession } from "@/lib/employee-auth";\n', 'import { getEmployeeSession } from "@/lib/employee-auth";\nimport { employeeI9ValidationErrors } from "@/lib/i9-validation";\n')
rep('src/app/api/employee/forms/route.ts', '    if (payload.preparerTranslator === "used") {\n      throw new Error("A preparer or translator requires Form I-9 Supplement A. Complete that supplement with management before signing electronically.");\n    }\n', '    if (payload.preparerTranslator === "used") {\n      throw new Error("A preparer or translator requires Form I-9 Supplement A. Complete that supplement with management before signing electronically.");\n    }\n    const i9Errors = employeeI9ValidationErrors(payload);\n    if (i9Errors.length) throw new Error(i9Errors[0]);\n')
rep('src/app/api/employment-forms/route.ts', 'import { redactEmploymentSensitiveData } from "@/lib/sensitive-redaction";\n', 'import { redactEmploymentSensitiveData } from "@/lib/sensitive-redaction";\nimport { employerI9ValidationErrors } from "@/lib/i9-validation";\n')
old = '''    if (action === "complete-i9") {
      const metadata = clientMetadata(request);
      const form = await completeEmployerI9({
        id: String(body.id || ""),
        business,
        actor: session.email,
        signatureName: String(body.signatureName || ""),
        payload: typeof body.payload === "object" && body.payload ? body.payload as Record<string, unknown> : {},
        ...metadata,
      });
      return NextResponse.json({ form });
    }
'''
new = '''    if (action === "complete-i9") {
      const metadata = clientMetadata(request);
      const payload = typeof body.payload === "object" && body.payload ? body.payload as Record<string, unknown> : {};
      const i9Errors = employerI9ValidationErrors(payload);
      if (i9Errors.length) throw new Error(i9Errors[0]);
      const form = await completeEmployerI9({
        id: String(body.id || ""),
        business,
        actor: session.email,
        signatureName: String(body.signatureName || ""),
        payload,
        ...metadata,
      });
      return NextResponse.json({ form });
    }
'''
rep('src/app/api/employment-forms/route.ts', old, new)

# CO-024: scope owner push subscriptions to their active business access and use bounded delivery concurrency.
rep('src/lib/push-notifications.ts', 'const MAX_PAYLOAD_BYTES = 3000;\n', 'const MAX_PAYLOAD_BYTES = 3000;\nconst PUSH_CONCURRENCY = 6;\n')
old = '''async function deliver(subscriptions: StoredSubscription[], message: PushMessage) {
  await ensurePushSchema();
  let delivered = 0;
  let failed = 0;
  for (const subscription of subscriptions) {
    let status: "Delivered" | "Failed" | "Expired" = "Delivered";
    let responseStatus: number | null = null;
    let errorText = "";
    try {
      await sendToSubscription(subscription, message);
      delivered += 1;
      await getSql()`UPDATE push_subscriptions SET last_used_at = NOW(), failure_count = 0, last_error = '', updated_at = NOW() WHERE id = ${subscription.id}`;
    } catch (error) {
      failed += 1;
      responseStatus = Number((error as { status?: number }).status || 0) || null;
      errorText = clean(error instanceof Error ? error.message : error, 500);
      status = responseStatus === 404 || responseStatus === 410 ? "Expired" : "Failed";
      await getSql()`
        UPDATE push_subscriptions SET
          active = CASE WHEN ${status} = 'Expired' THEN FALSE ELSE active END,
          failure_count = failure_count + 1,
          last_error = ${errorText}, updated_at = NOW()
        WHERE id = ${subscription.id}
      `;
    }
    await getSql()`
      INSERT INTO push_delivery_log (id, subscription_id, category, title, destination_url, status, response_status, error)
      VALUES (${crypto.randomUUID()}, ${subscription.id}, ${clean(message.category || "message", 60)}, ${clean(message.title, 200)}, ${clean(message.url, 1000)}, ${status}, ${responseStatus}, ${errorText})
    `;
  }
  return { attempted: subscriptions.length, delivered, failed };
}

async function ownerSubscriptions(): Promise<StoredSubscription[]> {
  await ensurePushSchema();
  return await getSql()`
    SELECT id, endpoint, p256dh, auth FROM push_subscriptions
    WHERE audience_type = 'owner' AND active = TRUE
    ORDER BY updated_at DESC
  ` as unknown as StoredSubscription[];
}
'''
new = '''async function deliver(subscriptions: StoredSubscription[], message: PushMessage) {
  await ensurePushSchema();
  let delivered = 0;
  let failed = 0;
  for (let index = 0; index < subscriptions.length; index += PUSH_CONCURRENCY) {
    await Promise.all(subscriptions.slice(index, index + PUSH_CONCURRENCY).map(async (subscription) => {
      let status: "Delivered" | "Failed" | "Expired" = "Delivered";
      let responseStatus: number | null = null;
      let errorText = "";
      try {
        await sendToSubscription(subscription, message);
        delivered += 1;
        await getSql()`UPDATE push_subscriptions SET last_used_at = NOW(), failure_count = 0, last_error = '', updated_at = NOW() WHERE id = ${subscription.id}`;
      } catch (error) {
        failed += 1;
        responseStatus = Number((error as { status?: number }).status || 0) || null;
        errorText = clean(error instanceof Error ? error.message : error, 500);
        status = responseStatus === 404 || responseStatus === 410 ? "Expired" : "Failed";
        await getSql()`
          UPDATE push_subscriptions SET
            active = CASE WHEN ${status} = 'Expired' THEN FALSE ELSE active END,
            failure_count = failure_count + 1,
            last_error = ${errorText}, updated_at = NOW()
          WHERE id = ${subscription.id}
        `;
      }
      await getSql()`
        INSERT INTO push_delivery_log (id, subscription_id, category, title, destination_url, status, response_status, error)
        VALUES (${crypto.randomUUID()}, ${subscription.id}, ${clean(message.category || "message", 60)}, ${clean(message.title, 200)}, ${clean(message.url, 1000)}, ${status}, ${responseStatus}, ${errorText})
      `;
    }));
  }
  return { attempted: subscriptions.length, delivered, failed };
}

async function ownerSubscriptions(business: Business): Promise<StoredSubscription[]> {
  await ensurePushSchema();
  return await getSql()`
    SELECT p.id, p.endpoint, p.p256dh, p.auth
    FROM push_subscriptions p
    JOIN app_users u ON LOWER(u.email) = LOWER(p.owner_email) AND u.active = TRUE
    WHERE p.audience_type = 'owner' AND p.active = TRUE
      AND ${business} = ANY(u.businesses)
    ORDER BY p.updated_at DESC
  ` as unknown as StoredSubscription[];
}
'''
rep('src/lib/push-notifications.ts', old, new)
rep('src/lib/push-notifications.ts', '    ownerSubscriptions(),\n', '    ownerSubscriptions(input.business),\n')

# CO-079: validate every Rezku download redirect, not only the initial URL.
rep('src/lib/rezku-workbook-download.ts', 'const REZKU_FILE_HOST = "files.reporting.rezkupos.com";\n', 'import { fetchTrustedRezkuWorkbook, trustedRezkuWorkbookUrl } from "@/lib/rezku-trusted-fetch";\n')
pattern = re.compile(r'function safeRezkuUrl\(rawUrl: string\): string \{.*?\n\}\n\n', re.S)
text = read('src/lib/rezku-workbook-download.ts'); text, count = pattern.subn('', text, count=1)
if count != 1: raise RuntimeError('rezku-workbook-download safeRezkuUrl block not found')
write('src/lib/rezku-workbook-download.ts', text)
rep('src/lib/rezku-workbook-download.ts', '  const response = await fetch(rawUrl, {\n    method: "GET",\n    redirect: "follow",\n', '  const response = await fetchTrustedRezkuWorkbook(rawUrl, {\n    method: "GET",\n')
rep('src/lib/rezku-workbook-download.ts', '  const normalizedUrl = safeRezkuUrl(rawUrl);', '  const normalizedUrl = trustedRezkuWorkbookUrl(rawUrl);')

# Edge proxy uses the same trusted redirect logic and a constant-work bearer comparison.
rep('src/app/api/rezku/download-proxy/route.ts', 'export const runtime = "edge";\n', 'import { fetchTrustedRezkuWorkbook, trustedRezkuWorkbookUrl } from "@/lib/rezku-trusted-fetch";\n\nexport const runtime = "edge";\n')
pattern = re.compile(r'const REZKU_FILE_HOST = .*?\n\n', re.S)
text = read('src/app/api/rezku/download-proxy/route.ts'); text, count = pattern.subn('', text, count=1)
if count != 1: raise RuntimeError('download proxy host constant not found')
write('src/app/api/rezku/download-proxy/route.ts', text)
pattern = re.compile(r'function trustedRawUrl\(value: unknown\): string \{.*?\n\}\n\n', re.S)
text = read('src/app/api/rezku/download-proxy/route.ts'); text, count = pattern.subn('''function safeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const maximum = Math.max(left.length, right.length);
  for (let index = 0; index < maximum; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

''', text, count=1)
if count != 1: raise RuntimeError('download proxy trustedRawUrl block not found')
write('src/app/api/rezku/download-proxy/route.ts', text)
rep('src/app/api/rezku/download-proxy/route.ts', '  if (!secret || authorization !== `Bearer ${secret}`) {', '  if (!secret || !safeEqual(authorization, `Bearer ${secret}`)) {')
rep('src/app/api/rezku/download-proxy/route.ts', '    const rawUrl = trustedRawUrl(body.url);', '    const rawUrl = trustedRezkuWorkbookUrl(String(body.url || ""));')
rep('src/app/api/rezku/download-proxy/route.ts', '    const response = await fetch(rawUrl, {\n      method: "GET",\n      redirect: "follow",\n', '    const response = await fetchTrustedRezkuWorkbook(rawUrl, {\n      method: "GET",\n')

# CO-091: scheduler secret compare timing safe.
rep('src/lib/scheduler.ts', 'import { Resend } from "resend";\n', 'import { timingSafeEqual } from "node:crypto";\nimport { Resend } from "resend";\n')
rep('src/lib/scheduler.ts', 'export async function handleCronRequest(request: Request) {\n', 'function safeBearer(left: string, right: string): boolean {\n  const a = Buffer.from(left);\n  const b = Buffer.from(right);\n  return a.length === b.length && timingSafeEqual(a, b);\n}\n\nexport async function handleCronRequest(request: Request) {\n')
rep('src/lib/scheduler.ts', '  if (request.headers.get("authorization") !== `Bearer ${expected}`) {', '  if (!safeBearer(request.headers.get("authorization") || "", `Bearer ${expected}`)) {')

# CO-086: receipt page warning was guaranteed noise.
rep('src/lib/invoice-ocr.ts', '  if ((analyzeResult.pages?.length || 0) >= (receipt ? 1 : 2)) {\n    warnings.push(`Only the first ${receipt ? "page" : "two pages"} were analyzed to stay within the Azure free-tier document limits.`);\n  }', '  if (!receipt && (analyzeResult.pages?.length || 0) >= 2) {\n    warnings.push("Only the first two pages were analyzed to stay within the Azure free-tier document limits.");\n  }')

# CO-099: network failure means push state is unknown, not unsubscribed.
rep('src/app/pwa-client.tsx', '    if (!response?.ok) {\n      setStatus(null);\n      return;\n    }', '    if (!response) return;\n    if (!response.ok) {\n      setStatus(null);\n      return;\n    }')

# CO-082: email fanout is bounded-concurrent too.
old = '''  let sent = 0;
  const failures: Array<{ employeeId: string; message: string }> = [];
  for (const employee of deliverable) {
    try {
      const result = await configured.resend.emails.send({
        from: configured.from,
        to: clean(employee.email, 255),
        subject: input.subject(employee),
        text: input.text(employee),
      });
      if (result.error) throw new Error(result.error.message);
      sent += 1;
    } catch (error) {
      failures.push({ employeeId: employee.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
'''
new = '''  let sent = 0;
  const failures: Array<{ employeeId: string; message: string }> = [];
  const concurrency = 6;
  for (let index = 0; index < deliverable.length; index += concurrency) {
    await Promise.all(deliverable.slice(index, index + concurrency).map(async (employee) => {
      try {
        const result = await configured.resend.emails.send({
          from: configured.from,
          to: clean(employee.email, 255),
          subject: input.subject(employee),
          text: input.text(employee),
        });
        if (result.error) throw new Error(result.error.message);
        sent += 1;
      } catch (error) {
        failures.push({ employeeId: employee.id, message: error instanceof Error ? error.message : String(error) });
      }
    }));
  }
'''
rep('src/lib/staff-notifications.ts', old, new)

print('Stage 5 runtime transformations applied')
