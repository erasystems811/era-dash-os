-- Needed for the 24h "welcome back, want to order again?" window (Chidera's
-- call, 2026-09-03): the moment an order finishes and there's no longer an
-- open order for a customer, the bot should offer to start another one
-- instead of the normal fresh-greeting/root flow -- but only for 24h after
-- completion, then it really does go back to root. updated_at isn't a safe
-- stand-in for "when did this complete": it's only reliably bumped to
-- completion time via the staff-driven /orders/:id/status route, not via
-- routes/rider.js's own auto-completion when a rider enters the delivery
-- code (fixed alongside this migration to also set completed_at, see
-- flow.js's recentlyCompletedOrder for the read side).
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0026_order_completed_at.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0026_order_completed_at.sql

alter table "order" add column if not exists completed_at timestamptz;
