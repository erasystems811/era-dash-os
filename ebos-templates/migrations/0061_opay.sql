-- Chidera, 2026-09-23: "so what of opay?" -- OPay's own "Bank Transfer
-- Payment" product, same dynamic-account shape as Monnify's (see
-- 0060_monnify.sql), a separate provider option, not a dependency on it.
alter table payment_config drop constraint if exists payment_config_provider_check;
alter table payment_config add constraint payment_config_provider_check check (provider in ('pos', 'paystack', 'manual', 'monnify', 'opay'));

-- Display-only, same reasoning as Monnify's own columns -- the real
-- reference OPay confirms against lives in the EXISTING payment_reference
-- column. No account NAME column here: OPay's response
-- (nextAction.transferAccountNumber/transferBankName) never returns one,
-- unlike Monnify's.
alter table "order" add column if not exists opay_account_number text;
alter table "order" add column if not exists opay_bank_name text;
alter table "order" add column if not exists opay_account_expires_at timestamptz;
