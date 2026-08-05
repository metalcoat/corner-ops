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

## Automatic invoice OCR

The **Invoices** owner navigation item opens `/ops/finance-operations/invoice-ocr`.

Selecting a PDF, JPG, PNG, or WebP invoice automatically sends it to a Google Document AI Invoice Parser. Corner Ops extracts:

- supplier/vendor name
- invoice number
- invoice and due dates
- subtotal, tax, total, and currency
- line descriptions, product codes, quantities, units, unit prices, and line totals
- field and line confidence scores

OCR results remain an editable draft. Warnings identify missing, low-confidence, or inconsistent fields. Nothing is written to accounts payable or inventory until the owner reviews the draft and chooses **Save reviewed bill**. The original invoice is then stored privately with the AP record.

Required Google configuration:

- `GOOGLE_CLOUD_PROJECT_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `GOOGLE_DOCUMENT_AI_LOCATION`
- `GOOGLE_DOCUMENT_AI_INVOICE_PROCESSOR_ID`
- optional `GOOGLE_DOCUMENT_AI_INVOICE_PROCESSOR_VERSION`

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
- Google Document AI invoice OCR credentials
- Resend and alert-email variables when email delivery is enabled

Do not store live credentials in the repository.
