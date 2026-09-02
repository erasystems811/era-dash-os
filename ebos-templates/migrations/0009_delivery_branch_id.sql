-- Stage 2 of real multi-branch support: delivery is always per-branch, in
-- both sharing modes (operations never merge, only menu/customers can).
-- Deliberately NOT touching order_item here -- it's reachable via
-- order_item.order_id -> order.branch_id already, so denormalizing
-- branch_id onto it would mean editing every order-item insert site inside
-- engine/flow.js's conversational logic for no real gain. delivery.js has
-- no such coupling, so this one is safe and actually useful (per-branch
-- "riders on duty" reporting, addendum section 7).
--
-- Nullable only until code populating it on every new delivery ships and is
-- confirmed live -- do not add a NOT NULL constraint in the same migration
-- as the column (see 0010_delivery_branch_id_notnull.sql).
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0009_delivery_branch_id.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0009_delivery_branch_id.sql
alter table delivery add column if not exists branch_id uuid references branch(id);

update delivery d set branch_id = o.branch_id
from "order" o where d.order_id = o.id and d.branch_id is null and o.branch_id is not null;

update delivery d set branch_id = b.branch_id
from booking b where d.booking_id = b.id and d.branch_id is null and b.branch_id is not null;
