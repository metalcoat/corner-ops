import { getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { deliverSms, type SmsRecipient } from "@/lib/sms-notifications";

export const runtime = "nodejs";

const campaign = "corner-deli-team-link-2026-09-28";
const message = "Corner Deli team: Our new team site is https://team.ordercornerdeli.com. Use your existing PIN for Employee Hub, schedules, and messages. Reply STOP to opt out.";

type EmployeeRow = { id: string; name: string; phone: string; sms_opt_in: boolean };

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    if (process.env.VERCEL_ENV !== "production" || url.hostname !== "team.ordercornerdeli.com") {
      return Response.json({ error: "This announcement is available only on the production Corner Deli team site." }, { status: 403 });
    }
    if (request.headers.get("origin") !== url.origin) {
      return Response.json({ error: "Invalid request origin." }, { status: 403 });
    }
    const session = await getSession();
    if (!session) return unauthorized();
    if (session.role !== "Owner" || !session.businesses.includes("Corner Deli")) {
      return Response.json({ error: "Owner access required." }, { status: 403 });
    }

    const sql = getSql();
    await sql`
      CREATE TABLE IF NOT EXISTS team_link_announcement_delivery (
        campaign TEXT NOT NULL,
        employee_id UUID NOT NULL,
        status TEXT NOT NULL,
        message_id TEXT,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (campaign, employee_id)
      )
    `;
    const rows = await sql`
      SELECT id, name, phone, sms_opt_in
      FROM employees
      WHERE business = 'Corner Deli' AND active = TRUE
      ORDER BY name
    ` as unknown as EmployeeRow[];

    let alreadyProcessed = 0;
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const results: Array<{ employeeId: string; status: string; messageId?: string; detail?: string }> = [];
    for (const employee of rows) {
      if (!employee.sms_opt_in || !String(employee.phone || "").trim()) {
        skipped += 1;
        continue;
      }
      const reserved = await sql`
        INSERT INTO team_link_announcement_delivery (campaign, employee_id, status)
        VALUES (${campaign}, ${employee.id}, 'reserved')
        ON CONFLICT DO NOTHING
        RETURNING employee_id
      `;
      if (!reserved.length) {
        alreadyProcessed += 1;
        continue;
      }
      const recipient: SmsRecipient = {
        id: employee.id,
        name: employee.name,
        phone: employee.phone,
        smsOptIn: true,
      };
      const delivery = await deliverSms({ recipients: [recipient], text: () => message });
      const accepted = delivery.accepted[0];
      const status = accepted ? "accepted" : "failed";
      const detail = delivery.failures[0]?.message || (!delivery.configured ? "Telnyx is not configured." : "SMS was not accepted.");
      await sql`
        UPDATE team_link_announcement_delivery
        SET status = ${status}, message_id = ${accepted?.messageId || null},
            detail = ${accepted ? null : detail}, updated_at = NOW()
        WHERE campaign = ${campaign} AND employee_id = ${employee.id}
      `;
      if (accepted) sent += 1;
      else failed += 1;
      results.push({ employeeId: employee.id, status, messageId: accepted?.messageId, detail: accepted ? undefined : detail });
    }
    return Response.json({ campaign, text: message, eligible: rows.length - skipped, sent, failed, skipped, alreadyProcessed, results });
  } catch (error) {
    return apiError(error);
  }
}
