// Payroll Relief (AccountantsOffice) timesheet: reads the "Download Excel" CSV of
// the open payroll, fills in Corner Deli's approved hours and tips, and checks the
// totals Payroll Relief shows after the upload. Also guesses which Payroll Relief
// employee each Corner Ops name is. Used by the app and by the store server's
// payroll job (deploy/supplier-scraper/payroll-relief.mjs), which runs it with
// Node's TypeScript support, so this file must stay self-contained: no imports,
// only erasable type syntax.
//
// The CSV looks like:
//   Firm:,,Whalen  Davey & Looney  CPA LLP,,,Firm Code:,,Whale1910
//   Employer:,,Mike's Corner Deli  LLC,,,Client Code:,,471907494
//   Pay Period:,,9/28/2026 to 10/4/2026
//   ...
//   ,,S/H,Reg,Sick,TipWa,PCTip,OT,SPOH,DED426434
//   Emp,Employee,Salaried,Regular,Sick,TipWage,Paycheck Tips,Overtime,Spread of Hours,Overpayment
//   Num,Name,/ Hourly,Hours,Hours,Hours,Amount,Hours,Hours,Amount
//   26,Allen  Gregory M.,H,39.97,,,81.6800,,,,,
// (commas inside names are written as two spaces: "Allen  Gregory M." is "Allen, Gregory M.").

/** What Corner Ops enters: Reg = regular hours, TipWa = driver (tipped-wage) hours, PCTip = tips, OT = overtime hours. */
export type HoursTotals = { reg: number; tipHours: number; tips: number; ot: number };

export type TimesheetEmployee = {
  /** Index into Timesheet.lines. */
  line: number;
  num: string;
  name: string;
  /** "H" hourly or "S" salaried. */
  payType: string;
  cells: string[];
};

export type Timesheet = {
  lines: string[];
  eol: string;
  firm: string;
  employer: string;
  clientCode: string;
  /** ISO dates (YYYY-MM-DD). */
  periodStart: string;
  periodEnd: string;
  payDate: string;
  schedule: string;
  columns: { payType: number; reg: number; tipHours: number; tips: number; ot: number };
  employees: TimesheetEmployee[];
};

export type RosterEntry = { num: string; name: string; payType: string };

// ---------------------------------------------------------------------------
// CSV

/** One CSV line into cells (quoted cells may hold commas and doubled quotes). */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvLine(cells: string[]): string {
  return cells.map(csvCell).join(",");
}

