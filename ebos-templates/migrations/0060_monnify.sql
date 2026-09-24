-- Chidera, 2026-09-23: "now check if we can integrate monify and opay to
-- be like paystack for auto confirm" then "then we wont use reserved we
-- will use dynamic" -- Monnify's Reserved Accounts (long-lived, tied to a
-- permanent customer identity) needs the customer's own BVN/NIN, the
-- original blocker; "Pay with Bank Transfer" is a separate, per-transaction
-- dynamic account product that does NOT, confirmed directly against
-- Monnify's own docs. "my client wants it as an option" -- a business-level
-- choice, same as pos/paystack/manual.
alter table payment_config drop constraint if exists payment_config_provider_check;
alter table payment_config add constraint payment_config_provider_check check (provider in ('pos', 'paystack', 'manual', 'monnify'));

-- Display-only -- the actual payment reference Monnify confirms against
-- (its own generated paymentReference, sent at init-transaction time) is
-- stored in the EXISTING payment_reference column, reusing
-- findOrderByPaymentReference exactly as Paystack already does. Only the
-- account details a customer needs to see are new here.
alter table "order" add column if not exists monnify_account_number text;
alter table "order" add column if not exists monnify_account_name text;
alter table "order" add column if not exists monnify_bank_name text;
alter table "order" add column if not exists monnify_account_expires_at timestamptz;
