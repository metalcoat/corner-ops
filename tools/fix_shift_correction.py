from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

board = ROOT / "src/app/ops/workforce/schedule-board.tsx"
text = board.read_text()
old = '''      status: "Draft",\n      notes: editor.notes,\n      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n      expectedUpdatedAt: editor.shift?.updatedAt || null,\n    }, editor.shift ? "Shift updated and marked for publishing." : "Draft shift added.");\n'''
new = '''      status: editor.shift\n        ? editor.shift.status === "Draft"\n          ? "Draft"\n          : editor.employeeId ? "Published" : "Open"\n        : "Draft",\n      notes: editor.notes,\n      acknowledgePendingTimeOff: timeOffCheck.acknowledgePendingTimeOff,\n      expectedUpdatedAt: editor.shift?.updatedAt || null,\n    }, editor.shift ? "Shift changes saved." : "Draft shift added.");\n'''
if old not in text:
    raise RuntimeError("schedule-board saveShift block not found")
text = text.replace(old, new, 1)
old_button = '<button type="submit" className="schedulePrimary" disabled={busy || Boolean(editorPreview?.overlap)}>Save draft</button>'
new_button = '<button type="submit" className="schedulePrimary" disabled={busy || Boolean(editorPreview?.overlap)}>{editor.shift ? "Save changes" : "Save draft"}</button>'
if old_button not in text:
    raise RuntimeError("schedule-board submit button not found")
text = text.replace(old_button, new_button, 1)
board.write_text(text)

route = ROOT / "src/app/api/workforce/route.ts"
text = route.read_text()
old = '''        const status = requestedStatus === "Published" || requestedStatus === "Open"\n          ? "Draft"\n          : requestedStatus;\n'''
new = '''        const status = requestedStatus;\n'''
if old not in text:
    raise RuntimeError("workforce route forced-draft block not found")
text = text.replace(old, new, 1)
old_cast = '          status: status as "Draft" | "Cancelled" | undefined,\n'
new_cast = '          status: status as "Draft" | "Published" | "Open" | "Cancelled" | undefined,\n'
if old_cast not in text:
    raise RuntimeError("workforce route status cast not found")
text = text.replace(old_cast, new_cast, 1)
route.write_text(text)

guard = ROOT / "tools/verify_review_regressions.py"
text = guard.read_text()
marker = 'expect("dead publish recovery helpers", count(r"sendRecoveredPublishNotifications|SchedulePublishConfirmFix|overnight-shift-helper"), 0)\n'
addition = '''expect("dead publish recovery helpers", count(r"sendRecoveredPublishNotifications|SchedulePublishConfirmFix|overnight-shift-helper"), 0)\n\n# Published/open shift corrections must stay live instead of being silently demoted to Draft.\nschedule_board_text = (APP / "ops/workforce/schedule-board.tsx").read_text(errors="replace")\nworkforce_route_text = (APP / "api/workforce/route.ts").read_text(errors="replace")\nif 'editor.shift.status === "Draft"' not in schedule_board_text or 'editor.employeeId ? "Published" : "Open"' not in schedule_board_text:\n    errors.append("existing shift edits no longer preserve live Published/Open status")\nif 'requestedStatus === "Published" || requestedStatus === "Open"' in workforce_route_text:\n    errors.append("workforce API reintroduced Published/Open to Draft demotion")\n'''
if marker not in text:
    raise RuntimeError("review regression guard marker not found")
text = text.replace(marker, addition, 1)
guard.write_text(text)

print("Shift correction hotfix applied")