/** "81.6800" → 81.68, "$1,234.50" → 1234.5, "" → 0. */
export function amount(value: unknown): number {
  const text = String(value ?? "").replace(/[$,\s]/g, "");
  if (!text) return 0;
  const negative = /^\(.*\)$/.test(text);
  const parsed = Number(text.replace(/[()]/g, ""));
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -parsed : parsed;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** "9/28/2026" → "2026-09-28"; "" when it isn't a date. */
export function usDateToIso(value: string): string {
  const match = String(value || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return "";
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Reading the timesheet

const REQUIRED_CODES = { payType: "S/H", reg: "Reg", tipHours: "TipWa", tips: "PCTip", ot: "OT" } as const;

/** Reads Payroll Relief's timesheet CSV. Throws with a plain message when it doesn't look like one. */
export function parseTimesheet(text: string): Timesheet {
  const source = String(text || "").replace(/^﻿/, "");
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const rows = lines.map(parseCsvLine);
  const codesAt = rows.findIndex((cells) => cells.some((c) => c.trim() === "Reg") && cells.some((c) => c.trim() === "PCTip"));
  if (codesAt < 0) throw new Error("The downloaded timesheet has no Reg / PCTip columns; Payroll Relief's file format may have changed.");
  const codes = rows[codesAt].map((c) => c.trim());
  const column = (code: string) => codes.indexOf(code);
  const columns = {
    payType: column(REQUIRED_CODES.payType),
    reg: column(REQUIRED_CODES.reg),
    tipHours: column(REQUIRED_CODES.tipHours),
    tips: column(REQUIRED_CODES.tips),
    ot: column(REQUIRED_CODES.ot),
  };
  const missing = (Object.keys(columns) as Array<keyof typeof columns>).filter((key) => columns[key] < 0).map((key) => REQUIRED_CODES[key]);
  if (missing.length) throw new Error(`The downloaded timesheet is missing the ${missing.join(", ")} column(s).`);

  // "Label:" cells before the column codes, each followed by its value.
  const labels = new Map<string, string>();
  for (const cells of rows.slice(0, codesAt)) {
    for (let index = 0; index < cells.length; index++) {
      const label = cells[index].trim();
      if (!label.endsWith(":")) continue;
      const value = cells.slice(index + 1).find((c) => c.trim() && !c.trim().endsWith(":"));
      if (value !== undefined) labels.set(label.slice(0, -1).trim().toLowerCase(), value.trim());
    }
  }
  const period = (labels.get("pay period") || "").split(/\s+to\s+/i);

  const employees: TimesheetEmployee[] = [];
  for (let index = codesAt + 1; index < rows.length; index++) {
    const cells = rows[index];
    const num = (cells[0] || "").trim();
    const name = (cells[1] || "").trim();
    // The two caption rows under the codes ("Emp,Employee,..." and "Num,Name,...") and blank or total lines aren't employees.
    if (!/^[A-Za-z0-9-]+$/.test(num) || !name || /^(emp|num|total)/i.test(num) || /^total/i.test(name)) continue;
    employees.push({ line: index, num, name, payType: (cells[columns.payType] || "").trim().toUpperCase(), cells });
  }
  return {
    lines,
    eol,
    firm: labels.get("firm") || "",
    employer: labels.get("employer") || "",
    clientCode: labels.get("client code") || "",
    periodStart: usDateToIso(period[0] || ""),
    periodEnd: usDateToIso(period[1] || ""),
    payDate: usDateToIso(labels.get("pay date") || ""),
    schedule: labels.get("pay schedule") || "",
    columns,
    employees,
  };
}

export function timesheetRoster(sheet: Timesheet): RosterEntry[] {
  return sheet.employees.map((e) => ({ num: e.num, name: e.name, payType: e.payType }));
}

/** Totals of Reg, TipWa, PCTip and OT over every employee line (salaried ones included), as Payroll Relief's Totals row adds them. */
export function timesheetTotals(sheet: Timesheet): HoursTotals {
  const totals = { reg: 0, tipHours: 0, tips: 0, ot: 0 };
  for (const employee of sheet.employees) {
    totals.reg += amount(employee.cells[sheet.columns.reg]);
    totals.tipHours += amount(employee.cells[sheet.columns.tipHours]);
    totals.tips += amount(employee.cells[sheet.columns.tips]);
    totals.ot += amount(employee.cells[sheet.columns.ot]);
  }
  return { reg: round2(totals.reg), tipHours: round2(totals.tipHours), tips: round2(totals.tips), ot: round2(totals.ot) };
}

export function timesheetText(sheet: Timesheet): string {
  return sheet.lines.join(sheet.eol);
}

// ---------------------------------------------------------------------------
// Filling it in

/** A Corner Deli payroll summary row (payroll_run_versions.payload.rows). */
export type PayrollRowInput = {
  employee: string;
  regularHours?: number;
  overtimeHours?: number;
  driverTipHours?: number;
  tips?: number;
};

/** How names are matched to saved mappings: case and spacing don't matter. */
export function employeeKey(name: string): string {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function rowAmounts(row: PayrollRowInput): HoursTotals {
  return {
    reg: round2(Number(row.regularHours || 0)),
    tipHours: round2(Number(row.driverTipHours || 0)),
    tips: round2(Number(row.tips || 0)),
    ot: round2(Number(row.overtimeHours || 0)),
  };
}

function isZero(t: HoursTotals): boolean {
  return !t.reg && !t.tipHours && !t.tips && !t.ot;
}

function fmt(value: number): string {
  return value ? round2(value).toFixed(2) : "";
}

export type TimesheetPlan = {
  /** The filled timesheet (same lines, only mapped hourly employees' Reg/TipWa/PCTip/OT changed). */
  sheet: Timesheet;
  text: string;
  entries: Array<{ employees: string[]; num: string; rosterName: string; amounts: HoursTotals }>;
  /** Mapped hourly employees with nothing this week whose earlier entries were cleared. */
  cleared: Array<{ num: string; rosterName: string; before: HoursTotals }>;
  /** Anything that must be fixed before the timesheet may be uploaded. */
  problems: string[];
  notes: string[];
  totals: HoursTotals;
};

/**
 * Fills the downloaded timesheet with the approved payroll rows. mapping: employeeKey(Corner Ops name) → EE #.
 * Only Reg, TipWa, PCTip and OT of mapped hourly (H) employees are written; Sick, SPOH, Overpay, salaried
 * employees and employees nobody in Corner Ops is matched to stay exactly as downloaded.
 */
export function planTimesheet(source: Timesheet, rows: PayrollRowInput[], mapping: Record<string, string>): TimesheetPlan {
  const sheet: Timesheet = { ...source, lines: [...source.lines], employees: source.employees.map((e) => ({ ...e, cells: [...e.cells] })) };
  const byNum = new Map(sheet.employees.map((e) => [e.num, e]));
  const problems: string[] = [];
  const notes: string[] = [];
  const wanted = new Map<string, { employees: string[]; amounts: HoursTotals }>();

  for (const row of rows) {
    const name = String(row.employee || "").trim();
    if (!name || /^(unallocated|cover)$/i.test(name)) continue;
    const amounts = rowAmounts(row);
    const num = String(mapping[employeeKey(name)] || "").trim();
    if (!num) {
      if (!isZero(amounts)) problems.push(`${name} has hours or tips but isn't matched to a Payroll Relief employee (choose one under AccountantsOffice employees on the payroll page).`);
      continue;
    }
    const target = byNum.get(num);
    if (!target) {
      if (!isZero(amounts)) problems.push(`${name} is matched to EE #${num}, who isn't on Payroll Relief's timesheet for this payroll.`);
      continue;
    }
    if (target.payType === "S") {
      if (!isZero(amounts)) notes.push(`${name} (EE #${num}) is salaried in Payroll Relief; left as it is.`);
      continue;
    }
    const entry = wanted.get(num) || { employees: [], amounts: { reg: 0, tipHours: 0, tips: 0, ot: 0 } };
    entry.employees.push(name);
    entry.amounts = {
      reg: round2(entry.amounts.reg + amounts.reg),
      tipHours: round2(entry.amounts.tipHours + amounts.tipHours),
      tips: round2(entry.amounts.tips + amounts.tips),
      ot: round2(entry.amounts.ot + amounts.ot),
    };
    wanted.set(num, entry);
  }
  for (const [num, entry] of wanted) {
    if (entry.employees.length > 1) notes.push(`${entry.employees.join(" and ")} are all matched to EE #${num}; their hours and tips were added together.`);
  }

  const mappedNums = new Set(Object.values(mapping).map((n) => String(n || "").trim()).filter(Boolean));
  const c = sheet.columns;
  const current = (e: TimesheetEmployee): HoursTotals => ({ reg: amount(e.cells[c.reg]), tipHours: amount(e.cells[c.tipHours]), tips: amount(e.cells[c.tips]), ot: amount(e.cells[c.ot]) });
  const write = (e: TimesheetEmployee, t: HoursTotals) => {
    while (e.cells.length <= Math.max(c.reg, c.tipHours, c.tips, c.ot)) e.cells.push("");
    e.cells[c.reg] = fmt(t.reg);
    e.cells[c.tipHours] = fmt(t.tipHours);
    e.cells[c.tips] = fmt(t.tips);
    e.cells[c.ot] = fmt(t.ot);
    sheet.lines[e.line] = csvLine(e.cells);
  };

  const entries: TimesheetPlan["entries"] = [];
  const cleared: TimesheetPlan["cleared"] = [];
  for (const employee of sheet.employees) {
    if (employee.payType === "S") continue;
    const entry = wanted.get(employee.num);
    if (entry) {
      write(employee, entry.amounts);
      entries.push({ employees: entry.employees, num: employee.num, rosterName: employee.name, amounts: entry.amounts });
    } else if (mappedNums.has(employee.num)) {
      // Matched to someone in Corner Ops who has nothing this week: Corner Ops' numbers (none) are the entry.
      const before = current(employee);
      if (!isZero(before)) cleared.push({ num: employee.num, rosterName: employee.name, before });
      write(employee, { reg: 0, tipHours: 0, tips: 0, ot: 0 });
    } else {
      const before = current(employee);
      if (!isZero(before)) notes.push(`EE #${employee.num} ${employee.name} isn't matched to anyone in Corner Ops; left as it is (${formatTotals(before)}).`);
    }
  }
  return { sheet, text: timesheetText(sheet), entries, cleared, problems, notes, totals: timesheetTotals(sheet) };
}

// ---------------------------------------------------------------------------
// Payroll Relief's screens

/** "... Payroll (#42) for Period 9/28/2026-10/4/2026 and Pay Date 10/09/2026" → ISO dates. */
export function parsePayrollEntryPeriod(text: string): { start: string; end: string; payDate: string } | null {
  const match = String(text || "").match(/for\s+Period\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:-|–|to)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (!match) return null;
  const pay = String(text).match(/Pay\s+Date\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  return { start: usDateToIso(match[1]), end: usDateToIso(match[2]), payDate: pay ? usDateToIso(pay[1]) : "" };
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "2026-09-28" → "9/28". */
export function shortDate(isoDate: string): string {
  const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${Number(match[2])}/${Number(match[3])}` : String(isoDate || "");
}

/** The Monday–Sunday payroll week as "9/28–10/4". */
export function weekRangeLabel(weekStart: string): string {
  return `${shortDate(weekStart)}–${shortDate(addDays(weekStart, 6))}`;
}

/** null when Payroll Relief's open payroll is the approved week (Monday weekStart through Sunday). */
export function periodMismatch(open: { start: string; end: string } | null, weekStart: string): string | null {
  const weekEnd = addDays(weekStart, 6);
  if (!open || !open.start || !open.end) return `Payroll Relief has no open payroll showing a period; expected ${weekRangeLabel(weekStart)}.`;
  if (open.start === weekStart && open.end === weekEnd) return null;
  return `Payroll Relief's open payroll is ${shortDate(open.start)}–${shortDate(open.end)}, not ${weekRangeLabel(weekStart)}.`;
}

export type GridCell = { text: string; span?: number };

function expand(cells: GridCell[]): string[] {
  const out: string[] = [];
  for (const cell of cells) {
    const span = Math.max(1, Math.min(50, Number(cell.span || 1)));
    out.push(String(cell.text || "").replace(/\s+/g, " ").trim());
    for (let index = 1; index < span; index++) out.push("");
  }
  return out;
}

const GRID_COLUMNS: Array<[keyof HoursTotals, RegExp]> = [
  ["reg", /^reg\b/i],
  ["tipHours", /^tipwa\b/i],
  ["tips", /^pc ?tip/i],
  // "OT Hrs", not "Qualified OT".
  ["ot", /^ot\b/i],
];

/**
 * Reg / TipWa / PCTip / OT from the payroll entry grid's header cells and its Totals row (colspans
 * expanded). When the two rows have a different number of columns they are lined up from the right.
 */
export function gridTotals(header: GridCell[], totalsRow: GridCell[]): HoursTotals | null {
  const heads = expand(header);
  const values = expand(totalsRow);
  const offset = values.length - heads.length;
  const out: Partial<HoursTotals> = {};
  for (const [key, pattern] of GRID_COLUMNS) {
    const at = heads.findIndex((h) => pattern.test(h));
    if (at < 0) return null;
    const value = values[at + offset];
    if (value === undefined) return null;
    out[key] = round2(amount(value));
  }
  return out as HoursTotals;
}

/** What differs between the file's totals and the grid's (to the cent). */
export function compareTotals(expected: HoursTotals, actual: HoursTotals): string[] {
  const labels: Record<keyof HoursTotals, string> = { reg: "Reg", tipHours: "TipWa", tips: "PCTip", ot: "OT" };
  return (Object.keys(labels) as Array<keyof HoursTotals>)
    .filter((key) => Math.abs(round2(expected[key]) - round2(actual[key])) > 0.005)
    .map((key) => `${labels[key]} ${round2(actual[key]).toFixed(2)} in Payroll Relief vs ${round2(expected[key]).toFixed(2)} in the file`);
}

export function formatTotals(t: HoursTotals): string {
  return `Reg ${round2(t.reg).toFixed(2)}, Tipped ${round2(t.tipHours).toFixed(2)}, Tips $${round2(t.tips).toFixed(2)}, OT ${round2(t.ot).toFixed(2)}`;
}

/** Words on a control the payroll job may never press (it only uploads and saves; the owner submits). */
export const FORBIDDEN_CONTROL = /submit|approv|finali[sz]e|process|transmit|send to|commit|release/i;

// ---------------------------------------------------------------------------
// Matching Corner Ops names to Payroll Relief employees

const NICKNAMES: string[][] = [
  ["greg", "gregory"], ["mike", "michael", "mikey"], ["chris", "christopher", "christian"], ["matt", "matthew"],
  ["nick", "nicholas", "nicolas"], ["tom", "thomas", "tommy"], ["will", "bill", "william", "billy", "liam"],
  ["bob", "rob", "robert", "bobby", "robbie"], ["jim", "jimmy", "james", "jamie"], ["joe", "joseph", "joey"],
  ["dan", "danny", "daniel"], ["dave", "david"], ["steve", "steven", "stephen"], ["tony", "anthony"],
  ["alex", "alexander", "alexandra", "alexis"], ["sam", "samuel", "samantha", "sammy"], ["ben", "benjamin"],
  ["jon", "john", "jonathan", "johnny", "jack"], ["kate", "katie", "katherine", "kathryn", "catherine", "kathy"],
  ["liz", "beth", "elizabeth", "lizzie", "eliza"], ["jen", "jenny", "jennifer"], ["abby", "abigail"],
  ["maddie", "madison", "madeline", "madelyn"], ["nate", "nathan", "nathaniel"], ["zach", "zack", "zachary"],
  ["jake", "jacob"], ["andy", "drew", "andrew"], ["pat", "patrick", "patricia"], ["rick", "rich", "richard", "dick"],
  ["ed", "eddie", "edward"], ["ken", "kenny", "kenneth"], ["ron", "ronald"], ["don", "donald"], ["larry", "lawrence"],
  ["jeff", "jeffrey"], ["josh", "joshua"], ["tim", "timothy"], ["pete", "peter"], ["charlie", "charles", "chuck"],
  ["frank", "francis"], ["hank", "henry"], ["al", "albert", "alan", "allen"], ["vince", "vincent"],
  ["sean", "shawn", "shaun"], ["meg", "megan", "margaret", "maggie"], ["sue", "susan", "suzanne"],
  ["becky", "rebecca"], ["vicky", "victoria"], ["tori", "victoria"], ["gabe", "gabriel"], ["gabby", "gabrielle", "gabriella"],
  ["mo", "maureen"], ["lexi", "alexis", "alexa"], ["cam", "cameron"], ["manny", "manuel"], ["javi", "javier"],
];

function normalizeName(value: string): string {
  return String(value || "").toLowerCase().replace(/[.'’]/g, "").replace(/[^a-z\s-]/g, " ").replace(/\s+/g, " ").trim();
}

/** "Allen  Gregory M." (Payroll Relief's "Last, First Middle") → { last: "allen", first: "gregory" }. */
export function splitRosterName(name: string): { last: string; first: string; display: string } {
  const raw = String(name || "").trim();
  const parts = raw.split(/\s{2,}|,\s*/).filter(Boolean);
  let last: string;
  let rest: string;
  if (parts.length >= 2) {
    last = parts[0];
    rest = parts.slice(1).join(" ");
  } else {
    const tokens = raw.split(/\s+/);
    last = tokens[0] || "";
    rest = tokens.slice(1).join(" ");
  }
  const first = normalizeName(rest).split(" ")[0] || "";
  return { last: normalizeName(last), first, display: `${rest} ${last}`.replace(/\s+/g, " ").trim() };
}

/** Same first name, a known nickname (Greg ↔ Gregory), or one is the start of the other (at least 3 letters). */
export function firstNamesMatch(a: string, b: string): "exact" | "nickname" | null {
  const x = normalizeName(a), y = normalizeName(b);
  if (!x || !y) return null;
  if (x === y) return "exact";
  if (NICKNAMES.some((group) => group.includes(x) && group.includes(y))) return "nickname";
  if (Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x))) return "nickname";
  return null;
}

export type RosterGuess = { num: string; reason: string; score: number };

function cap(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function bestFor(name: string, roster: RosterEntry[]): RosterGuess | null {
  const tokens = normalizeName(name).split(" ").filter(Boolean);
  if (!tokens.length) return null;
  const people = roster.map((entry) => ({ entry, ...splitRosterName(entry.name) }));
  const scored: RosterGuess[] = [];
  if (tokens.length >= 2) {
    const first = tokens[0], last = tokens[tokens.length - 1];
    for (const p of people) {
      const forward = firstNamesMatch(first, p.first);
      const backward = firstNamesMatch(last, p.first);
      if (p.last === last && forward === "exact") scored.push({ num: p.entry.num, score: 100, reason: "same first and last name" });
      else if (p.last === last && forward) scored.push({ num: p.entry.num, score: 90, reason: `${cap(first)} ↔ ${cap(p.first)}, same last name` });
      else if (p.last === first && backward) scored.push({ num: p.entry.num, score: 80, reason: "same name, written last name first" });
      else if (last.length === 1 && p.last.startsWith(last) && forward) scored.push({ num: p.entry.num, score: 70, reason: `${cap(p.first)} ${last.toUpperCase()}.` });
    }
  } else {
    const only = tokens[0];
    const exact = people.filter((p) => firstNamesMatch(only, p.first) === "exact");
    const close = people.filter((p) => firstNamesMatch(only, p.first));
    const lastNames = people.filter((p) => p.last === only);
    if (exact.length === 1) scored.push({ num: exact[0].entry.num, score: 65, reason: `the only ${cap(exact[0].first)} in Payroll Relief` });
    else if (!exact.length && close.length === 1) scored.push({ num: close[0].entry.num, score: 60, reason: `${cap(only)} ↔ ${cap(close[0].first)}, the only one in Payroll Relief` });
    else if (!close.length && lastNames.length === 1) scored.push({ num: lastNames[0].entry.num, score: 40, reason: "same last name" });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  // Two equally good matches: no guess.
  if (scored[1] && scored[1].score === scored[0].score) return null;
  return scored[0];
}

/**
 * Best guess of each Corner Ops name's Payroll Relief employee, for the owner to confirm. Employees already
 * taken (saved mappings) aren't guessed for anyone else, and one Payroll Relief employee is guessed for at most
 * one name (the better match; neither when equally good).
 */
export function guessRosterMatches(names: string[], roster: RosterEntry[], taken: string[] = []): Record<string, RosterGuess | null> {
  const takenSet = new Set(taken.map(String));
  const open = roster.filter((entry) => !takenSet.has(entry.num));
  const result: Record<string, RosterGuess | null> = {};
  for (const name of names) result[name] = bestFor(name, open);
  const byNum = new Map<string, string[]>();
  for (const [name, guess] of Object.entries(result)) if (guess) byNum.set(guess.num, [...(byNum.get(guess.num) || []), name]);
  for (const claimants of byNum.values()) {
    if (claimants.length < 2) continue;
    const ranked = claimants.map((name) => ({ name, score: result[name]!.score })).sort((a, b) => b.score - a.score);
    const keep = ranked[0].score > ranked[1].score ? ranked[0].name : null;
    for (const { name } of ranked) if (name !== keep) result[name] = null;
  }
  return result;
}

/** "Allen  Gregory M." → "Gregory M. Allen". */
export function rosterDisplayName(name: string): string {
  return splitRosterName(name).display || String(name || "");
}
