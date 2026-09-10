create unique index if not exists restaurant_table_branch_label_active_idx
  on restaurant_table (branch_id, lower(label)) where status = 'active';
