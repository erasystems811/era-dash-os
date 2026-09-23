-- Chidera, 2026-09-20: joint dine-in ordering + serve-then-pay + split
-- payment. Schema only -- nothing reads or writes any of this yet, added
-- ahead of the app code that will (see fancy-whistling-pearl.md).

-- Who's currently part of an open table sitting -- recorded the first
-- time each guest actually interacts with the table (scans, or the
-- shared page loads for them), not a roster they explicitly join.
create table if not exists table_session_guest (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references table_session(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (session_id, customer_id)
);
create index if not exists table_session_guest_session_idx on table_session_guest (session_id);

-- Whoever added this specific line -- null for every existing row and
-- every non-dine-in order; only ever set going forward for dine-in.
alter table order_item add column if not exists added_by_customer_id uuid references customers(id);

-- One row per actual charge attempt against an order, not one column on
-- the order itself -- lets a table's bill be paid as one whole-order
-- charge (covers_item_ids null) or as one-or-more group charges, each
-- covering only the items its own payers actually ordered. reference is
-- our own bookkeeping id (order.reference + '-P' + n), never sent to
-- Moniepoint -- confirmation is matched by amount/time against real
-- pos_transaction rows (engine/webhook-moniepoint.js), not by reference.
-- provider defaults to 'pos' -- Chidera, 2026-09-20: "i said use pos not
-- paystack," the whole point being the bot auto-confirms a real POS
-- transaction (card or transfer to the terminal's linked account) with no
-- staff step, closing a real staff-fraud vector (staff redirecting
-- customers to their own personal account number instead).
create table if not exists order_payment (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id) on delete cascade,
  provider text not null default 'pos' check (provider in ('pos', 'paystack', 'manual')),
  reference text not null unique,
  amount numeric(12, 2) not null,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'failed')),
  covers_item_ids uuid[],
  paid_by_customer_id uuid references customers(id),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);
create index if not exists order_payment_order_idx on order_payment (order_id);
create index if not exists order_payment_pending_amount_idx on order_payment (amount) where status = 'pending';
