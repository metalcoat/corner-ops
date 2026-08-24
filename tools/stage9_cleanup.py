from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "src/app"
# Final reconciliation pass. This transform is intentionally mechanical and idempotent.


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
    return line + text


def remove_function(text: str, name: str) -> tuple[str, int]:
    patterns = [
        re.compile(rf'\n(?:async\s+)?function\s+{re.escape(name)}\s*\([^{{]*\)\s*(?::\s*[^{{]+)?\s*\{{', re.M),
    ]
    for pattern in patterns:
        match = pattern.search(text)
        if not match:
            continue
        brace = text.find('{', match.start())
        depth = 0
        i = brace
        in_string = None
        escaped = False
        while i < len(text):
            ch = text[i]
            if in_string:
                if escaped:
                    escaped = False
                elif ch == '\\':
                    escaped = True
                elif ch == in_string:
                    in_string = None
            else:
                if ch in {'"', "'", '`'}:
                    in_string = ch
                elif ch == '{': depth += 1
                elif ch == '}':
                    depth -= 1
                    if depth == 0:
                        end = i + 1
                        while end < len(text) and text[end] in ' \t': end += 1
                        if end < len(text) and text[end] == '\r': end += 1
                        if end < len(text) and text[end] == '\n': end += 1
                        return text[:match.start()] + '\n' + text[end:], 1
            i += 1
    return text, 0

# 1) Canonical responseMessage helper across client components.
client_files = [p for p in APP.rglob('*') if p.suffix in {'.ts', '.tsx'}]
response_names = ['responseMessage', 'responseError', 'responseErrorMessage', 'errorMessage']
for path in client_files:
    if path.as_posix().endswith('/client-http.ts'):
        continue
    text = path.read_text()
    removed_names = []
    for name in response_names:
        text, n = remove_function(text, name)
        if n:
            removed_names.append(name)
    if removed_names:
        text = add_import(text, '@/app/client-http', ['responseMessage'])
        for name in removed_names:
            if name != 'responseMessage':
                text = re.sub(rf'\b{re.escape(name)}\(', 'responseMessage(', text)
        path.write_text(text)

# Catch direct fallback literals without introducing async into synchronous callbacks.
for path in client_files:
    text = path.read_text()
    if 'Request failed (${response.status}).' not in text:
        continue
    if path.as_posix().endswith('/client-http.ts'):
        continue
    text = text.replace('`Request failed (${response.status}).`', 'requestFailure(response)')
    text = add_import(text, '@/app/client-http', ['requestFailure'])
    path.write_text(text)

# 2) Canonical display first-name helper.
for path in client_files:
    if path.as_posix().endswith('/client-text.ts'):
        continue
    text = path.read_text()
    text2, n = remove_function(text, 'firstName')
    if n:
        text2 = add_import(text2, '@/app/client-text', ['firstName'])
        path.write_text(text2)

# 3) Canonical PWA platform helpers and InstallPromptEvent type.
for rel in ['pwa-client.tsx', 'employee/install-prompt.tsx']:
    path = APP / rel
    text = path.read_text()
    for name in ['isStandalone', 'isIos']:
        text, _ = remove_function(text, name)
    text = re.sub(r'\ntype InstallPromptEvent = Event & \{.*?\n\};\n', '\n', text, count=1, flags=re.S)
    text = add_import(text, '@/app/pwa-platform', ['isIos', 'isStandalone'])
    text = text.replace('useState<InstallPromptEvent | null>', 'useState<BeforeInstallPromptEvent | null>')
    text = text.replace('event as InstallPromptEvent', 'event as BeforeInstallPromptEvent')
    text = add_import(text, '@/app/pwa-platform', ['BeforeInstallPromptEvent'])
    path.write_text(text)

# 4) Scope operations.css to the document-vault home page instead of the root layout.
layout = APP / 'layout.tsx'
layout_text = layout.read_text().replace('import "./operations.css";\n', '')
layout.write_text(layout_text)
home = APP / 'page.tsx'
home_text = home.read_text()
if 'import "./operations.css";' not in home_text:
    marker = 'import type { Business, SessionView } from "@/lib/types";\n'
    if marker in home_text:
        home_text = home_text.replace(marker, marker + 'import "./operations.css";\n')
    else:
        anchor = '} from "@/lib/types";\n'
        home_text = home_text.replace(anchor, anchor + 'import "./operations.css";\n', 1)
home.write_text(home_text)

# 5) Merge the last patch-named employee layout stylesheet into employee.css.
patch = APP / 'employee/portal-layout-fixes.css'
canonical = APP / 'employee/employee.css'
if patch.exists():
    canonical.write_text(canonical.read_text().rstrip() + '\n\n/* Employee portal responsive/layout rules consolidated from the former patch sheet. */\n' + patch.read_text().strip() + '\n')
    patch.unlink()
emp_layout = APP / 'employee/layout.tsx'
emp_layout.write_text(emp_layout.read_text().replace('import "./portal-layout-fixes.css";\n', ''))

# 6) Replace positional attendance ordering with explicit identity classes.
attendance = APP / 'employee/attendance/page.tsx'
text = attendance.read_text()
needle = '<article className="attendanceEmployeeCard">'
positions = [
    '<article className="attendanceEmployeeCard attendanceCorrectionRequestCard">',
    '<article className="attendanceEmployeeCard attendanceRecentTimeCard">',
]
for replacement in positions:
    if needle in text:
        text = text.replace(needle, replacement, 1)
attendance.write_text(text)

employee_css = canonical.read_text()
employee_css = employee_css.replace('.attendanceTimeGrid > .attendanceEmployeeCard:nth-child(2) {', '.attendanceTimeGrid > .attendanceRecentTimeCard {')
employee_css = employee_css.replace('.attendanceTimeGrid > .attendanceEmployeeCard:nth-child(3) {', '.attendanceTimeGrid > .attendanceTimeWide {')
employee_css = employee_css.replace('.attendanceTimeGrid > .attendanceEmployeeCard:nth-child(1) {', '.attendanceTimeGrid > .attendanceCorrectionRequestCard {')
canonical.write_text(employee_css)

# 7) Ensure every referenced semantic theme token exists.
theme = APP / 'business-theme.css'
theme_text = theme.read_text()
if '--danger:' not in theme_text:
    theme_text = theme_text.replace('--accent-contrast:', '--danger: #dc2626;\n  --accent-contrast:', 1)
    second = theme_text.find('--accent-contrast:', theme_text.find('--accent-contrast:') + 1)
    if second >= 0:
        theme_text = theme_text[:second] + '--danger: #dc2626;\n  ' + theme_text[second:]
theme.write_text(theme_text)

print('Stage 9 first-pass helper/CSS cleanup applied')
