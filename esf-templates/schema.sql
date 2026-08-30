-- ERA StaffFlow (ESF) -- per-client schema.
-- One database per business, same as EBOS. No business_id anywhere --
-- isolation is physical (a separate database per client), not row-level.
-- `business` is a single-row settings table, not a list. See
-- ERA-StaffFlow-Build-Schema-v2.0.md for the full spec.
create extension if not exists pgcrypto;

create table if not exists business (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Africa/Lagos',
  lat double precision,
  lng double precision,
  radius_m integer not null default 200,
  owner_phone text,
  created_at timestamptz not null default now()
);
-- Enforces "exactly one settings row" at the database level, not just by
-- convention -- a second insert fails loudly instead of silently creating
-- an ambiguous second business. Same trick as ebos-templates/schema.sql.
create unique index if not exists business_singleton_idx on business ((true));

-- WhatsApp credentials are NOT a column here -- they live in this
-- deployment's own .env, set via add-whatsapp.mjs, same as any other
-- era-dash-os client (see esf-templates/.env.template).

create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  -- 2348..., no plus, no leading zero. Unique WITHIN this business only --
  -- each ESF client is its own database, so no cross-business dedup is
  -- needed (unlike a shared-number multi-tenant design, which this
  -- deliberately is not -- see build schema v2.0 section 1).
  phone text not null unique,
  name text not null,
  -- Free text on purpose, not a role table. Every business names roles
  -- differently (sales, cashier, cleaner, stylist...) and a lookup table
  -- becomes maintenance debt, not structure.
  role text not null,
  shift_start time,
  shift_end time,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists task (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Two independent ways to target who gets this task, most specific wins:
  -- staff_id set = this one person only, regardless of role. staff_id null
  -- + role set = every active staff member with that role. Both null =
  -- every active staff member. Tasks are not one-size-fits-all -- a
  -- business assigns whatever mix of shared and individual tasks it needs.
  staff_id uuid references staff (id) on delete cascade,
  role text,
  seq integer not null default 0,
  -- 'MON,TUE,WED,THU,FRI,SAT' -- comma-separated 3-letter days.
  days text not null,
  available_from time not null,
  due_by time not null,
  mode text not null default 'chat' check (mode in ('chat', 'form')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists task_staff_id_idx on task (staff_id);

create table if not exists step (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references task (id) on delete cascade,
  seq integer not null,
  instruction text not null,
  proof_type text not null check (
    proof_type in ('tap', 'photo', 'location', 'number', 'text', 'choice', 'code', 'api', 'countersign')
  ),
  proof_config jsonb not null default '{}'::jsonb,
  on_problem text not null default 'continue' check (on_problem in ('continue', 'alert', 'block')),
  optional boolean not null default false,
  requires_prev boolean not null default true,
  clock_action text not null default 'none' check (clock_action in ('none', 'in', 'out')),
  created_at timestamptz not null default now()
);
create index if not exists step_task_id_idx on step (task_id, seq);

-- One per staff member per task per day.
create table if not exists run (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references task (id) on delete cascade,
  staff_id uuid not null references staff (id) on delete cascade,
  -- A run belongs to a date, not a session -- she can start, drop off, and
  -- resume, and it is the same run.
  run_date date not null,
  current_seq integer not null default 1,
  status text not null default 'open' check (status in ('open', 'complete', 'blocked', 'missed')),
  started_at timestamptz,
  completed_at timestamptz,
  -- Set when a scheduled prompt had to go out as a WhatsApp template (the
  -- 24h customer-service window had closed) instead of a freeform message --
  -- bot-engine/wake-template.js's flow. Not null means "the real step
  -- content is queued behind this staff member's next reply, whatever it
  -- says" -- re-derived from current_seq/step on flush, never cached as
  -- separate text, so there is one source of truth for what she's owed.
  wake_sent_at timestamptz,
  -- Set when the current step is a `countersign` step and a matching
  -- staff member was found to confirm it -- the run is now waiting on
  -- THAT person's reply, not staff_id's own. Whoever's phone messages the
  -- bot next is checked against this before their own normal open-run
  -- lookup (run-engine.js's handleStaffReply), since the confirming
  -- person is very likely a different staff member with her own separate
  -- tasks/runs too.
  pending_countersign_staff_id uuid references staff (id),
  -- Set only for a task.mode='form' run -- the unguessable token in the
  -- link sent to her ("fill it out here: .../form/<token>"), build schema
  -- v2.0 section 6's "she taps once to open it, fills every field, submits
  -- once". Null for every chat-mode run; never reused once she's submitted
  -- (the run leaves 'open' status, and routes/form.js checks that first).
  form_token text unique,
  created_at timestamptz not null default now(),
  unique (task_id, staff_id, run_date)
);
create index if not exists run_status_due_idx on run (status, run_date);
create index if not exists run_form_token_idx on run (form_token) where form_token is not null;

-- One per answered step. The permanent record -- append only. Never
-- UPDATE, never DELETE. A correction is a new row pointing at the old one
-- via corrects_entry_id; reports read the latest in each chain.
create table if not exists entry (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references run (id) on delete cascade,
  step_id uuid not null references step (id),
  staff_id uuid not null references staff (id),
  answer text not null check (answer in ('done', 'problem', 'skipped')),
  value text,
  media_url text,
  lat double precision,
  lng double precision,
  note text,
  -- Copied onto the row, not looked up from step, so a step edited next
  -- year never silently rewrites what a historical entry claims was
  -- required.
  applied_proof_type text not null,
  corrects_entry_id uuid references entry (id),
  -- Server time, UTC, never the client's clock (engine rule 2).
  created_at timestamptz not null default now()
);
create index if not exists entry_run_id_idx on entry (run_id);

-- Proof set per PERSON, not per business. Engine reads step, then checks
-- here for this staff member; override wins if present. reason is shown to
-- the staff member -- proof is a dial, never a silent per-person rule.
create table if not exists step_override (
  step_id uuid not null references step (id) on delete cascade,
  staff_id uuid not null references staff (id) on delete cascade,
  proof_type text not null check (
    proof_type in ('tap', 'photo', 'location', 'number', 'text', 'choice', 'code', 'api', 'countersign')
  ),
  proof_config jsonb not null default '{}'::jsonb,
  reason text not null,
  expires_on date,
  created_at timestamptz not null default now(),
  primary key (step_id, staff_id)
);

-- Who logs into this business's dashboard. Staff are never owner_users --
-- their entire interface is the chat, they never log in anywhere.
create table if not exists owner_user (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'owner' check (role in ('owner', 'manager', 'viewer')),
  can_override boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists alert_route (
  id uuid primary key default gen_random_uuid(),
  event text not null check (event in ('problem', 'blocked', 'missing', 'late', 'variance', 'daily_summary')),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'email', 'dashboard')),
  target text not null,
  -- e.g. '22:00-07:00'. Applies to every event except 'blocked', which
  -- always fires immediately (engine rule: a stuck run is worth the
  -- interruption).
  quiet_hours text,
  created_at timestamptz not null default now()
);

-- Dedup for alert_route: at most one alert per (event, event_date, context).
-- Not in the original config schema doc -- added because "one alert per
-- event per day" (build schema v2.0 section 8) needs somewhere to record
-- that today's alert already went out, or a 30-minute missing-detection
-- sweep re-fires it every cycle. `context` (e.g. "<task_id>:<staff_id>")
-- keeps this per task+staff rather than one alert total per business per
-- day -- a business with three staff missing three different tasks needs
-- three alerts, not one that swallows the rest.
create table if not exists alert_log (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  event_date date not null,
  context text not null default '',
  created_at timestamptz not null default now(),
  unique (event, event_date, context)
);

create table if not exists sheet_link (
  spreadsheet_id text,
  last_synced_at timestamptz,
  tabs jsonb not null default '{}'::jsonb
);
create unique index if not exists sheet_link_singleton_idx on sheet_link ((true));

-- WhatsApp message log. Two jobs: (1) idempotency -- store the incoming
-- message id, ignore repeats, WhatsApp resends on poor network (engine rule
-- 4); (2) lastCustomerMessageAt for bot-engine/wake-template.js's 24h-window
-- check. Not in the original config schema doc, same reasoning as
-- alert_log -- both rules were named in the spec with nowhere to actually
-- store their state.
create table if not exists message (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff (id),
  direction text not null check (direction in ('inbound', 'outbound')),
  body text,
  wa_message_id text unique,
  created_at timestamptz not null default now()
);
create index if not exists message_staff_created_idx on message (staff_id, created_at desc);
