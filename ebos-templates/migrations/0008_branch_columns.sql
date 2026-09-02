-- Stage 0 of real multi-branch support (see the branch addendum). Adds the
-- real branch columns (contact/hours/status/credentials-anchor) and
-- business.sharing_mode, plus a nullable branch_id on product and customers
-- -- the two tables whose scope depends on sharing_mode. Purely additive:
-- no application code reads any of these columns yet, so this is safe
-- against a live database with zero behavior change.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0008_branch_columns.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0008_branch_columns.sql
alter table branch add column if not exists business_id uuid references business(id);
alter table branch add column if not exists area text;
alter table branch add column if not exists whatsapp_number text;
alter table branch add column if not exists instagram_handle text;
alter table branch add column if not exists opening_hours jsonb;
alter table branch add column if not exists timezone text not null default 'Africa/Lagos';
alter table branch add column if not exists status text not null default 'active' check (status in ('active', 'paused', 'closed'));
alter table branch add column if not exists is_primary boolean not null default false;

alter table business add column if not exists sharing_mode text not null default 'independent' check (sharing_mode in ('independent', 'merged'));

alter table product add column if not exists branch_id uuid references branch(id);
alter table customers add column if not exists branch_id uuid references branch(id);

-- Backfill, only meaningful where a branch row already exists (most
-- deployments today have zero, per branch's original "optional" design).
update branch set business_id = (select id from business limit 1) where business_id is null;

-- Mark the oldest branch primary when a business has branches but none is
-- flagged yet -- covers every existing single-branch deployment (there's
-- only ever been one branch row to pick) without guessing on a business
-- that somehow already has several.
update branch b set is_primary = true
where b.id = (select id from branch order by created_at asc limit 1)
  and not exists (select 1 from branch where is_primary = true);

-- product/customers stay unscoped (branch_id null) for a business with zero
-- branch rows -- the menu/customer resolver (Stage 4) treats "no branches"
-- the same way missingFieldsForOrder already does today: no scoping at all.
-- Any business that already has branch rows gets every existing (until now
-- unscoped) product/customer backfilled to the primary branch -- a real
-- decision, not a technicality: it means "everything that already exists
-- belongs to the primary branch" is the assumed starting point for a
-- pre-existing multi-branch business's menu/customer split under
-- `independent` mode, until someone reassigns items via the dashboard. This
-- keeps the resolver's `independent` case (branch_id = current_branch)
-- correct unconditionally from day one, with no null-check special case.
update product set branch_id = (select id from branch where is_primary limit 1)
where branch_id is null and exists (select 1 from branch);
update customers set branch_id = (select id from branch where is_primary limit 1)
where branch_id is null and exists (select 1 from branch);
