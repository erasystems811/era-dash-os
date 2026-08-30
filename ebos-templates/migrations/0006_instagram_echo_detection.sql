-- Lets webhook-instagram.js tell the bot's/staff's own API-sent messages
-- apart from a human reply typed directly in the Instagram app, so
-- Instagram gets the same "bot stays quiet once a human is replying"
-- behavior WhatsApp coexistence already has. See schema.sql's comment on
-- message.platform_message_id for the full reasoning.
-- Additive and idempotent, safe against a live database.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0006_instagram_echo_detection.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0006_instagram_echo_detection.sql
alter table message add column if not exists platform_message_id text;
create index if not exists message_platform_message_id_idx on message (platform_message_id) where platform_message_id is not null;
