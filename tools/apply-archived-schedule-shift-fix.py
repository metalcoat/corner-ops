from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1), encoding="utf-8")


def replace_in_section(path: str, start_marker: str, end_marker: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"Missing start marker in {path}: {start_marker!r}")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"Missing end marker in {path}: {end_marker!r}")
    section = text[start:end]
    count = section.count(old)
    if count != 1:
        raise SystemExit(f"Expected one section match in {path}, found {count}: {old[:120]!r}")
    section = section.replace(old, new, 1)
    file.write_text(text[:start] + section + text[end:], encoding="utf-8")


replace_once(
    "src/app/api/workforce/route.ts",
    '''    shifts: dashboard.shifts.map((shift) => {
      const meal = mealByShiftId.get(shift.id);
      return {
        ...shift,
        mealBreakStart: meal?.meal_break_start ? String(meal.meal_break_start) : null,
        mealBreakMinutes: Number(meal?.meal_break_minutes || 0),
        extraMealBreakStart: meal?.extra_meal_break_start ? String(meal.extra_meal_break_start) : null,
        extraMealBreakMinutes: Number(meal?.extra_meal_break_minutes || 0),
        employeeColor: shift.employeeId ? contactById.get(shift.employeeId)?.scheduleColor || "#64748B" : "#64748B",
        employeeAvatarSet: shift.employeeId ? contactById.get(shift.employeeId)?.avatarSet || false : false,
      };
    }),''',
    '''    shifts: dashboard.shifts.map((shift) => {
      const meal = mealByShiftId.get(shift.id);
      const assignedEmployee = shift.employeeId ? contactById.get(shift.employeeId) : undefined;
      const visibleEmployeeId = assignedEmployee?.active ? shift.employeeId : null;
      const releasedArchivedAssignment = Boolean(shift.employeeId && !visibleEmployeeId);
      return {
        ...shift,
        employeeId: visibleEmployeeId,
        employeeName: releasedArchivedAssignment ? "Open / unassigned" : shift.employeeName,
        status: releasedArchivedAssignment && shift.status === "Published" ? "Open" : shift.status,
        mealBreakStart: meal?.meal_break_start ? String(meal.meal_break_start) : null,
        mealBreakMinutes: Number(meal?.meal_break_minutes || 0),
        extraMealBreakStart: meal?.extra_meal_break_start ? String(meal.extra_meal_break_start) : null,
        extraMealBreakMinutes: Number(meal?.extra_meal_break_minutes || 0),
        employeeColor: visibleEmployeeId ? contactById.get(visibleEmployeeId)?.scheduleColor || "#64748B" : "#64748B",
        employeeAvatarSet: visibleEmployeeId ? contactById.get(visibleEmployeeId)?.avatarSet || false : false,
      };
    }),''',
)

replace_once(
    "src/lib/schedule-publish-validation.ts",
    '''    SELECT s.id, s.employee_id, e.name AS employee_name, s.starts_at, s.ends_at,
      s.meal_break_start, s.meal_break_minutes,''',
    '''    SELECT s.id,
      CASE WHEN e.active IS TRUE THEN s.employee_id ELSE NULL END AS employee_id,
      CASE WHEN e.active IS TRUE THEN e.name ELSE 'Open / unassigned' END AS employee_name,
      s.starts_at, s.ends_at,
      s.meal_break_start, s.meal_break_minutes,''',
)
replace_once(
    "src/lib/schedule-publish-validation.ts",
    '''      AND s.status <> 'Cancelled'
      AND t.status = 'Approved' ''',
    '''      AND s.status <> 'Cancelled'
      AND e.active = TRUE
      AND t.status = 'Approved' ''',
)

replace_once(
    "src/lib/business-schedule-publication.ts",
    '''    SELECT s.id, s.employee_id, e.name AS employee_name, s.position,
      s.starts_at, s.ends_at, s.meal_break_start, s.meal_break_minutes,''',
    '''    SELECT s.id,
      CASE WHEN e.active IS TRUE THEN s.employee_id ELSE NULL END AS employee_id,
      CASE WHEN e.active IS TRUE THEN e.name ELSE 'Open / unassigned' END AS employee_name,
      s.position, s.starts_at, s.ends_at, s.meal_break_start, s.meal_break_minutes,''',
)
replace_once(
    "src/lib/business-schedule-publication.ts",
    '''      sql`
        UPDATE schedule_shifts SET
          status = CASE WHEN employee_id IS NULL THEN 'Open' ELSE 'Published' END,
          published_at = NOW(), updated_at = NOW()
        WHERE business = ${input.business}
          AND starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
          AND starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
          AND status <> 'Cancelled'
      `,''',
    '''      sql`
        UPDATE schedule_shifts s SET
          employee_id = CASE
            WHEN s.employee_id IS NULL OR EXISTS (
              SELECT 1 FROM employees e
              WHERE e.id = s.employee_id AND e.business = s.business AND e.active = TRUE
            ) THEN s.employee_id
            ELSE NULL
          END,
          status = CASE
            WHEN s.employee_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM employees e
              WHERE e.id = s.employee_id AND e.business = s.business AND e.active = TRUE
            ) THEN 'Open'
            ELSE 'Published'
          END,
          published_at = NOW(), updated_at = NOW()
        WHERE s.business = ${input.business}
          AND s.starts_at >= (${input.weekStart}::date AT TIME ZONE ${TIME_ZONE})
          AND s.starts_at < ((${input.weekStart}::date + 7) AT TIME ZONE ${TIME_ZONE})
          AND s.status <> 'Cancelled'
      `,''',
)

