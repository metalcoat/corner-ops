from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
PATTERN = re.compile(r"\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|FUNCTION|CONSTRAINT)\b", re.I)
rows = []
for path in sorted(SRC.rglob("*")):
    if path.suffix not in {".ts", ".tsx", ".js", ".mjs"}:
        continue
    text = path.read_text(errors="replace")
    for line_no, line in enumerate(text.splitlines(), 1):
        if PATTERN.search(line):
            rows.append((path.relative_to(ROOT).as_posix(), line_no, line.strip()))

out = ["# Stage 8 runtime DDL scan", "", f"Occurrences: {len(rows)}", ""]
for path, line_no, line in rows:
    out.append(f"- `{path}:{line_no}` — `{line[:220].replace('`', "'")}`")
(ROOT / ".stage8-ddl-scan.md").write_text("\n".join(out) + "\n")
print(f"Found {len(rows)} runtime DDL occurrences")
