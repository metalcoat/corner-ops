import assert from "node:assert/strict";
import test from "node:test";
import {
  inviteUsable,
  newOnboardingToken,
  onboardingChecklist,
  onboardingComplete,
  onboardingExpiry,
  onboardingLink,
  onboardingSmsLogOnly,
  onboardingSmsText,
  onboardingTokenHash,
  validOnboardingTokenShape,
  type OnboardingFacts,
} from "../src/lib/employee-onboarding-rules";
import { CORNER_DELI_HANDBOOK_SECTIONS } from "../src/lib/corner-deli-handbook";
import { teamRoute } from "../src/lib/team-domain-routing";

const facts = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  textStatus: "sent", textSentAt: "Nov 6, 3:00 PM", linkExpiresAt: "Nov 13, 3:00 PM", linkUsable: true,
  accountSet: false, formsAssigned: 4, formsSigned: 0, formsAwaitingEmployer: 0,
  handbookRequired: true, handbookAcknowledged: false, directDeposit: "assigned", appSignIns: 0,
  payrollReliefEeNum: null, payrollReliefApplies: true, hourlyRateSet: true, ...overrides,
});

test("setup tokens are random, URL-safe, and stored only as a hash", () => {
  const a = newOnboardingToken();
  const b = newOnboardingToken();
  assert.notEqual(a, b);
  assert.equal(validOnboardingTokenShape(a), true);
  assert.equal(validOnboardingTokenShape("short"), false);
  assert.equal(validOnboardingTokenShape(`${a.slice(0, 31)}/`), false);
  assert.match(onboardingTokenHash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(onboardingTokenHash(a), onboardingTokenHash(b));
  assert.equal(onboardingTokenHash(a).includes(a), false);
});

test("links expire after seven days and stop working once replaced", () => {
  const now = new Date("2026-11-06T20:00:00Z");
  const expiresAt = onboardingExpiry(now);
  assert.equal(expiresAt.toISOString(), "2026-11-13T20:00:00.000Z");
  assert.equal(inviteUsable({ expiresAt, revokedAt: null }, now), true);
  assert.equal(inviteUsable({ expiresAt, revokedAt: null }, new Date("2026-11-13T20:00:01Z")), false);
  assert.equal(inviteUsable({ expiresAt, revokedAt: new Date("2026-11-07T00:00:00Z") }, now), false);
  assert.equal(inviteUsable(null, now), false);
});

test("the setup text names Corner Deli, the store phone and the personal link", () => {
  const link = onboardingLink("https://team.ordercornerdeli.com/", "T".repeat(32));
  assert.equal(link, `https://team.ordercornerdeli.com/employee/welcome/${"T".repeat(32)}`);
  const text = onboardingSmsText({ name: "Jamie Lee", link });
  assert.match(text, /^Corner Deli: Welcome to the team, Jamie!/);
  assert.ok(text.includes(link));
  assert.ok(text.includes("315-393-2271"));
  assert.ok(text.includes("expires in 7 days"));
  assert.ok(text.includes("STOP"));
  assert.ok(!/PIN is \d/.test(text), "the text must not carry a PIN");
  assert.ok(text.length <= 320, `text is ${text.length} characters`);
});

test("off production the text is only logged unless the number is a listed test number", () => {
  assert.equal(onboardingSmsLogOnly("315-555-0123", {}), true);
  assert.equal(onboardingSmsLogOnly("315-555-0123", { TELNYX_API_KEY: "k", TELNYX_FROM_NUMBER: "+13155550000" }), false);
  assert.equal(onboardingSmsLogOnly("315-555-0123", { TELNYX_API_KEY: "k", TELNYX_FROM_NUMBER: "+13155550000", ONBOARDING_SMS_LOG_ONLY: "true" }), true);
  assert.equal(onboardingSmsLogOnly("+1 (315) 555-0123", { TELNYX_API_KEY: "k", TELNYX_FROM_NUMBER: "+13155550000", ONBOARDING_SMS_LOG_ONLY: "true", SMS_TEST_NUMBERS: "3155550123" }), false);
});

test("the manager checklist follows the new hire from text to payroll", () => {
  const start = onboardingChecklist(facts());
  assert.deepEqual(start.map((step) => step.key), ["text", "account", "forms", "handbook", "deposit", "app", "payroll"]);
  assert.equal(start.find((step) => step.key === "account")?.status, "waiting");
  assert.equal(onboardingComplete(start), false);

  const expired = onboardingChecklist(facts({ linkUsable: false }));
  assert.equal(expired[0].status, "manager");
  assert.match(expired[0].detail, /Resend/);

  const noRate = onboardingChecklist(facts({ hourlyRateSet: false }));
  assert.equal(noRate.find((step) => step.key === "pay")?.status, "manager");

  const i9 = onboardingChecklist(facts({ accountSet: true, formsSigned: 4, formsAwaitingEmployer: 1 }));
  assert.equal(i9.find((step) => step.key === "forms")?.status, "manager");

  const done = onboardingChecklist(facts({ accountSet: true, formsSigned: 4, handbookAcknowledged: true, appSignIns: 1, payrollReliefEeNum: "12" }));
  assert.equal(done.find((step) => step.key === "deposit")?.status, "optional");
  assert.equal(onboardingComplete(done), true);

  const tiki = onboardingChecklist(facts({ handbookRequired: false, payrollReliefApplies: false }));
  assert.equal(tiki.some((step) => step.key === "handbook" || step.key === "payroll"), false);
});

test("the handbook carries the zero-tolerance alcohol and no-smoking policies", () => {
  const text = (title: RegExp) => {
    const section = CORNER_DELI_HANDBOOK_SECTIONS.find((item) => title.test(item.title));
    assert.ok(section, `missing section ${title}`);
    return [...(section.paragraphs || []), ...(section.bullets || [])].join(" ");
  };
  const alcohol = text(/alcohol/i);
  assert.match(alcohol, /slightest hint of alcohol/);
  assert.match(alcohol, /immediate termination/);
  assert.match(alcohol, /company vehicle/);
  const smoking = text(/smoking/i);
  for (const place of ["inside the building", "out front of the store", "company vehicle"]) assert.ok(smoking.includes(place), place);
  assert.match(smoking, /vap/);
  assert.match(smoking, /cannabis/);
  const numbers = CORNER_DELI_HANDBOOK_SECTIONS.map((section) => Number(section.title.split(".")[0]));
  assert.deepEqual(numbers, numbers.map((_, index) => index + 1));
});

test("setup links and the moved People pages open on the team host", () => {
  assert.equal(teamRoute(`/employee/welcome/${"x".repeat(32)}`), "allow");
  assert.equal(teamRoute("/api/employee/onboarding"), "allow");
  assert.equal(teamRoute("/ops/people"), "home");
  for (const path of ["/ops/people/team", "/ops/people/team/abc", "/ops/people/add", "/ops/people/paperwork", "/ops/people/handbook"]) assert.equal(teamRoute(path), "allow", path);
});