archive_release = '''
  if (Boolean(existing.active) && !Boolean(row.active)) {
    await sql`
      UPDATE schedule_shifts
      SET employee_id = NULL,
        status = 'Draft',
        published_at = NULL,
        notes = CASE
          WHEN COALESCE(notes, '') LIKE '%Released after employee was archived.%' THEN notes
          WHEN BTRIM(COALESCE(notes, '')) = '' THEN 'Released after employee was archived.'
          ELSE BTRIM(notes) || E'\\nReleased after employee was archived.'
        END,
        updated_at = NOW()
      WHERE employee_id = ${input.id}
        AND status <> 'Cancelled'
        AND ends_at >= NOW()
    `;
  }
'''
replace_once(
    "src/lib/employee-directory-admin.ts",
    '''  const row = rows[0];
  return {''',
    '''  const row = rows[0];''' + archive_release + '''
  return {''',
)

replace_in_section(
    "src/lib/operations.ts",
    "export async function updateEmployee",
    "export async function punchTiki",
    '''  ` as unknown as EmployeeRow[];
  return mapEmployee(rows[0]);
}

''',
    '''  ` as unknown as EmployeeRow[];
  const updated = rows[0];
  if (current.active && updated && !updated.active) {
    await getSql()`
      UPDATE schedule_shifts
      SET employee_id = NULL,
        status = 'Draft',
        published_at = NULL,
        notes = CASE
          WHEN COALESCE(notes, '') LIKE '%Released after employee was archived.%' THEN notes
          WHEN BTRIM(COALESCE(notes, '')) = '' THEN 'Released after employee was archived.'
          ELSE BTRIM(notes) || E'\\nReleased after employee was archived.'
        END,
        updated_at = NOW()
      WHERE employee_id = ${input.id}
        AND status <> 'Cancelled'
        AND ends_at >= NOW()
    `;
  }
  return mapEmployee(updated);
}

''',
)

replace_once(
    "tools/apply-production-migrations.mjs",
    '''const [result] = await sql`
  SELECT''',
    '''await step("release future shifts assigned to archived employees", () => sql`
  UPDATE public.schedule_shifts s
  SET employee_id = NULL,
    status = 'Draft',
    published_at = NULL,
    notes = CASE
      WHEN COALESCE(s.notes, '') LIKE '%Released after employee was archived.%' THEN s.notes
      WHEN BTRIM(COALESCE(s.notes, '')) = '' THEN 'Released after employee was archived.'
      ELSE BTRIM(s.notes) || E'\\nReleased after employee was archived.'
    END,
    updated_at = NOW()
  FROM public.employees e
  WHERE s.employee_id = e.id
    AND e.active = FALSE
    AND s.status <> 'Cancelled'
    AND s.ends_at >= NOW()
`);

const [result] = await sql`
  SELECT''',
)

Path("tests/schedule-archived-employee-shifts.test.ts").write_text('''import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("workforce schedule exposes archived assignments as open instead of hiding a draft count", () => {
  const route = source("src/app/api/workforce/route.ts");
  assert.match(route, /const visibleEmployeeId = assignedEmployee\?\.active \? shift\.employeeId : null/);
  assert.match(route, /releasedArchivedAssignment/);
  assert.match(route, /employeeName: releasedArchivedAssignment \? "Open \/ unassigned"/);
});

test("publishing never assigns or notifies an archived employee", () => {
  const validation = source("src/lib/schedule-publish-validation.ts");
  const publication = source("src/lib/business-schedule-publication.ts");
  assert.match(validation, /CASE WHEN e\.active IS TRUE THEN s\.employee_id ELSE NULL END/);
  assert.match(publication, /CASE WHEN e\.active IS TRUE THEN s\.employee_id ELSE NULL END/);
  assert.match(publication, /NOT EXISTS \([\s\S]*e\.active = TRUE/);
});

test("archiving an employee releases future shifts and the production migration repairs old assignments", () => {
  const directory = source("src/lib/employee-directory-admin.ts");
  const operations = source("src/lib/operations.ts");
  const migrations = source("tools/apply-production-migrations.mjs");
  for (const text of [directory, operations, migrations]) {
    assert.match(text, /Released after employee was archived/);
    assert.match(text, /employee_id = NULL/);
  }
  assert.match(migrations, /release future shifts assigned to archived employees/);
});
''', encoding="utf-8")
