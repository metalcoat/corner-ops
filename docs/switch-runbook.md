# Switch runbook: production onto this branch, then online ordering

How production moves from the copied `/opt/corner-ops/production/release` folder (main + hand edits) to this
branch, and then takes online ordering over from Rezku. The phases and dates are in the switchover plan
(Claude Doc, see project memory). **Every production step needs the owner's go-ahead on the day.** Rehearse each
step on staging first (`deploy/staging/refresh-staging.sh`, then the same commands against
`corner-ops-staging-postgres` / :3002).

## Rehearsal results (2026-10-24, staging = last night's production backup + this branch)

| Step | Result |
|---|---|
| Database updates (`tools/db-migrate.sh`) on production's data | 0009–0018 applied in ~5 s, no errors; 0014 (~3,000 lines) included. |
| Store setup copied from dev (`tools/promote-dev-config.sh --with-customers`) | 51 tables in ~3 s: 219 menu items, 573 options, hours, delivery, printers/stations, loyalty, promotions, 3,189 CRM customers; no orphaned references. |
| App on production's data | Healthy; catalog shows 204 orderable items; card checkout on (MX sandbox). |
| Validation suites with `VALIDATION_TARGET=staging` | lifecycle, checkout preflight, MX sandbox checkout, saved cards, scheduled-order hold, void money, voids, item cancellation (+reopen), payments, delivery pricing, availability, promotions, loyalty, kitchen tickets: all passed. |
| Customer site in a browser (Playwright) | Passed after fixing a crash on plain-http LAN addresses (`crypto.randomUUID`). |

**Finding:** production's database has **no menu, hours, delivery settings, printers, stations, loyalty or
customers** today; all of that was built on dev. The switch must copy it once (step 4 below).

## Production steps (store closed, owner present)

1. **Backup:** `production/backup_prod.sh` (and confirm the off-site copy ran or run `deploy/offsite-backup.sh`).
2. **Code:** build the production image from this branch's tested commit (compose file
   `deploy/selfhost/docker-compose.prod.yml`, which also caps logs). Keep the current image tagged for rollback.
3. **Database:** `tools/db-migrate.sh --container corner-ops-prod-postgres` (production has 0001–0008 recorded).
4. **Store setup:** `tools/promote-dev-config.sh --target corner-ops-prod-postgres --with-customers` (refuses if
   production already has a menu). Freeze menu edits on dev from this point, or re-run on a fresh rehearsal.
5. **Settings** (`production/.env`): `MX_*` with `MX_ENVIRONMENT=production`, `PAYMENT_PROVIDER`,
   `CUSTOMER_APP_URL=https://ordercornerdeli.com`, `GOOGLE_CLIENT_ID/SECRET` (+ redirect URI registered),
   `ADDRESS_PROVIDER`, `GOOGLE_MAPS_API_KEY`, `DELI_ORIGIN_LATITUDE/LONGITUDE`, `SMTP_*`/`CUSTOMER_EMAIL_FROM`,
   `PAYROLL_NOTIFY_EMAIL`. Card payments refuse to run until `MX_ENVIRONMENT=production`.
6. **Jobs** (chris's crontab + `run_prod_cron.sh` allow list): add `ordering-maintenance` every minute (print
   retries, scheduled-order release, terminal capture, closing void-money email) and `missed-clock-outs` every
   15 minutes; remove `rezku-repair`.
7. **Start and check:** `/api/health`, POS sign-in, a kitchen test ticket, menu TVs pointed at production.
8. **Online ordering (separate go-ahead):** Cloudflare: route `ordercornerdeli.com` and `www` to the production
   tunnel (:3001). Place one small real order (pickup, card), refund it, then update the Google Business Profile
   link and add the site to Search Console.

**Rollback:** start the previous production image and restore the step-1 backup (`pg_restore` into
`corner-ops-prod-postgres`); point Cloudflare back to Rezku for online ordering.
