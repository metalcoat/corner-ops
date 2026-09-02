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
};

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
    if (isEmployeePinUniqueViolation(error)) {
      throw new Error("That PIN is already assigned to another active employee.");
    }
    throw error;
  }
}

export async function employeeByPin(business: Business, suppliedPin: unknown): Promise<EmployeePinRow | null> {
  const pin = validateEmployeePin(business, suppliedPin, business);
  const rows = await getSql()`
    SELECT id, business, name, position, pin_hash, pin_salt, pin_hash_version,
      pin_fingerprint, session_version
    FROM employees
    WHERE business = ${business} AND active = TRUE AND pin_enabled = TRUE
    ORDER BY name
  ` as unknown as EmployeePinRow[];
  const employee = rows.find((row) => matches(row, pin)) || null;
  if (employee) await upgradeLegacyPin(employee, pin);
  return employee;
}
