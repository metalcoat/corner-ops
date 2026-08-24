# Corner Ops

Corner Ops is the owner and employee operations system for Corner Deli and Tiki. It includes employee scheduling, time and attendance, payroll review, messaging, business reporting, banking integrations, finance operations, documents, and operational alerts.

## Development status

Production deploys from `main` through Vercel. Remediation branches are allowed to create preview deployments, and changes are tested before they are merged to production.

## Banking and historical imports

The Automation Center supports Plaid bank and credit-card connections, several accounts under one institution Item, Plaid update mode, CSV and Excel history imports, duplicate protection, transaction classification, and owner review. Corner Deli and Tiki/At The Docks remain separate accounting entities.

## Credit-card statements

The Banking area accepts PDF, CSV, XLS, and XLSX card statements. PDFs are stored securely as source documents. Spreadsheet statements can extract transaction rows. Reconciliation matches the checking-account payment to the statement, rather than incorrectly matching every card purchase to a bank withdrawal.

## Azure invoice and receipt OCR

The **Invoices** owner navigation item opens `/ops/finance-operations/invoice-ocr`.

Invoice and receipt recognition uses Azure Document Intelligence through a provider abstraction. The current provider is Azure, while the interface can later support a self-hosted invoice2data worker without replacing the owner or scanner workflows.

Azure extracts:

- vendor or merchant name
- invoice/reference number
- invoice, transaction, and due dates
- subtotal, tax, total, and currency
- descriptions, product codes, quantities, units, prices, and line totals
- field and line confidence scores

Owner invoice OCR results remain editable drafts. Nothing is written to accounts payable or inventory until the owner reviews the result and chooses **Save reviewed bill**.

The free-tier configuration deliberately analyzes only the first two invoice pages and the first receipt page.

Required Azure configuration:

- `INVOICE_OCR_PROVIDER=azure`
- `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT`
- `AZURE_DOCUMENT_INTELLIGENCE_KEY`
- optional `AZURE_DOCUMENT_INTELLIGENCE_API_VERSION`, defaulting to `2024-11-30`

## Mobile document scanner

The scanner is available at `/scan`, in owner navigation, and in Employee Hub navigation.

It supports:

- phone rear-camera capture or image selection
- browser-side black-and-white conversion
- adjustable threshold and image rotation
- Invoice, Receipt, Insurance, Permit, Contract, Employee, Inventory, and Other classifications
- standardized filenames using date, business, type, vendor/title, and reference number
- private Vercel Blob storage in the Documents vault
- automatic Azure extraction for invoices and receipts
- no OCR charge for insurance, permits, contracts, employee records, inventory documents, and other files

Owners can save directly. Employee and upload-only submissions are always marked **Needs Review**. Outside uploaders can use a business-specific PIN and cannot browse stored documents.

Optional outside-upload configuration:

- `DOCUMENT_UPLOAD_PIN_CORNER_DELI`
- `DOCUMENT_UPLOAD_PIN_TIKI`

## Overtime and shift coverage

The overtime monitor calculates Corner Deli and Tiki independently and uses the Monday 4:00 AM to Monday 4:00 AM payroll week. It combines actual worked hours with remaining assigned shifts, warns at 38 hours, flags projected overtime above 40 hours, identifies unscheduled or substituted work, and suggests qualified same-business replacements.

## Employee and owner apps

Corner Ops includes an installable PWA shell, owner and employee messaging, push-notification registration, mobile Employee Hub tools, a weekly employee schedule grid, and the document scanner.

## Core environment variables

Core deployment variables include:

- `DATABASE_URL`
- `SESSION_SECRET` as the legacy transition key, plus purpose-specific owner/employee/wallboard session secrets
- `EMPLOYEE_PIN_PEPPER`, `INTEGRATION_ENCRYPTION_KEY`, `SQUARE_OAUTH_STATE_SECRET`, and `KEY_ENCRYPTION_KEY` for independent credential rotation
- `BLOB_READ_WRITE_TOKEN` (or Vercel Blob OIDC configuration)
- `EMPLOYMENT_FORMS_ENCRYPTION_KEY` with strong random key material
- `CRON_SECRET`
- Plaid credentials and optional `PLAID_LINK_CUSTOMIZATION_NAME`
- Azure Document Intelligence endpoint and key
- optional outside document-upload PINs
- Resend and alert-email variables when email delivery is enabled

Do not store live credentials in the repository.
