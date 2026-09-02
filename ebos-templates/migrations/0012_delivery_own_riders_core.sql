-- Delivery add-on, own_riders mode (see EBOS-Addon-Schema-Voice-and-
-- Delivery.md, Capability B) -- optional, per business, off by default
-- (delivery_config.mode = 'none'). Purely additive: no application code
-- reads any of these tables/columns yet, so this is safe against a live
-- database with zero behavior change, same as 0008_branch_columns.sql.
--
-- branch_id, not business_id, on every new table except delivery_config --
-- same idiom the branch addendum (0008-0011) already established: business
-- is a locked singleton per database, so business_id would carry no
-- information; branch_id is the real per-location scope.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0012_delivery_own_riders_core.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0012_delivery_own_riders_core.sql

create table if not exists rider (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branch(id),
  name text not null,
  phone text not null unique,
  status text not null default 'off_duty' check (status in ('on_duty', 'off_duty', 'suspended')),
  bank_account_number text,
  bank_code text,
  account_name text,
  otp_code text,
  otp_expires_at timestamptz,
  last_lat numeric,
  last_lng numeric,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists delivery_zone (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branch(id),
  name text not null,
  aliases text[] not null default '{}',
  customer_fee numeric(12, 2) not null,
  rider_payout numeric(12, 2) not null,
  active boolean not null default true
);

create table if not exists delivery_offer (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id),
  branch_id uuid references branch(id),
  zone_id uuid not null references delivery_zone(id),
  status text not null default 'OPEN' check (status in ('OPEN', 'CLAIMED', 'EXPIRED', 'CANCELLED')),
  broadcast_at timestamptz not null default now(),
  escalated_at timestamptz,
  staff_alerted_at timestamptz,
  claimed_by uuid references rider(id),
  claimed_at timestamptz
);

create table if not exists delivery_assignment (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references delivery_offer(id),
  order_id uuid not null references "order"(id),
  rider_id uuid not null references rider(id),
  status text not null default 'ASSIGNED' check (status in ('ASSIGNED', 'PICKED_UP', 'ARRIVED', 'DELIVERED', 'FAILED')),
  delivery_code text not null,
  code_entered_at timestamptz,
  released_by_staff uuid references staff(id),
  override_reason text,
  tracking_token text not null unique,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists rider_payout (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references delivery_assignment(id),
  rider_id uuid not null references rider(id),
  branch_id uuid references branch(id),
  amount numeric(12, 2) not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'FAILED', 'PAID_MANUALLY')),
  provider text check (provider in ('paystack', 'flutterwave', 'moniepoint', 'manual')),
  provider_reference text,
  error text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create table if not exists delivery_config (
  business_id uuid primary key references business(id),
  mode text not null default 'none' check (mode in ('none', 'relay', 'own_riders')),
  payout_mode text not null default 'manual' check (payout_mode in ('automatic', 'manual')),
  provider text check (provider in ('paystack', 'flutterwave', 'moniepoint')),
  provider_keys text, -- encrypted opaque string (lib/crypto.js), not real JSON -- see schema.sql's comment
  offer_timeout_seconds int not null default 90
);

alter table "order" add column if not exists delivery_zone_id uuid references delivery_zone(id);

-- Widen delivery.provider's check constraint to allow 'own_riders' -- a
-- constraint swap, not a data-destructive statement, so it's outside what
-- migrate.mjs's guard is meant to catch.
alter table delivery drop constraint if exists delivery_provider_check;
alter table delivery add constraint delivery_provider_check check (provider in ('chowdeck', 'bolt', 'manual', 'own_riders'));
