-- Denormalizes "last message" onto customers so the conversations list
-- (routes/api.js GET /conversations) can sort by activity with a plain
-- indexed column instead of a correlated subquery into message per
-- customer -- that subquery got noticeably more expensive as a business's
-- customer table grew, regardless of how many were actually active.
-- engine/flow.js's logMessage now stamps both columns on every
-- inbound/outbound message going forward; this migration backfills them
-- once for messages that already exist. Additive and idempotent, safe
-- against a live database.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0003_customer_last_message.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0003_customer_last_message.sql
alter table customers add column if not exists last_message text;
alter table customers add column if not exists last_message_at timestamptz;
create index if not exists customers_last_message_at_idx on customers (last_message_at desc);

update customers c
set last_message = m.body, last_message_at = m.created_at
from (
  select distinct on (customer_id) customer_id, body, created_at
  from message
  order by customer_id, created_at desc
) m
where m.customer_id = c.id and c.last_message_at is null;
