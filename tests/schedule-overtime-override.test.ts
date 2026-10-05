import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("schedule publishing keeps 38-plus hours as a warning and permits explicit overtime approval", () => {
  const board = source("src/app/ops/workforce/schedule-board.tsx");
  assert.match(board, /blockingIssueCount - publishAnalysis\.overForty\.length/);
  assert.match(board, /OVERTIME WARNING/);
  assert.match(board, /allowOvertime/);
  assert.match(board, /disabled=\{busy \|\| !weekShifts\.length\}/);
  assert.match(board, /Manager confirmation required to publish/);
  assert.doesNotMatch(board, /disabled=\{busy \|\| !weekShifts\.length \|\| schedulePublishBlocked/);
  assert.doesNotMatch(board, /disabled=\{busy \|\| !weekShifts\.length \|\| !publishAnalysis\.canPublish/);
  assert.match(board, /Click to see the schedule issues preventing publication/);
  assert.match(board, /open=\{schedulePublishBlocked \|\| overtimeApprovalRequired\}/);
});

test("server requires and records the manager overtime approval", () => {
  const validator = source("src/lib/schedule-publish-validation.ts");
  const route = source("src/app/api/workforce/route.ts");
  const publication = source("src/lib/business-schedule-publication.ts");
  assert.match(validator, /analysis\.overForty\.length && !input\.allowOvertime/);
  assert.match(validator, /overtimeOverride: input\.allowOvertime/);
  assert.match(route, /allowOvertime: body\.allowOvertime === true/);
  assert.match(publication, /overtimeOverride/);
  assert.match(publication, /approvedBy: input\.actor/);
  assert.match(publication, /approvedAt: new Date\(\)\.toISOString\(\)/);
});
