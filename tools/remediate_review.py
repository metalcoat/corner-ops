from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text()


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one exact match, found {count}: {old[:80]!r}")
    write(path, text.replace(old, new, 1))


def sub_once(path: str, pattern: str, repl: str, flags: int = 0) -> None:
    text = read(path)
    next_text, count = re.subn(pattern, lambda _match: repl, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}: {pattern[:100]!r}")
    write(path, next_text)


# CO-004 / CO-005: one payroll engine and one DST-safe 4 AM payroll week.
replace_once(
    "src/lib/payroll-summary-rules.ts",
    'import { getSql } from "@/lib/db";\nimport type { Business } from "@/lib/types";\n',
    'import { getSql } from "@/lib/db";\nimport { payrollWeekBounds as weekBounds } from "@/lib/payroll-week";\nimport type { Business } from "@/lib/types";\n',
)
sub_once(
    "src/lib/payroll-summary-rules.ts",
    r'\nfunction getOffsetMilliseconds\(date: Date\): number \{.*?\nfunction localHour\(date: Date\): number \{',
    '\nfunction localHour(date: Date): number {',
    re.S,
)

replace_once(
    "src/lib/payroll-control.ts",
    'import { payrollSummary } from "@/lib/payroll-summary-rules";\nimport type { Business } from "@/lib/types";\n',
    'import { payrollSummary } from "@/lib/payroll-summary-rules";\nimport { payrollWeekBounds as weekBounds } from "@/lib/payroll-week";\nimport type { Business } from "@/lib/types";\n',
)
sub_once(
    "src/lib/payroll-control.ts",
    r'\nfunction getOffsetMilliseconds\(date: Date, timeZone: string\): number \{.*?\nexport async function ensurePayrollControlSchema',
    '\nexport async function ensurePayrollControlSchema',
    re.S,
)

replace_once(
    "src/lib/payroll-control-dashboard.ts",
    'import { repairRezkuOrderTimesForPayroll } from "@/lib/repair-rezku-order-times";\nimport type { Business } from "@/lib/types";\n',
    'import { repairRezkuOrderTimesForPayroll } from "@/lib/repair-rezku-order-times";\nimport { addDateKeyDays, payrollWeekBounds } from "@/lib/payroll-week";\nimport type { Business } from "@/lib/types";\n',
)
sub_once(
    "src/lib/payroll-control-dashboard.ts",
    r'\nfunction getOffsetMilliseconds\(date: Date, timeZone: string\): number \{.*?\nfunction timestamp\(value: unknown\): string \| null \{',
    '''\nfunction weekBounds(weekStart: string) {\n  const { start, end } = payrollWeekBounds(weekStart);\n  const adjustmentStart = payrollWeekBounds(addDateKeyDays(weekStart, -14)).start;\n  return { start, end, adjustmentStart };\n}\n\nfunction timestamp(value: unknown): string | null {''',
    re.S,
)

replace_once(
    "src/lib/overtime-risk.ts",
    'import { notifyOwnersOfOperationalAlert } from "@/lib/owner-operational-alerts";\nimport type { Business } from "@/lib/types";\n\nconst TIME_ZONE = "America/New_York";\nconst WORKWEEK_START_HOUR = 0;\n',
    'import { notifyOwnersOfOperationalAlert } from "@/lib/owner-operational-alerts";\nimport { currentPayrollWeekStart, payrollWeekBounds } from "@/lib/payroll-week";\nimport type { Business } from "@/lib/types";\n\nconst TIME_ZONE = "America/New_York";\n',
)
sub_once(
    "src/lib/overtime-risk.ts",
    r'\nfunction getOffsetMilliseconds\(date: Date, timeZone: string\): number \{.*?\nfunction riskLevel\(hours: number\): RiskLevel \{',
    '''\nexport function currentOvertimeWeekStart(value = new Date()): string {\n  return currentPayrollWeekStart(value);\n}\n\nfunction workweekBounds(requestedWeekStart?: string) {\n  const weekStart = requestedWeekStart && /^\\d{4}-\\d{2}-\\d{2}$/.test(requestedWeekStart)\n    ? requestedWeekStart\n    : currentOvertimeWeekStart();\n  const { start, end } = payrollWeekBounds(weekStart);\n  return { weekStart, start, end };\n}\n\nfunction riskLevel(hours: number): RiskLevel {''',
    re.S,
)

