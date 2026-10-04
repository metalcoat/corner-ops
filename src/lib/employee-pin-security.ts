import { getSql } from "@/lib/db";
import { validateEmployeePin } from "@/lib/employee-pin";
import {
  createEmployeePinCryptoRecord,
  employeePinDigest,
  employeePinFingerprint,
  EMPLOYEE_PIN_HASH_VERSION,
  legacyEmployeePinHash,
} from "@/lib/employee-pin-crypto";
import { constantTimeEqual } from "@/lib/security-keys";
import type { Business } from "@/lib/types";

export { employeePinFingerprint, EMPLOYEE_PIN_HASH_VERSION, legacyEmployeePinHash };

type EmployeePinRow = {
  id: string;
  business: Business;
  name: string;
  position: string;
  pin_hash: string;
  pin_salt: string;
  pin_hash_version: number;
  pin_fingerprint: string;
  session_version: number;
  role_group: string;
  pos_role: string;
};

let pinColumnsReady: Promise<void> | null = null;
/** The salted-PIN columns (migration 0005), so fresh databases work too. */
export function ensureEmployeePinColumns(): Promise<void> {
  pinColumnsReady ??= (async () => {
    const sql = getSql();
    await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_salt TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_hash_version INTEGER NOT NULL DEFAULT 1`;
    await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_fingerprint TEXT NOT NULL DEFAULT ''`;
    await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1`;
  })().catch((error) => {
    pinColumnsReady = null;
    throw error;
  });
  return pinColumnsReady;
}

/**
 * Column values for saving a new PIN. Every place that changes a PIN must use
 * these, so the stored hash and its format markers always agree.
 */
export function employeePinUpdate(business: Business, suppliedPin: unknown, employeeName = "Employee") {
  const record = createEmployeePinRecord(business, suppliedPin, employeeName);
  return { pin: record.pin, hash: record.hash, salt: record.salt, version: record.version, fingerprint: record.fingerprint };
}

export function createEmployeePinRecord(business: Business, suppliedPin: unknown, employeeName = "Employee") {
  const pin = validateEmployeePin(business, suppliedPin, employeeName);
  return { pin, ...createEmployeePinCryptoRecord(business, pin) };
}

export function isEmployeePinUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint?: unknown };
  return String(candidate?.code || "") === "23505"
    && /pin_(?:fingerprint|hash)|employees_business_pin/i.test(String(candidate?.constraint || ""));
}

export async function assertEmployeePinAvailable(input: {
  business: Business;
  pin: unknown;
  employeeName?: string;
  excludeEmployeeId?: string;
}): Promise<string> {
  const pin = validateEmployeePin(input.business, input.pin, input.employeeName || "Employee");
  const fingerprint = employeePinFingerprint(input.business, pin);
  const legacyHash = legacyEmployeePinHash(input.business, pin);
  const exclude = input.excludeEmployeeId || null;
  await ensureEmployeePinColumns();
  const rows = await getSql()`
    SELECT id FROM employees
    WHERE business = ${input.business}
      AND (${exclude}::uuid IS NULL OR id <> ${exclude}::uuid)
      AND active = TRUE
      AND (
        pin_fingerprint = ${fingerprint}
        OR (pin_hash_version < ${EMPLOYEE_PIN_HASH_VERSION} AND pin_hash = ${legacyHash})
      )
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (rows[0]) throw new Error("That PIN is already in use at this location.");
  return pin;
}

function matches(row: EmployeePinRow, pin: string): boolean {
  if (Number(row.pin_hash_version || 1) >= EMPLOYEE_PIN_HASH_VERSION && row.pin_salt) {
    return constantTimeEqual(employeePinDigest(row.business, pin, row.pin_salt), row.pin_hash);
  }
  return constantTimeEqual(legacyEmployeePinHash(row.business, pin), row.pin_hash);
}

async function upgradeLegacyPin(row: EmployeePinRow, pin: string): Promise<void> {
  if (Number(row.pin_hash_version || 1) >= EMPLOYEE_PIN_HASH_VERSION && row.pin_salt) return;
  const record = createEmployeePinRecord(row.business, pin, row.name);
  try {
    await getSql()`
      UPDATE employees SET
        pin_hash = ${record.hash}, pin_salt = ${record.salt},
        pin_hash_version = ${record.version}, pin_fingerprint = ${record.fingerprint},
        updated_at = NOW()
      WHERE id = ${row.id} AND business = ${row.business}
    `;
  } catch (error) {
    // The old hash still works, so a failed upgrade must not block sign-in.
    console.error("Employee PIN upgrade failed", isEmployeePinUniqueViolation(error) ? "duplicate PIN fingerprint" : error);
  }
}

/**
 * The one PIN lookup for every sign-in (POS, employee app, deli board, Tiki
 * punch). It accepts both the salted format and the old one, finds the row by
 * fingerprint or old hash instead of hashing every employee, and upgrades old
 * PINs on the way in.
 */
export async function employeeByPin(
  business: Business,
  suppliedPin: unknown,
  options: { requirePinEnabled?: boolean } = {},
): Promise<EmployeePinRow | null> {
  const pin = validateEmployeePin(business, suppliedPin, business);
  await ensureEmployeePinColumns();
  const requireEnabled = options.requirePinEnabled !== false;
  const fingerprint = employeePinFingerprint(business, pin);
  const legacyHash = legacyEmployeePinHash(business, pin);
  const rows = await getSql()`
    SELECT id, business, name, position, pin_hash, pin_salt, pin_hash_version,
      pin_fingerprint, session_version, COALESCE(role_group, '') role_group,
      COALESCE(to_jsonb(employees) ->> 'pos_role', 'employee') pos_role
    FROM employees
    WHERE business = ${business} AND active = TRUE
      AND (${!requireEnabled} OR pin_enabled = TRUE)
      AND (pin_fingerprint = ${fingerprint} OR pin_hash = ${legacyHash})
    ORDER BY name
  ` as unknown as EmployeePinRow[];
  const matched = rows.filter((row) => matches(row, pin));
  if (matched.length !== 1) return null;
  await upgradeLegacyPin(matched[0], pin);
  return matched[0];
}
