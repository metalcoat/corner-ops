import assert from "node:assert/strict";
import test from "node:test";
import { I9_COPY_NOTE, I9_DOCUMENT_CHOICES, i9DocumentsComplete, i9FileProblem } from "../src/lib/i9-document-rules";
import { employeeOnboardingSteps, onboardingChecklist, type OnboardingFacts } from "../src/lib/employee-onboarding-rules";

test("I-9 copies: List A alone, or List B + List C, the employee's choice", () => {
  assert.equal(i9DocumentsComplete(["A"]), true);
  assert.equal(i9DocumentsComplete(["B"]), false);
  assert.equal(i9DocumentsComplete(["B", "C"]), true);
  assert.equal(i9DocumentsComplete([]), false);
  assert.ok(I9_DOCUMENT_CHOICES.A.length && I9_DOCUMENT_CHOICES.B.length && I9_DOCUMENT_CHOICES.C.length);
  assert.match(I9_COPY_NOTE, /original documents in person within 3 business days/);
  assert.match(I9_COPY_NOTE, /every employee/);
});

test("only photos and PDFs up to 10 MB", () => {
  assert.equal(i9FileProblem({ contentType: "image/jpeg", size: 2_000_000 }), "");
  assert.equal(i9FileProblem({ contentType: "application/pdf", size: 500_000 }), "");
  assert.match(i9FileProblem({ contentType: "text/plain", size: 10 }), /photo/);
  assert.match(i9FileProblem({ contentType: "image/png", size: 11 * 1024 * 1024 }), /10 MB/);
});

const facts = (overrides: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  textStatus: "sent", textSentAt: null, linkExpiresAt: null, linkUsable: true, accountSet: true,
  formsAssigned: 5, formsSigned: 5, formsAwaitingEmployer: 1, handbookRequired: true, handbookAcknowledged: false,
  directDeposit: "assigned", appSignIns: 0, payrollReliefEeNum: null, payrollReliefApplies: false, hourlyRateSet: true,
  i9Assigned: true, i9DocumentsUploaded: false, ...overrides,
});

test("I-9 document copies are their own step, before the handbook", () => {
  const mine = employeeOnboardingSteps(facts());
  assert.deepEqual(mine.map((step) => [step.key, step.status]), [["account", "done"], ["forms", "done"], ["i9docs", "waiting"], ["handbook", "locked"], ["deposit", "optional"], ["app", "locked"]]);
  const manager = onboardingChecklist(facts({ i9DocumentsUploaded: true }));
  assert.equal(manager.find((step) => step.key === "i9docs")?.status, "done");
  assert.match(manager.find((step) => step.key === "i9docs")?.detail || "", /originals in person/);
  assert.equal(onboardingChecklist(facts({ i9Assigned: false })).some((step) => step.key === "i9docs"), false);
});
