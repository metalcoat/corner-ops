# Corner Ops

Corner Ops is the owner and employee operations system for Corner Deli and Tiki. It includes employee scheduling, time and attendance, payroll review, messaging, business reporting, banking integrations, documents, and operational alerts.

## Development status

Production deployments are intentionally paused. Current work remains on the deployment-disabled `agent/rebuild-corner-ops` branch and draft pull request #3 until the owner explicitly authorizes deployment.

## Banking and historical imports

The Automation Center supports:

- Plaid institution connections for bank and credit-card accounts
- several accounts under one Plaid Item/institution login
- Plaid update mode for changing the accounts shared by an existing Item
- CSV and Excel historical transaction imports
- format recognition for the supplied SEACOMM and NBT exports
- stable source identifiers and reimport-safe transaction identifiers
- duplicate checks against transactions received from other feeds
- accounting classification and owner review

The historical import screen is under **Settings → Integrations**. Choose the business, institution, account label, and CSV or Excel file. Corner Deli and Tiki/At The Docks remain separate accounting entities.

## Credit-card statements

The Banking area includes a card-statement reconciliation page. Owners can upload PDF, CSV, XLS, or XLSX statements. PDFs are stored securely as source documents. Spreadsheet statements also extract transaction rows.

A card statement is reconciled to the bank account through the statement payment, not by matching every card purchase to the bank feed. The system searches for equal bank withdrawals around the statement date and requires owner confirmation before marking a statement matched.

## Overtime and shift coverage

The overtime monitor calculates Corner Deli and Tiki independently and uses the Monday 4:00 AM to Monday 4:00 AM payroll week. It combines actual worked hours with remaining assigned shifts, warns at 38 hours, flags projected overtime above 40 hours, identifies unscheduled or substituted work, and suggests qualified same-business replacements.

## Employee and owner apps

Corner Ops includes an installable PWA shell, owner and employee messaging, push-notification registration, high-contrast message displays, mobile Employee Hub updates, and a weekly employee schedule grid.

## Environment variables

Core deployment variables include:

- `DATABASE_URL`
- `SESSION_SECRET`
- `BLOB_READ_WRITE_TOKEN`
- `EMPLOYMENT_FORMS_ENCRYPTION_KEY` with at least 32 characters
- `CRON_SECRET`
- Plaid credentials and optional `PLAID_LINK_CUSTOMIZATION_NAME`
- Resend and alert-email variables when email delivery is enabled

Do not store live credentials in the repository.
