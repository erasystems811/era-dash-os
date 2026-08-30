-- Adds real form delivery mode (build schema v2.0 section 6, closed
-- 2026-08-30) -- the unguessable token in the link sent for a
-- task.mode='form' run. Additive only (safe to run against a live
-- database with existing runs) -- new businesses provisioned after this
-- migration was added get the same column straight from schema.sql, so
-- this file only matters for businesses that already existed before it
-- (esf-demo, provisioned 2026-08-30 before this column existed).
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=esf-templates/migrations/0002_run_form_token.sql
alter table run add column if not exists form_token text;
create unique index if not exists run_form_token_key on run (form_token);
create index if not exists run_form_token_idx on run (form_token) where form_token is not null;
