-- Real bug caught live by testing (2026-09-02): migration 0018 added
-- 'manual' to customers.channel but missed message.channel, which has the
-- exact same constraint independently -- every outbound notification to a
-- manually-created order's customer (delivery dispatch, delivery
-- assigned, ready-for-pickup) was silently failing to log to `message`
-- (the actual WhatsApp/sandbox send still went out fine, engine/flow.js's
-- reply() sends before it logs -- only the log insert was rejected).
-- Purely additive: no behavior change for any existing row, only allows a
-- value nothing could write before.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0023_message_manual_channel.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0023_message_manual_channel.sql

alter table message drop constraint if exists message_channel_check;
alter table message add constraint message_channel_check
  check (channel in ('whatsapp', 'instagram', 'tiktok', 'website', 'voice', 'manual'));
