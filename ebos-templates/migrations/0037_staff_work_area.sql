alter table staff add column if not exists work_area text check (work_area in ('online', 'in_house'));
