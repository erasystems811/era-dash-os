-- ERA Business Order System (EBOS) -- per-client schema.
-- One database per business. No business_id anywhere -- isolation is
-- physical (a separate database per client), not row-level. `business` is a
-- single-row settings table, not a list. See
-- ERA-Business-Order-System-Build-Schema-v2.0.md for the full spec.
create extension if not exists pgcrypto;

create table if not exists business (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Free text, not a fixed enum -- restaurant/apartment/car_rental/
  -- lashes_nails are the four the workstation ships default questions for,
  -- but any business type can be typed in (Train the bot just starts empty
  -- for a type with no built-in defaults, same as any other business).
  type text not null,
  phone_number text,
  address text,
  operating_hours jsonb,
  delivery_enabled boolean not null default false,
  whatsapp_connection text check (whatsapp_connection in ('coexistence', 'api_only')),
  handover_number text,
  bank_name text,
  bank_account_number text,
  bank_account_name text,
  -- Branding, for the invoice/receipt template -- a full data: URI (the
  -- browser reads the uploaded file with FileReader), not a filesystem
  -- path. Simpler and safer than standing up file upload/static serving
  -- for what's realistically always a small logo image.
  logo_data_url text,
  brand_color text not null default '#111827',
  -- Meta's native WhatsApp Catalogue (the shop icon in-chat) -- separate
  -- from the product table's own use in the bot's order flow. Creating the
  -- catalog is self-service (engine/whatsapp-catalog.js); connecting it to
  -- this number is not exposed as a public API by Meta, so
  -- whatsapp_catalog_connected just tracks whether the one-time manual
  -- click in Meta Business Suite has happened yet.
  whatsapp_catalog_id text,
  whatsapp_catalog_connected boolean not null default false,
  created_at timestamptz not null default now()
);
-- Optional. Most businesses are single-location and just use business.address
-- above -- this table only matters once a business has more than one real
-- location. Zero rows means "single location, use business.address" exactly
-- as before; any rows here means the bot asks which branch on every order
-- and answers "where are you" from these instead of business.address.
create table if not exists branch (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null,
  phone_number text,
  operating_hours text,
  created_at timestamptz not null default now()
);

-- Payment provider keys (Paystack) live in this deployment's own .env, set
-- via add-payment.mjs, same as any other era-dash-os client -- no
-- encryption-at-rest machinery needed once there's only one business's
-- keys per deployment.

