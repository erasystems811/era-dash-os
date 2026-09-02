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
  -- Decides where the menu and the customer list live once a business has
  -- more than one branch: 'independent' (default) scopes both to the
  -- branch a conversation resolved to; 'merged' shares both at the business
  -- level regardless of branch. Operations (orders, staff, delivery) are
  -- always per branch in both modes -- see engine/fields.js's menu/customer
  -- resolvers. Meaningless with zero or one branch row.
  sharing_mode text not null default 'independent' check (sharing_mode in ('independent', 'merged')),
  created_at timestamptz not null default now()
);
-- Optional. Most businesses are single-location and just use business.address
-- above -- this table only matters once a business has more than one real
-- location. Zero rows means "single location, use business.address" exactly
-- as before; any rows here means the bot asks which branch on every order
-- and answers "where are you" from these instead of business.address.
create table if not exists branch (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references business(id),
  name text not null,
  address text not null,
  area text,
  phone_number text,
  -- The number the assistant answers on for this branch (engine/webhook-
  -- whatsapp.js resolves an inbound message's branch from this once a
  -- business has real per-branch numbers -- see branch_channel). Null means
  -- this branch has no dedicated number yet and falls back to the
  -- business's single shared number.
  whatsapp_number text,
  instagram_handle text,
  operating_hours text,
  opening_hours jsonb,
  timezone text not null default 'Africa/Lagos',
  -- 'paused' lets a branch stop taking orders (renovation, an outage)
  -- without deleting it or reconfiguring the assistant.
  status text not null default 'active' check (status in ('active', 'paused', 'closed')),
  -- Exactly one true per business -- the default scope, and where a
  -- zero/one-branch business's product/customers rows point (see below).
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);

-- Per-branch WhatsApp (and later voice/Instagram) credentials. A separate
-- table from `branch` -- a channel's number/token pair is its own config,
-- not a property of the location. Zero rows means every business behaves
-- exactly as today (single shared number from .env) -- see
-- engine/branch-channel.js. Plaintext access_token, same trust boundary as
-- Paystack's key in .env below -- no encryption-at-rest exists elsewhere in
-- EBOS to be consistent with.
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

-- ---------------------------------------------------------------------------
-- Delivery add-on (own_riders mode) -- optional, per business, off by
-- default (delivery_config.mode = 'none', defined further below). See
-- EBOS-Addon-Schema-Voice-and-Delivery.md, Capability B. The restaurant's
-- own riders, dispatched through a platform ERA provides -- money never
-- passes through an ERA account (B2). Every table here follows the same
-- branch_id-not-business_id idiom this file already established for branch
-- (business is a locked singleton per database -- see this file's header --
-- so a literal business_id would carry no information; branch_id is the
-- real per-location scope, exactly like order/customers/product/staff).
-- rider and delivery_zone are defined here, before "order", because
-- order.delivery_zone_id references delivery_zone -- the rest of this
-- capability's tables (which reference "order") live further below, after
-- it's defined.
-- ---------------------------------------------------------------------------

