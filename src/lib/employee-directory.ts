import { createHmac } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import { normalizePosition, roleGroupForPosition } from "@/lib/business-positions";
import { validateEmployeePin } from "@/lib/employee-pin";
import { normalizeSmsPhone } from "@/lib/phone";
import type { Business } from "@/lib/types";

export type DirectoryEmployeeInput = {
  business: Business;
  email?: string;
  phone?: string;
  smsOptIn?: boolean;
  name: string;
  pin: string;
  position?: string;
  roleGroup?: "Driver" | "In-House" | "Ignore";
  countsForTips?: boolean;
  hourlyRate?: number;
  tippedRate?: number;
};

let directorySchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function pinHash(business: Business, pin: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required.");
  return createHmac("sha256", secret).update(`${business}:${pin}`).digest("hex");
}

export function ensureEmployeeDirectorySchema(): Promise<void> {
  if (!directorySchemaPromise) {
    directorySchemaPromise = (async () => {
      await ensureSchema();
      const sql = getSql();

      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS sms_opt_in BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_enabled BOOLEAN NOT NULL DEFAULT TRUE`;
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS employees_business_email_unique
        ON employees (business, LOWER(email))
        WHERE email <> ''
      `;

      await sql`
        CREATE OR REPLACE FUNCTION corner_ops_sync_rezku_employee()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
          employee_position TEXT;
          employee_role TEXT;
        BEGIN
          IF NEW.employee_name IS NULL OR BTRIM(NEW.employee_name) = '' THEN
            RETURN NEW;
          END IF;

          employee_position := COALESCE(NULLIF(BTRIM(NEW.position), ''), 'Employee');
          employee_role := CASE
            WHEN NEW.role_group IN ('Driver', 'In-House', 'Ignore') THEN NEW.role_group
            WHEN LOWER(employee_position) ~ '(driver|deliver)' THEN 'Driver'
            WHEN LOWER(employee_position) ~ '(training|trainee)' THEN 'Ignore'
            ELSE 'In-House'
          END;

          UPDATE employees
          SET
            position = employee_position,
            role_group = employee_role,
            counts_for_tips = employee_role <> 'Ignore',
            updated_at = NOW()
          WHERE business = 'Corner Deli'
            AND LOWER(BTRIM(name)) = LOWER(BTRIM(NEW.employee_name));

          IF NOT FOUND THEN
            INSERT INTO employees (
              id, business, email, name, pin_hash, pin_enabled, position,
              role_group, counts_for_tips, hourly_rate, tipped_rate, active
            ) VALUES (
              gen_random_uuid(), 'Corner Deli', '', BTRIM(NEW.employee_name),
              'rezku:' || MD5(LOWER(BTRIM(NEW.employee_name))), FALSE,
              employee_position, employee_role, employee_role <> 'Ignore', 0, 0, TRUE
            );
          END IF;

          RETURN NEW;
        END;
        $$
      `;

      await sql`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'rezku_employee_directory_sync'
              AND tgrelid = 'rezku_shifts'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER rezku_employee_directory_sync
            AFTER INSERT OR UPDATE OF employee_name, position, role_group
            ON rezku_shifts
            FOR EACH ROW
            EXECUTE FUNCTION corner_ops_sync_rezku_employee();
          END IF;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
        $$
      `;

      await sql`
        INSERT INTO employees (
          id, business, email, name, pin_hash, pin_enabled, position,
          role_group, counts_for_tips, hourly_rate, tipped_rate, active
        )
        SELECT
          gen_random_uuid(), 'Corner Deli', '', source.employee_name,
          'rezku:' || MD5(LOWER(BTRIM(source.employee_name))), FALSE,
          source.position, source.role_group, source.role_group <> 'Ignore', 0, 0, TRUE
        FROM (
          SELECT DISTINCT ON (LOWER(BTRIM(employee_name)))
            BTRIM(employee_name) AS employee_name,
            COALESCE(NULLIF(BTRIM(position), ''), 'Employee') AS position,
            CASE
              WHEN role_group IN ('Driver', 'In-House', 'Ignore') THEN role_group
              WHEN LOWER(COALESCE(position, '')) ~ '(driver|deliver)' THEN 'Driver'
              WHEN LOWER(COALESCE(position, '')) ~ '(training|trainee)' THEN 'Ignore'
              ELSE 'In-House'
            END AS role_group
          FROM rezku_shifts
          WHERE employee_name IS NOT NULL AND BTRIM(employee_name) <> ''
          ORDER BY LOWER(BTRIM(employee_name)), COALESCE(clock_in, clock_out) DESC NULLS LAST
        ) AS source
        WHERE NOT EXISTS (
          SELECT 1 FROM employees existing
          WHERE existing.business = 'Corner Deli'
            AND LOWER(BTRIM(existing.name)) = LOWER(BTRIM(source.employee_name))
        )
        ON CONFLICT (business, pin_hash) DO NOTHING
      `;
    })().catch((error) => {
      directorySchemaPromise = null;
      throw error;
    });
  }
  return directorySchemaPromise;
}

