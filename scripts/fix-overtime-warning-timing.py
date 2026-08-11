from pathlib import Path

path = Path('src/lib/overtime-risk.ts')
text = path.read_text()
text = text.replace('const WORKWEEK_START_HOUR = 4;\nconst WARNING_HOURS = 38;\nconst OVERTIME_HOURS = 40;', 'const WORKWEEK_START_HOUR = 0;\nconst WARNING_HOURS = 38;\nconst OVERTIME_HOURS = 40;\nconst PROJECTION_ALERT_WEEK_PROGRESS = 0.75;')
old = '''function riskLevel(hours: number): RiskLevel {
  if (hours > OVERTIME_HOURS) return "overtime";
  if (hours >= WARNING_HOURS) return "warning";
  return "normal";
}'''
new = '''function riskLevel(hours: number): RiskLevel {
  if (hours > OVERTIME_HOURS) return "overtime";
  if (hours >= WARNING_HOURS) return "warning";
  return "normal";
}

function operationalRiskLevel(input: {
  actualHours: number;
  projectedHours: number;
  weekStartMs: number;
  weekEndMs: number;
  nowMs: number;
}): RiskLevel {
  const actualRisk = riskLevel(input.actualHours);
  if (actualRisk !== "normal") return actualRisk;

  const duration = Math.max(1, input.weekEndMs - input.weekStartMs);
  const progress = Math.max(0, Math.min(1, (input.nowMs - input.weekStartMs) / duration));
  if (progress < PROJECTION_ALERT_WEEK_PROGRESS) return "normal";
  return riskLevel(input.projectedHours);
}'''
if old not in text:
    raise SystemExit('riskLevel block not found')
text = text.replace(old, new, 1)
old = '''      replacementShift: overtimeShift || warningShift || remaining[0]?.shift || null,
      risk: riskLevel(projected),
    };'''
new = '''      replacementShift: overtimeShift || warningShift || remaining[0]?.shift || null,
      risk: operationalRiskLevel({
        actualHours: actualValue,
        projectedHours: projected,
        weekStartMs: bounds.start.getTime(),
        weekEndMs: bounds.end.getTime(),
        nowMs,
      }),
    };'''
if old not in text:
    raise SystemExit('base risk block not found')
text = text.replace(old, new, 1)
old = '''    thresholds: { warning: WARNING_HOURS, overtime: OVERTIME_HOURS },'''
new = '''    thresholds: {
      warning: WARNING_HOURS,
      overtime: OVERTIME_HOURS,
      projectionAlertWeekProgress: PROJECTION_ALERT_WEEK_PROGRESS,
    },'''
if old not in text:
    raise SystemExit('threshold block not found')
text = text.replace(old, new, 1)
path.write_text(text)

page = Path('src/app/ops/overtime/page.tsx')
text = page.read_text()
text = text.replace('thresholds: { warning: number; overtime: number };', 'thresholds: { warning: number; overtime: number; projectionAlertWeekProgress?: number };')
text = text.replace('Compares hours actually worked with the hours each employee should have reached by this point in the week, then keeps the remaining schedule projection and overtime status.', 'Compares hours actually worked with where each employee should be by this point in the week. Full-week projections remain visible for planning, but projected-hour warnings wait until about 75% of the week has elapsed unless actual worked hours already reach the warning threshold.')
text = text.replace('currentData ? `Pace measured through ${local(currentData.paceAsOf || currentData.generatedAt)}` : "Warning at 38 hours · overtime above 40 hours"', 'currentData ? `Pace measured through ${local(currentData.paceAsOf || currentData.generatedAt)} · projected warnings begin about 75% through the week` : "Actual warning at 38 hours · projected warnings begin about 75% through the week"')
page.write_text(text)