create table if not exists rider (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branch(id),
  name text not null,
  phone text not null unique,
  status text not null default 'off_duty' check (status in ('on_duty', 'off_duty', 'suspended')),
  -- Encrypted with lib/crypto.js before insert (AES-256-GCM, keyed off
  -- PAYMENT_ENCRYPTION_KEY -- already generated per deployment by
  -- create-client.mjs, unused until now). Same trust boundary as
  -- delivery_config.provider_keys below, not plaintext like
  -- branch_channel's access_token: unlike a business's own WhatsApp token,
  -- this is many individual people's real bank details sitting in one
  -- database.
  bank_account_number text,
  bank_code text,
  account_name text,
  -- Sign-in OTP (see engine/rider-auth.js) -- sent as a WhatsApp
  -- AUTHENTICATION-category template, not the shared env credentials,
  -- since a rider has never messaged the business number before their
  -- first sign-in.
  otp_code text,
  otp_expires_at timestamptz,
  last_lat numeric,
  last_lng numeric,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

-- The restaurant's own delivery areas and what each one costs -- set once,
-- like a catalogue, edited rarely (spec B5). customer_fee and rider_payout
-- default equal but are kept as two columns on purpose: a restaurant may
-- later subsidise a far zone to keep riders willing to go there, or take a
-- small margin, and that must be a settings change, never a migration.
create table if not exists delivery_zone (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid references branch(id),
  name text not null,
  -- Customers do not write addresses the way a database expects -- one
  -- area has several names in common use. Matched against these before an
  -- address is ever sent to the "unresolved, ask a human" queue.
  aliases text[] not null default '{}',
  customer_fee numeric(12, 2) not null,
  rider_payout numeric(12, 2) not null,
  active boolean not null default true
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
  -- Null = all branches (the only sensible value for role = 'owner', and
  -- every login today). A real branch = this staff member is locked to it
  -- -- no branch control anywhere in their dashboard, not just a filtered
  -- view. Not a new role: "branch staff"/"branch manager" from the branch
  -- addendum are just staff/manager with this set. See lib/auth.js's
  -- scopeToBranch.
  branch_id uuid references branch(id),
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
  -- Voice add-on only (see voice_call below) -- what the caller said to be
  -- called, captured naturally during a call, not asked for on WhatsApp.
  -- Separate from `name` because `name` is never written by any engine
  -- code today (dashboard-editable only); this is voice's own field so it
  -- can't collide with that.
  preferred_name text,
  phone_number text,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram', 'tiktok', 'website', 'voice')),
  channel_id text,
  address text,
  handled_by text not null default 'bot' check (handled_by in ('bot', 'staff')),
  handled_by_staff_id uuid references staff(id),
  -- Null when the business has zero branches or sharing_mode = 'merged'
  -- (customer is shared at the business level). Set to the branch a
  -- conversation resolved to when sharing_mode = 'independent' -- under
  -- that mode the same phone number ordering from two branches is
  -- deliberately two separate customer rows. See engine's customer
  -- resolver (wraps findOrCreateCustomer).
  branch_id uuid references branch(id),
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
  -- Voice add-on only -- drives the "welcome back" greeting (A6). Null
  -- means never called, or voice isn't enabled for this business.
  last_voice_call_at timestamptz,
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
  -- Null when the business has zero branches or sharing_mode = 'merged'
  -- (product is shared at the business level). Set to a specific branch
  -- when sharing_mode = 'independent' -- see engine's menu resolver
  -- (resolveMenu), the one place this table is queried from a feature.
  branch_id uuid references branch(id),
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
  -- Own-riders delivery only (delivery_config.mode = 'own_riders') -- the
  -- delivery_zone this order's address matched at handleCollectFulfilment
  -- time (engine/flow.js), persisted so dispatch later uses the exact same
  -- zone/price the customer was already charged, not a fresh re-match that
  -- could drift. Null for every other provider and for an unresolved
  -- address (see engine/delivery-zones.js -- unresolved always goes to a
  -- human, never a guess).
  delivery_zone_id uuid references delivery_zone(id),
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
  provider text check (provider in ('chowdeck', 'bolt', 'manual', 'own_riders')),
  provider_delivery_id text,
  rider_name text,
  rider_phone text,
  tracking_url text,
  status text not null default 'pending' check (status in ('pending', 'dispatched', 'delivered')),
  price numeric(12, 2) not null default 0,
  -- Always per branch, in both sharing modes -- copied from the parent
  -- order/booking's already-resolved branch_id at insert time (see
  -- engine/delivery.js), not re-resolved here.
  branch_id uuid references branch(id),
  check (order_id is not null or booking_id is not null)
);

-- ---------------------------------------------------------------------------
-- Delivery add-on (own_riders mode) -- optional, per business, off by
-- default (delivery_config.mode = 'none'). See
-- EBOS-Addon-Schema-Voice-and-Delivery.md, Capability B. The restaurant's
-- own riders, dispatched through a platform ERA provides -- money never
-- passes through an ERA account (B2). Every table here follows the same
-- branch_id-not-business_id idiom the branch addendum already established
-- (business is a locked singleton per database -- see this file's header --
-- so a literal business_id would carry no information; branch_id is the
-- real per-location scope, exactly like order/customers/product/staff).
-- ---------------------------------------------------------------------------

-- One broadcast to every on-duty rider for one order. status='OPEN' is the
-- only claimable state -- claiming is a single atomic UPDATE ... WHERE
-- status = 'OPEN', never a read then a separate write, or two riders can
-- both "win" the same job (spec B4 -- the failure this exists to prevent
-- outright, not just discourage).
create table if not exists delivery_offer (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id),
  branch_id uuid references branch(id),
  zone_id uuid not null references delivery_zone(id),
  status text not null default 'OPEN' check (status in ('OPEN', 'CLAIMED', 'EXPIRED', 'CANCELLED')),
  broadcast_at timestamptz not null default now(),
  escalated_at timestamptz,
  -- Separate from escalated_at so the staff-alert sweep never re-alerts on
  -- every tick for the same still-unaccepted offer.
  staff_alerted_at timestamptz,
  claimed_by uuid references rider(id),
  claimed_at timestamptz
);

