from pathlib import Path

workforce = Path('src/lib/workforce.ts')
text = workforce.read_text()

old = '''      SELECT t.*, e.name AS employee_name
      FROM time_off_requests t
      JOIN employees e ON e.id = t.employee_id
      WHERE t.business = ${business}'''
new = '''      SELECT t.*,
        t.starts_on::text AS starts_on,
        t.ends_on::text AS ends_on,
        e.name AS employee_name
      FROM time_off_requests t
      JOIN employees e ON e.id = t.employee_id
      WHERE t.business = ${business}'''
if old not in text:
    raise SystemExit('workforce admin time-off query not found')
text = text.replace(old, new, 1)

old = '''      SELECT * FROM time_off_requests
      WHERE employee_id = ${session.employeeId}
      ORDER BY created_at DESC LIMIT 100'''
new = '''      SELECT *,
        starts_on::text AS starts_on,
        ends_on::text AS ends_on
      FROM time_off_requests
      WHERE employee_id = ${session.employeeId}
      ORDER BY created_at DESC LIMIT 100'''
if old not in text:
    raise SystemExit('employee time-off query not found')
text = text.replace(old, new, 1)
workforce.write_text(text)

page = Path('src/app/ops/workforce/page.tsx')
text = page.read_text()
old = '''function dateOnly(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}'''
new = '''function dateOnly(value: string) {
  const raw = String(value || "").trim();
  const match = /^(\\d{4})-(\\d{2})-(\\d{2})/.exec(raw);
  if (!match) return "Invalid date";
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return date.toLocaleDateString([], {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}'''
if old not in text:
    raise SystemExit('dateOnly formatter not found')
page.write_text(text.replace(old, new, 1))
