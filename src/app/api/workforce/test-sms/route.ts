import { canAccessBusiness, getSession } from "@/lib/auth";
import { getSql } from "@/lib/db";
import { apiError, unauthorized } from "@/lib/http";
import { deliverSms, getSmsDeliveryStatus, type SmsRecipient } from "@/lib/sms-notifications";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function businessFrom(value: unknown): Business {
  return value === "Tiki" ? "Tiki" : "Corner Deli";
}

type EmployeeRow = {
  id: string;
  name: string;
  phone: string;
  sms_opt_in: boolean;
  business: Business;
};

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const url = new URL(request.url);
    const messageId = String(url.searchParams.get("messageId") || "").trim();
    if (messageId) {
      const delivery = await getSmsDeliveryStatus(messageId);
      return Response.json({ ok: true, delivery });
    }

    const business = businessFrom(url.searchParams.get("business"));
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const rows = await getSql()`
      SELECT id, name, phone, sms_opt_in, business
      FROM employees
      WHERE business = ${business} AND active = TRUE
      ORDER BY name
    ` as unknown as EmployeeRow[];

    return Response.json({
      business,
      employees: rows.map((employee) => ({
        id: employee.id,
        name: employee.name,
        hasPhone: Boolean(String(employee.phone || "").trim()),
        smsOptIn: Boolean(employee.sms_opt_in),
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const body = await request.json() as Record<string, unknown>;
    const business = businessFrom(body.business);
    if (!canAccessBusiness(session, business)) {
      return Response.json({ error: "Business access denied." }, { status: 403 });
    }

    const employeeId = String(body.employeeId || "").trim();
    if (!employeeId) {
      return Response.json({ error: "Choose an employee." }, { status: 400 });
    }

    const rows = await getSql()`
      SELECT id, name, phone, sms_opt_in, business
      FROM employees
      WHERE id = ${employeeId} AND business = ${business} AND active = TRUE
      LIMIT 1
    ` as unknown as EmployeeRow[];
    const employee = rows[0];
    if (!employee) {
      return Response.json({ error: "Employee not found." }, { status: 404 });
    }

    const recipient: SmsRecipient = {
      id: employee.id,
      name: employee.name,
      phone: employee.phone || "",
      smsOptIn: Boolean(employee.sms_opt_in),
    };

    const sms = await deliverSms({
      recipients: [recipient],
      text: (target) => `${target.name}, this is a Corner Ops SMS test. If you received this, schedule text notifications are connected and working. No action is needed. Reply STOP to opt out.`,
    });

    const ok = sms.configured && sms.sent === 1 && sms.failed === 0;
    return Response.json({ ok, employee: employee.name, sms }, { status: ok ? 200 : 502 });
  } catch (error) {
    return apiError(error);
  }
}
