-- Menu bulk-import now stages proposed changes instead of writing straight
-- to the live catalogue (routes/api.js's /catalogue/bulk-import), and the
-- bot can forward the business's actual menu photo(s) to a customer instead
-- of listing every item as text once a catalogue gets large. See
-- schema.sql's product/menu_photo comments for the full reasoning.
-- Additive and idempotent, safe against a live database.
--
-- Apply to a live business with:
--   node scripts/migrate.mjs --client=slug --file=ebos-templates/migrations/0004_menu_photo_and_import.sql
--   node scripts/migrate.mjs --all-ebos --file=ebos-templates/migrations/0004_menu_photo_and_import.sql
alter table product add column if not exists import_status text check (import_status in ('new', 'changed', 'removed'));
alter table product add column if not exists pending_name text;
alter table product add column if not exists pending_description text;
alter table product add column if not exists pending_price numeric(12, 2);

create table if not exists menu_photo (
  id uuid primary key default gen_random_uuid(),
  data_url text not null,
  position integer not null default 0,
  created_at timestamptz not null default now()
);
