from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src/app"


def add_import(text: str, module: str, names: list[str]) -> str:
    names = sorted(set(names))
    if not names:
        return text
    pattern = re.compile(rf'import\s*\{{([^}}]+)\}}\s*from\s*"{re.escape(module)}";')
    match = pattern.search(text)
    if match:
        existing = [x.strip() for x in match.group(1).split(',') if x.strip()]
        merged = sorted(set(existing + names))
        return text[:match.start()] + f'import {{ {", ".join(merged)} }} from "{module}";' + text[match.end():]
    line = f'import {{ {", ".join(names)} }} from "{module}";\n'
    if text.startswith('"use client";\n'):
        return '"use client";\n\n' + line + text[len('"use client";\n\n'):] if text.startswith('"use client";\n\n') else '"use client";\n' + line + text[len('"use client";\n'):]
    first_import = text.find("import ")
    if first_import >= 0:
        return text[:first_import] + line + text[first_import:]
    return line + text


def remove_braced_decl(text: str, marker_pattern: str) -> tuple[str, int]:
    rx = re.compile(marker_pattern, re.M)
    removed = 0
    while True:
        m = rx.search(text)
        if not m:
            break
        start = text.rfind("\n", 0, m.start()) + 1
        brace = text.find("{", m.end() - 1)
        if brace < 0:
            raise RuntimeError(f"Declaration has no opening brace: {m.group(0)}")
        depth = 0
        i = brace
        quote = None
        escape = False
        while i < len(text):
            ch = text[i]
            if quote:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == quote:
                    quote = None
                i += 1
                continue
            if ch in {'"', "'", '`'}:
                quote = ch
                i += 1
                continue
            if ch == "{": depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    while end < len(text) and text[end] in " \t": end += 1
                    if end < len(text) and text[end] == "\r": end += 1
                    if end < len(text) and text[end] == "\n": end += 1
                    if end < len(text) and text[end] == "\n": end += 1
                    text = text[:start] + text[end:]
                    removed += 1
                    break
            i += 1
        else:
            raise RuntimeError(f"Declaration did not close: {m.group(0)}")
    return text, removed

# CO-096: collapse response helpers and failure literal.
response_files = 0
response_defs = 0
for path in sorted(APP.rglob("*.tsx")):
    if path.name == "client-http.ts":
        continue
    text = path.read_text()
    if "Request failed (" not in text and "responseMessage(" not in text:
        continue
    before = text
    text = text.replace('`Request failed (${response.status}).`', 'requestFailure(response)')
    text, n = remove_braced_decl(text, r"\b(?:async\s+)?function\s+responseMessage\s*\([^)]*\)(?:\s*:\s*Promise<string>)?\s*\{")
    response_defs += n
    names = []
    if "responseMessage(" in text: names.append("responseMessage")
    if "requestFailure(" in text: names.append("requestFailure")
    if names:
        text = add_import(text, "@/app/client-http", names)
    if text != before:
        path.write_text(text)
        response_files += 1

# CO-096: one first-name display helper.
first_name_files = 0
for path in sorted(APP.rglob("*.tsx")):
    text = path.read_text()
    if not re.search(r"\bfunction\s+firstName\s*\(", text):
        continue
    text, n = remove_braced_decl(text, r"\bfunction\s+firstName\s*\([^)]*\)(?:\s*:\s*string)?\s*\{")
    if n:
        text = add_import(text, "@/app/client-text", ["firstName"])
        path.write_text(text)
        first_name_files += 1

# CO-096: share PWA capability/type helpers.
for relative in ["pwa-client.tsx", "employee/install-prompt.tsx"]:
    path = APP / relative
    text = path.read_text()
    # Remove the type block.
    text, type_count = remove_braced_decl(text, r"\btype\s+InstallPromptEvent\s*=\s*Event\s*&\s*\{")
    text, standalone_count = remove_braced_decl(text, r"\bfunction\s+isStandalone\s*\([^)]*\)\s*\{")
    text, ios_count = remove_braced_decl(text, r"\bfunction\s+isIos\s*\([^)]*\)\s*\{")
    if type_count != 1 or standalone_count != 1 or ios_count != 1:
        raise RuntimeError(f"{relative}: expected one PWA type/platform helper of each kind")
    text = add_import(text, "@/app/pwa-platform", ["InstallPromptEvent", "isIos", "isStandalone"])
    path.write_text(text)

