-- Stage 3 of real multi-branch support: per-branch WhatsApp credentials.
-- A separate table from `branch` -- a channel's number/token pair is its
-- own config, not a property of the location, and voice/Instagram will
-- want the same shape later without widening `branch` indefinitely.
--
-- Plaintext access_token, matching how every other provider key in this
-- codebase already lives (Paystack's in .env, same trust boundary: one
-- business's own database, on its own server). No encryption-at-rest
-- machinery exists anywhere else in EBOS to be consistent with, and none
-- is being invented here.
--
-- Zero rows here means every business behaves exactly as it does today
-- (single shared number from .env) -- see engine/branch-channel.js.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0010_branch_channel.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0010_branch_channel.sql
create table if not exists branch_channel (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branch(id) on delete cascade,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram', 'voice')),
  phone_number_id text,
  access_token text,
  verify_token text,
  created_at timestamptz not null default now()
);
create unique index if not exists branch_channel_branch_channel_idx on branch_channel (branch_id, channel);
create unique index if not exists branch_channel_phone_number_id_idx on branch_channel (phone_number_id) where phone_number_id is not null;
