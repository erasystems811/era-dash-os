-- Chidera, 2026-09-24: "there is also nowhere for complaint to go to,
-- there is no database table" -- a complaint submitted via routes/
-- complaint.js used to only ever exist as a real WhatsApp handover() alert
-- (ephemeral, no persistent record) and a couple of `message` rows tied to
-- a customer, with nothing to list on a dashboard tab. order_id is
-- deliberately nullable -- a complaint doesn't require an existing order
-- (a customer can complain before ever placing one).
create table if not exists complaint (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  branch_id uuid references branch(id),
  message text not null,
  status text not null default 'open' check (status in ('open', 'replied', 'resolved')),
  staff_reply text,
  replied_by_staff_id uuid references staff(id),
  replied_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists complaint_customer_idx on complaint (customer_id);
create index if not exists complaint_status_idx on complaint (status);