# CO-095: operations.css belongs to the document-vault route, not every route in the root layout.
layout = APP / "layout.tsx"
text = layout.read_text()
if 'import "./operations.css";\n' not in text:
    raise RuntimeError("Root operations.css import not found")
layout.write_text(text.replace('import "./operations.css";\n', '', 1))
page = APP / "page.tsx"
text = page.read_text()
if 'import "./operations.css";' not in text:
    text = add_import(text, "./operations.css", []) if False else text
    anchor = 'import { FormEvent, useEffect, useMemo, useState } from "react";\n'
    if anchor not in text:
        raise RuntimeError("Home page React import anchor not found")
    text = text.replace(anchor, anchor + 'import "./operations.css";\n', 1)
page.write_text(text)

# CO-095 / positional CSS: turn the last patch-named employee sheet into a normal layout stylesheet,
# and replace DOM-order rules with explicit card identities.
old_css = APP / "employee/portal-layout-fixes.css"
new_css = APP / "employee/employee-layout.css"
if old_css.exists():
    css = old_css.read_text()
    css = re.sub(r"\n?\.attendanceTimeGrid > \.attendanceEmployeeCard:nth-child\(2\) \{\s*order: 1;\s*\}\s*", "\n.attendanceRecentTimeCard { order: 1; }\n", css, count=1, flags=re.S)
    css = re.sub(r"\n?\.attendanceTimeGrid > \.attendanceEmployeeCard:nth-child\(3\) \{\s*order: 2;\s*\}\s*", "\n.attendanceCorrectionHistoryCard { order: 2; }\n", css, count=1, flags=re.S)
    css = re.sub(r"\n?\.attendanceTimeGrid > \.attendanceEmployeeCard:nth-child\(1\) \{\s*order: 3;\s*\}\s*", "\n.attendanceCorrectionRequestCard { order: 3; }\n", css, count=1, flags=re.S)
    new_css.write_text(css)
    old_css.unlink()
else:
    raise RuntimeError("portal-layout-fixes.css not found")

employee_layout = APP / "employee/layout.tsx"
text = employee_layout.read_text()
if 'import "./portal-layout-fixes.css";' not in text:
    raise RuntimeError("Employee patch stylesheet import not found")
employee_layout.write_text(text.replace('import "./portal-layout-fixes.css";', 'import "./employee-layout.css";', 1))

attendance = APP / "employee/attendance/page.tsx"
text = attendance.read_text()
old_classes = ['<article className="attendanceEmployeeCard">', '<article className="attendanceEmployeeCard">', '<article className="attendanceEmployeeCard attendanceTimeWide">']
replacements = [
    '<article className="attendanceEmployeeCard attendanceCorrectionRequestCard">',
    '<article className="attendanceEmployeeCard attendanceRecentTimeCard">',
    '<article className="attendanceEmployeeCard attendanceTimeWide attendanceCorrectionHistoryCard">',
]
# Only modify the three cards inside attendanceTimeGrid by splitting at that section.
anchor = '<section className="attendanceTimeGrid">'
if anchor not in text:
    raise RuntimeError("attendanceTimeGrid not found")
head, tail = text.split(anchor, 1)
for old, new in zip(old_classes, replacements):
    if old not in tail:
        raise RuntimeError(f"Attendance card target missing: {old}")
    tail = tail.replace(old, new, 1)
attendance.write_text(head + anchor + tail)

# CO-033 follow-through after Stage 7 removed the old root palette: --danger must remain defined.
theme = APP / "business-theme.css"
text = theme.read_text()
if "--danger:" not in text:
    # Define once in :root; business themes may override later if desired.
    text = text.replace("  --theme-accent: var(--accent);\n", "  --theme-accent: var(--accent);\n  --danger: #ff9b9b;\n", 1)
theme.write_text(text)

print(f"Stage 9 first pass: response files={response_files}, local response defs removed={response_defs}, firstName files={first_name_files}")
