# Audit remediation and controlled rollout

## Scope

The changes cover direct-deposit sensitive access, time-clock idempotency,
runtime schema mutation, deployment-safe migrations, and independent production
secrets. They also remove ten additional runtime DDL statements found by the
expanded guard and correct the OAuth-state environment-variable name.

## Changes

- Detailed direct-deposit reads require `direct_deposit.sensitive.read`. Only
  Owner and Co-Owner currently receive this through their existing `*` permission.
  Manager and Viewer may retain summary/list access, but cannot request decrypted
  detail. The SQL lookup is business/employee-scoped before decryption. Sensitive
  admin reads are audited without banking values and are marked `private, no-store`.
- Punch POST requests must contain an explicit action, request UUID, and the last
  observed entry ID. Clock-out targets that specific entry. An employee-scoped
  transaction lock serializes requests; punch data and its replay receipt commit
  atomically. Reusing the same UUID with different action/target is rejected.
  Replaying an old clock-out cannot create a clock-in or close a newer shift.
- The clock UI checks status before asking the employee to confirm an explicit
  clock-in/out. A pending command is saved before submission and retained across
  reloads. Retries send that same command. Unknown commit outcomes say **PUNCH NOT
  CONFIRMED**, rather than incorrectly saying the employee is still clocked in.
  Fresh location is requested per punch, null GPS is not treated as zero, requests
  are bounded, and optional overtime notification is outside the response path.
- Schema changes are under migrations, including the bank filter, employee sync,
  handbook, receipt/expense, vendor-bill, and overtime schema statements. The DDL
  guard handles multiline statements, `OR REPLACE`, and `UNIQUE` variants.
- `npm run build` is now pure `next build`. Managed releases start at migration
  `0010`; the historical `0001` through `0009` baseline remains unchanged.
  `db:migrate` uses one database connection/transaction, a transaction-level
  advisory lock, checksums, and a ledger. Failure rolls back both schema work and
  ledger entries. Previously applied files cannot be silently changed or replayed.
- Production build and Node startup require strong, distinct dedicated secrets.
  New sessions, PIN hashes, and encrypted values cannot fall back to the global
  session secret in production. Legacy session signatures are rejected. Explicit
  historical keys remain available only for existing encrypted data/PIN migration.

## Rollout is blocked until production configuration is verified

Do not merge/promote this branch before all steps below are complete. The connected
Vercel account returned no accessible projects during this repair; production
variables, runtime role, database state, and live behavior have NOT been verified.
No production data or secrets were changed by this repair.

1. Back up the database and retain the existing secret values securely. Identify
   each current effective encryption root before adding dedicated keys.
2. Configure distinct strong production values for `OWNER_SESSION_SECRET`,
   `EMPLOYEE_SESSION_SECRET`, `DELI_BOARD_SESSION_SECRET`, `EMPLOYEE_PIN_PEPPER`,
   `INTEGRATION_ENCRYPTION_KEY`, `KEY_ENCRYPTION_KEY`,
   `EMPLOYMENT_FORMS_ENCRYPTION_KEY`, `SQUARE_OAUTH_STATE_SECRET`, and `CRON_SECRET`.
   Do not replace the existing employment-form encryption key just to satisfy the
   check: it is needed to read existing banking/onboarding records. Preserve the
   original `SESSION_SECRET` while legacy stored credentials/PIN hashes need it.
3. When changing an existing effective root, first configure its actual previous
   value in `LEGACY_INTEGRATION_ENCRYPTION_KEY`, `LEGACY_KEY_ENCRYPTION_KEY`, or
   `LEGACY_EMPLOYEE_PIN_PEPPER` (and optional `_2`). These are former real roots,
   NOT newly generated random values. For a formerly unset dedicated key, inspect
   the old fallback chain: employment-form key first, then session secret.
   Validate decryption of existing integrations and the persisted VAPID key in
   an isolated environment. Existing v1 integration ciphertext continues to use
   the unchanged historical `SESSION_SECRET` derivation.
4. Test on a disposable/staging database. A fresh database must first apply the
   historical `0001*.sql` baseline, then `0008` and `0009`, matching schema CI.
   `0002` through `0007` are already represented by the captured baseline and
   must not be blindly replayed. Existing production databases use the idempotent
   `0010` compatibility bridge; no implicit baseline adoption is performed.
5. Using a controlled environment with `MIGRATION_DATABASE_URL` set securely, run
   `npm run db:status`, then `npm run db:migrate -- --production`. The runner uses
   Node 22 and the existing Neon Client/WebSocket driver. Do not run this from
   Vercel's build command. Re-run status to confirm the committed ledger.
6. The new function is SECURITY INVOKER and its PUBLIC execution permission is
   revoked. If migration and runtime database roles differ, explicitly grant the
   runtime role SELECT/INSERT on `public.timeclock_punch_requests` and EXECUTE on
   `public.corner_ops_punch_tiki(uuid,uuid,text,uuid,numeric,numeric,numeric,text)`.
   Existing employee/time-entry table permissions are still required. Do not grant
   these permissions to anonymous database roles.
7. Build with verified production configuration, then promote the tested release.
   The old site remains running until promotion. Existing signed sessions will
   require login again; old clock clients are rejected and must refresh. Test one
   complete clock-in/out cycle, lost-response replay, sensitive detail access as
   Viewer/Manager/Owner, existing encrypted-record reads, and nightly cron health.

## Rollback

Keep the additive schema migrations and ledger in place when rolling back the
application. Do not delete punch receipts, drop columns/tables, reverse the data
backfills, or replace original encryption keys as a rollback shortcut. Restoring
old application code restores its old toggle/security behavior, so assess that
tradeoff before rollback. Preserve explicit historical keys until data has been
re-encrypted and legacy PINs have migrated; PIN upgrades happen on verified login.

## Validation

`npm test` runs actual route-policy tests with mocked external boundaries, contract
and pending-request tests, secret isolation/legacy decryption checks, migration
ledger behavior tests, and DDL-guard tests. Existing regression checks are retained
and their migration assertions follow the moved SQL files. Schema CI runs real
PostgreSQL tests for atomic receipt persistence, stale-shift safety, isolated
cleanup failure, and simultaneous requests over separate database connections.
