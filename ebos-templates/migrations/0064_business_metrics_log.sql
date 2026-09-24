-- Chidera, 2026-09-25: "for my dashboard the upsell and all, even though a
-- conversation is deleted it should keep calculating that, it shouldnt
-- delete or reduce the rate." Same root cause as whatsapp_send_log
-- (0062_whatsapp_send_log.sql), generalized to every other My Dashboard
-- stat: upsell offered/accepted, total orders, abandoned orders, and
-- complaints are all computed LIVE off "order"/customers rows that DELETE
-- /customers/:id (routes/api.js) hard-deletes -- deleting one old
-- conversation that happened to have a completed, upsold order silently
-- un-counts it from every month it ever showed up in. A permanent,
-- append-only log, written once per real event AT THE MOMENT it actually
-- happens, immune to any later delete because it references nothing else
-- at all -- same shape as whatsapp_send_log, one row per event instead of
-- one row per send.
--
-- order totals/completions/abandons/upsell are logged by a TRIGGER on
-- "order" itself, not a call site in engine/flow.js, because a new order
-- gets created or completed from several genuinely different places in
-- this codebase (engine/flow.js, routes/api.js's manual POS/"mark paid"
-- actions, routes/delivery.js, routes/rider.js) -- a trigger fires no
-- matter which one does it, so a future completion path can never
-- accidentally forget to log the way a hand-picked list of JS call sites
-- eventually would. Complaint and active-customer are each only ever
-- decided in exactly one place already (engine/flow.js), so those two just
-- log directly from there instead.
create table if not exists business_metrics_log (
  id uuid primary key default gen_random_uuid(),
  metric text not null,
  created_at timestamptz not null default now()
);
create index if not exists business_metrics_log_metric_created_at_idx on business_metrics_log (metric, created_at);

-- One-time backfill from whatever "order"/customers/message data still
-- exists right now, so switching My Dashboard over to reading this log
-- doesn't make every historical number visibly drop to near-zero the
-- moment this deploys (the exact bug already hit once with
-- whatsapp_send_log's own launch). Guarded on the table still being empty
-- so an accidental re-run of this file is a no-op, not a double-count.
do $$
begin
  if not exists (select 1 from business_metrics_log limit 1) then
    insert into business_metrics_log (metric, created_at)
    select 'order_total', created_at from "order";

    -- Same heuristic routes/api.js's business-intelligence route uses:
    -- a cancelled order with no inbound customer message in the hour
    -- right before its own last (pre-cancel) update.
    insert into business_metrics_log (metric, created_at)
    select 'order_abandoned', o.created_at
    from "order" o
    where o.status = 'cancelled'
      and not exists (
        select 1 from message m
        where m.customer_id = o.customer_id and m.direction = 'inbound'
          and m.created_at > o.updated_at - interval '1 hour' and m.created_at <= o.updated_at
      );

    insert into business_metrics_log (metric, created_at)
    select 'complaint', c.handover_at
    from customers c
    where c.handover_reason = 'Customer message classified as a complaint' and c.handover_at is not null;

    -- One row per customer per calendar month they sent at least one
    -- inbound message -- matches the live count(distinct customer_id)
    -- per month the dashboard used to compute on the fly.
    insert into business_metrics_log (metric, created_at)
    select 'active_customer', min(m.created_at)
    from message m
    where m.direction = 'inbound'
    group by m.customer_id, date_trunc('month', m.created_at);

    -- Upsell offered/accepted -- the same per-order match
    -- routes/api.js's computeUpsellStats does in JS (last entry of
    -- upsell_offered against the final order's own item categories),
    -- run once here in SQL for this historical backfill. The keyword
    -- lists below are engine/flow.js's UPSELL_GROUPS, copied by hand --
    -- see the trigger function further down for the same copy and why.
    insert into business_metrics_log (metric, created_at)
    select 'upsell_offered', o.created_at
    from "order" o
    where o.status = 'completed' and o.upsell_offered != '{}';

    insert into business_metrics_log (metric, created_at)
    select 'upsell_accepted', o.created_at
    from "order" o
    where o.status = 'completed' and o.upsell_offered != '{}'
      and exists (
        select 1 from order_item oi
        join product p on p.id = oi.product_id
        where oi.order_id = o.id
          and (
            (o.upsell_offered[array_upper(o.upsell_offered, 1)] = 'drink'
              and (p.category ilike '%drink%' or p.category ilike '%beverage%' or p.category ilike '%juice%' or p.category ilike '%water%'))
            or (o.upsell_offered[array_upper(o.upsell_offered, 1)] = 'protein'
              and (p.category ilike '%protein%' or p.category ilike '%meat%'))
            or (o.upsell_offered[array_upper(o.upsell_offered, 1)] = 'snack'
              and (p.category ilike '%snack%' or p.category ilike '%small chop%' or p.category ilike '%appetiser%' or p.category ilike '%appetizer%' or p.category ilike '%starter%'))
          )
      );
  end if;
end $$;

-- Fires on every future insert/status-change no matter which route caused
-- it. The upsell keyword lists here MUST be kept in sync by hand with
-- engine/flow.js's own UPSELL_GROUPS (a database trigger can't import a JS
-- module) -- that list has been stable for weeks and only ever changes
-- deliberately, so this is a documented, known pairing, not a silent trap.
create or replace function log_order_metrics() returns trigger as $$
declare
  offered_key text;
  matched boolean;
