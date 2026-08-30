-- Tracks real Claude call FAILURES (not usage/cost -- see ai_usage), so a
-- monitoring check can tell "Claude API is having trouble right now" apart
-- from "nobody's messaged in a while" using only a plain HTTPS request --
-- no SSH/server access needed. Additive, safe on a live database.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0003_ai_errors.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0003_ai_errors.sql
create table if not exists ai_errors (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists ai_errors_created_at_idx on ai_errors (created_at);
