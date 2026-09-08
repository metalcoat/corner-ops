# Payroll form access and optional punch notes

## Punch corrections

On both Payroll control and Tiki punch corrections, the reason starts as **Owner time correction**. Clearing it is allowed; the server supplies that default to the audit. A custom note is retained while editing further punches on the same page, including after a failed save. Switching payroll businesses resets the note. The legacy payroll helper delegates to the current implementation so it cannot reintroduce the old required-reason check. Manual tip allocations still require their own reason.

## Completed employment forms

Under **People > Employment forms**, Owner and Co-Owner accounts can choose **View completed form** beside a signed record. The view shows the saved employee submission, including the full SSN when it was collected, withholding elections, addresses, employer-completed fields, and electronic-signature attestations. It is read-only. The separate government link is labeled **Blank official template**; this release does not create or claim to reconstruct a government PDF.

Full details require the server-checked `employment_forms.sensitive.read` permission, currently available to Owner/Co-Owner through their `*` permission only. Ordinary reviews stay redacted, and Employee Hub continues to hide completed tax/identity submissions. Database reads are scoped by business and, for Employee Hub, by employee before decryption. The dedicated POST endpoint rejects cross-business and cross-origin requests, returns private/no-store responses, and records access in the existing audit table without sensitive field values. An audit-write failure prevents disclosure.

The view keeps data in component memory, not local/session storage. Hide and close, navigation, hiding the tab, or the five-minute limit clears the view. No SSNs are copied automatically, included in URLs, or added to logs.

## Release scope and tests

This change is based on main independently of draft PR #36. No encryption keys, schema migrations, production employee records, or broad role grants are changed.

`npm test` covers role restrictions, cross-business denial, audit failure, redacted reviews, Employee Hub privacy, real encryption/decryption of synthetic saved answers, blank-note saves, and the Tiki correction HTTP handler with mocked database boundaries. `tools/test_payroll_forms_ui.py` exercises the browser against intercepted synthetic API responses after a build. It requires `pip install playwright==1.57.0` and `python -m playwright install --with-deps chromium`. No test logs or screenshots contain real employee data.
