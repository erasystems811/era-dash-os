-- One-tap login for a staff handover alert sent over WhatsApp -- lets
-- tapping the conversation link in that alert sign the staff member in
-- automatically, no separate dashboard login, no leaving WhatsApp first.
-- Only the token's sha256 hash is stored (same "a DB leak can't be turned
-- into a usable credential" property a password reset token needs); the
-- real token only ever exists in the URL sent to the staff member's phone.
create table if not exists staff_magic_link (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id) on delete cascade,
  token_hash text not null unique,
  redirect_path text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists staff_magic_link_staff_idx on staff_magic_link(staff_id);
