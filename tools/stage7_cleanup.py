from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text()

def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content)

def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))

# CO-072: repository status and deployment configuration must describe the repository that is actually deployed.
replace_once(
    "README.md",
    "Production deployments are intentionally paused. Current work remains on the deployment-disabled `agent/rebuild-corner-ops` branch and draft pull request #3 until the owner explicitly authorizes deployment.",
    "Production deploys from `main` through Vercel. Remediation branches are allowed to create preview deployments, and changes are tested before they are merged to production.",
)

vercel_path = ROOT / "vercel.json"
vercel = json.loads(vercel_path.read_text())
vercel.pop("git", None)
vercel_path.write_text(json.dumps(vercel, indent=2) + "\n")

# CO-095: remove the dead palette duplicated by business-theme.css. Keep only the global browser color-scheme declaration.
globals_css = read("src/app/globals.css")
globals_css, count = re.subn(r"^:root \{.*?\}\n\n", ":root { color-scheme: dark; }\n\n", globals_css, count=1, flags=re.S)
if count != 1:
    raise RuntimeError("src/app/globals.css: expected the root token block once")
write("src/app/globals.css", globals_css)

# The owner layout still loads a patch-on-patch stylesheet. Fold its surviving rules into the canonical ops sheet.
ops_css = read("src/app/ops/ops.css").rstrip()
cleanup_css = read("src/app/ops/interface-cleanup.css").strip()
write("src/app/ops/ops.css", f"{ops_css}\n\n/* Consolidated owner-layout rules from the former interface-cleanup patch sheet. */\n{cleanup_css}\n")
replace_once("src/app/ops/layout.tsx", 'import "./interface-cleanup.css";\n', "")
(ROOT / "src/app/ops/interface-cleanup.css").unlink()

# CO-034: preserve the current hidden Time tab behavior without selecting it by DOM position.
replace_once(
    "src/app/employee/page.tsx",
    '        <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>',
    '        <button key={name} className={`${tab === name ? "active" : ""}${name === "time" ? " employeeTimeTab" : ""}`.trim()} onClick={() => setTab(name)}>',
)
replace_once(
    "src/app/employee/employee-nav.css",
    ".employeePortalContent .employeeTabs>button:nth-child(4){display:none}",
    ".employeePortalContent .employeeTabs>.employeeTimeTab{display:none}",
)

# CO-006 / Stage 4 follow-through: document the independent keys the runtime already supports.
env = read(".env.example")
env = env.replace(
    "SESSION_SECRET=\nAPP_PASSWORD=",
    "SESSION_SECRET=\nOWNER_SESSION_SECRET=\nEMPLOYEE_SESSION_SECRET=\nDELI_BOARD_SESSION_SECRET=\nEMPLOYEE_PIN_PEPPER=\nINTEGRATION_ENCRYPTION_KEY=\nSQUARE_OAUTH_STATE_SECRET=\nKEY_ENCRYPTION_KEY=\nAPP_PASSWORD=",
)
env = env.replace("TELNYX_FROM_NUMBER=\n", "TELNYX_FROM_NUMBER=\nTELNYX_PUBLIC_KEY=\n")
env = env.replace("# Weather\nOPENWEATHER_API_KEY=\n\n", "")
write(".env.example", env)

# README environment list must not imply SESSION_SECRET is still the root for unrelated credentials.
readme = read("README.md")
readme = readme.replace(
    "- `SESSION_SECRET`\n- `BLOB_READ_WRITE_TOKEN`\n- `EMPLOYMENT_FORMS_ENCRYPTION_KEY` with at least 32 characters",
    "- `SESSION_SECRET` as the legacy transition key, plus purpose-specific owner/employee/wallboard session secrets\n- `EMPLOYEE_PIN_PEPPER`, `INTEGRATION_ENCRYPTION_KEY`, `SQUARE_OAUTH_STATE_SECRET`, and `KEY_ENCRYPTION_KEY` for independent credential rotation\n- `BLOB_READ_WRITE_TOKEN` (or Vercel Blob OIDC configuration)\n- `EMPLOYMENT_FORMS_ENCRYPTION_KEY` with strong random key material",
)
write("README.md", readme)

# CO-071: the two-table legacy schema file is actively misleading now that migrations are authoritative.
legacy_schema = ROOT / "db/schema.sql"
if legacy_schema.exists():
    legacy_schema.unlink()

print("Stage 7 repository/CSS cleanup transform applied")
