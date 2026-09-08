"""Reject schema mutation SQL in runtime sources, including multiline variants."""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
PATTERN = re.compile(
    r"\b(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:UNIQUE|TEMP|TEMPORARY|UNLOGGED)\s+)?"
    r"(?:TABLE|INDEX|TRIGGER|FUNCTION|PROCEDURE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|SCHEMA|TYPE|EXTENSION)"
    r"|(?:ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|FUNCTION|PROCEDURE|VIEW|SEQUENCE|SCHEMA|TYPE|EXTENSION|CONSTRAINT)"
    r"|TRUNCATE\s+(?:TABLE\s+)?[a-z_][a-z_0-9.]*)\b", re.I,
)

def ddl_matches(text: str):
    # Strip SQL/JS block and line comments without changing line counts. Preserve
    # SQL strings/templates: those are the content this guard needs to inspect.
    stripped = re.sub(r"/\*[\s\S]*?\*/", lambda m: "\n" * m[0].count("\n"), text)
    stripped = re.sub(r"(?m)^\s*(?://|--).*?$", "", stripped)
    return [(stripped.count("\n", 0, match.start()) + 1, match[0]) for match in PATTERN.finditer(stripped)]

def main() -> int:
    violations = []
    for path in sorted((ROOT / "src").rglob("*")):
        if path.suffix not in {".ts", ".tsx", ".js", ".mjs"}:
            continue
        violations.extend(f"{path.relative_to(ROOT)}:{line}: {sql}" for line, sql in ddl_matches(path.read_text()))
    if violations:
        print("Runtime schema DDL is forbidden. Use db/migrations instead:")
        print("\n".join(violations))
        return 1
    print("Runtime DDL check passed: source tree contains no schema mutation SQL.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
