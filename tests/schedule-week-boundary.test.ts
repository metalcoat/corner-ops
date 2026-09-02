import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

test("schedule publication uses New York midnight boundaries through the end of Sunday", () => {
  const files = [
    "src/lib/schedule-publish-validation.ts",
    "src/lib/business-schedule-publication.ts",
    "src/lib/schedule-publication-sms.ts",
  ];
  for (const file of files) {
    const text = source(file);
    assert.equal(text.includes("::date AT TIME ZONE ${TIME_ZONE}"), false, `${file} still casts a date directly through AT TIME ZONE`);
    assert.equal(text.includes("::date::timestamp AT TIME ZONE ${TIME_ZONE}"), true, `${file} is missing an explicit local-midnight timestamp cast`);
    assert.equal(text.includes("::date + 7)::timestamp) AT TIME ZONE ${TIME_ZONE}"), true, `${file} is missing the corrected end-of-week boundary`);
  }
});
