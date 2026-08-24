-- Corner Ops production schema baseline
-- Generated from production Neon PostgreSQL 17.11 on 2026-08-24.
-- Baseline inventory: 117 public tables, 0 public views, 0 public sequences,
-- 6 public functions, 5 non-internal public triggers, 0 RLS policies.
--
-- Validation: the generated baseline was replayed onto a blank public schema on
-- Neon branch br-weathered-rice-av71nwrz. Catalog fingerprints for columns/defaults,
-- constraints, indexes, functions, triggers, and the public schema owner/ACL matched
-- production exactly after reconstruction.
--
-- Fresh databases apply all 0001* baseline files in lexical order. This baseline
-- already includes the historical effects of migrations 0002 through 0007, which
-- remain in the repository for audit history and MUST NOT be replayed after 0001.
-- New migrations for fresh databases begin at 0008 and are applied in lexical order.
-- Do not apply the 0001 baseline to a database that already contains Corner Ops.

CREATE SCHEMA IF NOT EXISTS public AUTHORIZATION pg_database_owner;
ALTER SCHEMA public OWNER TO pg_database_owner;
GRANT ALL ON SCHEMA public TO pg_database_owner;
GRANT USAGE ON SCHEMA public TO PUBLIC;
