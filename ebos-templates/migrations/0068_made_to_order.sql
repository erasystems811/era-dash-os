-- Chidera, 2026-10-02: "she sells slippers and leather textured things...
-- with product you cant predict its basically buy and sell or produce and
-- sell, its not a service." Product businesses need a way to mark some
-- items as made-to-order (produced after the order comes in) instead of
-- ready_made (already in stock) -- and "not all product business do ready
-- made or made to order, some do just ready made simply" means this is a
-- per-business config, never forced on. "not all do deposit or cutoff time
-- all those are options" -- deposit_percent/max_concurrent_jobs/
-- same_day_cutoff_time are each independently nullable, never bundled.
--
-- order_type defaults to 'ready_made' so every existing product on every
-- existing business keeps behaving exactly as it already does -- this is
-- purely additive, zero migration risk for a business that never touches
-- made-to-order at all.
alter table product add column if not exists order_type text not null default 'ready_made' check (order_type in ('ready_made', 'made_to_order'));

-- Same "ERA switches these, not the client" whole-deployment-toggle shape
-- as delivery_config/voice_config/dinein_config -- see dinein_config's own
-- schema comment. enabled = false by default, so a brand-new or
-- already-live business is never affected until ERA actually turns this on
-- for a genuine made-to-order product business.
create table if not exists made_to_order_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  -- Null = no deposit required, pay in full like any ready_made item.
  deposit_percent numeric(5, 2),
  -- Null = no cap on how many made-to-order jobs can be in flight at once.
  max_concurrent_jobs integer,
  -- Null = no same-day cutoff enforced.
  same_day_cutoff_time time
);

-- Null on every order that never involved a made-to-order item (the
-- overwhelming majority, including every order on every non-product
-- business) -- deposit_amount/balance_due only ever get set by
-- sendPaymentInstructions when the cart actually has a made-to-order item
-- AND the business has made_to_order_config.enabled with a deposit_percent
-- set. The genuinely new fact these carry: a payment confirming
-- deposit_amount is NOT the same fact as the order being fully paid for --
-- see payment-flow.js's completePayment, which checks balance_due before
-- ever treating a payment as having settled the whole order.
alter table "order" add column if not exists deposit_amount numeric(12, 2);
alter table "order" add column if not exists balance_due numeric(12, 2);
