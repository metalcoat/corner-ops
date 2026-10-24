# Corner Ops

Corner Ops is the owner and employee operations system for Corner Deli and Tiki. It includes employee scheduling, time and attendance, payroll review, messaging, business reporting, banking integrations, finance operations, documents, and operational alerts.

## Development status

Automatic Vercel Git deployments are intentionally disabled while the replacement POS and AI ordering platform is under construction. Active POS development is on `agent/pos-ordering-foundation` in draft pull request #9. Keep the branch development-only and re-enable deployments deliberately when preview/parallel testing is worth the build and infrastructure cost. Production deployment still requires explicit owner authorization.

The POS foundation now includes separate Deli/Tiki POS surfaces, shared menu/modifier/combo rules, fulfillment and unpaid-web SMS verification, saved processor payment references, employee meals, house accounts, inventory movement tracking, cash/driver settlement foundations, future-order capacity, Tiki-only bar tabs, promotions, gift/store-credit ledgers, closeout/audit structures, and separate Deli/Tiki reporting direction.

Corner Deli delivery policy is also being built as shared server-side logic so POS, employee-entered phone orders, AI phone orders, and web ordering cannot quietly disagree. The current development policy uses a $20 merchandise minimum, configurable distance/fee bands, an upsell-first under-minimum flow, an exact shortfall fee when the customer declines add-ons, management-visible true bypasses, and tax-inclusive menu pricing with a configurable tax rate. The actual tax rate must be explicitly configured before production.

For example, a $14 delivery order against a $20 minimum should first trigger a useful add-on offer such as fries. If the customer declines and still wants delivery, policy can add a visible $6 minimum-order adjustment. That is not a true bypass. A true waiver of the missing $6 requires authorized management action and creates an alert.

The replacement POS and these delivery/tax settings remain development-only. They are not merged into the existing live Vercel workflow during this build phase.

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
- `SESSION_SECRET`
- `BLOB_READ_WRITE_TOKEN`
- `EMPLOYMENT_FORMS_ENCRYPTION_KEY` with at least 32 characters
- `CRON_SECRET`
- Plaid credentials and optional `PLAID_LINK_CUSTOMIZATION_NAME`
- Azure Document Intelligence endpoint and key
- optional outside document-upload PINs
- Resend and alert-email variables when email delivery is enabled

Do not store live credentials in the repository.
