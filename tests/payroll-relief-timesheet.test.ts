import test from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_CONTROL,
  compareTotals,
  employeeKey,
  firstNamesMatch,
  formatTotals,
  gridTotals,
  guessRosterMatches,
  parseCsvLine,
  parsePayrollEntryPeriod,
  parseTimesheet,
  periodMismatch,
  planTimesheet,
  rosterDisplayName,
  splitRosterName,
  timesheetRoster,
  timesheetTotals,
  weekRangeLabel,
} from "../src/lib/payroll-relief-timesheet.js";

// The shape of Payroll Relief's "Download Excel" (a real export's layout, made-up values).
const DOWNLOAD = [
  "Firm:,,Whalen  Davey & Looney  CPA LLP,,,Firm Code:,,Whale1910",
  "Employer:,,Mike's Corner Deli  LLC,,,Client Code:,,471907494",
  "Pay Period:,,9/28/2026 to 10/4/2026",
  "Pay Schedule:,,Normal (Weekly)",
  "",
  "Pay Date:,,10/9/2026",
  "",
  ",,S/H,Reg,Sick,TipWa,PCTip,OT,SPOH,DED426434",
  "Emp,Employee,Salaried,Regular,Sick,TipWage,Paycheck Tips,Overtime,Spread of Hours,Overpayment",
  "Num,Name,/ Hourly,Hours,Hours,Hours,Amount,Hours,Hours,Amount",
  "26,Allen  Gregory M.,H,39.97,,,81.6800,,,,,",
  "41,Bush  Lillian,H,4.03,,,4.1200,,,,,",
  "33,Frary  Christopher,S,40.00,,,,,,,,",
  "52,Epprecht  Sean,H,,8.00,,,,1.00,,,",
  "57,Martell  Seth,H,12.00,,,,,,,,",
  "60,Nobody  Known,H,3.00,,,,,,,,",
  "",
].join("\r\n");

test("reads the header, columns and employees of the download", () => {
  const sheet = parseTimesheet(`﻿${DOWNLOAD}`);
  assert.equal(sheet.firm, "Whalen  Davey & Looney  CPA LLP");
  assert.equal(sheet.employer, "Mike's Corner Deli  LLC");
  assert.equal(sheet.clientCode, "471907494");
  assert.equal(sheet.periodStart, "2026-09-28");
  assert.equal(sheet.periodEnd, "2026-10-04");
  assert.equal(sheet.payDate, "2026-10-09");
  assert.deepEqual(sheet.columns, { payType: 2, reg: 3, tipHours: 5, tips: 6, ot: 7 });
  assert.equal(sheet.employees.length, 6);
  assert.deepEqual(timesheetRoster(sheet)[0], { num: "26", name: "Allen  Gregory M.", payType: "H" });
  assert.deepEqual(timesheetTotals(sheet), { reg: 99, tipHours: 0, tips: 85.8, ot: 0 });
});

test("refuses a file without the expected columns", () => {
  assert.throws(() => parseTimesheet("Emp,Name\n1,Someone"), /no Reg \/ PCTip columns/);
  assert.throws(() => parseTimesheet(",,S/H,Reg,Sick,PCTip\n1,A,H,1,,"), /missing the TipWa, OT column/);
});

test("CSV cells with quotes and commas", () => {
  assert.deepEqual(parseCsvLine('1,"Doe, ""Jo""",H,,'), ["1", 'Doe, "Jo"', "H", "", ""]);
});

