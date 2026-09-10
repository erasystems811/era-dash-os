-- Real bug caught live (2026-09-02): a plain-text WhatsApp send outside the
-- 24h session window sometimes gets accepted by Meta's synchronous API
-- (200, a real wamid) and only fails afterward via an async status webhook
-- -- which webhook-whatsapp.js never listened for at all, so the message
-- silently vanished with no retry and nothing in the UI to show it. This
-- column plus platform_message_id (already exists) is what lets that
-- webhook correlate a failure back to the row that produced it.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0024_message_delivery_status.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0024_message_delivery_status.sql

alter table message add column if not exists delivery_status text
  check (delivery_status in ('sent', 'delivered', 'read', 'failed', 'retried'));
