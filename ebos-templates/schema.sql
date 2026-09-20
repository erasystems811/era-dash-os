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
  -- Headline photo across the top of the web menu page (engine/menu-page-
  -- template.js) -- Chidera 2026-09-10: "the menu when sent at first is to
  -- have a one head line photo... create space for cover photo in back
  -- end". Same data: URI pattern as logo_data_url above, same reasoning.
  -- Null falls back to a plain dark header with just the business name.
  cover_photo_data_url text,
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
  -- otp_code/otp_expires_at: superseded by the pin_* columns below
  -- (Chidera's call, 2026-09-02 -- a rider is already pre-registered by the
  -- restaurant, so a WhatsApp AUTHENTICATION-template OTP added a Meta
  -- approval dependency for no real security gain over a PIN staff sets
  -- directly). Left in place, unused, rather than dropped -- migrate.mjs's
  -- destructive-statement guard refuses `drop column` on purpose.
  otp_code text,
  otp_expires_at timestamptz,
  -- Sign-in PIN, set by staff when adding/editing a rider (routes/
  -- delivery.js), never by the rider themselves. Same shape and the same
  -- lockout logic as staff's own PIN accounts (lib/auth.js's verifyPin) --
  -- see engine/rider-auth.js's verifyRiderPin.
  pin_hash text,
  pin_failed_attempts integer not null default 0,
  pin_locked_until timestamptz,
  -- The browser's real PushSubscription object (endpoint + keys.p256dh/
  -- auth), saved the moment the rider PWA registers its service worker and
  -- subscribes -- see engine/push-notify.js. Without this, an offer only
  -- ever reaches a rider whose app happens to be open on screen right now
  -- (engine/offer-bus.js's in-page SSE alarm) -- real push is what actually
  -- rings/vibrates the phone with the screen off or the app backgrounded,
  -- which is the whole point of an "alarm". Null until the rider's app has
  -- subscribed at least once.
  push_subscription jsonb,
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
  -- Nullable: a PIN-tier staff account (auth_type = 'pin') has neither an
  -- email nor a password -- see auth_type below. Every owner/manager row
  -- still has both, exactly as before.
  email text unique,
  password_hash text,
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
  -- 'password' = the email+password login every owner/manager uses.
  -- 'pin' = a name+4-digit-PIN login, always branch_id-scoped, always
  -- provisioned by a branch manager (or an owner acting on one branch) --
  -- see routes/api.js's POST /staff/pin. Never valid for role = 'owner'.
  auth_type text not null default 'password' check (auth_type in ('password', 'pin')),
  pin_hash text,
  -- Per-account PIN lockout, not a global one -- see lib/auth.js's
  -- verifyPin. A 4-digit PIN is only safe because each guess is checked
  -- against exactly one person on one branch, never a business-wide scan,
  -- and because repeated wrong guesses lock that one row out for a while
  -- rather than being unlimited.
  pin_failed_attempts integer not null default 0,
  pin_locked_until timestamptz,
  -- Who set up this PIN account -- an accountability trail for the branch
  -- manager who provisioned it, surfaced in the activity log.
  created_by_staff_id uuid references staff(id),
  -- Splits floor/counter (PIN-tier) staff into two non-overlapping worlds
  -- once a business has dine-in on -- null (owner/manager, and any staff
  -- before this existed) means unrestricted, exactly today's behavior.
  -- 'online' sees Orders (delivery/pickup only) and never the Dine-in tab;
  -- 'in_house' lands on /in-house (just their table's pending orders) and
  -- gets the Dine-in tab, never the main Orders board. Chidera 2026-09-11:
  -- "theyll be 2 types of staff for people with dine in toggle on, the in
  -- house and online staff... i can just give them their part to manage."
  work_area text check (work_area in ('online', 'in_house')),
  created_at timestamptz not null default now()
);

-- One-tap login for a staff handover alert sent over WhatsApp -- lets
-- tapping the conversation link in that alert sign the staff member in
-- automatically, no separate dashboard login, no leaving WhatsApp first.
-- Only the token's sha256 hash is stored (same "a DB leak can't be turned
-- into a usable credential" property a password reset token needs); the
-- real token only ever exists in the URL sent to the staff member's phone.
create table if not exists staff_magic_link (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  token_hash text not null unique,
  redirect_path text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists staff_magic_link_staff_idx on staff_magic_link(staff_id);

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
  -- 'manual' -- staff created this order/customer directly from the
  -- dashboard (routes/api.js's POST /orders), for a delivery or order that
  -- came in some way other than a channel this system listens on itself
  -- (a landline call, a walk-in). Still a real customer row -- delivery
  -- notifications/tracking go to phone_number over WhatsApp exactly like
  -- any other channel, see engine/flow.js's recipientFor.
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram', 'tiktok', 'website', 'voice', 'manual')),
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

-- The real web menu page (engine/menu-page-template.js) backing the
-- REGULAR (non-dine-in) ordering flow too, not just dine-in -- how
-- routes/menu-page.js's public /m/:token resolves back to a real customer
-- with no login, same idea as restaurant_table.qr_token for a table.
alter table customers add column if not exists menu_token text;
create unique index if not exists customers_menu_token_idx on customers (menu_token) where menu_token is not null;

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
  -- A combo/special offer (its own name, its own bundled price) is a real
  -- product like any other -- orders, receipts, the upsell/menu-page
  -- machinery all already work on `product` and don't need to know it's a
  -- bundle underneath. This boolean is the one deterministic signal for
  -- "does this business have a real special offer right now" (engine/
  -- flow.js's findSpecialsCategory) -- Chidera 2026-09-10: "a special
  -- offer is a combo so it should be created not marked... with form
  -- style adding the items in the deal and how much and name of deal."
  -- What's actually IN the combo lives in product_combo_item below.
  is_combo boolean not null default false,
  -- Reading order (bulk-import assigns it in source order; a manually
  -- added item gets none until repositioned) -- a real menu is rarely
  -- alphabetical, see migrations/0045_product_position.sql. Folded in here
  -- (was only ever an `alter table`, never added to this file) after it
  -- broke POST /catalogue for a brand-new client: create-client.mjs seeds
  -- a fresh database from this file alone, never the migrations/ folder,
  -- so any client created since 0045 shipped had no position column at
  -- all until someone happened to run a manual migration backfill.
  position integer,
  created_at timestamptz not null default now()
);

-- What a combo (product.is_combo = true) actually contains -- purely
-- informational (shown on the menu page's item description, e.g. "2x
-- Jollof Rice, 1x Chicken"), not exploded into separate order_item rows
-- when ordered: a combo is ordered and charged as the one product it is,
-- same as anything else. component_product_id has no ON DELETE CASCADE on
-- purpose -- deleting a real menu item out from under a combo that still
-- references it should fail loudly (23503), not silently corrupt what the
-- combo claims to include.
create table if not exists product_combo_item (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references product(id) on delete cascade,
  component_product_id uuid not null references product(id),
  quantity integer not null default 1
);
create index if not exists product_combo_item_product_idx on product_combo_item (product_id);

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
  -- Full pipeline (Chidera's call, 2026-09-02): new -> confirmation ->
  -- preparation -> ready -> [pickup: completed] -> [delivery: delivery ->
  -- in_transit -> completed]. `new` is the bot's own in-progress draft
  -- order (still being built through chat, before payment) -- staff's
  -- kanban board (Orders.jsx) doesn't render a column for it, that
  -- work-in-progress state belongs on the Conversations tab. `confirmation`
  -- means paid and needs someone to look at it; `preparation` means the
  -- kitchen actually started, and is the ONLY stage the "mark as ready"
  -- button (routes/api.js's /orders/:id/status, which calls
  -- maybeDispatchOwnRiders) appears from. `ready` branches by
  -- fulfilment_type: a pickup order's "Picked up" button goes straight to
  -- `completed` (its last stage); a delivery order's own button moves it
  -- to `delivery` ("waiting for rider"), which then advances itself,
  -- automatically, to `in_transit` the moment a rider marks picked-up, and
  -- to `completed` the moment the rider closes it out with the delivery
  -- code (routes/rider.js) -- never a staff click for those two, the
  -- system already knows. A manually-created order (routes/api.js's POST
  -- /orders) lands directly in `preparation`, skipping `confirmation` --
  -- staff already confirmed it themselves by typing it in.
  status text not null default 'new' check (status in ('new', 'confirmation', 'preparation', 'ready', 'delivery', 'in_transit', 'completed', 'cancelled')),
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
  -- 'table' is the dine-in add-on's own fulfilment type (settled at the
  -- table, never delivered or collected -- EBOS-Addon-Schema-Dine-In.md
  -- section 5.3/5.4).
  fulfilment_type text check (fulfilment_type in ('delivery', 'pickup', 'table')),
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
  -- The two steps before delivery_zone_id is actually set: a zone found by
  -- matching the address (or a later clarification reply) but not yet
  -- confirmed by the customer, and "we already asked what area this is,
  -- waiting on their answer" -- same null/non-null gate idiom confirmed_at
  -- uses for the order-confirmation yes/no step. See engine/flow.js's
  -- handleCollectFulfilment.
  delivery_zone_candidate_id uuid references delivery_zone(id),
  delivery_area_prompted_at timestamptz,
  -- Set the moment status actually becomes 'completed' -- both the
  -- staff-driven /orders/:id/status route and routes/rider.js's own
  -- auto-completion (delivery code entered) set this explicitly, never
  -- inferred from updated_at (that column isn't reliably bumped by every
  -- path that completes an order). Drives the 24h "want to order again?"
  -- window instead of the normal root greeting -- see engine/flow.js's
  -- recentlyCompletedOrder.
  completed_at timestamptz,
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

-- Per-item customization questions (water: room temp or cold, rice:
-- peppered or not, ...) -- opt-in per catalogue item. An item with zero
-- rows here behaves exactly as before: the bot never asks anything.
create table if not exists product_question (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references product(id) on delete cascade,
  question text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists product_question_product_idx on product_question (product_id);

-- One row per (order_item, question) actually asked+answered -- tracks
-- exactly which questions still need asking (engine/flow.js's
-- askNextItemQuestion) without parsing order_item.modification's free text.
create table if not exists order_item_answer (
  order_item_id uuid not null references order_item(id) on delete cascade,
  question_id uuid not null references product_question(id) on delete cascade,
  answer text not null,
  created_at timestamptz not null default now(),
  primary key (order_item_id, question_id)
);

-- Which single item-customization question the bot is mid-way through
-- asking for this order, if any -- see engine/flow.js's dispatch() and
-- askNextItemQuestion. Added via alter, not inline on "order" above, since
-- order_item/product_question (what these reference) are only defined
-- here, after "order" itself.
alter table "order" add column if not exists pending_question_order_item_id uuid references order_item(id);
alter table "order" add column if not exists pending_question_id uuid references product_question(id);

-- Interactive drink/protein cross-sell -- see engine/flow.js's
-- nextUpsellGroup/handlePendingUpsell. pending_upsell_category is which
-- offer (if any) is awaiting a reply right now; upsell_offered is every
-- category already offered this order, so a decline is never re-asked.
alter table "order" add column if not exists pending_upsell_category text;
alter table "order" add column if not exists upsell_offered text[] not null default '{}';

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
  -- Generated the moment this offer broadcasts (engine/delivery-dispatch.js)
  -- and sent to the customer right then -- a stage tracker ("waiting for a
  -- rider" -> accepted -> picked up -> here -> delivered, Chidera's own
  -- Chowdeck-style request, 2026-09-02) needs no real coordinates the way
  -- a live-location link would have, so there's no reason to wait until a
  -- rider actually accepts before the customer gets a real link. Copied
  -- onto delivery_assignment.tracking_token unchanged once a rider claims
  -- this offer (routes/rider.js) -- one token for the whole journey, not a
  -- second one issued partway through.
  tracking_token text unique,
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
  channel text not null check (channel in ('whatsapp', 'instagram', 'tiktok', 'website', 'voice', 'manual')),
  sender text not null,
  body text not null,
  trigger text,
  -- Only meaningful for direction='inbound': set once the debounced batch
  -- containing this message has actually been handled (see flow.js's
  -- processPendingMessages). Null means still waiting -- an explicit marker
  -- instead of inferring "already answered" from timestamps, which had a
  -- real race window a message could fall through and get silently dropped.
  processed_at timestamptz,
  -- Set for an outbound Instagram send (Meta's message_id from the send
  -- response) AND, since 2026-09-02, an outbound WhatsApp send (Meta's
  -- wamid) -- the WhatsApp case exists so webhook-whatsapp.js's status
  -- handler can correlate an async delivery failure back to the row that
  -- produced it (see 0024_message_delivery_status.sql for why that
  -- matters: a plain-text send outside the 24h window can be accepted
  -- synchronously and only fail afterward, via that webhook). Instagram's
  -- own use predates this: it mirrors every business-sent message back
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
  -- Only meaningful when platform_message_id is set. Null until a status
  -- webhook actually reports something -- most sends never get one at all
  -- in practice (Meta doesn't guarantee delivery/read receipts), so null
  -- means "unknown", not "failed". 'retried' means Meta reported this
  -- specific send failed and the business_outreach template retry (see
  -- flow.js's retryFailedSendAsTemplate) already went out for it -- kept
  -- distinct from 'failed' so the UI can tell "gave up" from "fixed itself
  -- automatically" at a glance.
  delivery_status text check (delivery_status in ('sent', 'delivered', 'read', 'failed', 'retried')),
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

-- Adding items to an order that's already been paid for needs its own
-- smaller "top-up" invoice -- just the extra owed, not the whole order
-- total again (engine/flow.js's sendTopupInvoice). Chidera 2026-09-11:
-- "calculate only their new add on and send them an invoice for top up."
create table if not exists order_topup (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id) on delete cascade,
  items jsonb not null,
  amount numeric(12,2) not null,
  payment_status text not null default 'pending' check (payment_status in ('pending', 'proof_submitted', 'confirmed')),
  created_at timestamptz not null default now()
);
create index if not exists order_topup_order_idx on order_topup (order_id);

-- Every payment-proof image a customer sends, kept -- not overwritten the
-- way order.payment_proof_url used to be. A top-up after the original
-- payment needs its own proof without losing the first one. Chidera
-- 2026-09-11: "let the place in the dashboard that shows receipt be able
-- to store multiple receipts image."
create table if not exists order_payment_proof (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id) on delete cascade,
  data_url text not null,
  created_at timestamptz not null default now()
);
create index if not exists order_payment_proof_order_idx on order_payment_proof (order_id);

-- Records every "major action" a staff member takes (order status changes,
-- marking an order ready, confirming payment, sending a message, taking a
-- conversation from the bot or giving it back) so a branch manager and the
-- general manager both have an accountability trail. See lib/auth.js's
-- logActivity and its call sites in routes/api.js.
-- ---------------------------------------------------------------------------
-- Dine-in add-on (EBOS-Addon-Schema-Dine-In.md). Optional, per business,
-- off by default (dinein_config.enabled = false), switched on by ERA not
-- the restaurant -- same whole-deployment-toggle shape as
-- voice_config/delivery_config above.
-- ---------------------------------------------------------------------------

create table if not exists dinein_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  feedback_enabled boolean not null default true,
  -- Chidera's call, 2026-09-10: 120, not the spec's original 20.
  feedback_delay_minutes int not null default 120,
  auto_close_hours int not null default 4,
  pos_mode text not null default 'none' check (pos_mode in ('none', 'webhook', 'api', 'database', 'printer')),
  pos_config text,
  review_link text,
  welcome_image_url text
);

-- Tables belong to a branch, not a business -- same idiom as delivery_zone
-- above and everywhere else with real per-location scope. qr_token is the
-- guest-facing identity for a table; regenerating it is how a stolen or
-- renumbered printed card gets invalidated without touching the table row.
create table if not exists restaurant_table (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branch(id),
  label text not null,
  qr_token text not null unique,
  seats int,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now()
);
create index if not exists restaurant_table_branch_idx on restaurant_table (branch_id);
-- A table's label is what a scan actually resolves by (flow.js's
-- handleDineinScan: branch_id + lower(label), no other tiebreaker) -- two
-- active tables sharing a label in the same branch would make scanning
-- either one genuinely ambiguous, silently routing orders/waiter calls to
-- whichever row Postgres happened to return. Chidera 2026-09-10: "the qr
-- code for each table[] should be unique to identify each table." Partial
-- (status = 'active' only) so a deactivated table's old label is free to
-- reuse on a new one.
create unique index if not exists restaurant_table_branch_label_active_idx
  on restaurant_table (branch_id, lower(label)) where status = 'active';

-- One open session per table at a time -- opened on the first scan, closed
-- from the dashboard or a POS integration. "Which session does a waiter
-- call / feedback message belong to" is always "the most recent open
-- (closed_at is null) session for that table", enforced here as a partial
-- unique index rather than left as an application-level assumption.
create table if not exists table_session (
  id uuid primary key default gen_random_uuid(),
  table_id uuid not null references restaurant_table(id),
  branch_id uuid not null references branch(id),
  customer_id uuid references customers(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by text check (closed_by in ('pos', 'staff', 'auto')),
  closed_by_staff uuid references staff(id),
  feedback_state text not null default 'none' check (feedback_state in ('none', 'scheduled', 'sent', 'answered', 'skipped'))
);
create unique index if not exists table_session_one_open_idx on table_session (table_id) where closed_at is null;
create index if not exists table_session_branch_idx on table_session (branch_id);

create table if not exists waiter_call (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references table_session(id),
  table_id uuid not null references restaurant_table(id),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_by uuid references staff(id),
  resolved_at timestamptz
);
create index if not exists waiter_call_open_idx on waiter_call (table_id) where status = 'open';

-- Retired -- Chidera 2026-09-11 replaced dine-in's own Good/Alright/Not
-- good feedback with a unified 3-question star system for every order
-- (see order_feedback below), sent right after payment/completion instead
-- of hours later on table-close. Table kept, not dropped (existing rows
-- are real history), just nothing reads or writes it anymore.
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references table_session(id),
  branch_id uuid not null references branch(id),
  customer_id uuid not null references customers(id),
  score text check (score in ('good', 'alright', 'bad')),
  comment text,
  status text not null default 'new' check (status in ('new', 'seen', 'actioned', 'closed')),
  actioned_by uuid references staff(id),
  created_at timestamptz not null default now()
);
create index if not exists feedback_branch_idx on feedback (branch_id, created_at desc);

-- Every order's feedback now, one row per order, filled in progressively
-- as each of the 3 star questions gets answered (pending_question tracks
-- which is next; a WhatsApp List Message tap answers exactly one).
-- Chidera 2026-09-11: "the questions will be how was your experience? how
-- was the food? and how was the service? 5 starts to rate" -- sent the
-- moment any order reaches status = 'completed' (delivery/pickup
-- delivered or picked up, or dine-in's "Mark paid" -- see In House's own
-- two pipelines), one shared trigger for all three instead of the old
-- dine-in-only, table-close-delayed version.
create table if not exists order_feedback (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id) on delete cascade,
  branch_id uuid references branch(id),
  customer_id uuid not null references customers(id),
  -- Copied at write time from order.channel, not re-derived by joining --
  -- 'dinein' vs everything else is exactly the in-house/online split
  -- Chidera asked the dashboard to filter by: "let the dashboard kind of
  -- also differentiate the feedback for inhouse or online so they know
  -- where the complain is from."
  channel text not null,
  experience_rating integer check (experience_rating between 1 and 5),
  food_rating integer check (food_rating between 1 and 5),
  service_rating integer check (service_rating between 1 and 5),
  -- 'ratings'/'ratings_retry' -- all three asked and parsed from one free-
  -- text reply (Chidera 2026-09-11: "cant they all be collected in one
  -- chat or form?" -- a real WhatsApp Flow would need registering with
  -- Meta first, so this parses one combined text reply with AI instead:
  -- "no i dont know how but cant you set it up yourself and push without
  -- meta"), not three separate List Message taps. 'experience'/'food'/
  -- 'service' kept as allowed values only for a row already mid-flow the
  -- moment this shipped, never written by fresh code.
  pending_question text check (pending_question in ('experience', 'food', 'service', 'ratings', 'ratings_retry', 'comment')),
  comment text,
  status text not null default 'sent' check (status in ('sent', 'answered')),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create unique index if not exists order_feedback_order_idx on order_feedback (order_id);
create index if not exists order_feedback_branch_created_idx on order_feedback (branch_id, created_at desc);

-- A dine-in order's own channel/fulfilment shape -- settled at the table,
-- never delivered or collected, no payment confirmation step.
alter table "order" add column if not exists channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram', 'dinein'));
alter table "order" add column if not exists table_id uuid references restaurant_table(id);
alter table "order" add column if not exists session_id uuid references table_session(id);
alter table "order" add column if not exists payment_mode text not null default 'online' check (payment_mode in ('online', 'at_table'));
-- Dine-in's own two-stage pipeline, separate from the generic order
-- status column -- "served" (food/drinks physically out) and "paid" are
-- two different real-world facts a waiter confirms at two different
-- moments, not one click. Null = not yet served (In House's first
-- pipeline); set = served, awaiting payment (second pipeline, "Mark
-- paid" is the existing POST /orders/:id/status {status:'completed'}).
-- Reset back to null if more items get added to an already-served order
-- (engine/flow.js's applyOrderModifications) -- there's something new to
-- bring out again. Chidera 2026-09-11: "confirming payment is different
-- from marking served so there should be 2 piplines."
alter table "order" add column if not exists served_at timestamptz;

-- ---------------------------------------------------------------------------
-- Folded in from migrations/0042-0048 (never added to this file at the
-- time -- create-client.mjs seeds a brand-new client from this file
-- alone, never the migrations/ folder, so every one of these was
-- genuinely missing for any client created after its own migration
-- shipped, the same class of gap a manual migration backfill exists to
-- catch on an EXISTING client). See each numbered migration file for the
-- original reasoning; kept brief here.
-- ---------------------------------------------------------------------------

-- "Let them know immediately they open" (Chidera, 2026-09-16). One pending
-- row per customer -- the partial unique index means messaging again
-- during the same closed period never queues a second notification.
create table if not exists hours_notify_request (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  branch_id uuid references branch(id) on delete cascade,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);
create unique index if not exists hours_notify_request_pending_idx on hours_notify_request(customer_id) where notified_at is null;
create index if not exists hours_notify_request_branch_idx on hours_notify_request(branch_id) where notified_at is null;

-- Customer database (CRM) add-on -- toggleable per business, same
-- "ERA switches these, not the client" shape as delivery_config/
-- voice_config/dinein_config above. birthday_prompt_enabled (0047,
-- Chidera: "not every restaurant needs it, let it be a toogle on or off
-- capability") defaults true so a business already on CRM keeps behaving
-- exactly as it does today.
create table if not exists crm_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  birthday_prompt_enabled boolean not null default true
);
alter table customers add column if not exists birthday date;

-- POS sync add-on -- reads sales that already happened on a physical
-- Moniepoint terminal into the dashboard as a real transaction list,
-- separate from PAYMENT_PROVIDER/payment.js (which collects money FROM a
-- customer through the bot).
create table if not exists pos_sync_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  provider text not null default 'moniepoint' check (provider in ('moniepoint')),
  api_key text,
  webhook_username text,
  webhook_password text,
  connected_at timestamptz
);
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

-- Who gets pinged the moment a payment clears and an order is ready to
-- start preparing (kitchen/ops), separate from handover_alerts (customer-
-- service escalations). Chidera, 2026-09-16.
alter table staff add column if not exists order_alerts boolean not null default false;

-- ERA's own prepaid message wallet (engine/wallet.js) -- WhatsApp gives no
-- self-service spending cap, so this enforces one in code. Deliberately
-- off by default and built well ahead of being turned on for anyone real,
-- Chidera's own call, 2026-09-17: "build it first, roll out later."
-- balance_kobo/rate_kobo_per_message: kobo (integer), never naira
-- (numeric), so a per-message deduction is always an exact integer
-- subtraction, never a float rounding error compounding over thousands
-- of messages.
create table if not exists message_wallet (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  balance_kobo bigint not null default 0,
  rate_kobo_per_message integer not null default 1400,
  free_messages_per_month integer not null default 1500,
  free_reset_month text not null default to_char(now(), 'YYYY-MM'),
  free_messages_this_month integer not null default 0
);

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id),
  -- Copied at write time, not re-derived by joining staff, so a later
  -- branch reassignment never rewrites history -- same "copy, don't
  -- re-resolve" idiom as rider_payout.amount and delivery_assignment's
  -- zone rate above.
  branch_id uuid references branch(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_branch_created_idx on activity_log (branch_id, created_at desc);
create index if not exists activity_log_staff_created_idx on activity_log (staff_id, created_at desc);

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
