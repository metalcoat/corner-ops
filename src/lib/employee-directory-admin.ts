import { createHmac } from "node:crypto";
import { ensureEmployeeDirectorySchema, upsertDirectoryEmployees, type DirectoryEmployeeInput } from "@/lib/employee-directory";
import { getSql } from "@/lib/db";
import type { Business } from "@/lib/types";

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}

function pinHash(business: Business, pin: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required.");
  return createHmac("sha256", secret).update(`${business}:${pin}`).digest("hex");
}

export async function listDirectoryEmployees(business: Business) {
  await ensureEmployeeDirectorySchema();
  const rows = await getSql()`
    SELECT id, business, email, name, position, role_group, counts_for_tips,
      hourly_rate, tipped_rate, active, pin_enabled, created_at, updated_at
    FROM employees
    WHERE business = ${business}
    ORDER BY active DESC, name
  ` as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    business: row.business as Business,
    email: String(row.email || ""),
    name: String(row.name),
    position: String(row.position),
    roleGroup: row.role_group as "Driver" | "In-House" | "Ignore",
    countsForTips: Boolean(row.counts_for_tips),
    hourlyRate: Number(row.hourly_rate || 0),
    tippedRate: Number(row.tipped_rate || 0),
    active: Boolean(row.active),
    pinEnabled: Boolean(row.pin_enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function createDirectoryEmployee(input: DirectoryEmployeeInput) {
  const result = await upsertDirectoryEmployees([input]);
  return result.employees[0];
}

export async function updateDirectoryEmployee(input: {
  id: string;
  business: Business;
  email?: string;
  pin?: string;
  active?: boolean;
}) {
  await ensureEmployeeDirectorySchema();
  const sql = getSql();
  const current = await sql`
    SELECT id, business, email
    FROM employees
    WHERE id = ${input.id} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{ id: string; business: Business; email: string }>;
  if (!current[0]) throw new Error("Employee not found.");

  const email = input.email === undefined ? current[0].email : clean(input.email, 255).toLowerCase();
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Employee email is invalid.");
  const pin = input.pin ? clean(input.pin, 5) : "";
  if (pin && !/^\d{5}$/.test(pin)) throw new Error("Employee PINs must contain exactly five digits.");

  const rows = await sql`
    UPDATE employees SET
      email = ${email},
      active = COALESCE(${input.active ?? null}, active),
      pin_hash = CASE WHEN ${pin} <> '' THEN ${pin ? pinHash(input.business, pin) : ""} ELSE pin_hash END,
      pin_enabled = CASE WHEN ${pin} <> '' THEN TRUE ELSE pin_enabled END,
      updated_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business}
    RETURNING id, email, name, pin_enabled, active
  ` as unknown as Array<{ id: string; email: string; name: string; pin_enabled: boolean; active: boolean }>;

  return {
    id: rows[0].id,
    email: rows[0].email,
    name: rows[0].name,
    pinEnabled: rows[0].pin_enabled,
    active: rows[0].active,
  };
}
