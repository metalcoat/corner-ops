import assert from "node:assert/strict";
import test from "node:test";
import { employeeI9ValidationErrors, employerI9ValidationErrors } from "../src/lib/i9-validation";

test("lawful permanent resident requires USCIS or A-Number", () => {
  assert.ok(employeeI9ValidationErrors({ citizenshipStatus: "permanent-resident" }).some((error) => error.includes("A-Number")));
  assert.equal(employeeI9ValidationErrors({ citizenshipStatus: "permanent-resident", uscisOrAlienNumber: "123456789" }).length, 0);
});

test("authorized noncitizen requires work authorization identity details", () => {
  const errors = employeeI9ValidationErrors({ citizenshipStatus: "authorized-alien" });
  assert.ok(errors.some((error) => error.includes("expiration")));
  assert.ok(errors.some((error) => error.includes("USCIS/A-Number")));
});

test("employer List A completion requires title issuer and number", () => {
  const errors = employerI9ValidationErrors({
    documentMethod: "List A",
    firstDayOfEmployment: "2026-08-24",
    employerTitle: "Owner",
  });
  assert.equal(errors.length, 3);
  assert.equal(employerI9ValidationErrors({
    documentMethod: "List A",
    firstDayOfEmployment: "2026-08-24",
    employerTitle: "Owner",
    listATitle: "U.S. Passport",
    listAIssuer: "U.S. Department of State",
    listANumber: "example",
  }).length, 0);
});

test("employer List B and C completion requires both document sets", () => {
  const errors = employerI9ValidationErrors({
    documentMethod: "List B and C",
    firstDayOfEmployment: "2026-08-24",
    employerTitle: "Owner",
    listBTitle: "Driver License",
    listBIssuer: "NY DMV",
    listBNumber: "example",
  });
  assert.ok(errors.some((error) => error.includes("List C")));
});
