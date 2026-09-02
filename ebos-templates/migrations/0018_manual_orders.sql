-- Lets staff create an order directly from the dashboard (routes/api.js's
-- POST /orders) for a delivery/order that came in some way other than a
-- channel this system listens on itself (a landline call, a walk-in) --
-- Chidera's ask, 2026-09-02: "where can i book a delivery without a
-- whatsapp order". Purely additive: no application code writes channel =
-- 'manual' anywhere until this deploys alongside it, so this is safe
-- against a live database with zero behavior change on its own.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0018_manual_orders.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0018_manual_orders.sql

alter table customers drop constraint if exists customers_channel_check;
alter table customers add constraint customers_channel_check
  check (channel in ('whatsapp', 'instagram', 'tiktok', 'website', 'voice', 'manual'));
