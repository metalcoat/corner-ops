from pathlib import Path

staff = Path('src/lib/staff-notifications.ts')
text = staff.read_text()

old = '''        openShifts.length ? `\\nThere ${openShifts.length === 1 ? "is" : "are"} ${openShifts.length} open shift${openShifts.length === 1 ? "" : "s"} in Employee Hub.` : "",
        hubUrl ? `\\nView the schedule: ${hubUrl}` : "",
        hubUrl ? `Sign in with your ${pinLength}-digit employee PIN.` : "",'''
new = '''        openShifts.length ? `\\nThere ${openShifts.length === 1 ? "is" : "are"} ${openShifts.length} open shift${openShifts.length === 1 ? "" : "s"} in Employee Hub.` : "",
        hubUrl ? `\\nNeed to offer, swap, claim an open shift, or check for changes? ${hubUrl}` : "",
        hubUrl ? `Sign in with your ${pinLength}-digit employee PIN.` : "",'''
if old not in text:
    raise SystemExit('schedule email portal wording not found')
text = text.replace(old, new, 1)

old = '''  const sms = await deliverSms({
    recipients: contacts,
    text: () => [
      `${input.business} schedule ${scheduleVerb} for ${dateLabel(weekStart)}-${dateLabel(weekEnd)}.`,
      hubUrl ? `Review: ${hubUrl}` : "Open Employee Hub to review.",
      `Use your ${pinLength}-digit employee PIN.`,
      "Reply STOP to opt out.",
    ].join(" "),
  });'''
new = '''  const sms = await deliverSms({
    recipients: contacts,
    text: (employee) => {
      const employeeShifts = shifts.filter((shift) => shift.employee_id === employee.id);
      const schedule = employeeShifts.length
        ? employeeShifts.map((shift) => {
            const start = new Date(shift.starts_at);
            const end = new Date(shift.ends_at);
            const day = new Intl.DateTimeFormat("en-US", {
              timeZone: TIME_ZONE,
              weekday: "short",
              month: "numeric",
              day: "numeric",
            }).format(start);
            const time = new Intl.DateTimeFormat("en-US", {
              timeZone: TIME_ZONE,
              hour: "numeric",
              minute: "2-digit",
            });
            return `${day} ${time.format(start)}-${time.format(end)} ${clean(shift.position, 60) || "Shift"}`;
          }).join("; ")
        : "No shifts assigned this week.";
      return [
        `${input.business} schedule ${scheduleVerb}: ${schedule}.`,
        openShifts.length ? `${openShifts.length} open shift${openShifts.length === 1 ? "" : "s"} available.` : "",
        hubUrl ? `Changes/open shifts: ${hubUrl}` : "",
        "Reply STOP to opt out.",
      ].filter(Boolean).join(" ");
    },
  });'''
if old not in text:
    raise SystemExit('schedule SMS block not found')
text = text.replace(old, new, 1)

staff.write_text(text)
