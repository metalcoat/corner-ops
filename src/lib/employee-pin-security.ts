import { getSql } from "@/lib/db";
import { ConflictError } from "@/lib/http";
import { validateEmployeePin } from "@/lib/employee-pin";
import {
  createEmployeePinCryptoRecord,
  employeePinDigestForCandidate,
  employeePinFingerprint,
  employeePinFingerprintCandidates,
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

type PinMatch = {
  matched: boolean;
  needsUpgrade: boolean;
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
  const [fingerprint, formsFingerprint, sessionFingerprint] = employeePinFingerprintCandidates(input.business, pin);
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
        OR pin_fingerprint = ${formsFingerprint}
        OR pin_fingerprint = ${sessionFingerprint}
        OR (pin_hash_version < ${EMPLOYEE_PIN_HASH_VERSION} AND pin_hash = ${legacyHash})
      )
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (rows[0]) throw new Error("That PIN is already assigned at this location.");
  return pin;
}

function matches(row: EmployeePinRow, pin: string): PinMatch {
  if (Number(row.pin_hash_version || 1) >= EMPLOYEE_PIN_HASH_VERSION && row.pin_salt) {
    const fingerprints = employeePinFingerprintCandidates(row.business, pin);

    for (let index = 0; index < fingerprints.length; index += 1) {
      if (!row.pin_fingerprint || !constantTimeEqual(fingerprints[index], row.pin_fingerprint)) continue;
      const digest = employeePinDigestForCandidate(row.business, pin, row.pin_salt, index);
      if (constantTimeEqual(digest, row.pin_hash)) {
        return { matched: true, needsUpgrade: index !== 0 };
      }
    }

    // A version-2 row should always have a fingerprint, but tolerate an incomplete
    // historical migration by checking the known key roots directly once.
    if (!row.pin_fingerprint) {
      for (let index = 0; index < fingerprints.length; index += 1) {
        const digest = employeePinDigestForCandidate(row.business, pin, row.pin_salt, index);
        if (constantTimeEqual(digest, row.pin_hash)) {
          return { matched: true, needsUpgrade: true };
        }
      }
    }

    return { matched: false, needsUpgrade: false };
  }

  return {
    matched: constantTimeEqual(legacyEmployeePinHash(row.business, pin), row.pin_hash),
    needsUpgrade: true,
  };
}

async function rewritePinWithCurrentKey(row: EmployeePinRow, pin: string): Promise<void> {
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
      throw new ConflictError("This PIN conflicts with another active employee. An owner must reset one of the PINs.");
    }
    throw error;
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
  // Every key generation's fingerprint, so PINs saved before a key rotation
  // are still found (and then rehashed onto the current key below).
  const [fingerprint, formsFingerprint, sessionFingerprint] = employeePinFingerprintCandidates(business, pin);
  const legacyHash = legacyEmployeePinHash(business, pin);
  const rows = await getSql()`
    SELECT id, business, name, position, pin_hash, pin_salt, pin_hash_version,
      pin_fingerprint, session_version, COALESCE(role_group, '') role_group,
      COALESCE(to_jsonb(employees) ->> 'pos_role', 'employee') pos_role
    FROM employees
    WHERE business = ${business} AND active = TRUE
      AND (${!requireEnabled} OR pin_enabled = TRUE)
      AND (
        pin_fingerprint IN (${fingerprint}, ${formsFingerprint}, ${sessionFingerprint})
        OR pin_hash = ${legacyHash}
        OR (pin_hash_version >= ${EMPLOYEE_PIN_HASH_VERSION} AND COALESCE(pin_fingerprint, '') = '')
      )
    ORDER BY name
  ` as unknown as EmployeePinRow[];

  const found = rows
    .map((row) => ({ row, match: matches(row, pin) }))
    .filter((candidate) => candidate.match.matched);

  if (found.length > 1) {
    throw new ConflictError("This PIN matches more than one active employee. An owner must reset one of the PINs.");
  }

  const candidate = found[0];
  if (!candidate) return null;

  if (candidate.match.needsUpgrade) {
    try {
      await rewritePinWithCurrentKey(candidate.row, pin);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      console.error("[employee-pin] verified PIN but key migration was deferred", {
        employeeId: candidate.row.id,
        business: candidate.row.business,
        error,
      });
    }
  }

  return candidate.row;
}
