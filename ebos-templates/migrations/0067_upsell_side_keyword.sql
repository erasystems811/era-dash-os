-- Chidera, 2026-09-25 (via peer session, following up on 0065's own left
-- gap): engine/flow.js's UPSELL_GROUPS already has a 'side' entry on this
-- branch (keywords: 'side', 'sides') -- 0065's trigger only ever checked
-- drink/protein/snack, so a 'side' offer counted as OFFERED but could
-- never count as ACCEPTED (no keyword branch matched it), undercounting
-- era-demo's real success rate. Adds the missing branch, same shape as
-- the other three, idempotent (create or replace) like every other
-- version of this function.
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
              or (offered_key = 'side' and (p.category ilike '%side%'))
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
