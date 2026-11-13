// The nightly till email: one table for every till and its change bag, then the discrepancies.
// Pure, so it is unit-tested; ordering-registers.ts gathers the closeouts and sends it.
import { DENOMINATIONS, type DenominationCounts, type FloatIssue, type ResetPlan } from "./till-reset-rules";

export type TillCloseout = {
  closedBy: string;
  closedAt: string;
  counted: DenominationCounts | null;
  checksCents: number;
  countedCents: number;
  expectedCents: number;
  overShortCents: number;
  resetTargetCents: number;
  leftCents: number;
  resetNote: string;
  plan: ResetPlan | null;
};
/** label: "Front till" / "Back till". closeout null = not closed out that business day. */
export type TillReportInput = { name: string; label: string; closeout: TillCloseout | null };
export type Discrepancy = { where: string; issue: string; amountCents: number | null };

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const signed = (cents: number) => (cents > 0 ? `+${money(cents)}` : money(cents));
const short = (label: string) => label.replace(/ bills$/, "");
const escape = (value: string) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const time = (value: string) => new Date(value).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

type Column = { title: string; till: TillReportInput; bag: boolean };

export function closeoutDiscrepancies(tills: TillReportInput[]): Discrepancy[] {
  const rows: Discrepancy[] = [];
  for (const till of tills) {
    const c = till.closeout;
    if (!c) { rows.push({ where: till.label, issue: "Not closed out", amountCents: null }); continue; }
    if (c.overShortCents !== 0) rows.push({ where: till.label, issue: c.overShortCents > 0 ? "Drawer over" : "Drawer short", amountCents: c.overShortCents });
    if (c.leftCents !== c.resetTargetCents) rows.push({ where: till.label, issue: `Left ${money(c.leftCents)} instead of ${money(c.resetTargetCents)}${c.resetNote ? `: ${c.resetNote}` : ""}`, amountCents: c.leftCents - c.resetTargetCents });
    // Closeouts saved before discrepancies had amounts only have their flag text.
    const issues = (plan: { issues?: FloatIssue[]; flags: string[] }): Array<{ issue: string; amountCents: number | null }> => plan.issues ?? plan.flags.map((flag) => ({ issue: flag, amountCents: null }));
    if (c.plan) for (const issue of issues(c.plan)) rows.push({ where: till.label, ...issue });
    if (c.plan?.bag) for (const issue of issues(c.plan.bag)) rows.push({ where: "Change bag", ...issue });
  }
  return rows;
}

function columns(tills: TillReportInput[]): Column[] {
  return tills.flatMap((till) => [{ title: till.label, till, bag: false }, ...(till.closeout?.plan?.bag ? [{ title: "Change bag", till, bag: true }] : [])]);
}

/** Table rows: [row label, one cell per column]. */
function tableRows(cols: Column[]): string[][] {
  const counts = (col: Column) => (col.bag ? col.till.closeout?.plan?.bag?.counted : col.till.closeout?.counted) || null;
  const rows: string[][] = [];
  for (const d of DENOMINATIONS) {
    if (!cols.some((col) => (counts(col)?.[d.key] || 0) > 0)) continue;
    rows.push([short(d.label), ...cols.map((col) => { const n = counts(col)?.[d.key] || 0; return n ? `${n} = ${money(n * d.cents)}` : "—"; })]);
  }
  const cell = (col: Column, till: (c: TillCloseout) => string, bag: (b: NonNullable<ResetPlan["bag"]>) => string) => {
    const c = col.till.closeout;
    if (!c) return "not closed";
    return col.bag ? bag(c.plan!.bag!) : till(c);
  };
  rows.push(["Checks", ...cols.map((col) => cell(col, (c) => money(c.checksCents), () => "—"))]);
  rows.push(["Total counted", ...cols.map((col) => cell(col, (c) => money(c.countedCents), (b) => money(b.countedCents)))]);
  rows.push(["Expected", ...cols.map((col) => cell(col, (c) => money(c.expectedCents), (b) => money(b.targetCents)))]);
  rows.push(["Over/short", ...cols.map((col) => cell(col, (c) => signed(c.overShortCents), (b) => signed(b.countedCents - b.targetCents)))]);
  rows.push(["Left in till / bag", ...cols.map((col) => cell(col, (c) => money(c.leftCents), (b) => money(b.leaveCents)))]);
  rows.push(["Deposit", ...cols.map((col) => cell(col, (c) => money(c.plan ? c.plan.depositCents + c.checksCents : c.countedCents - c.leftCents), () => "—"))]);
  rows.push(["Closed by", ...cols.map((col) => cell(col, (c) => `${c.closedBy}, ${time(c.closedAt)}`, () => "(with back till)"))]);
  return rows;
}

