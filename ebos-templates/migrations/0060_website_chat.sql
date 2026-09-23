-- Structured payload for an interactive outbound message on the website
-- channel (buttons/list/cta_url/document) -- the web-chat page renders a
-- real bubble/button/list from this instead of flattened text; every
-- other channel leaves this null and keeps using body as today.
alter table message add column if not exists interactive jsonb;

-- Touched on every request into the web-chat page (routes/web-chat.js) --
-- lets an async trigger (completePayment, fired from Paystack's webhook
-- with no live customer object) know a customer's most recent turn was on
-- this page, without ever writing 'website' into customers.channel itself
-- (which must stay the real stored channel so a fresh WhatsApp text days
-- later still starts the normal WhatsApp flow).
alter table customers add column if not exists web_chat_active_at timestamptz;
