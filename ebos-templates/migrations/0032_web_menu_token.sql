-- The real web menu page (engine/menu-page-template.js, per Chidera
-- 2026-09-10: "the menu is meant to be like a site... not just in dine in
-- the normal conversation flow") now also backs the REGULAR (non-dine-in)
-- ordering flow -- "Place an order" and "what do you have" both open this
-- instead of the old WhatsApp native list message. menu_token is how
-- routes/menu-page.js's public /m/:token resolves back to a real customer
-- with no login, same idea as restaurant_table.qr_token for a table.
alter table customers add column if not exists menu_token text;
create unique index if not exists customers_menu_token_idx on customers (menu_token) where menu_token is not null;
