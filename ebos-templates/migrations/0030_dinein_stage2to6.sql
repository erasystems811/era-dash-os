-- Dine-in add-on, Stages 2-6: scan handling, call a waiter, the menu page,
-- ordering into the existing engine, closing a table. See
-- EBOS-Addon-Schema-Dine-In.md sections 3, 5, 6, 9.
alter table "order" add column if not exists channel text not null default 'whatsapp' check (channel in ('whatsapp', 'instagram', 'dinein'));
alter table "order" add column if not exists table_id uuid references restaurant_table(id);
alter table "order" add column if not exists session_id uuid references table_session(id);
alter table "order" add column if not exists payment_mode text not null default 'online' check (payment_mode in ('online', 'at_table'));
-- 'table' alongside the existing 'delivery'/'pickup' -- a dine-in order is
-- settled at the table, never delivered or collected (spec 5.3/5.4).
alter table "order" drop constraint if exists "order_fulfilment_type_check";
alter table "order" add constraint "order_fulfilment_type_check" check (fulfilment_type in ('delivery', 'pickup', 'table'));

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
