from pathlib import Path

# Fix the normal publication path so database Date values do not trigger the legacy recovery path.
publication = Path('src/lib/business-schedule-publication.ts')
text = publication.read_text()
old = '''      .sort((left, right) => left.starts_at.localeCompare(right.starts_at) || left.id.localeCompare(right.id))'''
new = '''      .sort((left, right) => {
        const startDifference = new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime();
        return startDifference || String(left.id).localeCompare(String(right.id));
      })'''
if old not in text:
    raise SystemExit('publication timestamp sort block not found')
text = text.replace(old, new, 1)
publication.write_text(text)

# Make the recovery notification equally useful: include the employee's actual days/times/position.
route = Path('src/app/api/workforce/week-publish-v2/route.ts')
text = route.read_text()
text = text.replace(
'''  employee_name: string | null;\n  starts_at: string | Date;\n  ends_at: string | Date;''',
'''  employee_name: string | null;\n  position: string;\n  starts_at: string | Date;\n  ends_at: string | Date;'''
)
text = text.replace(
'''    SELECT s.id, s.employee_id, e.name AS employee_name, s.starts_at, s.ends_at''',
'''    SELECT s.id, s.employee_id, e.name AS employee_name, s.position, s.starts_at, s.ends_at'''
)

insert_after = '''function mondayForDate(value: string | Date): string {\n  const localDate = localDateKey(value);\n  const date = new Date(`${localDate}T12:00:00Z`);\n  const day = date.getUTCDay();\n  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));\n  return date.toISOString().slice(0, 10);\n}\n'''
helpers = '''\nfunction recoveredShiftLabel(shift: DraftShiftRow): string {\n  const start = new Date(shift.starts_at);\n  const end = new Date(shift.ends_at);\n  const day = new Intl.DateTimeFormat("en-US", {\n    timeZone: TIME_ZONE,\n    weekday: "long",\n    month: "short",\n    day: "numeric",\n  }).format(start);\n  const time = new Intl.DateTimeFormat("en-US", {\n    timeZone: TIME_ZONE,\n    hour: "numeric",\n    minute: "2-digit",\n  });\n  return `${day}: ${time.format(start)}–${time.format(end)} — ${String(shift.position || "Shift").trim() || "Shift"}`;\n}\n'''
if insert_after not in text:
    raise SystemExit('helper insertion point not found')
text = text.replace(insert_after, insert_after + helpers, 1)

old = '''  const body = `Your ${input.business} schedule was updated for ${input.weekStart} through ${addDays(input.weekStart, 6)}. Review your current shifts in Employee Hub.`;\n\n  const emailResults = [];\n  for (const employeeId of employeeIds) {\n    emailResults.push(await sendStaffNotification({\n      business: input.business,\n      recipientEmployeeId: employeeId,\n      body,\n      actor: input.actor,\n    }));\n  }'''
new = '''  const emailResults = [];\n  for (const employeeId of employeeIds) {\n    const employeeShifts = input.drafts\n      .filter((shift) => shift.employee_id === employeeId)\n      .sort((left, right) => new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime());\n    const scheduleLines = employeeShifts.length\n      ? employeeShifts.map((shift) => `- ${recoveredShiftLabel(shift)}`).join("\\n")\n      : "- You are not currently scheduled for this week.";\n    const body = [\n      `Your ${input.business} schedule was updated for ${input.weekStart} through ${addDays(input.weekStart, 6)}.`,\n      "",\n      "Your current schedule:",\n      scheduleLines,\n      "",\n      "Open Employee Hub if you need to review changes, offer a shift, or claim an open shift.",\n    ].join("\\n");\n    emailResults.push(await sendStaffNotification({\n      business: input.business,\n      recipientEmployeeId: employeeId,\n      body,\n      actor: input.actor,\n    }));\n  }'''
if old not in text:
    raise SystemExit('recovery email block not found')
text = text.replace(old, new, 1)

old = '''  const sms = await deliverSms({\n    recipients: smsRecipients,\n    text: () => `${body} Reply STOP to opt out.`,\n  });'''
new = '''  const sms = await deliverSms({\n    recipients: smsRecipients,\n    text: (employee) => {\n      const employeeShifts = input.drafts\n        .filter((shift) => shift.employee_id === employee.id)\n        .sort((left, right) => new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime());\n      const shifts = employeeShifts.map((shift) => recoveredShiftLabel(shift)).join("; ");\n      return `${employee.name}, your ${input.business} schedule was updated. ${shifts || "No assigned shifts this week."} Open Employee Hub for changes. Reply STOP to opt out.`;\n    },\n  });'''
if old not in text:
    raise SystemExit('recovery sms block not found')
text = text.replace(old, new, 1)
route.write_text(text)
