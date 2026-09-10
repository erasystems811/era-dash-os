-- Interactive drink/protein cross-sell -- per Chidera 2026-09-10, asked and
-- answered as its own exchange (real options named, real answer awaited)
-- before the final "to confirm" summary, not decoration folded into it.
-- See engine/flow.js's nextUpsellGroup/handlePendingUpsell.
alter table "order" add column if not exists pending_upsell_category text;
alter table "order" add column if not exists upsell_offered text[] not null default '{}';
