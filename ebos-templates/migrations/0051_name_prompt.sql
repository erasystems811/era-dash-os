-- Chidera, 2026-09-20: "we agreed a name so bot can refer to customer" --
-- same pattern as birthday_prompt_enabled (migration 0047): a business
-- toggle, not tied unconditionally to the CRM add-on's own on/off switch.
-- Defaults true so a business with CRM already on keeps behaving exactly
-- as it does today; only one that explicitly wants it off needs to flip it.
alter table crm_config add column if not exists name_prompt_enabled boolean not null default true;
