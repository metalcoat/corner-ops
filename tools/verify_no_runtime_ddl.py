from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
PATTERN = re.compile(r"\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|FUNCTION|CONSTRAINT)\b", re.I)
violations = []
for path in sorted(SRC.rglob("*")):
    if path.suffix not in {".ts", ".tsx", ".js", ".mjs"}:
        continue
    for number, line in enumerate(path.read_text(errors="replace").splitlines(), 1):
        if PATTERN.search(line):
            violations.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()[:240]}")

if violations:
    print("Runtime schema DDL is forbidden. Add or update a file under db/migrations instead:")
    print("\n".join(violations))
    sys.exit(1)
print("Runtime DDL check passed: source tree contains no schema mutation SQL.")
