alter table pos_sync_config add column if not exists terminal_serial text;
alter table order_payment add column if not exists dynamic_account_number text;
alter table order_payment add column if not exists dynamic_account_name text;
alter table order_payment add column if not exists dynamic_account_expires_at timestamptz;
