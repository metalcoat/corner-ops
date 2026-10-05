import assert from "node:assert/strict";
import test from "node:test";
import { publicEmployeeHubUrl, publicTeamBaseUrl } from "../src/lib/public-team-url";

test("production employee links use each business's team domain", () => {
  const prior = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  try {
    assert.equal(publicTeamBaseUrl("Corner Deli"), "https://team.ordercornerdeli.com");
    assert.equal(publicTeamBaseUrl("Tiki"), "https://team.atthedocks.com");
    assert.equal(publicEmployeeHubUrl("Corner Deli"), "https://team.ordercornerdeli.com/employee?business=Corner%20Deli");
    assert.equal(publicEmployeeHubUrl("Tiki"), "https://team.atthedocks.com/employee?business=Tiki");
  } finally {
    if (prior === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prior;
  }
});

test("development links retain the development URL", () => {
  const priorEnv = process.env.VERCEL_ENV;
  const priorAppUrl = process.env.EMPLOYEE_APP_URL;
  delete process.env.VERCEL_ENV;
  process.env.EMPLOYEE_APP_URL = "https://dev.ordercornerdeli.com/employee";
  try {
    assert.equal(publicEmployeeHubUrl("Corner Deli"), "https://dev.ordercornerdeli.com/employee?business=Corner%20Deli");
  } finally {
    if (priorEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = priorEnv;
    if (priorAppUrl === undefined) delete process.env.EMPLOYEE_APP_URL;
    else process.env.EMPLOYEE_APP_URL = priorAppUrl;
  }
});
