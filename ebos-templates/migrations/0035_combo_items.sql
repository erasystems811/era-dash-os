alter table product add column if not exists is_combo boolean not null default false;

create table if not exists product_combo_item (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references product(id) on delete cascade,
  component_product_id uuid not null references product(id),
  quantity integer not null default 1
);
create index if not exists product_combo_item_product_idx on product_combo_item (product_id);
