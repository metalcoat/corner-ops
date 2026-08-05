# Corner Ops integrations

## Plaid banks and cards

A Plaid **Item** represents one institution login, not one individual bank account. When the same online-banking login exposes several checking, savings, or credit-card accounts, select all required accounts in a single Link session.

For the Plaid Dashboard Link customization used by Corner Ops:

1. Enable Account Select.
2. Set the selection mode to Multiple or All.
3. Assign that customization name to `PLAID_LINK_CUSTOMIZATION_NAME`.
4. Connect each distinct institution login once.

Existing Plaid connections have a **Manage shared accounts** action. It opens Plaid update mode with account selection enabled, allowing accounts to be added or removed without creating a second Item or exchanging a new public token.

New Items request up to 730 days of Transactions history. Institutions can still return less history. Existing Items initialized with a shorter history window may need to be removed and relinked to request a larger window.

## Historical bank imports

The Automation Center accepts CSV, XLS, and XLSX bank history files. The importer currently recognizes the supplied:

- SEACOMM Corner Deli transaction-history export
- NBT Bank At The Docks/Tiki transaction export

It also supports generic exports containing a transaction date, description, amount or debit/credit columns, and optional balance/account/check fields.

Historical imports:

- remain separate by business
- preserve institution and account labels
- parse parenthesized withdrawals and minus-sign withdrawals
- generate stable transaction identifiers
- can be reimported safely
- compare against other feeds for strong duplicate matches
- apply existing classification rules

## Credit-card statements

Card statements are handled under **Banking → Card statements**.

Accepted files:

- PDF
- CSV
- XLS
- XLSX

PDF statements are retained securely as source documents. Spreadsheet statements also extract transaction lines. Individual card purchases do not normally match checking-account transactions. The system instead matches the credit-card statement payment to an equal bank withdrawal near the statement date, then requires owner confirmation.

## Square

Square supplies Tiki payment and tip activity. Corner Ops remains the employee time-clock source.

## Rezku

Trusted Rezku daily-report emails provide Corner Deli labor, order, transaction, product-sales, and void information. Inbound report processing validates the sender, subject, and download host before importing workbooks.

## Scheduler

The nightly scheduler performs operational checks and synchronizes configured feeds. Production deployments remain paused until the owner explicitly authorizes them.