replace_once(
    "src/lib/scheduler.ts",
    'import { payrollSummary } from "@/lib/operations";\n',
    'import { payrollSummary } from "@/lib/payroll-summary-rules";\n',
)

replace_once(
    "src/app/api/operations/route.ts",
    '  listRecentTimeEntries,\n  listRezkuImports,\n  payrollSummary,\n  updateEmployee,\n} from "@/lib/operations";\n',
    '  listRecentTimeEntries,\n  listRezkuImports,\n  updateEmployee,\n} from "@/lib/operations";\nimport { payrollSummary } from "@/lib/payroll-summary-rules";\nimport { addDateKeyDays, currentPayrollWeekStart } from "@/lib/payroll-week";\n',
)
replace_once(
    "src/app/api/operations/route.ts",
    '      return Response.json(await payrollSummary(business, url.searchParams.get("weekStart") || undefined));\n',
    '      const weekStart = url.searchParams.get("weekStart") || addDateKeyDays(currentPayrollWeekStart(), -7);\n      return Response.json(await payrollSummary(business, weekStart));\n',
)

# Remove the legacy payroll engine and its duplicated week/tip rules from operations.ts.
sub_once(
    "src/lib/operations.ts",
    r'\nfunction getOffsetMilliseconds\(date: Date, timeZone: string\): number \{.*?\nfunction reportType\(filename: string, requested\?: string\): "shifts" \| "orders" \| "transactions" \{',
    '\nfunction reportType(filename: string, requested?: string): "shifts" | "orders" | "transactions" {',
    re.S,
)
text = read("src/lib/operations.ts")
text = re.sub(r'\nconst TIME_ZONE = "America/New_York";\nconst TIP_MULTIPLIER = 0\.965;\nconst CUTOFF_HOUR = 15;\nconst DRIVER_GRACE_MINUTES = 35;\n', '\n', text, count=1)
text = re.sub(r'\ntype ShiftLike = \{.*?\n\};\n\ntype TipTransaction = \{.*?\n\};\n', '\n', text, count=1, flags=re.S)
write("src/lib/operations.ts", text)

