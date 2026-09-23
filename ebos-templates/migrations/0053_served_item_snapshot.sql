-- Chidera, 2026-09-20: "on the staff card let there be a clear
-- demarcation for add on, so they know what has been served and what
-- has just been added on." order_item has no stable row identity across
-- a resubmit (the web review route deletes and reinserts every line
-- every time -- see routes/dinein-menu.js), so "was THIS row already
-- served" can't be tracked on the row itself. A snapshot of quantities
-- per product, taken the moment staff actually taps "Served"
-- (routes/dinein.js), is a pure diff against the CURRENT quantities --
-- correct regardless of how items get added afterward, web or chat.
alter table "order" add column if not exists served_item_snapshot jsonb;
