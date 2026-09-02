import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const productionBuild = process.env.VERCEL_ENV === "production";
const databaseUrl = process.env.DATABASE_URL?.trim();
const outputPath = "public/onboarding-reminder-send-result.json";
const campaign = "corner-deli-new-hires-2026-08-28";
const targetNames = ["Sean", "Mackenzie", "Lillian"];
const requiredTypes = ["PAY_NOTICE", "W4", "IT2104", "I9", "MEAL_POLICY"];
const labels = {
  PAY_NOTICE: "New York pay-rate and payday notice",
  W4: "federal W-4",
  IT2104: "New York IT-2104",
  I9: "I-9 Section 1",
  MEAL_POLICY: "meal-period acknowledgment",
};

function baseUrl() {
  const configured = process.env.APP_URL?.trim() || process.env.EMPLOYEE_APP_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  return vercel ? `https://${vercel.replace(/\/$/, "")}` : "";
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (String(value || "").trim().startsWith("+") && digits.length >= 11) return `+${digits}`;
  throw new Error("Employee phone number is not a valid SMS number.");
}

function employeeFinished(type, status) {
  if (type === "I9") return status === "Employer Review" || status === "Completed";
  return status === "Completed";
}

function telnyxConfiguration() {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const from = process.env.TELNYX_FROM_NUMBER?.trim();
  if (!apiKey || !from) return null;
  return { apiKey, from: normalizePhone(from) };
}

async function sendSms(configuration, to, text) {
  const response = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${configuration.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: configuration.from,
      to,
      text: text.trim().slice(0, 600),
      type: "SMS",
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title || `Telnyx request failed (${response.status}).`;
    throw new Error(detail);
  }
  return {
    messageId: String(payload?.data?.id || ""),
    status: String(payload?.data?.to?.[0]?.status || "accepted"),
  };
}

