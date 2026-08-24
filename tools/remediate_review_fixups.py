from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def update(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if old not in text:
        raise RuntimeError(f"{path}: expected fixup marker not found: {old!r}")
    target.write_text(text.replace(old, new))


update(
    "src/lib/payroll-summary-rules.ts",
    'import { payrollWeekBounds as weekBounds } from "@/lib/payroll-week";',
    'import { newYorkDateTime, payrollWeekBounds as weekBounds } from "@/lib/payroll-week";',
)
update(
    "src/lib/payroll-summary-rules.ts",
    'zonedDateToUtc(',
    'newYorkDateTime(',
)
update(
    "src/lib/overtime-risk.ts",
    'import { currentPayrollWeekStart, payrollWeekBounds } from "@/lib/payroll-week";',
    'import { addDateKeyDays as addDays, currentPayrollWeekStart, payrollWeekBounds } from "@/lib/payroll-week";',
)

print("Stage 1 typecheck fixups applied.")
