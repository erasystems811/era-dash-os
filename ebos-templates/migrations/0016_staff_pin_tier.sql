-- Adds a third staff tier: PIN-only accounts for the "staff" role, alongside
-- the existing email+password login every owner/manager already uses.
-- A PIN account is always branch-scoped and always provisioned by a branch
-- manager (or an owner acting on one branch) -- there is no "all-branches
-- PIN staff", see routes/api.js's POST /staff/pin.
--
-- Zero effect on any existing row: every current staff account keeps
-- auth_type = 'password' and its email/password login unchanged. Dropping
-- NOT NULL on email/password_hash only makes room for PIN rows to exist
-- alongside them -- it does not relax anything for existing rows, and the
-- unique index on email already tolerates multiple NULLs under normal
-- Postgres semantics.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0016_staff_pin_tier.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0016_staff_pin_tier.sql
alter table staff alter column email drop not null;
alter table staff alter column password_hash drop not null;
alter table staff add column if not exists auth_type text not null default 'password' check (auth_type in ('password', 'pin'));
alter table staff add column if not exists pin_hash text;
-- Per-account PIN lockout (see lib/auth.js's verifyPin) -- a 4-digit PIN is
-- only safe because each one is checked against exactly one person on one
-- branch (never a global scan), and because repeated wrong guesses lock
-- that one row out for a while rather than being unlimited.
alter table staff add column if not exists pin_failed_attempts integer not null default 0;
alter table staff add column if not exists pin_locked_until timestamptz;
-- Who set up this PIN account -- an accountability trail for the branch
-- manager who provisioned it, surfaced in the activity log.
alter table staff add column if not exists created_by_staff_id uuid references staff(id);
