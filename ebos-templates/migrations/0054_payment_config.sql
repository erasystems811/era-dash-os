-- Chidera, 2026-09-20: "what i was generating was a test key" (Moniepoint
-- POS setup) then "can you integrate the pos? ill get a live key" plus the
-- broader ask from earlier the same day: "a business can choose pos,
-- flutterwave, paystack, or manual... i need pos to work now for both
-- online and in house". Flutterwave deliberately left out of the check
-- constraint for now ("leave flutterwave out for now") -- add it in its
-- own migration once that integration actually exists, rather than
-- offering a selectable-but-nonfunctional option today.
--
-- provider has NO default on purpose -- a business with no row here yet
-- (every existing client, era-demo/pomodoro/dee included) must keep
-- behaving exactly as it does today (engine/payment.js's env-var-driven
-- PAYMENT_PROVIDER check), not silently fall back to 'manual' the moment
-- this migration runs. Only once an owner actually saves a choice on
-- Settings does this table's value start being consulted at all -- see
-- engine/payment.js's getPaymentConfig.
create table if not exists payment_config (
  business_id uuid primary key references business(id),
  provider text check (provider in ('pos', 'paystack', 'manual')),
  transfer_account_number text,
  transfer_account_name text,
  transfer_bank_name text
);
