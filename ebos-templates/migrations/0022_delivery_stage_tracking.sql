-- A Chowdeck-style STAGE tracker for customers (Chidera's call,
-- 2026-09-02) -- "waiting for rider to accept" -> "rider accepted" ->
-- "rider picked up / in transit" -> "rider is here" -> "delivered". No
-- real coordinates needed for this (unlike the live-location link that
-- was paused earlier for oversetting what an ungeocoded address could
-- show), so the tracking link can go out from the moment an offer
-- broadcasts, not only once a rider accepts.
--
-- tracking_token is generated at OFFER creation (engine/delivery-
-- dispatch.js) and copied unchanged onto delivery_assignment.tracking_
-- token once claimed (routes/rider.js) -- one link for the whole journey.
-- Purely additive: no application code reads/writes this column until the
-- new dispatch/tracking code is also deployed, so this is safe against a
-- live database with zero behavior change until then.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0022_delivery_stage_tracking.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0022_delivery_stage_tracking.sql

alter table delivery_offer add column if not exists tracking_token text;
create unique index if not exists delivery_offer_tracking_token_idx on delivery_offer (tracking_token) where tracking_token is not null;
