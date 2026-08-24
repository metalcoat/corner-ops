from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src/app"
LIB = ROOT / "src/lib"

# Preserve the finance dashboard's original default of zero decimal places while still
# using the shared client currency formatter.
finance_page = APP / "ops/finance-operations/page.tsx"
text = finance_page.read_text()
text = re.sub(r"\bformatUsd\b", "formatUsdFixed", text)
finance_page.write_text(text)

# The old clock helper returned an Error object. The canonical helper returns a message,
# so keep the original throw/catch behavior while sharing the response parser.
clock = APP / "clock/page.tsx"
text = clock.read_text()
text = text.replace(
    'throw await responseMessage(login, "PIN not recognized.");',
    'throw new Error(await responseMessage(login, "PIN not recognized."));',
)
clock.write_text(text)

# Cancelled shifts stay in the database for history/audit, but must not be returned as
# active schedule rows to Workforce Admin or its related schedule consumers.
workforce = LIB / "workforce.ts"
text = workforce.read_text()
needle = """      WHERE s.business = ${business}\n        AND s.starts_at >= NOW() - INTERVAL '21 days'\n"""
replacement = """      WHERE s.business = ${business}\n        AND s.status <> 'Cancelled'\n        AND s.starts_at >= NOW() - INTERVAL '21 days'\n"""
if replacement not in text:
    if needle not in text:
        raise RuntimeError("workforceDashboard schedule query marker not found")
    text = text.replace(needle, replacement, 1)
workforce.write_text(text)

workforce_route = APP / "api/workforce/route.ts"
text = workforce_route.read_text()
meal_needle = """    WHERE business = ${business}\n      AND starts_at >= NOW() - INTERVAL '21 days'\n"""
meal_replacement = """    WHERE business = ${business}\n      AND status <> 'Cancelled'\n      AND starts_at >= NOW() - INTERVAL '21 days'\n"""
if meal_replacement not in text:
    if meal_needle not in text:
        raise RuntimeError("workforce meal query marker not found")
    text = text.replace(meal_needle, meal_replacement, 1)
workforce_route.write_text(text)

print("Stage 9 type-preservation and cancelled-shift visibility fixes applied")
