import { writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

const productionBuild = process.env.VERCEL_ENV === "production";
const databaseUrl = process.env.DATABASE_URL?.trim();
const outputPath = "public/onboarding-reminder-candidates.json";

if (!databaseUrl || !productionBuild) {
  console.log("Onboarding reminder inspection skipped outside the production Vercel build.");
  process.exit(0);
}

const sql = neon(databaseUrl);
const requiredTypes = ["PAY_NOTICE", "W4", "IT2104", "I9", "MEAL_POLICY"];
const employeeActionComplete = new Set(["Completed", "Employer Review"]);

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
      latest.status,
      latest.assigned_at
    FROM employees e
    LEFT JOIN LATERAL (
      SELECT DISTINCT ON (ef.form_type)
        ef.form_type,
        ef.status,
        ef.assigned_at
      FROM employment_forms ef
      WHERE ef.employee_id = e.id
        AND ef.business = e.business
        AND ef.status <> 'Superseded'
      ORDER BY ef.form_type, ef.assigned_at DESC
    ) latest ON TRUE
    WHERE e.active = TRUE
      AND e.created_at >= NOW() - INTERVAL '45 days'
    ORDER BY e.created_at DESC, e.name, latest.form_type
  `;

  const byEmployee = new Map();
  for (const row of rows) {
    const id = String(row.id);
    let employee = byEmployee.get(id);
    if (!employee) {
      employee = {
        id,
        business: String(row.business),
        name: String(row.name),
        createdAt: new Date(row.created_at).toISOString(),
        hasPhone: Boolean(String(row.phone || "").trim()),
        phoneLast4: String(row.phone || "").replace(/\D/g, "").slice(-4),
        smsOptIn: Boolean(row.sms_opt_in),
        forms: {},
      };
      byEmployee.set(id, employee);
    }
    if (row.form_type) {
      employee.forms[String(row.form_type)] = {
        status: String(row.status || ""),
        assignedAt: row.assigned_at ? new Date(row.assigned_at).toISOString() : null,
      };
    }
  }

  const employees = Array.from(byEmployee.values()).map((employee) => {
    const missingOrIncomplete = requiredTypes.filter((type) => {
      const form = employee.forms[type];
      if (!form) return true;
      if (type === "I9") return !employeeActionComplete.has(form.status);
      return form.status !== "Completed";
    });
    const notAssigned = requiredTypes.filter((type) => !employee.forms[type]);
    return {
      business: employee.business,
      name: employee.name,
      createdAt: employee.createdAt,
      hasPhone: employee.hasPhone,
      phoneLast4: employee.phoneLast4,
      smsOptIn: employee.smsOptIn,
      forms: employee.forms,
      notAssigned,
      missingOrIncomplete,
      eligibleForReminder: employee.hasPhone && employee.smsOptIn && missingOrIncomplete.length > 0 && notAssigned.length === 0,
    };
  });

  const newestThree = employees.slice(0, 3);
  const diagnostic = {
    generatedAt: new Date().toISOString(),
    recentActiveEmployeeCount: employees.length,
    newestThree,
    exactThreeEligible: newestThree.length === 3 && newestThree.every((employee) => employee.eligibleForReminder),
  };
  writeFileSync(outputPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
  console.log(`Onboarding reminder inspection: ${JSON.stringify(diagnostic)}.`);
} catch (error) {
  const diagnostic = {
    generatedAt: new Date().toISOString(),
    status: "query-error",
    error: error instanceof Error ? error.message : String(error),
  };
  writeFileSync(outputPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
  console.error(`Onboarding reminder inspection failed: ${JSON.stringify(diagnostic)}.`);
}
