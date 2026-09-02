-- Voice ordering add-on (see EBOS-Addon-Schema-Voice-and-Delivery.md,
-- Capability A) -- optional, per business, off by default
-- (voice_config.enabled = false). Purely additive: no application code
-- reads any of these tables/columns yet, so this is safe against a live
-- database with zero behavior change, same as 0012.
--
-- branch_id, not business_id, on voice_call/call_turn/callback_task --
-- same idiom every prior migration in this file has used since 0008:
-- business is a locked singleton per database, so business_id would carry
-- no information; branch_id is the real per-location scope. voice_config
-- is keyed on business_id, matching delivery_config -- a true
-- whole-deployment toggle, not a per-branch setting.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0013_voice_ordering_core.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0013_voice_ordering_core.sql

alter table customers add column if not exists preferred_name text;
alter table customers add column if not exists last_voice_call_at timestamptz;
alter table customers drop constraint if exists customers_channel_check;
alter table customers add constraint customers_channel_check
  check (channel in ('whatsapp', 'instagram', 'tiktok', 'website', 'voice'));

alter table message drop constraint if exists message_channel_check;
alter table message add constraint message_channel_check
  check (channel in ('whatsapp', 'instagram', 'tiktok', 'website', 'voice'));

create table if not exists voice_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  transport text not null default 'forwarding' check (transport in ('forwarding', 'gateway')),
  inbound_number text,
  voice_id text,
  transfer_numbers text[] not null default '{}',
  operating_hours jsonb,
  greeting_override text,
  max_minutes_per_month int,
  recording_enabled boolean not null default false,
  recording_retention_days int not null default 30
);

create table if not exists voice_call (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branch(id),
  customer_id uuid references customers(id),
  direction text not null default 'inbound' check (direction in ('inbound', 'outbound_callback')),
  caller_number text,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int,
  outcome text check (outcome in ('order_placed', 'enquiry_answered', 'handover_transferred', 'handover_callback', 'abandoned', 'failed')),
  order_id uuid references "order"(id),
  transport text not null default 'forwarding' check (transport in ('forwarding', 'gateway')),
  recording_url text,
  cost_estimate numeric(12, 2)
);
create index if not exists voice_call_branch_started_idx on voice_call (branch_id, started_at desc);

create table if not exists call_turn (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references voice_call(id),
  seq int not null,
  speaker text not null check (speaker in ('caller', 'system', 'staff')),
  transcript text,
  confidence numeric,
  started_at timestamptz not null default now()
);
create index if not exists call_turn_call_seq_idx on call_turn (call_id, seq);

create table if not exists callback_task (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branch(id),
  call_id uuid not null references voice_call(id),
  customer_id uuid references customers(id),
  reason text,
  context_summary text,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'abandoned')),
  claimed_by uuid references staff(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists callback_task_status_idx on callback_task (status) where status = 'open';