test("fills Reg, TipWa, PCTip and OT of matched hourly employees only", () => {
  const sheet = parseTimesheet(DOWNLOAD);
  const plan = planTimesheet(sheet, [
    { employee: "Greg Allen", regularHours: 35.5, driverTipHours: 4.47, overtimeHours: 0, tips: 120.456 },
    { employee: "Lillian", regularHours: 10, driverTipHours: 0, overtimeHours: 1.25, tips: 20 },
    { employee: "Sean", regularHours: 0, driverTipHours: 0, overtimeHours: 0, tips: 0 },
    { employee: "Chris", regularHours: 5, driverTipHours: 0, overtimeHours: 0, tips: 0 },
  ], {
    [employeeKey("Greg Allen")]: "26",
    [employeeKey("lillian")]: "41",
    [employeeKey("Sean")]: "52",
    [employeeKey("Seth")]: "57",
    [employeeKey("Chris")]: "33",
  });
  assert.deepEqual(plan.problems, []);
  const lines = plan.text.split("\r\n");
  // Untouched header lines, line endings and the trailing blank line.
  assert.deepEqual(lines.slice(0, 10), DOWNLOAD.split("\r\n").slice(0, 10));
  assert.equal(lines[10], "26,Allen  Gregory M.,H,35.50,,4.47,120.46,,,,,");
  assert.equal(lines[11], "41,Bush  Lillian,H,10.00,,,20.00,1.25,,,,");
  // Salaried: left as downloaded, with a note.
  assert.equal(lines[12], "33,Frary  Christopher,S,40.00,,,,,,,,");
  assert.ok(plan.notes.some((note) => /Chris \(EE #33\) is salaried/.test(note)));
  // Sean has nothing this week: his four fields are blank, Sick and SPOH stay.
  assert.equal(lines[13], "52,Epprecht  Sean,H,,8.00,,,,1.00,,,");
  // Seth is matched but had no row: his earlier 12.00 is cleared.
  assert.equal(lines[14], "57,Martell  Seth,H,,,,,,,,,");
  assert.deepEqual(plan.cleared, [{ num: "57", rosterName: "Martell  Seth", before: { reg: 12, tipHours: 0, tips: 0, ot: 0 } }]);
  // Nobody in Corner Ops is EE #60: left alone, noted.
  assert.equal(lines[15], "60,Nobody  Known,H,3.00,,,,,,,,");
  assert.ok(plan.notes.some((note) => /EE #60 Nobody  Known isn't matched/.test(note)));
  assert.equal(lines[16], "");
  assert.deepEqual(plan.totals, { reg: 88.5, tipHours: 4.47, tips: 140.46, ot: 1.25 });
  assert.equal(formatTotals(plan.totals), "Reg 88.50, Tipped 4.47, Tips $140.46, OT 1.25");
  // The filled file reads back the same.
  assert.deepEqual(timesheetTotals(parseTimesheet(plan.text)), plan.totals);
  // The download itself was not changed.
  assert.equal(sheet.lines[14], "57,Martell  Seth,H,12.00,,,,,,,,");
});

test("an employee with hours but no match, or a match not in the file, is a problem", () => {
  const plan = planTimesheet(parseTimesheet(DOWNLOAD), [
    { employee: "New Person", regularHours: 4 },
    { employee: "Old Person", regularHours: 2, tips: 5 },
    { employee: "Idle Person", regularHours: 0 },
    { employee: "Unallocated", tips: 30 },
  ], { [employeeKey("Old Person")]: "999" });
  assert.equal(plan.problems.length, 2);
  assert.match(plan.problems[0], /New Person has hours or tips but isn't matched/);
  assert.match(plan.problems[1], /Old Person is matched to EE #999, who isn't on Payroll Relief's timesheet/);
});

test("two names matched to one employee are added together", () => {
  const plan = planTimesheet(parseTimesheet(DOWNLOAD), [
    { employee: "Ken", regularHours: 3, tips: 1 },
    { employee: "Kenny", regularHours: 2, tips: 2.5 },
  ], { ken: "41", kenny: "41" });
  assert.deepEqual(plan.entries[0].amounts, { reg: 5, tipHours: 0, tips: 3.5, ot: 0 });
  assert.ok(plan.notes.some((note) => /Ken and Kenny are all matched to EE #41/.test(note)));
});

test("the open payroll's period must be the approved Monday–Sunday week", () => {
  const text = "Standard Normal (Weekly) Payroll (#42) for Period 9/28/2026-10/4/2026 and Pay Date 10/09/2026 Payroll Submission Method -Excel Timesheet";
  const open = parsePayrollEntryPeriod(text);
  assert.deepEqual(open, { start: "2026-09-28", end: "2026-10-04", payDate: "2026-10-09" });
  assert.equal(periodMismatch(open, "2026-09-28"), null);
  assert.equal(
    periodMismatch(parsePayrollEntryPeriod("Payroll (#43) for Period 10/5/2026 - 10/11/2026 and Pay Date 10/16/2026"), "2026-09-28"),
    "Payroll Relief's open payroll is 10/5–10/11, not 9/28–10/4.",
  );
  assert.match(periodMismatch(null, "2026-09-28") || "", /no open payroll/);
  assert.equal(weekRangeLabel("2026-12-28"), "12/28–1/3");
});

test("grid totals by header, with colspans and a different column count", () => {
  const header = ["Pay", "EE #", "Employee", "Type (H/S)", "Reg Hrs", "Sick Hrs", "TipWa Hrs", "PCTip", "Qualified OT", "OT Hrs", "SPOH Hrs", "Overpay", "Hand Chk", "More"].map((text) => ({ text }));
  const totals = [{ text: "Totals", span: 4 }, { text: "88.50" }, { text: "8.00" }, { text: "4.47" }, { text: "$140.46" }, { text: "0.00" }, { text: "1.25" }, { text: "1.00" }, { text: "" }, { text: "" }, { text: "" }];
  assert.deepEqual(gridTotals(header, totals), { reg: 88.5, tipHours: 4.47, tips: 140.46, ot: 1.25 });
  // A totals row whose label cell covers the first columns without a colspan is lined up from the right.
  const shorter = [{ text: "Totals" }, ...totals.slice(1)];
  assert.deepEqual(gridTotals(header, shorter), { reg: 88.5, tipHours: 4.47, tips: 140.46, ot: 1.25 });
  assert.equal(gridTotals([{ text: "Employee" }], totals), null);
  assert.deepEqual(compareTotals({ reg: 88.5, tipHours: 4.47, tips: 140.46, ot: 1.25 }, { reg: 88.5, tipHours: 4.47, tips: 140.46, ot: 1.25 }), []);
  assert.deepEqual(compareTotals({ reg: 88.5, tipHours: 4.47, tips: 140.46, ot: 1.25 }, { reg: 88.5, tipHours: 4.47, tips: 140.45, ot: 1.25 }), ["PCTip 140.45 in Payroll Relief vs 140.46 in the file"]);
});

test("never presses a control that submits or approves payroll", () => {
  for (const word of ["Submit", "Review and Submit", "Approve", "Process Payroll", "Finalize"]) assert.ok(FORBIDDEN_CONTROL.test(word), word);
  for (const word of ["Save", "Upload", "OK", "Timesheet Options", "Download Excel", "Log in"]) assert.ok(!FORBIDDEN_CONTROL.test(word), word);
});

const ROSTER = [
  { num: "26", name: "Allen  Gregory M.", payType: "H" },
  { num: "41", name: "Bush  Lillian", payType: "H" },
  { num: "33", name: "Frary  Christopher", payType: "S" },
  { num: "52", name: "Epprecht  Sean", payType: "H" },
  { num: "57", name: "Martell  Seth", payType: "H" },
  { num: "70", name: "Smith  Michael", payType: "H" },
  { num: "71", name: "Jones  Michael", payType: "H" },
];

test("splits Payroll Relief's Last  First names", () => {
  assert.deepEqual(splitRosterName("Allen  Gregory M."), { last: "allen", first: "gregory", display: "Gregory M. Allen" });
  assert.equal(rosterDisplayName("Bush  Lillian"), "Lillian Bush");
  assert.equal(firstNamesMatch("Greg", "Gregory"), "nickname");
  assert.equal(firstNamesMatch("Bill", "William"), "nickname");
  assert.equal(firstNamesMatch("Sean", "Sean"), "exact");
  assert.equal(firstNamesMatch("Al", "Sean"), null);
});

test("guesses: full name with nickname, unique first names, and no guess when ambiguous", () => {
  const guesses = guessRosterMatches(["Greg Allen", "Sean", "Seth", "Lillian", "Chris Frary", "Mike", "Mike Jones", "Allen Greg", "Zed"], ROSTER);
  assert.equal(guesses["Greg Allen"]?.num, "26");
  assert.match(guesses["Greg Allen"]?.reason || "", /Greg ↔ Gregory, same last name/);
  // "Allen Greg" (last name first) also points at #26 but less surely, so only Greg Allen keeps it.
  assert.equal(guesses["Allen Greg"], null);
  assert.equal(guesses.Sean?.num, "52");
  assert.equal(guesses.Seth?.num, "57");
  assert.equal(guesses.Lillian?.num, "41");
  assert.equal(guesses["Chris Frary"]?.num, "33");
  // Two Michaels: "Mike" alone can't be told apart; "Mike Jones" can.
  assert.equal(guesses.Mike, null);
  assert.equal(guesses["Mike Jones"]?.num, "71");
  assert.equal(guesses.Zed, null);
});

test("employees already matched aren't guessed for someone else", () => {
  const guesses = guessRosterMatches(["Sean"], ROSTER, ["52"]);
  assert.equal(guesses.Sean, null);
  // Two names that both look like the only Seth: neither is guessed.
  const tie = guessRosterMatches(["Seth", "seth "], ROSTER);
  assert.equal(tie.Seth, null);
});
