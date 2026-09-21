alter table order_payment add column if not exists payment_reference text;
alter table order_payment add column if not exists payment_link_url text;
