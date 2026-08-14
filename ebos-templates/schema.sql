-- ERA Business Order System (EBOS) -- shared multi-tenant schema.
-- Every table below is business_id-scoped so one deployment serves many
-- businesses (restaurant, apartment/shortlet, car rental, lashes and nails).
-- Source of truth for field choices: ERA-Business-Order-System-Build-Schema-v1.1.
--
-- pgcrypto is needed for gen_random_uuid() and for encrypting per-business
-- payment secrets (Section 3.4) -- EBOS holds many businesses' keys at once,
-- unlike a normal ERA client app which has exactly one set of secrets in its
-- own .env, so those keys are encrypted columns here instead.
create extension if not exists pgcrypto;

create table if not exists business (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone_number text,
  address text,
  operating_hours jsonb,
  type text not null check (type in ('restaurant', 'apartment', 'car_rental', 'lashes_nails')),
  delivery_enabled boolean not null default false,
  whatsapp_connection text check (whatsapp_connection in ('coexistence', 'api_only')),
  handover_number text,
  -- Section 3.4: bank account details, shown back to staff, not secret enough
  -- to need encryption.
  bank_name text,
  bank_account_number text,
  bank_account_name text,
  -- Payment provider keys ARE encrypted (pgp_sym_encrypt), keyed by the
  -- PAYMENT_ENCRYPTION_KEY env var this deployment is given at provision
  -- time. Never select these back out in plaintext except to actually call
  -- the provider.
  payment_provider text check (payment_provider in ('paystack')),
  payment_secret_key_encrypted bytea,
  payment_public_key_encrypted bytea,
  created_at timestamptz not null default now()
);

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  name text not null,
  phone_number text,
  email text not null,
  password_hash text not null,
  role text not null check (role in ('owner', 'manager', 'staff')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  -- Globally unique, not per-business: login is email+password with no
  -- business picker, so one person can't hold two logins with the same
  -- email. A person genuinely staffing two businesses needs two emails --
  -- an acceptable trade for keeping login a single, simple step.
  unique (email)
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  name text,
  phone_number text,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram', 'tiktok', 'website')),
  channel_id text,
  address text,
  handled_by text not null default 'bot' check (handled_by in ('bot', 'staff')),
  handled_by_staff_id uuid references staff(id),
  handover_at timestamptz,
  handover_reason text,
  created_at timestamptz not null default now()
);
-- A customer is identified by (business, channel, whichever id that channel
-- gives -- phone for WhatsApp, channel_id for IG/TikTok), never phone alone.
create unique index if not exists customers_business_phone_idx
  on customers (business_id, phone_number) where phone_number is not null;
create unique index if not exists customers_business_channel_id_idx
  on customers (business_id, channel, channel_id) where channel_id is not null;

create table if not exists product (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  name text not null,
  description text,
  price numeric(12, 2) not null,
  availability boolean not null default true,
  availability_type text not null default 'stock' check (availability_type in ('stock', 'time_slot', 'date')),
  duration_minutes integer,
  -- Section 5.4 semantic matching is Phase 6 (AI layer), out of scope for
  -- this slice. Stored as a plain float array for now rather than pgvector's
  -- vector type, since the base postgres:16-alpine image this deployment
  -- uses doesn't have the pgvector extension installed -- swap to a real
  -- `vector(n)` column (and add the extension) when Phase 6 lands.
  embedding jsonb,
  created_at timestamptz not null default now()
);

create table if not exists "order" (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  customer_id uuid not null references customers(id),
  reference text not null unique,
  status text not null default 'new' check (status in ('new', 'confirmed', 'preparing', 'ready', 'delivery', 'completed', 'cancelled')),
  total numeric(12, 2) not null default 0,
  payment_status text not null default 'pending' check (payment_status in ('pending', 'proof_submitted', 'confirmed', 'accepted')),
  payment_proof_url text,
  fulfilment_type text check (fulfilment_type in ('delivery', 'pickup')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_item (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id) on delete cascade,
  product_id uuid not null references product(id),
  quantity integer not null default 1,
  price numeric(12, 2) not null,
  modification text
);

create table if not exists booking (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references business(id) on delete cascade,
  customer_id uuid not null references customers(id),
  product_id uuid not null references product(id),
  date date not null,
  end_date date,
  time time,
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'completed', 'cancelled', 'no_show')),
  total numeric(12, 2) not null default 0,
  payment_status text not null default 'pending' check (payment_status in ('pending', 'proof_submitted', 'confirmed', 'accepted')),
  payment_proof_url text,
  reference text not null unique,
  created_at timestamptz not null default now()
);
-- Prevents two confirmations racing each other onto the same slot -- the
-- database refuses the second one instead of the customer finding out on
-- the day. Partial (time may be null for a whole-day/date-range booking).
create unique index if not exists booking_no_double_booking_idx
  on booking (product_id, date, time) where status not in ('cancelled', 'no_show');

create table if not exists delivery (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references "order"(id) on delete cascade,
  business_id uuid not null references business(id) on delete cascade,
  booking_id uuid references booking(id) on delete cascade,
  customer_id uuid not null references customers(id),
  address text,
  phone_number text,
  rider_name text,
  rider_phone text,
  tracking_url text,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'delivered')),
  price numeric(12, 2) not null default 0,
  check (order_id is not null or booking_id is not null)
);

create index if not exists staff_business_idx on staff (business_id);
create index if not exists customers_business_idx on customers (business_id);
create index if not exists product_business_idx on product (business_id);
create index if not exists order_business_idx on "order" (business_id);
create index if not exists order_item_order_idx on order_item (order_id);
create index if not exists booking_business_idx on booking (business_id);
create index if not exists delivery_business_idx on delivery (business_id);

-- ---------------------------------------------------------------------------
-- pgrst_watch: keeps PostgREST's in-memory schema cache in sync automatically.
-- Without this, PostgREST only learns about a new/changed column on restart,
-- a real incident already hit once on Bali (see bali/supabase/schema.sql).
-- Copied verbatim rather than rediscovering it.
-- ---------------------------------------------------------------------------
create or replace function public.pgrst_watch() returns event_trigger
language plpgsql as $$
begin
  notify pgrst, 'reload schema';
end;
$$;

drop event trigger if exists pgrst_watch;
create event trigger pgrst_watch on ddl_command_end execute procedure public.pgrst_watch();
