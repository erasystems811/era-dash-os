-- Customer database (CRM) add-on -- Chidera, 2026-09-16: a client wants a
-- customer profile dashboard (spend, birthdays, export), toggleable per
-- business. `enabled` starts false, same "ERA switches these, not the
-- client" shape as delivery_config/voice_config/dinein_config.
create table if not exists crm_config (
  business_id uuid primary key references business(id),
  enabled boolean not null default false
);

-- Nullable -- most customers won't have one yet. Filled in via the
-- "what's their birthday?" popup on an order's own page for a customer
-- who doesn't have one on file, not collected up front.
alter table customers add column if not exists birthday date;
