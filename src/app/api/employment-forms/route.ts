import { NextRequest, NextResponse } from "next/server";
import { canAccessBusiness, getSession, requirePermission } from "@/lib/auth";
import { getSql } from "@/lib/db";
import {
  assignOnboardingPacket,
  assignRateChange,
  completeEmployerI9,
  ensureEmploymentFormsSchema,
  getEmploymentForm,
  getEmploymentFormProfile,
  listEmploymentEmployees,
  listEmploymentForms,
  saveEmploymentFormProfile,
  type EmploymentFormProfile,
} from "@/lib/employment-forms";
import type { Business } from "@/lib/types";

function businessValue(value: unknown): Business {
  if (value !== "Corner Deli" && value !== "Tiki") throw new Error("Choose Corner Deli or Tiki.");
  return value;
}

function clientMetadata(request: NextRequest) {
  return {
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown",
    userAgent: request.headers.get("user-agent") || "unknown",
  };
}

type AssignmentRow = {
  id: string;
  assigned_by: string;
};

type EventRow = {
  action: string;
  actor: string;
  metadata: Record<string, unknown> | string;
  created_at: string | Date;
};

function eventView(row: EventRow) {
  let metadata: Record<string, unknown> = {};
  if (typeof row.metadata === "string") {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  } else {
    metadata = row.metadata || {};
  }
  return {
    action: row.action,
    actor: row.actor,
    metadata,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

async function assignmentActors(business: Business) {
  await ensureEmploymentFormsSchema();
  const rows = await getSql()`
    SELECT id, assigned_by
    FROM employment_forms
    WHERE business = ${business}
  ` as unknown as AssignmentRow[];
  return new Map(rows.map((row) => [row.id, row.assigned_by]));
}

async function formAudit(id: string) {
  await ensureEmploymentFormsSchema();
  const assignmentRows = await getSql()`
    SELECT id, assigned_by
    FROM employment_forms
    WHERE id = ${id}
    LIMIT 1
  ` as unknown as AssignmentRow[];
  const eventRows = await getSql()`
    SELECT action, actor, metadata, created_at
    FROM employment_form_events
    WHERE form_id = ${id}
    ORDER BY created_at DESC
  ` as unknown as EventRow[];
  return {
    assignedBy: assignmentRows[0]?.assigned_by || "Unknown account",
    events: eventRows.map(eventView),
  };
}

async function unassignEmploymentForm(input: {
  id: string;
  business: Business;
  actor: string;
  reason: string;
}) {
  await ensureEmploymentFormsSchema();
  const rows = await getSql()`
    SELECT id, employee_id, employee_name, title, status
    FROM employment_forms
    WHERE id = ${input.id} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{
    id: string;
    employee_id: string;
    employee_name: string;
    title: string;
    status: string;
  }>;
  const form = rows[0];
  if (!form) throw new Error("Employment form was not found.");
  if (form.status === "Superseded") throw new Error("This form is already unassigned.");
  if (form.status !== "Assigned") {
    throw new Error("Only unsigned assigned forms can be unassigned. Signed forms remain preserved in the audit record.");
  }

  await getSql()`
    UPDATE employment_forms
    SET status = 'Superseded', updated_at = NOW()
    WHERE id = ${form.id}
  `;
  await getSql()`
    INSERT INTO employment_form_events (id, form_id, action, actor, metadata)
    VALUES (
      ${crypto.randomUUID()}, ${form.id}, 'unassigned', ${input.actor},
      ${JSON.stringify({
        reason: input.reason || "Unassigned by management.",
        employeeId: form.employee_id,
        employeeName: form.employee_name,
        title: form.title,
      })}::jsonb
    )
  `;
  return {
    unassigned: true,
    id: form.id,
    employeeId: form.employee_id,
    employeeName: form.employee_name,
    title: form.title,
    actor: input.actor,
  };
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    requirePermission(session, "workforce.read");
    const business = businessValue(request.nextUrl.searchParams.get("business"));
    if (!canAccessBusiness(session, business)) return NextResponse.json({ error: "Business access denied." }, { status: 403 });
    const id = request.nextUrl.searchParams.get("id");
    if (id) {
      const form = await getEmploymentForm(id);
      if (!form || form.business !== business) return NextResponse.json({ error: "Employment form was not found." }, { status: 404 });
      const audit = await formAudit(id);
      return NextResponse.json({ form: { ...form, ...audit } });
    }
    const [forms, employees, profile, actors] = await Promise.all([
      listEmploymentForms(business),
      listEmploymentEmployees(business),
      getEmploymentFormProfile(business),
      assignmentActors(business),
    ]);
    return NextResponse.json({
      business,
      forms: forms.map((form) => ({ ...form, assignedBy: actors.get(form.id) || "Unknown account" })),
      employees,
      profile,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Employment forms could not be loaded." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Authentication required." }, { status: 401 });
    requirePermission(session, "workforce.write");
    const body = await request.json() as Record<string, unknown>;
    const business = businessValue(body.business);
    if (!canAccessBusiness(session, business)) return NextResponse.json({ error: "Business access denied." }, { status: 403 });
    const action = String(body.action || "");

    if (action === "save-profile") {
      const profile: EmploymentFormProfile = {
        legalName: String(body.legalName || "").trim(),
        dba: String(body.dba || business).trim(),
        ein: String(body.ein || "").trim(),
        address: String(body.address || "").trim(),
        phone: String(body.phone || "").trim(),
        payFrequency: String(body.payFrequency || "Weekly").trim(),
        payday: String(body.payday || "").trim(),
        dependentHealthAvailable: Boolean(body.dependentHealthAvailable),
        dependentHealthEligibility: String(body.dependentHealthEligibility || "").trim(),
      };
      if (!profile.legalName || !profile.ein || !profile.address || !profile.phone || !profile.payday) {
        throw new Error("Legal name, EIN, address, phone, and regular payday are required.");
      }
      return NextResponse.json({ profile: await saveEmploymentFormProfile(business, profile, session.email) });
    }

    if (action === "assign-packet") {
      const forms = await assignOnboardingPacket({
        business,
        employeeId: String(body.employeeId || ""),
        hireDate: String(body.hireDate || ""),
        actor: session.email,
        employerSignature: String(body.employerSignature || ""),
      });
      return NextResponse.json({ forms }, { status: 201 });
    }

    if (action === "rate-change") {
      const form = await assignRateChange({
        business,
        employeeId: String(body.employeeId || ""),
        effectiveDate: String(body.effectiveDate || ""),
        hourlyRate: Number(body.hourlyRate),
        tippedRate: Number(body.tippedRate || 0),
        actor: session.email,
        employerSignature: String(body.employerSignature || ""),
      });
      return NextResponse.json({ form }, { status: 201 });
    }

    if (action === "complete-i9") {
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

    if (action === "unassign") {
      return NextResponse.json(await unassignEmploymentForm({
        id: String(body.id || ""),
        business,
        actor: session.email,
        reason: String(body.reason || "").trim(),
      }));
    }

    throw new Error("Unknown employment forms action.");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Employment form update failed." }, { status: 400 });
  }
}