begin
  if tg_op = 'INSERT' then
    insert into business_metrics_log (metric, created_at) values ('order_total', new.created_at);
    return new;
  end if;

  -- tg_op = 'UPDATE' (this trigger only fires on "update of status" --
  -- see the CREATE TRIGGER below -- so status is always the column that
  -- changed).
  if new.status = 'completed' and old.status is distinct from 'completed' then
    if new.upsell_offered is not null and array_length(new.upsell_offered, 1) > 0 then
      insert into business_metrics_log (metric, created_at) values ('upsell_offered', new.created_at);
      -- Only one offer per order since 2026-09-20 (Chidera: "only upsell
      -- once"), but upsell_offered stays an array for older orders -- the
      -- LAST entry is the one actually left standing when the order
      -- completed, same as computeUpsellStats' own JS logic.
      offered_key := new.upsell_offered[array_upper(new.upsell_offered, 1)];
      select exists (
        select 1 from order_item oi
        join product p on p.id = oi.product_id
        where oi.order_id = new.id
          and (
            (offered_key = 'drink' and (p.category ilike '%drink%' or p.category ilike '%beverage%' or p.category ilike '%juice%' or p.category ilike '%water%'))
            or (offered_key = 'protein' and (p.category ilike '%protein%' or p.category ilike '%meat%'))
            or (offered_key = 'snack' and (p.category ilike '%snack%' or p.category ilike '%small chop%' or p.category ilike '%appetiser%' or p.category ilike '%appetizer%' or p.category ilike '%starter%'))
          )
      ) into matched;
      if matched then
        insert into business_metrics_log (metric, created_at) values ('upsell_accepted', new.created_at);
      end if;
    end if;
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    -- new.updated_at here is still the PRE-cancel value (closeStaleOrders'
    -- own UPDATE never touches updated_at itself) -- the same "quiet for an
    -- hour before this" anchor the live heuristic query already used.
    if not exists (
      select 1 from message where customer_id = new.customer_id and direction = 'inbound'
        and created_at > new.updated_at - interval '1 hour' and created_at <= new.updated_at
    ) then
      insert into business_metrics_log (metric, created_at) values ('order_abandoned', new.created_at);
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists order_metrics_trigger on "order";
create trigger order_metrics_trigger
  after insert or update of status on "order"
  for each row execute function log_order_metrics();
