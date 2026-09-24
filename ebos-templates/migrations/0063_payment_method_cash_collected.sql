-- Chidera, 2026-09-24: "in the dine in where is the space to type in cash
-- collected by staff so bot knows how much to expect?" -- "Mark paid" was
-- a single click with no payment method or amount captured at all. These
-- two columns are what the new finance dashboard's "total cash collected"
-- figure actually sums (only ever set for payment_method = 'cash' -- a
-- card/transfer payment has no separate "cash collected" fact to record).
alter table "order" add column if not exists payment_method text;
alter table "order" add column if not exists cash_collected numeric;
