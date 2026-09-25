-- Chidera, 2026-09-24: "let table dine in and online delivery have their
-- complete different web chat so a person can be doing both at same time
-- in 2 different web chats, so let dine in be its own web chat." Real gap
-- confirmed by reading, not assumed: getOpenOrder(customerId) has no
-- channel filter at all, so a customer who's both mid dine-in table
-- session AND has a separate online order open gets whichever one is
-- more recent resolved for EVERY tap/text, regardless of which chat
-- thread they're actually in. message itself has no way to tell a
-- dine-in bubble apart from an online one for the same customer_id
-- either -- both problems share this one root cause. NULL means "not
-- dine-in" (the existing /wa/:token online thread), a real table_session
-- id means "this bubble belongs to that table's own chat thread"
-- (routes/dinein-menu.js's new /t/:qrToken/chat).
alter table message add column if not exists table_session_id uuid references table_session(id);
create index if not exists message_table_session_idx on message (table_session_id) where table_session_id is not null;
