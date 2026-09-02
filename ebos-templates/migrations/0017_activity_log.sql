-- Records every "major action" a staff member takes (order status changes,
-- marking an order ready, confirming payment, sending a message, taking a
-- conversation from the bot or giving it back) so a branch manager and the
-- general manager both have an accountability trail. See lib/auth.js's
-- logActivity and its call sites in routes/api.js.
--
-- branch_id is copied at write time, not re-derived by joining staff, so a
-- later branch reassignment never rewrites history -- the same "copy, don't
-- re-resolve" idiom already used for rider_payout.amount and
-- delivery_assignment's zone rate.
--
-- New table, nothing reads or writes it until the routes that call
-- logActivity ship -- safe to apply to a live business well ahead of that.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0017_activity_log.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0017_activity_log.sql
create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id),
  branch_id uuid references branch(id),
  action text not null,
  entity_type text,
  entity_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_branch_created_idx on activity_log (branch_id, created_at desc);
create index if not exists activity_log_staff_created_idx on activity_log (staff_id, created_at desc);
