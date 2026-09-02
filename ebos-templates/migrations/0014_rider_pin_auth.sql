-- Rider sign-in switches from a WhatsApp OTP to a staff-set PIN (Chidera's
-- call, 2026-09-02) -- a rider is already pre-registered by the restaurant,
-- so the OTP's only real job was proving phone ownership, at the cost of a
-- Meta AUTHENTICATION-template approval this codebase otherwise has no use
-- for. Purely additive: otp_code/otp_expires_at are left in place, unused
-- rather than removed, so this is safe against a live database with zero
-- behavior change until the new sign-in code is also deployed.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0014_rider_pin_auth.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0014_rider_pin_auth.sql

alter table rider add column if not exists pin_hash text;
alter table rider add column if not exists pin_failed_attempts integer not null default 0;
alter table rider add column if not exists pin_locked_until timestamptz;
