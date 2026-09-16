-- "Let them know immediately they open" (Chidera, 2026-09-16): a customer
-- who messages while closed gets told when the business opens, and gets one
-- more message the moment it actually does. One pending row per customer --
-- the partial unique index (only while notified_at is null) means a
-- customer messaging again during the same closed period never queues a
-- second notification, so they get exactly one "we're open" ping, not one
-- per message they sent while waiting.
create table if not exists hours_notify_request (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  branch_id uuid references branch(id) on delete cascade,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);

create unique index if not exists hours_notify_request_pending_idx on hours_notify_request(customer_id) where notified_at is null;
create index if not exists hours_notify_request_branch_idx on hours_notify_request(branch_id) where notified_at is null;
