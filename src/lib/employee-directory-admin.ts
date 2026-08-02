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
  name?: string;
  position?: string;
  roleGroup?: "Driver" | "In-House" | "Ignore";
  countsForTips?: boolean;
  hourlyRate?: number;
  tippedRate?: number;
}) {
  await ensureEmployeeDirectorySchema();
  const sql = getSql();
  const current = await sql`
    SELECT id, business, email, name, position, role_group, counts_for_tips,
      hourly_rate, tipped_rate, active
    FROM employees
    WHERE id = ${input.id} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{
    id: string;
    business: Business;
    email: string;
    name: string;
    position: string;
    role_group: "Driver" | "In-House" | "Ignore";
    counts_for_tips: boolean;
    hourly_rate: number | string;
    tipped_rate: number | string;
    active: boolean;
  }>;
  const existing = current[0];
  if (!existing) throw new Error("Employee not found.");

  const email = input.email === undefined ? existing.email : clean(input.email, 255).toLowerCase();
  const name = input.name === undefined ? existing.name : clean(input.name, 120);
  const position = input.position === undefined ? existing.position : clean(input.position, 80);
  const roleGroup = input.roleGroup ?? existing.role_group;
  const countsForTips = input.countsForTips ?? existing.counts_for_tips;
  const hourlyRate = Math.max(0, input.hourlyRate ?? Number(existing.hourly_rate));
  const tippedRate = Math.max(0, input.tippedRate ?? Number(existing.tipped_rate));
  const active = input.active ?? existing.active;

  if (!name) throw new Error("Employee name is required.");
  if (!position) throw new Error("Employee position is required.");
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Employee email is invalid.");
  const pin = input.pin ? clean(input.pin, 5) : "";
  if (pin && !/^\d{5}$/.test(pin)) throw new Error("Employee PINs must contain exactly five digits.");

  const duplicate = await sql`
    SELECT id FROM employees
    WHERE business = ${input.business}
      AND id <> ${input.id}
      AND LOWER(BTRIM(name)) = LOWER(BTRIM(${name}))
    LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (duplicate[0]) throw new Error("Another employee at this location already uses that name.");

  const rows = await sql`
    UPDATE employees SET
      email = ${email},
      name = ${name},
      position = ${position},
      role_group = ${roleGroup},
      counts_for_tips = ${countsForTips},
      hourly_rate = ${hourlyRate},
      tipped_rate = ${tippedRate},
      active = ${active},
      pin_hash = CASE WHEN ${pin} <> '' THEN ${pin ? pinHash(input.business, pin) : ""} ELSE pin_hash END,
      pin_enabled = CASE WHEN ${pin} <> '' THEN TRUE ELSE pin_enabled END,
      updated_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business}
    RETURNING id, email, name, position, role_group, counts_for_tips,
      hourly_rate, tipped_rate, pin_enabled, active
  ` as unknown as Array<Record<string, unknown>>;

  if (name !== existing.name) {
    await Promise.all([
      sql`
        UPDATE time_entries
        SET employee_name = ${name}, updated_at = NOW()
        WHERE employee_id = ${input.id}
      `,
      sql`
        UPDATE employee_messages
        SET sender_name = ${name}
        WHERE sender_employee_id = ${input.id}
      `,
      input.business === "Corner Deli"
        ? sql`
            UPDATE rezku_shifts
            SET employee_name = ${name}
            WHERE LOWER(BTRIM(employee_name)) = LOWER(BTRIM(${existing.name}))
          `
        : Promise.resolve([]),
    ]);
  }

  const row = rows[0];
  return {
    id: String(row.id),
    email: String(row.email || ""),
    name: String(row.name),
    position: String(row.position),
    roleGroup: row.role_group as "Driver" | "In-House" | "Ignore",
    countsForTips: Boolean(row.counts_for_tips),
    hourlyRate: Number(row.hourly_rate || 0),
    tippedRate: Number(row.tipped_rate || 0),
    pinEnabled: Boolean(row.pin_enabled),
    active: Boolean(row.active),
  };
}
