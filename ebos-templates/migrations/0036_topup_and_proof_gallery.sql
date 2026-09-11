create table if not exists order_topup (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id) on delete cascade,
  items jsonb not null,
  amount numeric(12,2) not null,
  payment_status text not null default 'pending' check (payment_status in ('pending', 'proof_submitted', 'confirmed')),
  created_at timestamptz not null default now()
);
create index if not exists order_topup_order_idx on order_topup (order_id);

create table if not exists order_payment_proof (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references "order"(id) on delete cascade,
  data_url text not null,
  created_at timestamptz not null default now()
);
create index if not exists order_payment_proof_order_idx on order_payment_proof (order_id);
