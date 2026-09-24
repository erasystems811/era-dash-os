-- Chidera, 2026-09-24: "even though a conversation is deleted it should
-- be counted on my dash... the client dashboard shouldnt be what is used
-- to count outbound but the bot itself." Real bug: routes/api.js's DELETE
-- /customers/:id hard-deletes every row in `message` for that customer
-- (a deliberate, correct cleanup of conversation content) -- but
-- /monitor/messaging-cost counted outbound WhatsApp sends straight out of
-- that same table, so deleting a test conversation silently erased every
-- real, already-billed WhatsApp send in it too. A count of what the bot
-- genuinely sent has to survive conversation cleanup -- this is a
-- permanent, append-only log, written once per real outbound WhatsApp
-- send (engine/flow.js's logMessage) and never deleted by anything,
-- customer-delete included. No customer_id/body/content at all on
-- purpose -- this is a billing count, not a second copy of the
-- conversation, so deleting a conversation for privacy still actually
-- removes its content.
create table if not exists whatsapp_send_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_send_log_created_at_idx on whatsapp_send_log (created_at);
