-- Minimal starting schema for a new ERA client app.
-- Generic role/permission tags (not a fixed cast of roles) so this can grow
-- into whatever the client's real system needs, same pattern used in Bali.

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  phone_number text unique,
  name text,
  role text not null default 'customer',
  department text,
  created_at timestamptz not null default now()
);

create table if not exists app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
