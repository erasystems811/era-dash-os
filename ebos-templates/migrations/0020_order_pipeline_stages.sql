-- Reworks the order.status pipeline (Chidera's call, 2026-09-02):
--   new -> confirmation -> preparation -> ready -> [pickup: completed]
--                                               -> [delivery: delivery -> in_transit -> completed]
-- 'confirmed' renamed to 'confirmation' (a real data migration, not just a
-- wider constraint -- existing rows get moved over). 'delivery' already
-- existed as a value but was never actually used by any code path; it now
-- means "handed to a rider, not yet collected." 'in_transit' is new
-- (delivery orders only, set automatically the moment a rider marks
-- picked-up -- see routes/rider.js). No column is dropped, so this stays
-- safe to run against a live database with the OLD dashboard code still
-- briefly running (an order sitting in 'confirmation' just won't be
-- recognised by old code's 'confirmed' checks until the new code deploys
-- alongside this).
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0020_order_pipeline_stages.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0020_order_pipeline_stages.sql

alter table "order" drop constraint if exists order_status_check;
alter table "order" add constraint order_status_check
  check (status in ('new', 'confirmation', 'preparation', 'ready', 'delivery', 'in_transit', 'completed', 'cancelled', 'confirmed'));

update "order" set status = 'confirmation' where status = 'confirmed';

alter table "order" drop constraint if exists order_status_check;
alter table "order" add constraint order_status_check
  check (status in ('new', 'confirmation', 'preparation', 'ready', 'delivery', 'in_transit', 'completed', 'cancelled'));
