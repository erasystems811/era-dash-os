-- Adds a 'preparation' stage between 'confirmed' and 'ready' on the
-- Orders kanban board (Chidera's call, 2026-09-02): 'confirmed' means paid
-- and needs someone to look at it, 'preparation' means the kitchen has
-- actually started -- and is the only stage the "mark as ready" button
-- (which calls a rider) appears from. Purely additive: widens the check
-- constraint only, no existing row's status changes, so this is safe
-- against a live database with zero behavior change until the new
-- dashboard code is also deployed.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0019_order_preparation_stage.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0019_order_preparation_stage.sql

alter table "order" drop constraint if exists order_status_check;
alter table "order" add constraint order_status_check
  check (status in ('new', 'confirmed', 'preparation', 'ready', 'delivery', 'completed', 'cancelled'));
