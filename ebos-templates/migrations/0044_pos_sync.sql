-- POS sync add-on (Chidera, 2026-09-16): a client wants their Moniepoint POS
-- terminal sales pulled into the dashboard as a real transaction list, not
-- just a revenue number -- separate from PAYMENT_PROVIDER/payment.js, which
-- is about collecting money FROM a customer through the bot. This is about
-- reading sales that already happened on a physical terminal, so credentials
-- live here in the DB (same "ERA switches these" shape as crm_config) rather
-- than in .env, since nothing here needs a container restart to change.
create table if not exists pos_sync_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  provider text not null default 'moniepoint' check (provider in ('moniepoint')),
  -- Moniepoint's own API key for this business's POS account -- only needed
  -- again if the webhook subscription ever has to be re-registered/rotated
  -- (scripts/add-pos-sync.mjs), never used on the inbound path below.
  api_key text,
  -- Moniepoint's Webhook Subscription Groups support Basic auth on the
  -- webhook call it makes to us (docs.pos.moniepoint.com) -- these are the
  -- credentials WE generate and hand to Moniepoint at registration time,
  -- then check against on every inbound call. Not an HMAC signature like
  -- Paystack's -- a different provider, a different mechanism.
  webhook_username text,
  webhook_password text,
  connected_at timestamptz
);

-- One row per POS sale pushed to us by Moniepoint's V1_POS_TRANSACTION
-- webhook. provider_reference is whatever Moniepoint calls its own
-- transaction id -- kept as the idempotency key since a webhook can and
-- will redeliver. raw_payload keeps the full event: the exact field names
-- in a live payload aren't fully confirmed from the docs alone, so this is
-- both the audit trail and the fallback if a field we parsed turns out to
-- be named differently once real traffic arrives.
create table if not exists pos_transaction (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'moniepoint',
  provider_reference text not null,
  amount numeric(12, 2) not null,
  occurred_at timestamptz not null default now(),
  raw_payload jsonb,
  created_at timestamptz not null default now()
);
create unique index if not exists pos_transaction_provider_ref_idx on pos_transaction(provider, provider_reference);
create index if not exists pos_transaction_occurred_at_idx on pos_transaction(occurred_at desc);
