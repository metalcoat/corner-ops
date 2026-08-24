from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
lock = json.loads((ROOT / "package-lock.json").read_text())
xlsx = lock.get("packages", {}).get("node_modules/xlsx", {})
expected_url = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
if xlsx.get("version") != "0.20.3" or xlsx.get("resolved") != expected_url:
    print("SheetJS must remain pinned to the reviewed official 0.20.3 CDN artifact.")
    print(xlsx)
    sys.exit(1)

result = subprocess.run(
    ["npm", "audit", "--json"],
    cwd=ROOT,
    capture_output=True,
    text=True,
    check=False,
)
try:
    audit = json.loads(result.stdout or "{}")
except json.JSONDecodeError:
    print(result.stdout)
    print(result.stderr)
    raise

remaining = []
for name, finding in audit.get("vulnerabilities", {}).items():
    severity = str(finding.get("severity", "")).lower()
    if severity not in {"high", "critical"}:
        continue
    if name == "xlsx":
        # npm's registry advisory cannot represent fixed SheetJS releases distributed
        # from the project's authoritative CDN; provenance is checked above.
        continue
    remaining.append((name, severity, finding.get("via")))

if remaining:
    print("Unsuppressed high/critical npm audit findings:")
    for item in remaining:
        print(item)
    sys.exit(1)

print("Dependency security check passed; no unsuppressed high/critical findings.")