# CO-007: parse Rezku wall-clock timestamps correctly at ingestion, not by repair afterward.
replace_once(
    "src/lib/rezku-eastern-time.ts",
    'function rezkuDateTime(dateValue: unknown, timeValue: unknown): Date | null {',
    'export function rezkuDateTime(dateValue: unknown, timeValue: unknown): Date | null {',
)
replace_once(
    "src/lib/rezku-eastern-time.ts",
    '''  return easternDate(date, fullTime || { hour: 0, minute: 0, second: 0 });\n}\n\nfunction repairedRaw''',
    '''  return easternDate(date, fullTime || { hour: 0, minute: 0, second: 0 });\n}\n\nexport function rezkuNextDayDateTime(dateValue: unknown, timeValue: unknown): Date | null {\n  if (explicitInstant(timeValue)) return null;\n  const date = dateParts(dateValue) || dateParts(timeValue);\n  const time = timeParts(timeValue);\n  if (!date || !time) return null;\n  const next = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));\n  next.setUTCDate(next.getUTCDate() + 1);\n  return easternDate({\n    year: next.getUTCFullYear(),\n    month: next.getUTCMonth() + 1,\n    day: next.getUTCDate(),\n  }, time);\n}\n\nfunction repairedRaw''',
)
replace_once(
    "src/lib/operations.ts",
    'import { ensureSchema, getSql } from "@/lib/db";\nimport type { Business } from "@/lib/types";\n',
    'import { ensureSchema, getSql } from "@/lib/db";\nimport { rezkuDateTime, rezkuNextDayDateTime } from "@/lib/rezku-eastern-time";\nimport type { Business } from "@/lib/types";\n',
)
text = read("src/lib/operations.ts")
text = text.replace('combineDateAndTime(dateValue, rowLookup(row, ["Clock In", "In", "Start", "Start Time", "Time In"]))', 'rezkuDateTime(dateValue, rowLookup(row, ["Clock In", "In", "Start", "Start Time", "Time In"]))')
text = text.replace('combineDateAndTime(dateValue, rowLookup(row, ["Clock Out", "Out", "End", "End Time", "Time Out"]))', 'rezkuDateTime(dateValue, rowLookup(row, ["Clock Out", "Out", "End", "End Time", "Time Out"]))')
text = text.replace('combineDateAndTime(dateValue, orderOpenedLookup(row))', 'rezkuDateTime(dateValue, orderOpenedLookup(row))')
text = text.replace('combineDateAndTime(dateValue, rowLookup(row, ["Transaction Time", "Payment Time", "Created At", "Time"]))', 'rezkuDateTime(dateValue, rowLookup(row, ["Transaction Time", "Payment Time", "Created At", "Time"]))')
old_rollover = '''      if (clockIn && clockOut && clockOut.getTime() < clockIn.getTime()) {\n        clockOut = new Date(clockOut.getTime() + 24 * 60 * 60 * 1000);\n      }'''
new_rollover = '''      if (clockIn && clockOut && clockOut.getTime() < clockIn.getTime()) {\n        clockOut = rezkuNextDayDateTime(\n          dateValue,\n          rowLookup(row, ["Clock Out", "Out", "End", "End Time", "Time Out"]),\n        ) || clockOut;\n      }'''
if old_rollover not in text:
    raise RuntimeError("operations.ts: Rezku shift rollover block not found")
text = text.replace(old_rollover, new_rollover, 1)
text, count = re.subn(r'\nfunction combineDateAndTime\(dateValue: unknown, timeValue: unknown\): Date \| null \{.*?\n\}\n\nfunction roleFromPosition', '\nfunction roleFromPosition', text, count=1, flags=re.S)
if count != 1:
    raise RuntimeError("operations.ts: combineDateAndTime block not removed")
write("src/lib/operations.ts", text)

# CO-035 / CO-036: use New York wall-clock construction and calendar dates for overnight shifts.
replace_once(
    "src/app/ops/workforce/schedule-board.tsx",
    '  newYorkDateKey,\n  newYorkTimeValue,\n  shiftTimeForSelectedDay,\n',
    '  newYorkDateKey,\n  newYorkDateTime,\n  newYorkTimeValue,\n  shiftTimeForSelectedDay,\n',
)
replace_once("src/app/ops/workforce/schedule-board.tsx", 'const DAY_MS = 86_400_000;\n', '')
sub_once(
    "src/app/ops/workforce/schedule-board.tsx",
    r'function startOfMonday\(date: Date\): Date \{.*?\nfunction localTime\(value: string\): string \{',
    '''function dateFromKey(value: string): Date {\n  return new Date(`${value}T12:00:00Z`);\n}\n\nfunction addDays(date: Date, days: number): Date {\n  const result = new Date(date);\n  result.setUTCDate(result.getUTCDate() + days);\n  return result;\n}\n\nfunction dateKey(date: Date): string {\n  return date.toISOString().slice(0, 10);\n}\n\nfunction startOfMonday(date: Date): Date {\n  const localKey = newYorkDateKey(date);\n  const localNoon = dateFromKey(localKey);\n  const daysSinceMonday = (localNoon.getUTCDay() + 6) % 7;\n  return addDays(localNoon, -daysSinceMonday);\n}\n\nfunction localTime(value: string): string {''',
    re.S,
)
replace_once(
    "src/app/ops/workforce/schedule-board.tsx",
    '''function dateFromParts(day: string, time: string): Date {\n  const result = new Date(`${day}T${time}:00`);\n  if (Number.isNaN(result.getTime())) throw new Error("Shift date or time is invalid.");\n  return result;\n}\n\nfunction editorDates(editor: EditorState) {\n  const start = dateFromParts(editor.date, editor.startTime);\n  let end = dateFromParts(editor.date, editor.endTime);\n  if (end <= start) end = new Date(end.getTime() + DAY_MS);''',
    '''function dateFromParts(day: string, time: string): Date {\n  return newYorkDateTime(day, time);\n}\n\nfunction editorDates(editor: EditorState) {\n  const start = dateFromParts(editor.date, editor.startTime);\n  let end = dateFromParts(editor.date, editor.endTime);\n  if (end <= start) end = dateFromParts(dateKey(addDays(dateFromKey(editor.date), 1)), editor.endTime);''',
)

