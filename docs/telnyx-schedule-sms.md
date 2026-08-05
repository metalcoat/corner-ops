# Telnyx schedule SMS setup

Corner Ops uses Telnyx for employee schedule text messages.

## What sends an SMS

SMS is sent only when a schedule week is published or republished. Ordinary Corner Ops messages do not send SMS. Schedule texts contain a link to the employee portal and the applicable PIN instructions.

Only active employees with a mobile phone and the **Employee consented to SMS notifications** option enabled are eligible.

## Telnyx

1. Create a Telnyx API key.
2. Obtain an SMS-capable Telnyx number and attach it to the appropriate Messaging Profile.
3. Keep the number in E.164 format, such as `+13155551234`.

## Vercel

In the `DeliTiki` team, open the `corner-ops` project and go to **Settings → Environment Variables**. Add these variables to Production:

```text
TELNYX_API_KEY=<Telnyx API key>
TELNYX_FROM_NUMBER=<Telnyx SMS number in E.164 format>
EMPLOYEE_APP_URL=https://corner-ops.vercel.app
```

Redeploy Production after changing environment variables.

## Employee records

Open **Operations → Employees**, select the employee, enter their mobile phone, and enable **Employee consented to SMS notifications**. Employees without both values are skipped.