async function deliveryStatus(configuration, messageId) {
  if (!messageId) return { status: "unknown", errors: [] };
  const response = await fetch(`https://api.telnyx.com/v2/messages/${encodeURIComponent(messageId)}`, {
    headers: { Authorization: `Bearer ${configuration.apiKey}` },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      status: "status-check-failed",
      errors: [payload?.errors?.[0]?.detail || payload?.errors?.[0]?.title || `Telnyx status request failed (${response.status}).`],
    };
  }
  return {
    status: String(payload?.data?.to?.[0]?.status || "unknown"),
    errors: (payload?.data?.errors || []).map((error) => error?.detail || error?.title || error?.code || "Unknown carrier error"),
  };
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (!databaseUrl || !productionBuild) {
  console.log("One-time onboarding reminders skipped outside the production Vercel build.");
  process.exit(0);
}

const sql = neon(databaseUrl);
const configuration = telnyxConfiguration();
const appUrl = baseUrl();
const results = [];

try {
  const rows = await sql`
    SELECT
      e.id,
      e.business,
      e.name,
      e.phone,
      e.sms_opt_in,
      e.created_at,
      latest.form_type,
      latest.status
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT DISTINCT ON (ef.form_type)
        ef.form_type,
        ef.status
      FROM employment_forms ef
      WHERE ef.employee_id = e.id
        AND ef.business = e.business
        AND ef.status <> 'Superseded'
      ORDER BY ef.form_type, ef.assigned_at DESC
    ) latest ON TRUE
    WHERE e.business = 'Corner Deli'
      AND e.active = TRUE
      AND LOWER(BTRIM(e.name)) IN ('sean', 'mackenzie', 'lillian')
    ORDER BY e.created_at DESC, latest.form_type
  `;

  const employees = new Map();
  for (const row of rows) {
    const id = String(row.id);
    let employee = employees.get(id);
    if (!employee) {
      employee = {
        id,
        business: String(row.business),
        name: String(row.name),
        phone: String(row.phone || ""),
        smsOptIn: Boolean(row.sms_opt_in),
        createdAt: new Date(row.created_at).toISOString(),
        forms: {},
      };
      employees.set(id, employee);
    }
    if (row.form_type) employee.forms[String(row.form_type)] = String(row.status || "");
  }

  for (const expectedName of targetNames) {
    const employee = Array.from(employees.values()).find((item) => item.name.toLowerCase() === expectedName.toLowerCase());
    if (!employee) {
      results.push({ name: expectedName, outcome: "not-found" });
      continue;
    }

    const notAssigned = requiredTypes.filter((type) => !employee.forms[type]);
    const incomplete = requiredTypes.filter((type) => employee.forms[type] && !employeeFinished(type, employee.forms[type]));
    if (!incomplete.length && !notAssigned.length) {
      results.push({ name: employee.name, outcome: "already-complete" });
      continue;
    }
    if (notAssigned.length) {
      results.push({ name: employee.name, outcome: "packet-incomplete", notAssigned });
      continue;
    }
    if (!employee.smsOptIn) {
      results.push({ name: employee.name, outcome: "not-opted-in", incomplete });
      continue;
    }
    if (!employee.phone.trim()) {
      results.push({ name: employee.name, outcome: "missing-phone", incomplete });
      continue;
    }
    if (!configuration) {
      results.push({ name: employee.name, outcome: "telnyx-not-configured", incomplete });
      continue;
    }
    if (!appUrl) {
      results.push({ name: employee.name, outcome: "app-url-not-configured", incomplete });
      continue;
    }

    const existingRows = await sql`
      SELECT details, created_at
      FROM audit_events
      WHERE business = 'Corner Deli'
        AND entity_type = 'employee'
        AND entity_id = ${employee.id}
        AND action = 'onboarding-reminder-sms'
        AND details->>'campaign' = ${campaign}
        AND details->>'accepted' = 'true'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const existing = existingRows[0];
    if (existing) {
      const details = typeof existing.details === "string" ? JSON.parse(existing.details) : existing.details || {};
      const checked = await deliveryStatus(configuration, String(details.messageId || ""));
      results.push({
        name: employee.name,
        outcome: "already-sent",
        messageId: String(details.messageId || ""),
        acceptedStatus: String(details.acceptedStatus || "accepted"),
        deliveryStatus: checked.status,
        carrierErrors: checked.errors,
        sentAt: new Date(existing.created_at).toISOString(),
        incomplete,
      });
      continue;
    }

    const formsUrl = `${appUrl}/employee/forms`;
    const text = [
      `Corner Deli: ${employee.name}, please finish your required new-hire forms in Corner Ops: ${incomplete.map((type) => labels[type]).join(", ")}.`,
      `Sign in here: ${formsUrl}`,
      "Questions? Message management in Corner Ops. Do not reply here except STOP to opt out.",
    ].join("\n");

    try {
      const accepted = await sendSms(configuration, normalizePhone(employee.phone), text);
      await sql`
        INSERT INTO audit_events (
          id, business, document_id, entity_type, entity_id, action, actor, details
        ) VALUES (
          ${randomUUID()}, 'Corner Deli', NULL, 'employee', ${employee.id},
          'onboarding-reminder-sms', 'Corner Ops automated reminder',
          ${JSON.stringify({
            campaign,
            accepted: true,
            provider: "telnyx",
            messageId: accepted.messageId,
            acceptedStatus: accepted.status,
            incompleteForms: incomplete,
            sentAt: new Date().toISOString(),
          })}::jsonb
        )
      `;

      let checked = { status: accepted.status, errors: [] };
      const terminal = new Set(["delivered", "delivery_failed", "delivery_unconfirmed"]);
      for (const delay of [3000, 5000, 8000, 12000]) {
        await sleep(delay);
        checked = await deliveryStatus(configuration, accepted.messageId);
        if (terminal.has(checked.status)) break;
      }

      await sql`
        INSERT INTO audit_events (
          id, business, document_id, entity_type, entity_id, action, actor, details
        ) VALUES (
          ${randomUUID()}, 'Corner Deli', NULL, 'employee', ${employee.id},
          'onboarding-reminder-sms-status', 'Corner Ops automated reminder',
          ${JSON.stringify({
            campaign,
            provider: "telnyx",
            messageId: accepted.messageId,
            deliveryStatus: checked.status,
            carrierErrors: checked.errors,
            checkedAt: new Date().toISOString(),
          })}::jsonb
        )
      `;

      results.push({
        name: employee.name,
        outcome: "sent",
        messageId: accepted.messageId,
        acceptedStatus: accepted.status,
        deliveryStatus: checked.status,
        carrierErrors: checked.errors,
        incomplete,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await sql`
        INSERT INTO audit_events (
          id, business, document_id, entity_type, entity_id, action, actor, details
        ) VALUES (
          ${randomUUID()}, 'Corner Deli', NULL, 'employee', ${employee.id},
          'onboarding-reminder-sms-failed', 'Corner Ops automated reminder',
          ${JSON.stringify({ campaign, accepted: false, provider: "telnyx", error: message, incompleteForms: incomplete })}::jsonb
        )
      `;
      results.push({ name: employee.name, outcome: "failed", error: message, incomplete });
    }
  }
} catch (error) {
  results.push({ outcome: "query-error", error: error instanceof Error ? error.message : String(error) });
}

const diagnostic = {
  campaign,
  generatedAt: new Date().toISOString(),
  targetCount: targetNames.length,
  sentOrPreviouslySent: results.filter((item) => item.outcome === "sent" || item.outcome === "already-sent").length,
  delivered: results.filter((item) => item.deliveryStatus === "delivered").length,
  results,
};
writeFileSync(outputPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
console.log(`Onboarding reminder send result: ${JSON.stringify(diagnostic)}.`);