-- Enforces "exactly one settings row" at the database level, not just by
-- convention -- a second insert fails loudly instead of silently creating
-- an ambiguous second business.
create unique index if not exists business_singleton_idx on business ((true));

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone_number text,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('owner', 'manager', 'staff')),
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- Any number of staff can opt into handover alerts, not just the single
  -- business.handover_number -- a handover goes to all of them at once, and
  -- when one of them actually replies, the rest get told who's got it so
  -- two people don't answer the same customer.
  handover_alerts boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone_number text,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram', 'tiktok', 'website')),
  channel_id text,
  address text,
  handled_by text not null default 'bot' check (handled_by in ('bot', 'staff')),
  handled_by_staff_id uuid references staff(id),
  -- A real human took over via the WhatsApp Business app itself (Meta's
  -- coexistence mode -- Settings' "WhatsApp connection"), not via this
  -- dashboard, so there's no staff row to point handled_by_staff_id at
  -- (nobody's logged in, it's just the owner's phone). A separate signal
  -- rather than forcing a fake staff_id -- flow.js treats either one as
  -- "a human is really here, bot stays quiet."
  app_handled_at timestamptz,
  handover_at timestamptz,
  handover_reason text,
  -- Stamped by engine/flow.js's logMessage on every inbound/outbound
  -- message -- lets the conversations list (routes/api.js) sort by activity
  -- with a plain indexed column instead of a correlated subquery into
  -- message per customer, so the list stays cheap no matter how many
  -- customers this business has on file.
  last_message text,
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists customers_phone_idx on customers (phone_number) where phone_number is not null;
create unique index if not exists customers_channel_id_idx on customers (channel, channel_id) where channel_id is not null;
create index if not exists customers_last_message_at_idx on customers (last_message_at desc);

create table if not exists product (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  price numeric(12, 2) not null,
  availability boolean not null default true,
  availability_type text not null default 'stock' check (availability_type in ('stock', 'time_slot', 'date')),
  duration_minutes integer,
  -- The section an item appeared under on the real menu (Drinks, Rice,
  -- Proteins, ...), when the source actually had sections -- null when it
  -- didn't (never invented). The whole reason to carry this at all: once a
  -- catalogue has a few hundred items, the Catalogue page groups by this
  -- instead of one long flat list, so marking something unavailable means
  -- scanning one section, not the whole menu.
  category text,
  -- Whole-table-as-context matching (no pgvector dependency), same choice
  -- already proven live on Bali -- kept as a plain float array placeholder
  -- for when that changes, not wired up yet.
  embedding jsonb,
  -- A bulk menu import (routes/api.js's /catalogue/bulk-import) never
  -- writes straight to the live name/description/price -- it stages a
  -- proposal here for a human to approve first, per the standing rule that
  -- a re-uploaded menu must never silently change what the bot already
  -- tells customers. 'new' = a freshly-extracted item awaiting its first
  -- approval (excluded from every customer-facing query below until then).
  -- 'changed' = an existing item whose extracted name/description/price
  -- differs from what's live -- pending_* holds the proposed values, the
  -- real columns stay untouched (and keep serving customers) until
  -- approved. 'removed' = existing item missing from the new upload --
  -- flagged, not deleted, until a human confirms it's really gone.
  import_status text check (import_status in ('new', 'changed', 'removed')),
  pending_name text,
  pending_description text,
  pending_price numeric(12, 2),
  pending_category text,
  -- One real photo per item, same data: URI pattern as business.logo_data_url
  -- and menu_photo.data_url. Meta's native WhatsApp Catalogue requires a
  -- real image per item -- an item with no photo here is skipped on sync
  -- (engine/whatsapp-catalog.js) rather than sent looking broken.
  image_data_url text,
  created_at timestamptz not null default now()
);

-- The business's own menu photo(s), forwarded to customers as-is instead of
-- a text list -- once a catalogue is a few hundred items, "We have: X, Y,
-- Z..." is unreadable, but a photo of the real printed menu is exactly
-- what a customer would see in person. Replaced wholesale (not merged) on
-- every fresh photo-based bulk import: an old menu photo showing prices/
-- items that no longer exist is worse than no photo at all. data_url, not
-- a file path, same reasoning as business.logo_data_url -- no separate
-- file storage for what's realistically a handful of images per business.
-- Served back out as a real short URL by routes/documents.js's
-- /menu-photo/:id (same decode-on-read trick already used for
-- payment_proof_url), since WhatsApp/Instagram fetch media by URL, not
-- inline base64.
create table if not exists menu_photo (
  id uuid primary key default gen_random_uuid(),
  data_url text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

-- The engine's state map, as data -- editable from the dashboard's Train
-- the bot tab and drawable on the workstation's conversation-flow canvas.
-- Seeded below with the 10 states from the build schema's section 4. Must
-- exist before "order"/booking, which reference it.
create table if not exists bot_state (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  position_x integer not null default 0,
  position_y integer not null default 0,
  allowed_next text[] not null default '{}'
);

-- What the bot asks for and extracts -- bot-engine/extract.js's defineField
-- shape, made editable. Seeded per business type at provision time.
create table if not exists bot_field (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  label text not null,
  question text not null,
  type text not null default 'text' check (type in ('text', 'date', 'boolean', 'choice')),
  choices text[],
  examples text[],
  required_for_state text references bot_state(key)
);

create table if not exists "order" (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  reference text not null unique,
  -- Two different vocabularies on purpose: `status` is what staff see on the
  -- kanban board (business-facing). `engine_state` is which of the 10
  -- bot_state steps the conversation that built this order is currently in
  -- (conversation-facing) -- the engine reads/writes this one directly via
  -- bot-engine/states.js's assertTransition.
  engine_state text not null default 'new_inquiry' references bot_state(key),
  status text not null default 'new' check (status in ('new', 'confirmed', 'ready', 'delivery', 'completed', 'cancelled')),
  -- Set the moment the customer says yes to the order, before payment --
  -- distinct from `status`, which only reaches 'confirmed' once payment is
  -- actually in (see engine/flow.js). Purely an internal marker so the
  -- engine knows "still deciding whether to buy" from "buying it, now
  -- working out delivery/pickup", never shown to staff.
  confirmed_at timestamptz,
  total numeric(12, 2) not null default 0,
  -- The real Chowdeck delivery cost, added into `total` before payment is
  -- requested -- otherwise the customer never actually pays for the ride
  -- and the business absorbs it silently. Zero for pickup orders and for
  -- any business not on real Chowdeck delivery.
  delivery_fee numeric(12, 2) not null default 0,
  payment_status text not null default 'pending' check (payment_status in ('pending', 'proof_submitted', 'confirmed', 'accepted')),
  payment_proof_url text,
  -- Set the first (and only) time a "still waiting on payment" nudge goes
  -- out -- a customer messaging in five times while unpaid should never get
  -- five repeats of the same reminder, only the first one, ever.
  payment_reminder_sent_at timestamptz,
  payment_reference text,
  -- Persisted so the invoice page can show a real "Pay now" link, not just
  -- the one-time chat message -- Paystack's checkout URL for this specific
  -- reference, set once at initialization (engine/payment.js).
  payment_link_url text,
  fulfilment_type text check (fulfilment_type in ('delivery', 'pickup')),
  -- Null unless the business has more than one branch row -- see branch
  -- table's comment. Which branch fulfils this order, so pickup/delivery
  -- source address is that branch's, not a guess.
  branch_id uuid references branch(id),
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
  customer_id uuid not null references customers(id),
  product_id uuid not null references product(id),
  engine_state text not null default 'new_inquiry' references bot_state(key),
  date date not null,
  end_date date,
  time time,
  status text not null default 'requested' check (status in ('requested', 'confirmed', 'completed', 'cancelled', 'no_show')),
  total numeric(12, 2) not null default 0,
  payment_status text not null default 'pending' check (payment_status in ('pending', 'proof_submitted', 'confirmed', 'accepted')),
  payment_proof_url text,
  payment_reference text,
  payment_link_url text,
  branch_id uuid references branch(id),
  reference text not null unique,
  created_at timestamptz not null default now()
);
create unique index if not exists booking_no_double_booking_idx
  on booking (product_id, date, time) where status not in ('cancelled', 'no_show');

create table if not exists delivery (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references "order"(id) on delete cascade,
  booking_id uuid references booking(id) on delete cascade,
  customer_id uuid not null references customers(id),
  address text,
  phone_number text,
  provider text check (provider in ('chowdeck', 'bolt', 'manual')),
  provider_delivery_id text,
  rider_name text,
  rider_phone text,
  tracking_url text,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'delivered')),
  price numeric(12, 2) not null default 0,
  check (order_id is not null or booking_id is not null)
);

create table if not exists knowledge_base (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

-- One row per real Claude call (engine/claude.js) -- lets ERA Dash OS's
-- monitoring panel compute this business's own real AI spend instead of
-- guessing, since every business shares the same ANTHROPIC_API_KEY and
-- Anthropic's own billing can't split cost out per business on its own.
create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  -- Cache write/read tokens (prompt caching, engine/claude.js) -- priced
  -- differently from input_tokens, see lib/ai-pricing.js. 0 for a call that
  -- didn't cache (prompt too short, or caching not applicable).
  cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_created_at_idx on ai_usage (created_at);

-- Real Claude call FAILURES (not usage/cost) -- lets a plain HTTPS
-- monitoring check tell "Claude API is having trouble right now" apart
-- from "nobody's messaged in a while", with no SSH/server access needed.
create table if not exists ai_errors (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_errors_created_at_idx on ai_errors (created_at);

-- Backs the Live Conversations dashboard module and handover summaries --
-- without this table there was nowhere to show or summarise a thread.
create table if not exists message (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  direction text not null check (direction in ('inbound', 'outbound')),
  channel text not null check (channel in ('whatsapp', 'instagram', 'tiktok', 'website')),
  sender text not null,
  body text not null,
  trigger text,
  -- Only meaningful for direction='inbound': set once the debounced batch
  -- containing this message has actually been handled (see flow.js's
  -- processPendingMessages). Null means still waiting -- an explicit marker
  -- instead of inferring "already answered" from timestamps, which had a
  -- real race window a message could fall through and get silently dropped.
  processed_at timestamptz,
  -- Only set for an outbound Instagram send (Meta's message_id from the
  -- send response). Instagram mirrors every business-sent message back
  -- through the webhook as an echo (is_echo: true) with no way to tell
  -- "the bot's own API send" apart from "a human reply typed in the
  -- Instagram app" -- unlike WhatsApp, which has a wholly separate
  -- smb_message_echoes field just for app-originated sends. This is how
  -- webhook-instagram.js tells them apart instead: an incoming echo's mid
  -- gets looked up here -- a match means "that's one of ours, ignore it",
  -- no match means "a human just replied from the app", exactly the signal
  -- that drives recordAppReplyInstagram the same way smb_message_echoes
  -- drives recordAppReply for WhatsApp.
  platform_message_id text,
  created_at timestamptz not null default now()
);
create index if not exists message_platform_message_id_idx on message (platform_message_id) where platform_message_id is not null;

create table if not exists generated_document (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('invoice', 'receipt')),
  order_id uuid references "order"(id) on delete cascade,
  booking_id uuid references booking(id) on delete cascade,
  url text not null,
  created_at timestamptz not null default now(),
  check (order_id is not null or booking_id is not null)
);

create index if not exists order_item_order_idx on order_item (order_id);
create index if not exists message_customer_idx on message (customer_id, created_at);
create index if not exists generated_document_order_idx on generated_document (order_id);
create index if not exists generated_document_booking_idx on generated_document (booking_id);

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

-- ---------------------------------------------------------------------------
-- Seed data: the 10-state engine map from the build schema's section 4, plus
-- a cancelled state reachable from anywhere pre-fulfilment. Per-business-type
-- bot_field defaults are seeded separately at provision time
-- (create-client.mjs), since they depend on which business type was chosen
-- -- not knowable from this static file.
-- ---------------------------------------------------------------------------
-- position_x/position_y lay these out left-to-right along the happy path so
-- the Train the bot canvas isn't just 11 boxes stacked on top of each other
-- the first time anyone opens it -- purely presentational, staff can drag
-- them anywhere afterward.
insert into bot_state (key, label, position_x, position_y, allowed_next) values
  ('new_inquiry', 'New inquiry', 0, 0, array['understand_request', 'cancelled']),
  ('understand_request', 'Understand request', 220, 0, array['collect_info', 'cancelled']),
  ('collect_info', 'Collect information', 440, 0, array['check_availability', 'cancelled']),
  ('check_availability', 'Check availability', 660, 0, array['calculate_price', 'collect_info', 'cancelled']),
  ('calculate_price', 'Calculate price', 880, 0, array['confirm_order', 'cancelled']),
  ('confirm_order', 'Confirm order', 1100, 0, array['confirm_payment', 'collect_info', 'cancelled']),
  ('confirm_payment', 'Confirm payment', 1320, 0, array['payment_acceptance', 'cancelled']),
  ('payment_acceptance', 'Payment acceptance', 1540, 0, array['fulfilment']),
  ('fulfilment', 'Fulfilment', 1760, 0, array['completed']),
  ('completed', 'Completed', 1980, 0, array[]::text[]),
  ('cancelled', 'Cancelled', 660, 200, array[]::text[])
on conflict (key) do nothing;