export function buildCloseoutEmail(input: { businessDate: string; tills: TillReportInput[]; note?: string }) {
  const cols = columns(input.tills), rows = tableRows(cols), issues = closeoutDiscrepancies(input.tills);
  const day = new Date(`${input.businessDate}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  const subject = `${input.note ? `[${input.note}] ` : ""}Till closeout ${day} — ${issues.length ? `${issues.length} to check` : "OK"}`;
  const deposit = input.tills.reduce((sum, till) => sum + (till.closeout ? (till.closeout.plan ? till.closeout.plan.depositCents + till.closeout.checksCents : till.closeout.countedCents - till.closeout.leftCents) : 0), 0);

  const text = [
    `Till closeout ${day}${input.note ? ` (${input.note})` : ""}`,
    `Columns: ${cols.map((col) => col.title).join(" | ")}`,
    "",
    ...rows.map(([label, ...cells]) => `${label}: ${cells.join(" | ")}`),
    `Total deposit: ${money(deposit)}`,
    "",
    issues.length ? `DISCREPANCIES (${issues.length})` : "No discrepancies.",
    ...issues.map((row) => `- ${row.where}: ${row.issue}${row.amountCents == null ? "" : ` (${signed(row.amountCents)})`}`),
  ].join("\n");

  const td = "padding:4px 6px;border-bottom:1px solid #ddd;vertical-align:top;font-size:13px;";
  const th = `${td}text-align:left;background:#f3f0e8;font-weight:700;`;
  const table = (head: string[], body: string[][], firstBold = true) => `<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;max-width:640px;border-collapse:collapse;margin:8px 0 16px;font-family:Arial,sans-serif;">`
    + `<tr>${head.map((h) => `<th style="${th}">${escape(h)}</th>`).join("")}</tr>`
    + body.map((row) => `<tr>${row.map((value, index) => `<td style="${td}${index === 0 && firstBold ? "font-weight:700;" : ""}${index > 0 && firstBold ? "white-space:nowrap;" : ""}">${escape(value)}</td>`).join("")}</tr>`).join("")
    + `</table>`;
  const html = `<div style="font-family:Arial,sans-serif;color:#211d17;max-width:640px;">`
    + `<h2 style="font-size:17px;margin:0 0 4px;">Till closeout ${escape(day)}</h2>`
    + (input.note ? `<p style="margin:0 0 8px;font-size:13px;color:#8a4b00;">${escape(input.note)}</p>` : "")
    + table(["", ...cols.map((col) => col.title)], rows)
    + `<p style="font-size:14px;margin:0 0 12px;"><b>Total deposit: ${money(deposit)}</b></p>`
    + `<h3 style="font-size:15px;margin:8px 0 0;color:${issues.length ? "#b42318" : "#15803d"};">${issues.length ? `Discrepancies (${issues.length})` : "No discrepancies"}</h3>`
    + (issues.length ? table(["Where", "Issue", "Amount"], issues.map((row) => [row.where, row.issue, row.amountCents == null ? "—" : signed(row.amountCents)]), false) : "")
    + `</div>`;
  return { subject, text, html, discrepancies: issues };
}
