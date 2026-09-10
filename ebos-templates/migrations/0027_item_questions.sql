-- Per-item customization questions (water: room temp or cold, rice:
-- peppered or not, ...) -- opt-in per catalogue item, per Chidera 2026-09-10:
-- some restaurants want this, some don't (pre-made meals, nothing to ask).
-- An item with zero rows here behaves exactly as before -- the bot never
-- asks anything, same as today.
create table if not exists product_question (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references product(id) on delete cascade,
  question text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists product_question_product_idx on product_question (product_id);

-- One row per (order_item, question) actually asked+answered -- tracks
-- exactly which questions still need asking (see engine/flow.js's
-- askNextItemQuestion) without parsing order_item.modification's free text.
create table if not exists order_item_answer (
  order_item_id uuid not null references order_item(id) on delete cascade,
  question_id uuid not null references product_question(id) on delete cascade,
  answer text not null,
  created_at timestamptz not null default now(),
  primary key (order_item_id, question_id)
);

-- Which single question the bot is mid-way through asking for this order,
-- if any -- engine/flow.js's dispatch() checks this before its normal
-- engine_state routing, so the next inbound message is captured as the
-- answer instead of being run through intent classification.
alter table "order" add column if not exists pending_question_order_item_id uuid references order_item(id);
alter table "order" add column if not exists pending_question_id uuid references product_question(id);
