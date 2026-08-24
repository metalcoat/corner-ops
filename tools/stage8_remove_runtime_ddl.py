from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
DDL = re.compile(r"\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|FUNCTION|CONSTRAINT)\b", re.I)

# Core schema ownership moves entirely to migrations. Preserve getSql(), make the legacy
# readiness hook a no-op so existing callers do not need a risky all-at-once call-site rewrite.
db = SRC / "lib/db.ts"
text = db.read_text()
marker = "export function ensureSchema(): Promise<void> {"
pos = text.find(marker)
if pos < 0:
    raise RuntimeError("src/lib/db.ts ensureSchema() marker not found")
prefix = text[:pos]
prefix = prefix.replace("let schemaPromise: Promise<void> | null = null;\n", "")
db.write_text(prefix + "export async function ensureSchema(): Promise<void> {\n  // Schema is owned by db/migrations. Runtime requests must never mutate it.\n}\n")

# Remove standalone awaited Neon tagged-template DDL statements while preserving DML/seeding
# that may live in the same ensure*Schema function. Non-standalone DDL is deliberately left
# for the residual scan and a targeted second pass.
def closing_backtick(source: str, start: int) -> int:
    i = start + 1
    while i < len(source):
        if source[i] == "`":
            backslashes = 0
            j = i - 1
            while j >= 0 and source[j] == "\\":
                backslashes += 1
                j -= 1
            if backslashes % 2 == 0:
                return i
        i += 1
    return -1

start_re = re.compile(r"(?m)^(?P<indent>[ \t]*)await\s+(?P<tag>getSql\(\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*`")
changed_files = []
removed = 0
for path in sorted(SRC.rglob("*")):
    if path == db or path.suffix not in {".ts", ".tsx", ".js", ".mjs"}:
        continue
    source = path.read_text()
    cursor = 0
    pieces = []
    changed = False
    while True:
        match = start_re.search(source, cursor)
        if not match:
            pieces.append(source[cursor:])
            break
        tick = source.find("`", match.start())
        end_tick = closing_backtick(source, tick)
        if end_tick < 0:
            pieces.append(source[cursor:])
            break
        body = source[tick + 1:end_tick]
        after = end_tick + 1
        while after < len(source) and source[after] in " \t\r\n":
            after += 1
        if after >= len(source) or source[after] != ";" or not DDL.search(body):
            pieces.append(source[cursor:match.end()])
            cursor = match.end()
            continue
        statement_end = after + 1
        if statement_end < len(source) and source[statement_end] == "\r": statement_end += 1
        if statement_end < len(source) and source[statement_end] == "\n": statement_end += 1
        pieces.append(source[cursor:match.start()])
        cursor = statement_end
        changed = True
        removed += 1
    if changed:
        path.write_text("".join(pieces))
        changed_files.append(path.relative_to(ROOT).as_posix())

print(f"Removed {removed} standalone runtime DDL statements across {len(changed_files) + 1} files (including db.ts core cutover).")
for item in changed_files:
    print(item)

# Stage 8 gated transformation entry point. Re-run after every targeted residual fix.
