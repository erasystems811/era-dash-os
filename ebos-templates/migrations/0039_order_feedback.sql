create table if not exists order_feedback (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id) on delete cascade,
  branch_id uuid references branch(id),
  customer_id uuid not null references customers(id),
  -- Copied at write time from order.channel, not re-derived by joining --
  -- 'dinein' vs everything else is exactly the in-house/online split
  -- Chidera 2026-09-11 asked the dashboard to filter feedback by: "let the
  -- dashboard kind of also differentiate the feedback for inhouse or
  -- online so they know where the complain is from."
  channel text not null,
  experience_rating integer check (experience_rating between 1 and 5),
  food_rating integer check (food_rating between 1 and 5),
  service_rating integer check (service_rating between 1 and 5),
  pending_question text check (pending_question in ('experience', 'food', 'service', 'comment')),
  comment text,
  status text not null default 'sent' check (status in ('sent', 'answered')),
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create unique index if not exists order_feedback_order_idx on order_feedback (order_id);
create index if not exists order_feedback_branch_created_idx on order_feedback (branch_id, created_at desc);
