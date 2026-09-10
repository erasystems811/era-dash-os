-- Dine-in add-on, Stage 7: feedback. Fires feedback_delay_minutes after a
-- table closes (Chidera's call, 2026-09-10: 120, not the spec's original
-- 20), never on an auto-closed session (table_session.feedback_state
-- tracks this so a sweep never sends it twice).
alter table dinein_config alter column feedback_delay_minutes set default 120;
update dinein_config set feedback_delay_minutes = 120 where feedback_delay_minutes = 20;

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