-- The operational detail underneath one claimed offer -- delivery (above)
-- stays the summary row every provider (chowdeck/manual/own_riders) writes
-- to, so the existing dashboard Delivery card keeps working unmodified for
-- every provider; this is where the own_riders-specific lifecycle lives.
create table if not exists delivery_assignment (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references delivery_offer(id),
  order_id uuid not null references "order"(id),
  rider_id uuid not null references rider(id),
  status text not null default 'ASSIGNED' check (status in ('ASSIGNED', 'PICKED_UP', 'ARRIVED', 'DELIVERED', 'FAILED')),
  delivery_code text not null,
  code_entered_at timestamptz,
  -- Set on a staff human-override release (spec B7 -- lost code, dead
  -- phone, given to a neighbour). A system with no override strands a
  -- rider who genuinely did the job.
  released_by_staff uuid references staff(id),
  override_reason text,
  tracking_token text not null unique,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

-- One row per delivery a rider is owed. amount is copied from
-- delivery_zone.rider_payout the moment the offer is claimed (ASSIGNED),
-- never re-read at payout time -- if the restaurant edits a zone's price
-- mid shift, a delivery already accepted keeps the rate the rider actually
-- saw and agreed to (spec B7). A rider paid less than that figure is a
-- trust problem this system does not get a second chance to recover from.
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

-- One row per business (a true whole-deployment toggle, same as `business`
-- itself, not a per-branch setting -- unlike every other table above).
-- mode='none' is the default and must be genuinely inert: no nav item, no
-- background job doing real work, no cost, and the order engine/WhatsApp/
-- dashboard behave exactly as they do today (branch addendum's own "off is
-- the default" rule, restated here for this capability). ERA switches
-- mode, never the client (see routes/api.js's requireEraAdmin gate) --
-- payout_mode/provider/provider_keys are the restaurant's own to set, once
-- on.
create table if not exists delivery_config (
  business_id uuid primary key references business(id),
  mode text not null default 'none' check (mode in ('none', 'relay', 'own_riders')),
  payout_mode text not null default 'manual' check (payout_mode in ('automatic', 'manual')),
  provider text check (provider in ('paystack', 'flutterwave', 'moniepoint')),
  -- Encrypted with lib/crypto.js, same as rider.bank_account_number above --
  -- a real transfer-API secret, not a business's already-.env-stored key.
  -- text, not jsonb: lib/crypto.js's encrypt() output is an opaque
  -- "iv:authTag:ciphertext" string, not itself valid JSON -- the real JSON
  -- (whatever shape a given provider's keys take) only exists again after
  -- decrypt() at call time (engine/payout-providers.js).
  provider_keys text,
  offer_timeout_seconds int not null default 90
);

-- ---------------------------------------------------------------------------
-- Voice ordering add-on -- optional, per business, off by default
-- (voice_config.enabled = false). See EBOS-Addon-Schema-Voice-and-Delivery.md,
-- Capability A. A phone call is a new front door onto the SAME order engine
-- WhatsApp already uses (engine/flow.js's dispatch layer) -- nothing here
-- duplicates order-taking logic. voice_config follows delivery_config's own
-- shape immediately above: one row per business, a true whole-deployment
-- toggle, ERA-switches-it-not-the-client. voice_call/call_turn/callback_task
-- are per-call operational data and follow the branch_id-not-business_id
-- idiom the rest of this file uses (see the delivery add-on's comment above
-- rider/delivery_zone for why).
-- ---------------------------------------------------------------------------

create table if not exists voice_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  transport text not null default 'forwarding' check (transport in ('forwarding', 'gateway')),
  -- The number the voice provider terminates the restaurant's forwarded
  -- calls on (A2) -- not the restaurant's own number, which stays
  -- business.phone_number/branch.phone_number.
  inbound_number text,
  -- The cloned voice model to speak with (A3) -- one value at launch,
  -- ERA-wide, not a per-business recording. Nullable until the voice asset
  -- exists.
  voice_id text,
  -- Restaurant's own to edit (A8) -- staff phones tried in order on a
  -- Phase 2 (gateway) live transfer. An empty array is valid and falls
  -- back to the callback path, exactly as under Phase 1.
  transfer_numbers text[] not null default '{}',
  operating_hours jsonb,
  greeting_override text,
  -- Soft cap, alerts only (A10) -- never cuts a call off mid-order.
  max_minutes_per_month int,
  -- Off by default (A11) -- the Nigeria Data Protection Act makes the
  -- restaurant the data controller, so recording needs their opt-in, not
  -- ERA's.
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
  -- Derived, stored for billing (A10) rather than computed from
  -- started_at/ended_at on every read.
  duration_seconds int,
  outcome text check (outcome in ('order_placed', 'enquiry_answered', 'handover_transferred', 'handover_callback', 'abandoned', 'failed')),
  order_id uuid references "order"(id),
  transport text not null default 'forwarding' check (transport in ('forwarding', 'gateway')),
  -- Null unless voice_config.recording_enabled was true for this call.
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
  -- Recogniser confidence, 0 to 1 -- drives handover trigger 3 (A8: two
  -- consecutive low-confidence turns) and is the real evidence for whether
  -- a given restaurant's call quality actually works, not just testing.
  confidence numeric,
  started_at timestamptz not null default now()
);
create index if not exists call_turn_call_seq_idx on call_turn (call_id, seq);

-- Voice's own "needs a person" row (A8/A12) -- deliberately not a call to
-- the existing WhatsApp handover() (engine/flow.js), which sends an ack
-- into a chat thread and waits; a live call needs an answer inside the same
-- call, not a later reply. Surfaces in the same Needs Attention panel as
-- WhatsApp handovers and unaccepted delivery offers (C1's "one queue"),
-- tagged via routes/api.js's kind-tagged UNION ALL.
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
  channel text not null check (channel in ('whatsapp', 'instagram', 'tiktok', 'website', 'voice')),
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
