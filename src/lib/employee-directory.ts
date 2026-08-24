import { ensureSchema, getSql } from "@/lib/db";
import { normalizePosition, roleGroupForPosition } from "@/lib/business-positions";
import { assertEmployeePinAvailable, createEmployeePinRecord } from "@/lib/employee-pin-security";
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
        CREATE OR REPLACE FUNCTION corner_ops_prepare_rezku_employee()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.employee_name IS NULL OR BTRIM(NEW.employee_name) = '' THEN
            RETURN NEW;
          END IF;

          IF LOWER(BTRIM(NEW.employee_name)) = 'cover' THEN
            RETURN NULL;
          END IF;

          IF LOWER(BTRIM(NEW.employee_name)) = 'can' THEN
            NEW.employee_name := 'Ken';
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
            WHERE tgname = 'rezku_employee_alias_normalization'
              AND tgrelid = 'rezku_shifts'::regclass
              AND NOT tgisinternal
          ) THEN
            CREATE TRIGGER rezku_employee_alias_normalization
            BEFORE INSERT OR UPDATE OF employee_name
            ON rezku_shifts
            FOR EACH ROW
            EXECUTE FUNCTION corner_ops_prepare_rezku_employee();
          END IF;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
        $$
      `;

      await sql`
        CREATE OR REPLACE FUNCTION corner_ops_sync_rezku_employee()
        RETURNS TRIGGER
        LANGUAGE plpgsql
        AS $$
        DECLARE
          canonical_name TEXT;
          employee_position TEXT;
          employee_role TEXT;
        BEGIN
          canonical_name := BTRIM(COALESCE(NEW.employee_name, ''));
          IF canonical_name = '' OR LOWER(canonical_name) = 'cover' THEN
            RETURN NEW;
          END IF;
          IF LOWER(canonical_name) = 'can' THEN
            canonical_name := 'Ken';
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
            AND LOWER(BTRIM(name)) = LOWER(canonical_name);

          IF NOT FOUND THEN
            INSERT INTO employees (
              id, business, email, name, pin_hash, pin_enabled, position,
              role_group, counts_for_tips, hourly_rate, tipped_rate, active
            ) VALUES (
              gen_random_uuid(), 'Corner Deli', '', canonical_name,
              'rezku:' || MD5(LOWER(canonical_name)), FALSE,
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
        DELETE FROM rezku_shifts
        WHERE LOWER(BTRIM(COALESCE(employee_name, ''))) = 'cover'
      `;

      await sql`
        UPDATE rezku_shifts
        SET employee_name = 'Ken'
        WHERE LOWER(BTRIM(COALESCE(employee_name, ''))) = 'can'
      `;

      await sql`
        DELETE FROM employees
        WHERE business = 'Corner Deli'
          AND LOWER(BTRIM(name)) = 'cover'
          AND pin_enabled = FALSE
      `;

      await sql`
        UPDATE employees alias_employee
        SET name = 'Ken', updated_at = NOW()
        WHERE alias_employee.business = 'Corner Deli'
          AND LOWER(BTRIM(alias_employee.name)) = 'can'
          AND NOT EXISTS (
            SELECT 1 FROM employees canonical_employee
            WHERE canonical_employee.business = 'Corner Deli'
              AND LOWER(BTRIM(canonical_employee.name)) = 'ken'
          )
      `;

      await sql`
        DELETE FROM employees alias_employee
        WHERE alias_employee.business = 'Corner Deli'
          AND LOWER(BTRIM(alias_employee.name)) = 'can'
          AND alias_employee.pin_enabled = FALSE
          AND EXISTS (
            SELECT 1 FROM employees canonical_employee
            WHERE canonical_employee.business = 'Corner Deli'
              AND LOWER(BTRIM(canonical_employee.name)) = 'ken'
          )
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
          WHERE employee_name IS NOT NULL
            AND BTRIM(employee_name) <> ''
            AND LOWER(BTRIM(employee_name)) <> 'cover'
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
    const pin = await assertEmployeePinAvailable({ business, pin: input.pin, employeeName: name || "Employee", excludeEmployeeId: undefined });
    const pinRecord = createEmployeePinRecord(business, pin, name || "Employee");
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
          pin_hash = ${pinRecord.hash}, pin_salt = ${pinRecord.salt}, pin_hash_version = ${pinRecord.version},
          pin_fingerprint = ${pinRecord.fingerprint}, pin_enabled = TRUE, session_version = session_version + 1,
          position = ${position}, role_group = ${roleGroup}, counts_for_tips = ${countsForTips},
          hourly_rate = ${hourlyRate}, tipped_rate = ${tippedRate}, active = TRUE, updated_at = NOW()
        WHERE id = ${existing[0].id}
        RETURNING id, name, email, phone
      ` as unknown as Array<{ id: string; name: string; email: string; phone: string }>;
      results.push({ ...rows[0], action: "updated" });
    } else {
      const rows = await sql`
        INSERT INTO employees (
          id, business, email, phone, sms_opt_in, name, pin_hash, pin_salt, pin_hash_version, pin_fingerprint,
          pin_enabled, position, role_group, counts_for_tips, hourly_rate, tipped_rate, active
        ) VALUES (
          ${crypto.randomUUID()}, ${business}, ${email}, ${phone}, ${smsOptIn}, ${name},
          ${pinRecord.hash}, ${pinRecord.salt}, ${pinRecord.version}, ${pinRecord.fingerprint}, TRUE, ${position}, ${roleGroup}, ${countsForTips},
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
