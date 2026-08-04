import * as XLSX from "xlsx";

const COVER_SHEET = /^cover$/i;

type ReportKind = "shifts" | "orders" | "transactions";
type Matrix = unknown[][];

type HeaderField =
  | "employee"
  | "firstName"
  | "lastName"
  | "position"
  | "date"
  | "clockInDate"
  | "clockOutDate"
  | "clockIn"
  | "clockOut"
  | "regularHours"
  | "overtimeHours";

const HEADER_NAMES: Record<HeaderField, string[]> = {
  employee: [
    "Employee", "Employee Name", "Team Member", "Team Member Name", "Staff", "Staff Name",
    "Worker", "Worker Name", "User", "Server", "Cashier", "Name",
  ],
  firstName: ["First Name", "Employee First Name", "First"],
  lastName: ["Last Name", "Employee Last Name", "Last"],
  position: [
    "Position", "Position Name", "Job", "Job Name", "Role", "Role Name", "Job Title",
    "Labor Role", "Employee Role", "Clock In Role", "Department",
  ],
  date: ["Date", "Shift Date", "Business Date", "Work Date", "Labor Date"],
  clockInDate: [
    "Clock In Date", "Clock-In Date", "Clocked In Date", "Punch In Date", "Time In Date",
    "In Date", "Start Date",
  ],
  clockOutDate: [
    "Clock Out Date", "Clock-Out Date", "Clocked Out Date", "Punch Out Date", "Time Out Date",
    "Out Date", "End Date",
  ],
  clockIn: [
    "Clock In", "Clock-In", "Clock In Time", "Clock-In Time", "Clocked In", "Clocked In At",
    "Punch In", "Punch-In", "Punch In Time", "Time In", "In Time", "Start", "Start Time",
    "Actual Clock In", "Actual In",
  ],
  clockOut: [
    "Clock Out", "Clock-Out", "Clock Out Time", "Clock-Out Time", "Clocked Out", "Clocked Out At",
    "Punch Out", "Punch-Out", "Punch Out Time", "Time Out", "Out Time", "End", "End Time",
    "Actual Clock Out", "Actual Out",
  ],
  regularHours: [
    "Regular Hours", "Reg Hours", "Worked Hours", "Hours Worked", "Total Hours", "Hours",
  ],
  overtimeHours: ["Overtime Hours", "OT Hours", "Overtime", "OT"],
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FIELD_KEYS = Object.fromEntries(
  Object.entries(HEADER_NAMES).map(([field, names]) => [field, new Set(names.map(normalized))]),
) as Record<HeaderField, Set<string>>;

function reportKind(fileName: string, requestedType?: string): ReportKind | null {
  if (requestedType === "shifts" || requestedType === "orders" || requestedType === "transactions") return requestedType;
  const lower = fileName.toLowerCase();
  if (lower.includes("labor") || lower.includes("shift") || lower.includes("attestation") || lower.includes("timecard")) return "shifts";
  if (lower.includes("transaction") || lower.includes("payment")) return "transactions";
  if (lower.includes("order")) return "orders";
  return null;
}

function headerMap(row: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  row.forEach((value, index) => {
    const key = normalized(value);
    if (key && !map.has(key)) map.set(key, index);
  });
  return map;
}

function indexesFor(map: Map<string, number>, field: HeaderField): number[] {
  return [...FIELD_KEYS[field]].flatMap((key) => map.has(key) ? [map.get(key)!] : []);
}

function hasField(map: Map<string, number>, field: HeaderField): boolean {
  return indexesFor(map, field).length > 0;
}

function headerScore(row: unknown[]): number {
  const map = headerMap(row);
  let score = 0;
  if (hasField(map, "employee") || hasField(map, "firstName") || hasField(map, "lastName")) score += 5;
  if (hasField(map, "clockIn")) score += 5;
  if (hasField(map, "clockOut")) score += 5;
  if (hasField(map, "date") || hasField(map, "clockInDate")) score += 2;
  if (hasField(map, "position")) score += 1;
  if (hasField(map, "regularHours") || hasField(map, "overtimeHours")) score += 1;
  return score;
}

function findHeaderRow(matrix: Matrix): number {
  let bestIndex = -1;
  let bestScore = 0;
  const limit = Math.min(matrix.length, 40);
  for (let index = 0; index < limit; index += 1) {
    const score = headerScore(matrix[index] || []);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return bestScore >= 7 ? bestIndex : -1;
}

function valueFor(row: unknown[], map: Map<string, number>, field: HeaderField): unknown {
  for (const index of indexesFor(map, field)) {
    const value = row[index];
    if (value !== undefined && value !== null && clean(value) !== "") return value;
  }
  return "";
}

function joinedName(row: unknown[], map: Map<string, number>): string {
  const direct = clean(valueFor(row, map, "employee"));
  if (direct) return direct;
  return [clean(valueFor(row, map, "firstName")), clean(valueFor(row, map, "lastName"))]
    .filter(Boolean)
    .join(" ");
}

function fullDateTime(dateValue: unknown, timeValue: unknown): unknown {
  if (timeValue instanceof Date) return timeValue;
  const time = clean(timeValue);
  if (!time) return "";
  if (/\d{4}[-\/.]\d{1,2}[-\/.]\d{1,2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(time)) return timeValue;
  const date = clean(dateValue);
  return date ? `${date} ${time}` : timeValue;
}

function normalizeShiftSheet(sheetName: string, sheet: XLSX.WorkSheet): XLSX.WorkSheet | null {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
    dateNF: "yyyy-mm-dd hh:mm:ss",
    blankrows: false,
  }) as Matrix;

  const headerIndex = findHeaderRow(matrix);
  if (headerIndex < 0) return sheetName.toLowerCase() === "main" ? null : sheet;

  const map = headerMap(matrix[headerIndex]);
  const canonicalRows: Array<Record<string, unknown>> = [];
  for (const row of matrix.slice(headerIndex + 1)) {
    const employee = joinedName(row, map);
    const position = valueFor(row, map, "position");
    const commonDate = valueFor(row, map, "date");
    const clockIn = fullDateTime(valueFor(row, map, "clockInDate") || commonDate, valueFor(row, map, "clockIn"));
    const clockOut = fullDateTime(valueFor(row, map, "clockOutDate") || commonDate, valueFor(row, map, "clockOut"));
    const regularHours = valueFor(row, map, "regularHours");
    const overtimeHours = valueFor(row, map, "overtimeHours");
    const meaningful = employee || clean(clockIn) || clean(clockOut) || clean(regularHours) || clean(overtimeHours);
    if (!meaningful) continue;

    // Main is a shared attestation sheet, so every imported row must identify its employee.
    // Employee-specific Detailed Labor sheets may legitimately rely on their sheet name.
    if (sheetName.toLowerCase() === "main" && !employee) continue;

    canonicalRows.push({
      Employee: employee,
      Position: position,
      Date: commonDate,
      "Clock In": clockIn,
      "Clock Out": clockOut,
      "Regular Hours": regularHours,
      "Overtime Hours": overtimeHours,
    });
  }

  return XLSX.utils.json_to_sheet(canonicalRows, {
    header: ["Employee", "Position", "Date", "Clock In", "Clock Out", "Regular Hours", "Overtime Hours"],
  });
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

export function normalizeRezkuWorkbook(
  fileName: string,
  bytes: ArrayBuffer,
  requestedType?: string,
): ArrayBuffer {
  const workbook = XLSX.read(Buffer.from(bytes), { type: "buffer", cellDates: true });
  const kind = reportKind(fileName, requestedType);
  const output = XLSX.utils.book_new();

  for (const sheetName of workbook.SheetNames) {
    if (COVER_SHEET.test(sheetName.trim())) continue;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const nextSheet = kind === "shifts" ? normalizeShiftSheet(sheetName, sheet) : sheet;
    if (!nextSheet) continue;
    XLSX.utils.book_append_sheet(output, nextSheet, sheetName.slice(0, 31));
  }

  if (!output.SheetNames.length) throw new Error("The Rezku workbook contained no data sheets after removing Cover.");
  return bufferToArrayBuffer(XLSX.write(output, { type: "buffer", bookType: "xlsx" }) as Buffer);
}
