import { normalizePosition, roleGroupForPosition } from "@/lib/business-positions";
import { ensureEmployeeDirectorySchema, upsertDirectoryEmployees, type DirectoryEmployeeInput } from "@/lib/employee-directory";
import { ensureEmployeeProfileSchema, scheduleColorFromId, validScheduleColor } from "@/lib/employee-profile";
import { getSql } from "@/lib/db";
import { employeePinLength, validateEmployeePin } from "@/lib/employee-pin";
import { assertEmployeePinAvailable, createEmployeePinRecord, isEmployeePinUniqueViolation } from "@/lib/employee-pin-security";
import { normalizeSmsPhone } from "@/lib/phone";
import type { Business } from "@/lib/types";

function clean(value: unknown, max = 255): string {
  return String(value ?? "").trim().slice(0, max);
}


export async function listDirectoryEmployees(business: Business) {
  await ensureEmployeeProfileSchema();
  await ensureEmployeeDirectorySchema();
  const rows = await getSql()`
    SELECT id, business, email, phone, sms_opt_in, name, position, role_group, counts_for_tips,
      hourly_rate, tipped_rate, active, pin_enabled, schedule_color,
      profile_photo_pathname, chat_nickname, created_at, updated_at
    FROM employees
    WHERE business = ${business}
    ORDER BY active DESC, name
  ` as unknown as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: String(row.id),
    business: row.business as Business,
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    smsOptIn: Boolean(row.sms_opt_in),
    name: String(row.name),
    position: String(row.position),
    roleGroup: row.role_group as "Driver" | "In-House" | "Ignore",
    countsForTips: Boolean(row.counts_for_tips),
    hourlyRate: Number(row.hourly_rate || 0),
    tippedRate: Number(row.tipped_rate || 0),
    active: Boolean(row.active),
    pinEnabled: Boolean(row.pin_enabled),
    scheduleColor: String(row.schedule_color || scheduleColorFromId(String(row.id))),
    avatarSet: Boolean(row.profile_photo_pathname),
    chatNickname: String(row.chat_nickname || ""),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

export async function createDirectoryEmployee(input: DirectoryEmployeeInput) {
  await ensureEmployeeProfileSchema();
  const result = await upsertDirectoryEmployees([input]);
  return result.employees[0];
}

export async function bulkUpdateDirectoryPins(input: { business: Business; lines: string }) {
  await ensureEmployeeDirectorySchema();
  const expectedLength = employeePinLength(input.business);
  const parsed: Array<{ name: string; pin: string }> = [];
  const seen = new Set<string>();

  for (const [index, rawLine] of String(input.lines || "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(.*?)\s+(\d+)$/);
    if (!match) throw new Error(`Line ${index + 1} must end with the employee's ${expectedLength}-digit PIN.`);
    const name = clean(match[1], 120);
    const pin = validateEmployeePin(input.business, match[2], name || `Line ${index + 1}`);
    const key = name.toLowerCase();
    if (!name) throw new Error(`Line ${index + 1} is missing an employee name.`);
    if (seen.has(key)) throw new Error(`${name} appears more than once in the PIN list.`);
    seen.add(key);
    parsed.push({ name, pin });
  }

  if (!parsed.length) throw new Error("Enter at least one employee name and PIN.");
  const sql = getSql();
  const updated: string[] = [];
  const missing: string[] = [];
  for (const entry of parsed) {
    await assertEmployeePinAvailable({ business: input.business, pin: entry.pin, employeeName: entry.name });
    const record = createEmployeePinRecord(input.business, entry.pin, entry.name);
    const rows = await sql`
      UPDATE employees
      SET pin_hash = ${record.hash}, pin_salt = ${record.salt}, pin_hash_version = ${record.version},
        pin_fingerprint = ${record.fingerprint}, pin_enabled = TRUE,
        active = TRUE, session_version = session_version + 1, updated_at = NOW()
      WHERE business = ${input.business}
        AND LOWER(BTRIM(name)) = LOWER(BTRIM(${entry.name}))
      RETURNING name
    ` as unknown as Array<{ name: string }>;
    if (rows[0]) updated.push(rows[0].name);
    else missing.push(entry.name);
  }
  return { business: input.business, pinLength: expectedLength, requested: parsed.length, updated, missing };
}

export async function updateDirectoryEmployee(input: {
  id: string;
  business: Business;
  email?: string;
  phone?: string;
  smsOptIn?: boolean;
  pin?: string;
  active?: boolean;
  name?: string;
  position?: string;
  roleGroup?: "Driver" | "In-House" | "Ignore";
  countsForTips?: boolean;
  hourlyRate?: number;
  tippedRate?: number;
  scheduleColor?: string;
}) {
  await ensureEmployeeProfileSchema();
  await ensureEmployeeDirectorySchema();
  const sql = getSql();
  const current = await sql`
    SELECT id, business, email, phone, sms_opt_in, name, position, role_group, counts_for_tips,
      hourly_rate, tipped_rate, active, schedule_color, profile_photo_pathname, chat_nickname
    FROM employees WHERE id = ${input.id} AND business = ${input.business} LIMIT 1
  ` as unknown as Array<Record<string, unknown>>;
  const existing = current[0];
  if (!existing) throw new Error("Employee not found.");

  const existingRole = existing.role_group as "Driver" | "In-House" | "Ignore";
  const email = input.email === undefined ? String(existing.email || "") : clean(input.email, 255).toLowerCase();
  const phone = input.phone === undefined ? String(existing.phone || "") : normalizeSmsPhone(input.phone);
  const smsOptIn = input.smsOptIn === undefined ? Boolean(existing.sms_opt_in) : Boolean(input.smsOptIn && phone);
  const name = input.name === undefined ? String(existing.name) : clean(input.name, 120);
  const positionChanged = input.position !== undefined;
  const position = positionChanged ? normalizePosition(input.business, input.position) : String(existing.position);
  const roleGroup = input.roleGroup === "Ignore"
    ? "Ignore"
    : positionChanged && input.business === "Corner Deli"
      ? roleGroupForPosition(input.business, position)
      : input.roleGroup ?? existingRole;
  const countsForTips = input.countsForTips ?? Boolean(existing.counts_for_tips);
  const hourlyRate = Math.max(0, input.hourlyRate ?? Number(existing.hourly_rate));
  const tippedRate = Math.max(0, input.tippedRate ?? Number(existing.tipped_rate));
  const active = input.active ?? Boolean(existing.active);
  const scheduleColor = input.scheduleColor === undefined
    ? String(existing.schedule_color || scheduleColorFromId(String(existing.id)))
    : validScheduleColor(input.scheduleColor);

  if (!name) throw new Error("Employee name is required.");
  if (!position) throw new Error("Employee position is required.");
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new Error("Employee email is invalid.");
  if (input.smsOptIn && !phone) throw new Error("Add a mobile phone number before enabling SMS notifications.");
  const pin = input.pin ? await assertEmployeePinAvailable({ business: input.business, pin: validateEmployeePin(input.business, input.pin, name), employeeName: name, excludeEmployeeId: input.id }) : "";
  const pinRecord = pin ? createEmployeePinRecord(input.business, pin, name) : null;

  const duplicate = await sql`
    SELECT id FROM employees
    WHERE business = ${input.business} AND id <> ${input.id}
      AND LOWER(BTRIM(name)) = LOWER(BTRIM(${name})) LIMIT 1
  ` as unknown as Array<{ id: string }>;
  if (duplicate[0]) throw new Error("Another employee at this location already uses that name.");

  const rows = await sql`
    UPDATE employees SET
      email = ${email}, phone = ${phone}, sms_opt_in = ${smsOptIn},
      name = ${name}, position = ${position}, role_group = ${roleGroup},
      counts_for_tips = ${countsForTips}, hourly_rate = ${hourlyRate}, tipped_rate = ${tippedRate},
      active = ${active}, schedule_color = ${scheduleColor},
      pin_hash = CASE WHEN ${pin} <> '' THEN ${pinRecord?.hash || ""} ELSE pin_hash END,
      pin_salt = CASE WHEN ${pin} <> '' THEN ${pinRecord?.salt || ""} ELSE pin_salt END,
      pin_hash_version = CASE WHEN ${pin} <> '' THEN ${pinRecord?.version || 1} ELSE pin_hash_version END,
      pin_fingerprint = CASE WHEN ${pin} <> '' THEN ${pinRecord?.fingerprint || ""} ELSE pin_fingerprint END,
      pin_enabled = CASE WHEN ${pin} <> '' THEN TRUE ELSE pin_enabled END,
      session_version = CASE WHEN ${pin} <> '' OR active <> ${active} THEN session_version + 1 ELSE session_version END,
      updated_at = NOW()
    WHERE id = ${input.id} AND business = ${input.business}
    RETURNING id, email, phone, sms_opt_in, name, position, role_group, counts_for_tips,
      hourly_rate, tipped_rate, pin_enabled, active, schedule_color, profile_photo_pathname, chat_nickname
  ` as unknown as Array<Record<string, unknown>>;

  if (name !== String(existing.name)) {
    await Promise.all([
      sql`UPDATE time_entries SET employee_name = ${name}, updated_at = NOW() WHERE employee_id = ${input.id}`,
      sql`UPDATE employee_messages SET sender_name = ${name} WHERE sender_employee_id = ${input.id}`,
      input.business === "Corner Deli"
        ? sql`UPDATE rezku_shifts SET employee_name = ${name} WHERE LOWER(BTRIM(employee_name)) = LOWER(BTRIM(${String(existing.name)}))`
        : Promise.resolve([]),
    ]);
  }

  const row = rows[0];
  if (Boolean(existing.active) && !Boolean(row.active)) {
    await sql`
      UPDATE schedule_shifts
      SET employee_id = NULL,
        status = 'Draft',
        published_at = NULL,
        notes = CASE
          WHEN COALESCE(notes, '') LIKE '%Released after employee was archived.%' THEN notes
          WHEN BTRIM(COALESCE(notes, '')) = '' THEN 'Released after employee was archived.'
          ELSE BTRIM(notes) || E'\nReleased after employee was archived.'
        END,
        updated_at = NOW()
      WHERE employee_id = ${input.id}
        AND status <> 'Cancelled'
        AND ends_at >= NOW()
    `;
  }

  return {
    id: String(row.id), email: String(row.email || ""), phone: String(row.phone || ""),
    smsOptIn: Boolean(row.sms_opt_in), name: String(row.name), position: String(row.position),
    roleGroup: row.role_group as "Driver" | "In-House" | "Ignore",
    countsForTips: Boolean(row.counts_for_tips), hourlyRate: Number(row.hourly_rate || 0),
    tippedRate: Number(row.tipped_rate || 0), pinEnabled: Boolean(row.pin_enabled),
    active: Boolean(row.active), scheduleColor: String(row.schedule_color),
    avatarSet: Boolean(row.profile_photo_pathname), chatNickname: String(row.chat_nickname || ""),
  };
}
