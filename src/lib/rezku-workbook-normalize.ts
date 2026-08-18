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
    "Punch In", "Punch-In", "Punch In Time", "Time In", "In Time", "In", "Start", "Start Time",
    "Actual Clock In", "Actual In",
  ],
  clockOut: [
    "Clock Out", "Clock-Out", "Clock Out Time", "Clock-Out Time", "Clocked Out", "Clocked Out At",
    "Punch Out", "Punch-Out", "Punch Out Time", "Time Out", "Out Time", "Out", "End", "End Time",
    "Actual Clock Out", "Actual Out",
  ],
  regularHours: [
    "Regular Hours", "Reg Hours", "Reg", "Worked Hours", "Hours Worked", "Total Hours", "Hours",
  ],
  overtimeHours: ["Overtime Hours", "OT Hours", "Overtime", "OT"],
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function excelWallDateTime(value: Date): string {
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}`;
}

function dateText(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getUTCFullYear();
    if (year <= 1901) return "";
    return `${year}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }

  const text = clean(value);
  if (!text) return "";

  let match = text.match(/(?:^|\D)(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:\D|$)/);
  if (match) return `${match[1]}-${pad(Number(match[2]))}-${pad(Number(match[3]))}`;

  match = text.match(/(?:^|\D)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:\D|$)/);
  if (match) {
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? (rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear) : rawYear;
    return `${year}-${pad(Number(match[1]))}-${pad(Number(match[2]))}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())}`;
}

function clockText(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const hour = value.getUTCHours();
    const minute = value.getUTCMinutes();
    const second = value.getUTCSeconds();
    if (value.getUTCFullYear() <= 1901 && hour === 0 && minute === 0 && second === 0) return "";
    return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
  }

  const text = clean(value);
  if (!text || /^(?:0|1\/0\/00|1\/0\/1900)$/i.test(text)) return "";
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!match) return "";

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const meridiem = match[4]?.toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return "";
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
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

function fullDateTime(dateValue: unknown, timeValue: unknown): string {
  const date = dateText(dateValue) || dateText(timeValue);
  const time = clockText(timeValue);
  return date && time ? `${date} ${time}` : "";
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
    const commonDate = dateText(valueFor(row, map, "date"));
    const clockIn = fullDateTime(valueFor(row, map, "clockInDate") || commonDate, valueFor(row, map, "clockIn"));
    const clockOut = fullDateTime(valueFor(row, map, "clockOutDate") || commonDate, valueFor(row, map, "clockOut"));
    const regularHours = valueFor(row, map, "regularHours");
    const overtimeHours = valueFor(row, map, "overtimeHours");

    // Detailed Labor includes totals and earnings summaries with hours but no actual punches.
    // Those are not shifts and must not become missing-punch exceptions.
    if (!clockIn && !clockOut) continue;

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

function normalizeDataSheetDateTimes(sheet: XLSX.WorkSheet): XLSX.WorkSheet {
  // Rezku can format a true Excel datetime cell as date-only (for example 8/10/26).
  // Reading the displayed value with raw:false discards the fractional-day time even though
  // it is still present in the workbook. Read underlying typed values first, then turn Date
  // objects into explicit wall-clock strings before the normal importer reads the workbook.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: true,
    blankrows: false,
  }) as Matrix;

  const preserved = matrix.map((row) => row.map((value) => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return excelWallDateTime(value);
    return value;
  }));

  return XLSX.utils.aoa_to_sheet(preserved);
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
    const nextSheet = kind === "shifts"
      ? normalizeShiftSheet(sheetName, sheet)
      : kind === "orders" || kind === "transactions"
        ? normalizeDataSheetDateTimes(sheet)
        : sheet;
    if (!nextSheet) continue;
    XLSX.utils.book_append_sheet(output, nextSheet, sheetName.slice(0, 31));
  }

  if (!output.SheetNames.length) throw new Error("The Rezku workbook contained no data sheets after removing Cover.");
  return bufferToArrayBuffer(XLSX.write(output, { type: "buffer", bookType: "xlsx" }) as Buffer);
}
