-- Chidera, 2026-09-24: "in the dine in where is the space to type in cash
-- collected by staff so bot knows how much to expect?" -- "Mark paid" was
-- a single click with no payment method or amount captured at all. These
-- two columns are what the new finance dashboard's "total cash collected"
-- figure actually sums (only ever set for payment_method = 'cash' -- a
-- card/transfer payment has no separate "cash collected" fact to record).
--
-- Cherry-picked onto web-chat-sandbox-test 2026-09-25 (main commit
-- 9479ed1's own hard dependency -- its new GET /dinein/stats/today route
-- reads payment_method/cash_collected directly) -- kept main's own
-- filename/number rather than renumbering into this branch's own
-- migration sequence, since it's literally main's file, unmodified.
alter table "order" add column if not exists payment_method text;
alter table "order" add column if not exists cash_collected numeric;
