-- Adds per-item product photos (needed for Meta's native WhatsApp
-- Catalogue -- every item there requires a real image) and the two fields
-- tracking that business's own catalog once it's created and connected on
-- Meta's side. Additive, safe against a live database.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0007_whatsapp_catalog.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0007_whatsapp_catalog.sql
alter table product add column if not exists image_data_url text;
alter table business add column if not exists whatsapp_catalog_id text;
-- Meta doesn't expose a public API to connect a catalog to a WhatsApp
-- number -- that's a one-time manual click in Meta Business Suite. This
-- just tracks whether that click has happened yet (same "flag it, let a
-- human confirm" pattern as client.dnsPending in ERA Dash OS).
alter table business add column if not exists whatsapp_catalog_connected boolean not null default false;
