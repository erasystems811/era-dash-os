-- Dine-in add-on, Stage 1 (of 9 -- see EBOS-Addon-Schema-Dine-In.md's own
-- "Build order"): schema for tables + sessions, and dinein_config's toggle.
-- Optional, per business, off by default (dinein_config.enabled = false),
-- switched on by ERA not the restaurant -- same whole-deployment-toggle
-- shape as voice_config/delivery_config. A guest scanning a QR, ordering
-- from a menu page, and being asked for feedback after (stages 2-7) comes
-- in later migrations; this one only adds the tables a restaurant can be
-- set up with and the session concept everything else attaches to.
create table if not exists dinein_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  feedback_enabled boolean not null default true,
  feedback_delay_minutes int not null default 20,
  auto_close_hours int not null default 4,
  pos_mode text not null default 'none' check (pos_mode in ('none', 'webhook', 'api', 'database', 'printer')),
  -- Same encrypted-opaque-string idiom as delivery_config.provider_keys --
  -- whatever a given POS integration needs (a base URL, an API key, DB
  -- connection details) only exists as real JSON again after decrypt() at
  -- call time.
  pos_config text,
  review_link text,
  welcome_image_url text
);

-- Tables belong to a branch, not a business -- same idiom as delivery_zone
-- and everywhere else with real per-location scope (see the branches
-- addendum). qr_token is the guest-facing identity for a table (the QR
-- code encodes a wa.me link carrying the table's label as plain text, not
-- this token directly -- see menu-page routing added in a later stage);
-- regenerating it is how a stolen or renumbered printed card gets
-- invalidated without touching the table row itself.
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

-- One open session per table at a time -- opened on the first scan (a
-- later stage), closed from the dashboard or a POS integration. Matching
-- "which session does this waiter call / feedback message belong to" is
-- always "the most recent open (closed_at is null) session for that
-- table", per the doc's own section 6.4/7.3 -- enforced here as a partial
-- unique index (one null-closed_at row per table) rather than left as an
-- application-level assumption that could silently drift.
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
