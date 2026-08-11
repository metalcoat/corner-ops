from pathlib import Path

staff = Path('src/lib/staff-notifications.ts')
text = staff.read_text()
old = '''  const email = await deliverEmails({
    recipients,
    subject: () => `${input.business} staff message`,
    text: (employee) => [
      `Hi ${clean(employee.name, 120).split(/\\s+/)[0] || "there"},`,
      "",
      body,
      hubUrl ? `\\nOpen Employee Hub: ${hubUrl}` : "",
      hubUrl ? `Sign in with your ${pinLength}-digit employee PIN.` : "",
      "",
      `Sent by ${input.actor} through Corner Ops.`,
    ].filter(Boolean).join("\\n"),
  });

  return { sent: true, recipients: recipients.length, email };
}'''
new = '''  const email = await deliverEmails({
    recipients,
    subject: () => `${input.business} staff message`,
    text: (employee) => [
      `Hi ${clean(employee.name, 120).split(/\\s+/)[0] || "there"},`,
      "",
      body,
      hubUrl ? `\\nOpen Employee Hub: ${hubUrl}` : "",
      hubUrl ? `Sign in with your ${pinLength}-digit employee PIN.` : "",
      "",
      `Sent by ${input.actor} through Corner Ops.`,
    ].filter(Boolean).join("\\n"),
  });

  const sms = await deliverSms({
    recipients,
    text: () => [
      `${input.business}: ${body}`,
      hubUrl ? `Open Employee Hub: ${hubUrl}` : "",
      "Reply STOP to opt out.",
    ].filter(Boolean).join(" "),
  });

  return { sent: true, recipients: recipients.length, email, sms };
}'''
if old not in text:
    raise SystemExit('staff notification block not found')
staff.write_text(text.replace(old, new, 1))

workforce = Path('src/lib/workforce.ts')
text = workforce.read_text()
old = 'import type { EmployeeSession } from "@/lib/employee-auth";\nimport type { Business } from "@/lib/types";'
new = 'import type { EmployeeSession } from "@/lib/employee-auth";\nimport { sendStaffNotification } from "@/lib/staff-notifications";\nimport type { Business } from "@/lib/types";'
if old not in text:
    raise SystemExit('workforce import block not found')
text = text.replace(old, new, 1)

old = '''    } else if (request.request_type === "Offer") {
      await getSql()`
        UPDATE schedule_shifts SET employee_id = NULL, status = 'Open', updated_at = NOW()
        WHERE id = ${String(request.shift_id)} AND employee_id = ${String(request.requester_employee_id)}
      `;
    } else {'''
new = '''    } else if (request.request_type === "Offer") {
      const opened = await getSql()`
        UPDATE schedule_shifts SET employee_id = NULL, status = 'Open', updated_at = NOW()
        WHERE id = ${String(request.shift_id)} AND employee_id = ${String(request.requester_employee_id)}
        RETURNING starts_at, ends_at, position
      ` as unknown as Array<{ starts_at: string | Date; ends_at: string | Date; position: string }>;
      const openShift = opened[0];
      if (openShift) {
        const start = new Date(openShift.starts_at);
        const end = new Date(openShift.ends_at);
        const date = new Intl.DateTimeFormat("en-US", {
          timeZone: TIME_ZONE,
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(start);
        const time = new Intl.DateTimeFormat("en-US", {
          timeZone: TIME_ZONE,
          hour: "numeric",
          minute: "2-digit",
        });
        await sendStaffNotification({
          business: input.business,
          actor: input.actor,
          body: `Open shift available: ${date}, ${time.format(start)}-${time.format(end)} · ${clean(openShift.position, 100) || "Shift"}. Request it in Employee Hub.`,
        });
      }
    } else {'''
if old not in text:
    raise SystemExit('offer approval block not found')
workforce.write_text(text.replace(old, new, 1))
