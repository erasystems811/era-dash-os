-- Chidera, 2026-09-17: "not every restaurant needs it, let it be a toogle
-- on or off capability" -- the birthday popup (menu-page-template.js, the
-- customer's own web menu) used to be tied straight to the CRM add-on's
-- own on/off switch, with no separate control. Defaults true so a
-- business that already has CRM on keeps behaving exactly as it does
-- today; only a business that explicitly wants it off needs to flip it.
alter table crm_config add column if not exists birthday_prompt_enabled boolean not null default true;
