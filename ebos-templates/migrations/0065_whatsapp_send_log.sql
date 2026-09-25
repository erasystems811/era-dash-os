-- Mirrors main's own 0062_whatsapp_send_log.sql (this branch's migration
-- numbering diverged from main's after 0060 -- see project memory on the
-- branch split). Chidera: "even though a conversation is deleted it
-- should be counted on my dash." routes/api.js's DELETE /customers/:id
-- hard-deletes every row in `message` for that customer (a deliberate,
-- correct cleanup of conversation content) -- but /monitor/messaging-cost
-- counted outbound WhatsApp sends straight out of that same table, so
-- deleting a test conversation silently erased every real, already-billed
-- WhatsApp send in it too. A permanent, append-only log of real outbound
-- WhatsApp sends (engine/flow.js's logMessage), written once per real
-- send and never deleted by anything, customer-delete included. No
-- customer_id/body/content at all on purpose -- this is a billing count,
-- not a second copy of the conversation, so deleting a conversation for
-- privacy still actually removes its content.
create table if not exists whatsapp_send_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_send_log_created_at_idx on whatsapp_send_log (created_at);