export async function upsertDirectoryEmployees(inputs: DirectoryEmployeeInput[]) {
  await ensureEmployeeDirectorySchema();
  const sql = getSql();
  const results: Array<{ id: string; name: string; email: string; phone: string; action: "created" | "updated" }> = [];

  for (const input of inputs) {
    const business = input.business;
    const name = clean(input.name, 120);
    const email = clean(input.email, 255).toLowerCase();
    const phone = normalizeSmsPhone(input.phone);
    const smsOptIn = Boolean(input.smsOptIn && phone);
    const pin = validateEmployeePin(business, input.pin, name || "Employee");
    const position = normalizePosition(business, input.position || (business === "Tiki" ? "Bartender" : "Pizza"));
    const roleGroup = input.roleGroup === "Ignore" ? "Ignore" : roleGroupForPosition(business, position);
    const countsForTips = input.countsForTips ?? roleGroup !== "Ignore";
    const hourlyRate = Math.max(0, Number(input.hourlyRate || 0));
    const tippedRate = Math.max(0, Number(input.tippedRate || 0));

    if (!name) throw new Error("Employee name is required.");
    if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error(`Email for ${name} is invalid.`);

    const existing = await sql`
      SELECT id FROM employees
      WHERE business = ${business}
        AND ((${email} <> '' AND LOWER(email) = ${email}) OR LOWER(BTRIM(name)) = LOWER(BTRIM(${name})))
      ORDER BY CASE WHEN LOWER(email) = ${email} AND ${email} <> '' THEN 0 ELSE 1 END
      LIMIT 1
    ` as unknown as Array<{ id: string }>;

    if (existing[0]) {
      const rows = await sql`
        UPDATE employees SET
          email = ${email}, phone = ${phone}, sms_opt_in = ${smsOptIn}, name = ${name},
          pin_hash = ${pinHash(business, pin)}, pin_enabled = TRUE,
          position = ${position}, role_group = ${roleGroup}, counts_for_tips = ${countsForTips},
          hourly_rate = ${hourlyRate}, tipped_rate = ${tippedRate}, active = TRUE, updated_at = NOW()
        WHERE id = ${existing[0].id}
        RETURNING id, name, email, phone
      ` as unknown as Array<{ id: string; name: string; email: string; phone: string }>;
      results.push({ ...rows[0], action: "updated" });
    } else {
      const rows = await sql`
        INSERT INTO employees (
          id, business, email, phone, sms_opt_in, name, pin_hash, pin_enabled, position,
          role_group, counts_for_tips, hourly_rate, tipped_rate, active
        ) VALUES (
          ${crypto.randomUUID()}, ${business}, ${email}, ${phone}, ${smsOptIn}, ${name},
          ${pinHash(business, pin)}, TRUE, ${position}, ${roleGroup}, ${countsForTips},
          ${hourlyRate}, ${tippedRate}, TRUE
        )
        RETURNING id, name, email, phone
      ` as unknown as Array<{ id: string; name: string; email: string; phone: string }>;
      results.push({ ...rows[0], action: "created" });
    }
  }

  return {
    created: results.filter((result) => result.action === "created").length,
    updated: results.filter((result) => result.action === "updated").length,
    employees: results,
  };
}
