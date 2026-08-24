import { createHash, randomUUID } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/db";
import {
  CORNER_DELI_HANDBOOK_ACKNOWLEDGMENT,
  CORNER_DELI_HANDBOOK_EFFECTIVE_DATE,
  CORNER_DELI_HANDBOOK_INTRO,
  CORNER_DELI_HANDBOOK_SECTIONS,
  CORNER_DELI_HANDBOOK_TITLE,
  CORNER_DELI_HANDBOOK_VERSION,
} from "@/lib/corner-deli-handbook";
import type { Business } from "@/lib/types";

export type EmployeeHandbookDocument = {
  title: string;
  version: string;
  effectiveDate: string;
  intro: string[];
  sections: typeof CORNER_DELI_HANDBOOK_SECTIONS;
  acknowledgment: string;
  contentHash: string;
};

export type HandbookAcknowledgment = {
  id: string;
  employeeId: string;
  employeeName: string;
  business: Business;
  handbookVersion: string;
  signatureName: string;
  acknowledgedAt: string;
  contentHash: string;
};

export type HandbookEmployeeStatus = {
  employeeId: string;
  employeeName: string;
  position: string;
  active: boolean;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  signatureName: string | null;
  handbookVersion: string;
};

let handbookSchemaPromise: Promise<void> | null = null;

export function ensureEmployeeHandbookSchema(): Promise<void> {
  if (!handbookSchemaPromise) {
    handbookSchemaPromise = (async () => {
      await ensureSchema();
      await getSql()`
        CREATE TABLE IF NOT EXISTS employee_handbook_acknowledgments (
          id UUID PRIMARY KEY,
          employee_id UUID NOT NULL REFERENCES employees(id),
          employee_name TEXT NOT NULL,
          business TEXT NOT NULL CHECK (business IN ('Corner Deli', 'Tiki')),
          handbook_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          signature_name TEXT NOT NULL,
          ip_address TEXT NOT NULL DEFAULT '',
          user_agent TEXT NOT NULL DEFAULT '',
          acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        )
      `;
      await getSql()`CREATE UNIQUE INDEX IF NOT EXISTS employee_handbook_ack_employee_hash_unique ON employee_handbook_acknowledgments (employee_id, handbook_version, content_hash)`;
      await getSql()`CREATE INDEX IF NOT EXISTS employee_handbook_ack_business_idx ON employee_handbook_acknowledgments (business, handbook_version, content_hash, acknowledged_at DESC)`;
    })().catch((error) => {
      handbookSchemaPromise = null;
      throw error;
    });
  }
  return handbookSchemaPromise;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function getCornerDeliHandbook(): EmployeeHandbookDocument {
  const canonical = {
    title: CORNER_DELI_HANDBOOK_TITLE,
    version: CORNER_DELI_HANDBOOK_VERSION,
    effectiveDate: CORNER_DELI_HANDBOOK_EFFECTIVE_DATE,
    intro: CORNER_DELI_HANDBOOK_INTRO,
    sections: CORNER_DELI_HANDBOOK_SECTIONS,
    acknowledgment: CORNER_DELI_HANDBOOK_ACKNOWLEDGMENT,
  };
  return {
    ...canonical,
    contentHash: createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex"),
  };
}

function isoDateTime(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getEmployeeHandbookAcknowledgment(employeeId: string, business: Business): Promise<HandbookAcknowledgment | null> {
  await ensureEmployeeHandbookSchema();
  const handbook = getCornerDeliHandbook();
  const rows = await getSql()`
    SELECT id, employee_id, employee_name, business, handbook_version, content_hash, signature_name, acknowledged_at
    FROM employee_handbook_acknowledgments
    WHERE employee_id = ${employeeId} AND business = ${business}
      AND handbook_version = ${handbook.version} AND content_hash = ${handbook.contentHash}
    LIMIT 1
  ` as unknown as Array<{
    id: string;
    employee_id: string;
    employee_name: string;
    business: Business;
    handbook_version: string;
    content_hash: string;
    signature_name: string;
    acknowledged_at: string | Date;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    business: row.business,
    handbookVersion: row.handbook_version,
    contentHash: row.content_hash,
    signatureName: row.signature_name,
    acknowledgedAt: isoDateTime(row.acknowledged_at)!,
  };
}

export async function acknowledgeEmployeeHandbook(input: {
  employeeId: string;
  employeeName: string;
  business: Business;
  signatureName: string;
  ipAddress: string;
  userAgent: string;
}): Promise<HandbookAcknowledgment> {
  if (input.business !== "Corner Deli") throw new Error("The Corner Deli handbook is available only to Corner Deli employees.");
  if (normalizedName(input.signatureName) !== normalizedName(input.employeeName)) {
    throw new Error(`Type the employee name exactly as ${input.employeeName} to sign.`);
  }
  await ensureEmployeeHandbookSchema();
  const handbook = getCornerDeliHandbook();
  const existing = await getEmployeeHandbookAcknowledgment(input.employeeId, input.business);
  if (existing) return existing;

  const rows = await getSql()`
    INSERT INTO employee_handbook_acknowledgments (
      id, employee_id, employee_name, business, handbook_version, content_hash,
      signature_name, ip_address, user_agent
    ) VALUES (
      ${randomUUID()}, ${input.employeeId}, ${input.employeeName}, ${input.business},
      ${handbook.version}, ${handbook.contentHash}, ${input.signatureName.trim()},
      ${input.ipAddress}, ${input.userAgent}
    )
    RETURNING id, employee_id, employee_name, business, handbook_version, content_hash, signature_name, acknowledged_at
  ` as unknown as Array<{
    id: string;
    employee_id: string;
    employee_name: string;
    business: Business;
    handbook_version: string;
    content_hash: string;
    signature_name: string;
    acknowledged_at: string | Date;
  }>;
  const row = rows[0];
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    business: row.business,
    handbookVersion: row.handbook_version,
    contentHash: row.content_hash,
    signatureName: row.signature_name,
    acknowledgedAt: isoDateTime(row.acknowledged_at)!,
  };
}

export async function listHandbookEmployeeStatus(business: Business): Promise<HandbookEmployeeStatus[]> {
  await ensureEmployeeHandbookSchema();
  const handbook = getCornerDeliHandbook();
  const rows = await getSql()`
    SELECT
      e.id AS employee_id,
      e.name AS employee_name,
      e.position,
      e.active,
      a.signature_name,
      a.acknowledged_at
    FROM employees e
    LEFT JOIN employee_handbook_acknowledgments a
      ON a.employee_id = e.id
     AND a.handbook_version = ${handbook.version}
     AND a.content_hash = ${handbook.contentHash}
    WHERE e.business = ${business}
    ORDER BY e.active DESC, e.name
  ` as unknown as Array<{
    employee_id: string;
    employee_name: string;
    position: string;
    active: boolean;
    signature_name: string | null;
    acknowledged_at: string | Date | null;
  }>;

  return rows.map((row) => ({
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    position: row.position,
    active: Boolean(row.active),
    acknowledged: Boolean(row.acknowledged_at),
    acknowledgedAt: isoDateTime(row.acknowledged_at),
    signatureName: row.signature_name || null,
    handbookVersion: handbook.version,
  }));
}
