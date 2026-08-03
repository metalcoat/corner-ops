import { ensureEmployeeDirectorySchema } from "@/lib/employee-directory";
import { getSql } from "@/lib/db";
import type { EmployeeSession } from "@/lib/employee-auth";
import type { Business } from "@/lib/types";

const SCHEDULE_COLORS = [
  "#2563EB", "#7C3AED", "#DB2777", "#DC2626", "#EA580C", "#CA8A04",
  "#16A34A", "#059669", "#0891B2", "#4F46E5", "#9333EA", "#C2410C",
];

let profileSchemaPromise: Promise<void> | null = null;

function clean(value: unknown, max = 500): string {
  return String(value ?? "").trim().slice(0, max);
}

export function validScheduleColor(value: unknown): string {
  const color = clean(value, 7).toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(color)) throw new Error("Choose a valid employee color.");
  return color;
}

export function ensureEmployeeProfileSchema(): Promise<void> {
  if (!profileSchemaPromise) {
    profileSchemaPromise = (async () => {
      await ensureEmployeeDirectorySchema();
      const sql = getSql();
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS schedule_color TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS profile_photo_url TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS profile_photo_pathname TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS profile_photo_name TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS profile_photo_type TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS profile_photo_size BIGINT NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE employees ADD COLUMN IF NOT EXISTS chat_nickname TEXT NOT NULL DEFAULT ''`;
      await sql`
        UPDATE employees
        SET schedule_color = (ARRAY[
          '#2563EB','#7C3AED','#DB2777','#DC2626','#EA580C','#CA8A04',
          '#16A34A','#059669','#0891B2','#4F46E5','#9333EA','#C2410C'
        ])[(ABS(hashtext(id::text)) % 12) + 1]
        WHERE schedule_color = '' OR schedule_color !~ '^#[0-9A-Fa-f]{6}$'
      `;
    })().catch((error) => {
      profileSchemaPromise = null;
      throw error;
    });
  }
  return profileSchemaPromise;
}

export function scheduleColorFromId(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return SCHEDULE_COLORS[Math.abs(hash) % SCHEDULE_COLORS.length];
}

export async function updateEmployeeScheduleColor(input: {
  business: Business;
  employeeId: string;
  color: string;
}) {
  await ensureEmployeeProfileSchema();
  const rows = await getSql()`
    UPDATE employees SET schedule_color = ${validScheduleColor(input.color)}, updated_at = NOW()
    WHERE id = ${input.employeeId} AND business = ${input.business}
    RETURNING id, schedule_color
  ` as unknown as Array<{ id: string; schedule_color: string }>;
  if (!rows[0]) throw new Error("Employee not found.");
  return { id: rows[0].id, scheduleColor: rows[0].schedule_color };
}

export async function updateEmployeeChatNickname(session: EmployeeSession, value: unknown) {
  await ensureEmployeeProfileSchema();
  const nickname = clean(value, 32).replace(/\s+/g, " ");
  if (nickname && nickname.length < 2) throw new Error("Chat nicknames must contain at least two characters.");
  if (/[\r\n<>]/.test(nickname)) throw new Error("Chat nickname contains unsupported characters.");

  if (nickname) {
    const duplicate = await getSql()`
      SELECT id FROM employees
      WHERE business = ${session.business}
        AND id <> ${session.employeeId}
        AND active = TRUE
        AND LOWER(BTRIM(chat_nickname)) = LOWER(BTRIM(${nickname}))
      LIMIT 1
    ` as unknown as Array<{ id: string }>;
    if (duplicate[0]) throw new Error("Another employee is already using that chat nickname.");
  }

  const rows = await getSql()`
    UPDATE employees SET chat_nickname = ${nickname}, updated_at = NOW()
    WHERE id = ${session.employeeId} AND business = ${session.business} AND active = TRUE
    RETURNING chat_nickname
  ` as unknown as Array<{ chat_nickname: string }>;
  if (!rows[0]) throw new Error("Employee profile was not found.");
  return { chatNickname: rows[0].chat_nickname };
}

export async function setEmployeeProfilePhoto(input: {
  business: Business;
  employeeId: string;
  url: string;
  pathname: string;
  fileName: string;
  contentType: string;
  size: number;
}) {
  await ensureEmployeeProfileSchema();
  const current = await getSql()`
    SELECT profile_photo_url FROM employees
    WHERE id = ${input.employeeId} AND business = ${input.business}
    LIMIT 1
  ` as unknown as Array<{ profile_photo_url: string }>;
  if (!current[0]) throw new Error("Employee not found.");

  await getSql()`
    UPDATE employees SET
      profile_photo_url = ${clean(input.url, 1000)},
      profile_photo_pathname = ${clean(input.pathname, 1000)},
      profile_photo_name = ${clean(input.fileName, 255)},
      profile_photo_type = ${clean(input.contentType, 120)},
      profile_photo_size = ${Math.max(0, Math.round(input.size))},
      updated_at = NOW()
    WHERE id = ${input.employeeId} AND business = ${input.business}
  `;
  return { previousUrl: current[0].profile_photo_url || "" };
}

export async function removeEmployeeProfilePhoto(input: { business: Business; employeeId: string }) {
  await ensureEmployeeProfileSchema();
  const rows = await getSql()`
    UPDATE employees SET
      profile_photo_url = '', profile_photo_pathname = '', profile_photo_name = '',
      profile_photo_type = '', profile_photo_size = 0, updated_at = NOW()
    WHERE id = ${input.employeeId} AND business = ${input.business}
    RETURNING profile_photo_url
  ` as unknown as Array<{ profile_photo_url: string }>;
  if (!rows[0]) throw new Error("Employee not found.");
  return rows[0];
}

type StoredProfilePhoto = {
  pathname: string;
  fileName: string;
  contentType: string;
  size: number;
};

function mapPhoto(row: Record<string, unknown>): StoredProfilePhoto | null {
  const pathname = clean(row.profile_photo_pathname, 1000);
  if (!pathname) return null;
  return {
    pathname,
    fileName: clean(row.profile_photo_name, 255) || "employee-photo",
    contentType: clean(row.profile_photo_type, 120) || "application/octet-stream",
    size: Number(row.profile_photo_size || 0),
  };
}

export async function ownerEmployeeProfilePhoto(business: Business, employeeId: string): Promise<StoredProfilePhoto | null> {
  await ensureEmployeeProfileSchema();
  const rows = await getSql()`
    SELECT profile_photo_pathname, profile_photo_name, profile_photo_type, profile_photo_size
    FROM employees WHERE id = ${employeeId} AND business = ${business} LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapPhoto(rows[0]) : null;
}

export async function employeeVisibleProfilePhoto(session: EmployeeSession, employeeId: string): Promise<StoredProfilePhoto | null> {
  await ensureEmployeeProfileSchema();
  const rows = await getSql()`
    SELECT profile_photo_pathname, profile_photo_name, profile_photo_type, profile_photo_size
    FROM employees
    WHERE id = ${employeeId} AND business = ${session.business} AND active = TRUE
    LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  return rows[0] ? mapPhoto(rows[0]) : null;
}
