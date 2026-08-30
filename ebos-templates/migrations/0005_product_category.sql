-- Carries the menu's own sections (Drinks, Rice, Proteins, ...) through
-- bulk import, so the Catalogue page can group a large catalogue by
-- section instead of one flat list -- see schema.sql's comment on
-- product.category for the full reasoning.
-- Additive and idempotent, safe against a live database.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0005_product_category.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0005_product_category.sql
alter table product add column if not exists category text;
alter table product add column if not exists pending_category text;
