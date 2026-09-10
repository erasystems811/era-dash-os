-- Own-riders delivery previously matched an address to a zone silently,
-- applying whatever it found (or handing straight to staff on no match)
-- with no chance for the customer to confirm the area was read correctly.
-- Chidera's call, 2026-09-02: always confirm a matched area before
-- quoting the fee, and ask directly for the area instead of giving up
-- immediately when nothing in the address matches. These two columns are
-- the same null/non-null gate idiom order.confirmed_at already uses for
-- the order-confirmation yes/no step -- see engine/flow.js's
-- handleCollectFulfilment for how they drive it.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0025_delivery_area_confirmation.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0025_delivery_area_confirmation.sql

alter table "order" add column if not exists delivery_zone_candidate_id uuid references delivery_zone(id);
alter table "order" add column if not exists delivery_area_prompted_at timestamptz;
