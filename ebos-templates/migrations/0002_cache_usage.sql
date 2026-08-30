-- Adds cache-token columns to ai_usage so real spend can be computed
-- correctly once prompt caching is in use (a cache write/read is priced
-- differently from a normal input token -- see lib/ai-pricing.js). Additive
-- only, safe against a live database with existing ai_usage rows (defaults
-- to 0, which is the correct historical value for every call logged before
-- caching existed).
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0002_cache_usage.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0002_cache_usage.sql
alter table ai_usage add column if not exists cache_creation_input_tokens integer not null default 0;
alter table ai_usage add column if not exists cache_read_input_tokens integer not null default 0;
