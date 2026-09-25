-- Chidera, 2026-09-25: "NO ERA DEMO MULTIPLE UPSELL SHOULD BE CALCULATED
-- LIKE THAT ALL INDIVIDUAL, AND MY BOARD SHOWS 1/1 FOR UPSELL MEANING IT
-- HAS ONLY RECOEDED 1" -- 0064's own trigger only ever looked at the LAST
-- entry of upsell_offered (a leftover assumption from "only upsell once",
-- 2026-09-20 -- true on main's own bot flow, but era-demo's real orders
-- have arrays like ["protein","side","drink"], several real offers in one
-- order). Each entry in the array is now its own "offered" event, checked
-- individually against the final order's items for "accepted" -- an order
-- offered 3 things and only 1 landed now correctly logs 3 offered + 1
-- accepted, not 1 + 1 (or 1 + 0, depending on which happened to be last).
--
-- No backfill here: dee/pomodoro have zero orders with more than one
-- upsell_offered entry as of this migration (checked live), so nothing
-- already counted would change -- this only changes behavior for FUTURE
-- completions, and (once business_metrics_log itself reaches era-demo) for
-- that business's own backfill, run fresh against this corrected version.
--
-- Known gap, left for whoever brings this to era-demo: era-demo's real
-- upsell_offered values include a 'side' key main's own UPSELL_GROUPS
-- (engine/flow.js) doesn't have yet. Until a 'side' branch is added below
-- (matching whatever engine/flow.js ends up with post-merge), a 'side'
-- offer will correctly count as OFFERED but can never count as ACCEPTED
-- (no keyword branch matches it) -- an undercount, not a crash, but worth
-- fixing in the same pass as adding 'side' to UPSELL_GROUPS itself.
create or replace function log_order_metrics() returns trigger as $$
declare
  offered_key text;
  matched boolean;
begin
  if tg_op = 'INSERT' then
    insert into business_metrics_log (metric, created_at) values ('order_total', new.created_at);
    return new;
  end if;

  if new.status = 'completed' and old.status is distinct from 'completed' then
    if new.upsell_offered is not null and array_length(new.upsell_offered, 1) > 0 then
      foreach offered_key in array new.upsell_offered loop
        insert into business_metrics_log (metric, created_at) values ('upsell_offered', new.created_at);
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
      end loop;
    end if;
  end if;

  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
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
