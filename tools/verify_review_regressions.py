from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
APP = SRC / "app"
code_files = [p for p in SRC.rglob("*") if p.suffix in {".ts", ".tsx", ".js", ".mjs"}]
css_files = list(SRC.rglob("*.css"))
palette = APP / "color-tokens.css"
errors: list[str] = []


def count(pattern: str, files=code_files, exclude: set[str] | None = None) -> int:
    rx = re.compile(pattern, re.M)
    excluded = exclude or set()
    total = 0
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        if rel in excluded:
            continue
        total += len(rx.findall(path.read_text(errors="replace")))
    return total


def expect(label: str, actual: int, expected: int) -> None:
    if actual != expected:
        errors.append(f"{label}: expected {expected}, found {actual}")

expect("client response helpers", count(r"\b(?:async\s+)?function\s+(?:responseMessage|responseError|responseErrorMessage|errorMessage)\s*\("), 1)
expect("Request failed fallback literals", count(r"Request failed\s*\("), 1)
expect("firstName helpers", count(r"\bfunction\s+firstName\s*\("), 1)
expect("isStandalone helpers", count(r"\bfunction\s+isStandalone\s*\("), 1)
expect("isIos helpers", count(r"\bfunction\s+isIos\s*\("), 1)
expect("install prompt types", count(r"\b(?:type|interface)\s+(?:InstallPromptEvent|BeforeInstallPromptEvent)\b"), 1)
expect("generic money() helpers", count(r"\bfunction\s+money\s*\("), 0)
expect("Canvas drawImage calls in shared implementation", count(r"\.drawImage\s*\("), 2)
expect("legacy integration SESSION_SECRET crypto", count(r"corner-ops-integrations:|SESSION_SECRET is required before (?:Square can store credentials|bank connections can be managed)", exclude={"src/lib/integration-crypto.ts"}), 0)
expect("module-local Deli call-feed caches", count(r"\bcallFeedCache\b|\bcallFeedPromise\b"), 0)
expect("window.fetch monkey patches", count(r"window\.fetch\s*="), 0)
expect("dead publish recovery helpers", count(r"sendRecoveredPublishNotifications|SchedulePublishConfirmFix|overnight-shift-helper"), 0)

# Published/open shift corrections must stay live instead of being silently demoted to Draft.
schedule_board_text = (APP / "ops/workforce/schedule-board.tsx").read_text(errors="replace")
workforce_route_text = (APP / "api/workforce/route.ts").read_text(errors="replace")
if 'editor.shift.status === "Draft"' not in schedule_board_text or 'editor.employeeId ? "Published" : "Open"' not in schedule_board_text:
    errors.append("existing shift edits no longer preserve live Published/Open status")
if 'requestedStatus === "Published" || requestedStatus === "Open"' in workforce_route_text:
    errors.append("workforce API reintroduced Published/Open to Draft demotion")

# Both remaining drawImage calls must live in the shared helper, never feature code.
for path in code_files:
    rel = path.relative_to(ROOT).as_posix()
    if rel == "src/app/client-image.ts":
        continue
    if re.search(r"\.drawImage\s*\(", path.read_text(errors="replace")):
        errors.append(f"feature-specific Canvas drawImage implementation remains: {rel}")

# Cancelled shifts remain in the database for audit/history but may not return as active
# Workforce Admin schedule rows or meal metadata.
workforce_text = (SRC / "lib/workforce.ts").read_text(errors="replace")
if "WHERE s.business = ${business}\n        AND s.status <> 'Cancelled'\n        AND s.starts_at" not in workforce_text:
    errors.append("workforceDashboard does not exclude cancelled schedule rows")
workforce_route_text = (APP / "api/workforce/route.ts").read_text(errors="replace")
if "WHERE business = ${business}\n      AND status <> 'Cancelled'\n      AND starts_at" not in workforce_route_text:
    errors.append("workforce meal metadata query does not exclude cancelled shifts")

# CSS literals belong in the generated palette, not feature sheets.
hex_rx = re.compile(r"#[0-9a-fA-F]{3,8}\b")
token_ref_rx = re.compile(r"var\(--([A-Za-z0-9_-]+)\)")
token_def_rx = re.compile(r"--([A-Za-z0-9_-]+)\s*:")
refs: set[str] = set()
defs: set[str] = set()
for path in css_files:
    text = path.read_text(errors="replace")
    refs.update(token_ref_rx.findall(text))
    defs.update(token_def_rx.findall(text))
    if path != palette and hex_rx.search(text):
        errors.append(f"distributed CSS literal remains in {path.relative_to(ROOT)}")
    if "fix" in path.name.lower() or "cleanup" in path.name.lower():
        errors.append(f"patch-named stylesheet remains: {path.relative_to(ROOT)}")
for token in sorted(refs - defs):
    errors.append(f"undefined CSS token --{token}")

required_absent = [
    "db/schema.sql",
    ".github/workflows/ci.yml",
    "src/app/api/temporary-rezku-order-repair/route.ts",
    "src/app/api/temporary-rezku-order-diagnostic/route.ts",
    "src/app/api/workforce/week-publish/route.ts",
    "src/app/api/workforce/week-publish-v2/route.ts",
    "src/app/ops/schedule-publish-confirm-fix.tsx",
    "src/app/ops/workforce/overnight-shift-helper.tsx",
    "src/app/employee/portal-layout-fixes.css",
]
for rel in required_absent:
    if (ROOT / rel).exists():
        errors.append(f"retired artifact returned: {rel}")

required_present = [
    "db/migrations/0001a_production_baseline_schema.sql",
    "db/migrations/0008_deli_board_call_cache.sql",
    "src/lib/payroll-week.ts",
    "src/lib/integration-crypto.ts",
    "src/lib/security-keys.ts",
    "src/app/client-http.ts",
    "src/app/client-text.ts",
    "src/app/client-format.ts",
    "src/app/client-image.ts",
    "src/app/pwa-platform.ts",
]
for rel in required_present:
    if not (ROOT / rel).exists():
        errors.append(f"required remediation artifact missing: {rel}")

if errors:
    print("CODEBASEREVIEW regression guard failed:")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)

print("CODEBASEREVIEW regression guard passed.")
