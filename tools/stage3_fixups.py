from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def update(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected 1 match, got {count}: {old!r}")
    target.write_text(text.replace(old, new, 1))

update(
    "src/app/ops/workforce/layout.tsx",
    'import OvernightShiftHelper from "./overnight-shift-helper";\n',
    '',
)
update(
    "src/app/ops/workforce/layout.tsx",
    '    <OvernightShiftHelper />\n',
    '',
)
for path in [
    "src/app/ops/workforce/schedule-board.tsx",
    "src/app/ops/workforce/week-copy-panel.tsx",
]:
    update(
        path,
        '  runAction: (body: Record<string, unknown>, success: string) => Promise<void>;\n',
        '  runAction: (body: Record<string, unknown>, success: string) => Promise<Record<string, unknown> | null>;\n',
    )

print("Stage 3 type cleanup applied")
