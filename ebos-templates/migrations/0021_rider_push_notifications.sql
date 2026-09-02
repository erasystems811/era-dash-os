-- Real Web Push for the rider PWA (Chidera's report, 2026-09-02: "there
-- wasnt any actual ring on my phone"). The existing "alarm" (engine/
-- offer-bus.js's SSE + in-page synthesised tone/vibration) only runs while
-- the rider's browser tab is open and in the foreground -- with the phone
-- locked or the app backgrounded, no JS on that page executes at all, so
-- nothing plays. Web Push is delivered by the OS/browser's own push
-- service, not the page's JS, so it can wake the device even then.
-- Purely additive: no application code reads push_subscription until the
-- rider PWA's own service worker (rider-pwa/public/sw.js) and subscribe
-- flow are also deployed, so this is safe against a live database with
-- zero behavior change until then.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0021_rider_push_notifications.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0021_rider_push_notifications.sql

alter table rider add column if not exists push_subscription jsonb;
