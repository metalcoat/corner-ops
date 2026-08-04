# Employment forms rollout

Corner Ops includes a draft electronic onboarding and wage-notice workflow for New York employees. It stores sensitive submissions in an encrypted payload separate from ordinary employee scheduling fields and records signature timestamps, actors, network addresses, browser metadata, form versions, and an append-only event history.

## Included records

- Federal Form W-4, version 2026
- New York Form IT-2104, version 2026
- Form I-9 dated 08/01/23 with the 05/31/2027 expiration date
- New York LS 54 single-rate pay notice or LS 55 multiple-rate/hospitality notice
- New York meal-period acknowledgment

A new onboarding packet creates five separate records. A later pay-rate change creates a new notice with its own effective date and signatures. Existing signed records are not edited.

## Required configuration

Set `EMPLOYMENT_FORMS_ENCRYPTION_KEY` in every environment where forms will be used. Use a separate random value of at least 32 characters. Losing or changing the key without migrating existing records makes prior encrypted submissions unreadable.

Complete the employer form profile for each business before assigning a packet:

- legal employer name and DBA
- EIN
- principal address
- telephone number
- pay frequency and regular payday
- dependent health benefit availability and eligibility rule

## Meal-period wording

The acknowledgment states that employees receive an uninterrupted unpaid meal period of at least 30 minutes, or longer when required by New York law. Scheduling may account for operational needs, but the acknowledgment does not waive statutory meal-period rights. Employees are directed to report interruptions or work performed during a meal period so the time is recorded and paid.

## I-9 controls

- The employee completes and signs Section 1.
- The record then changes to `Employer Review`.
- Management records the documents the employee chose from the acceptable-document lists and completes Section 2.
- The app must not request a specific List A, B, or C document.
- If a preparer or translator assisted, Supplement A must be completed outside the current electronic workflow before submission.
- Identity-document images are not uploaded through the general Employee Hub. A future secure Drive workflow may add separately controlled storage if the employer chooses to retain copies consistently.

## Before production use

The workflow is intentionally kept in a draft pull request until all of the following are completed:

1. Configure the encryption key in Vercel.
2. Review the electronic substitute layouts against the current official W-4, IT-2104, I-9, LS 54, and LS 55 instructions.
3. Add a printable or downloadable final record that reproduces the completed official form or an approved electronic substitute.
4. Establish retention and deletion rules, including I-9 retention calculations.
5. Confirm employer signature authority and the business names/EINs used for Corner Deli and Tiki.
6. Conduct a test onboarding with fictional data and verify that sensitive values are not exposed after submission.
7. Obtain payroll or employment-law review before using the workflow for actual employees.

This feature is a records and workflow implementation, not legal or tax advice.
