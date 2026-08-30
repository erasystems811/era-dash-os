-- Adds per-call Claude token usage logging so real AI cost can be computed
-- per business. Additive only (safe to run against a live database with
-- existing data) -- new businesses provisioned after this migration was
-- added get the same table straight from schema.sql, so this file only
-- matters for businesses that already existed before it.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0001_ai_usage.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0001_ai_usage.sql
create table if not exists ai_usage (
  id uuid primary key default gen_random_uuid(),
  model text not null,
  input_tokens integer not null,
  output_tokens integer not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_created_at_idx on ai_usage (created_at);
