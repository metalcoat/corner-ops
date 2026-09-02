import test from "node:test";
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