write("src/lib/schedule-time-range.ts", '''import { newYorkDateKey, newYorkDateTime, newYorkTimeValue } from "@/lib/schedule-meal-compliance";\n\nfunction dateValue(value: unknown, label: string): Date {\n  const result = new Date(String(value || ""));\n  if (Number.isNaN(result.getTime())) throw new Error(`${label} is invalid.`);\n  return result;\n}\n\nfunction addDateKeyDays(value: string, days: number): string {\n  const date = new Date(`${value}T12:00:00Z`);\n  date.setUTCDate(date.getUTCDate() + days);\n  return date.toISOString().slice(0, 10);\n}\n\nexport function normalizeScheduleTimeRange(startsAt: unknown, endsAt: unknown) {\n  const start = dateValue(startsAt, "Shift start");\n  let end = dateValue(endsAt, "Shift end");\n\n  if (end <= start) {\n    end = newYorkDateTime(\n      addDateKeyDays(newYorkDateKey(start), 1),\n      newYorkTimeValue(end),\n    );\n  }\n\n  if (end <= start) throw new Error("Shift end must be after the start.");\n  const localStartKey = newYorkDateKey(start);\n  const maximumEnd = newYorkDateTime(addDateKeyDays(localStartKey, 1), newYorkTimeValue(start));\n  if (end > maximumEnd) throw new Error("A scheduled shift cannot exceed 24 wall-clock hours.");\n\n  return { start, end };\n}\n''')

# CO-039: any >6-hour shift overlapping the noon period gets its meal inside the overlap.
replace_once(
    "src/lib/schedule-meal-compliance.ts",
    '''    if (start < windowStart && end > windowEnd) {\n      const midpointMs = start.getTime() + (end.getTime() - start.getTime()) / 2;\n      const earliest = windowStart.getTime();\n      const latest = windowEnd.getTime() - 30 * MINUTE_MS;\n      const suggestedMs = clamp(roundDownQuarter(midpointMs - 15 * MINUTE_MS), earliest, latest);''',
    '''    const overlapStart = Math.max(start.getTime(), windowStart.getTime());\n    const overlapEnd = Math.min(end.getTime(), windowEnd.getTime());\n    if (overlapEnd - overlapStart >= 30 * MINUTE_MS) {\n      const midpointMs = start.getTime() + (end.getTime() - start.getTime()) / 2;\n      const earliest = overlapStart;\n      const latest = overlapEnd - 30 * MINUTE_MS;\n      const suggestedMs = clamp(roundDownQuarter(midpointMs - 15 * MINUTE_MS), earliest, latest);''',
)
replace_once(
    "src/lib/schedule-meal-compliance.ts",
    '        windowStart: windowStart.toISOString(),\n        windowEnd: windowEnd.toISOString(),\n',
    '        windowStart: new Date(overlapStart).toISOString(),\n        windowEnd: new Date(overlapEnd).toISOString(),\n',
)

print("Stage 1 CODEBASEREVIEW transformations applied.")
