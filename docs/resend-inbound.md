# Rezku inbound email through Resend

Corner Ops receives Rezku daily reports through Resend Inbound rather than Gmail or Google Apps Script.

## Required Vercel variables

- `RESEND_API_KEY`
- `RESEND_WEBHOOK_SECRET`
- `REZKU_ALLOWED_SENDER=support@rezku.com`

After adding or changing these variables, create a fresh Vercel deployment so the serverless functions receive the new values.

## Webhook

Configure a Resend `email.received` webhook to:

```text
https://<corner-ops-domain>/api/rezku/inbound
```

The route verifies the Resend/Svix signature, accepts only the trusted Rezku sender and subject, downloads Excel reports only from `files.reporting.rezkupos.com`, and imports them into the Corner Deli payroll pipeline.
