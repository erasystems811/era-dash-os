-- Chidera, 2026-09-17: "i give them 1500 free every month then they cover
-- the rest by putting money in an account and i extract it from there if
-- not it wont go" -- Meta itself gives no self-service spending cap for
-- WhatsApp messaging (checked live), so this is ERA's own prepaid wallet,
-- enforced in code (engine/wallet.js), not something Meta provides.
--
-- Deliberately off by default (enabled=false) and built well ahead of
-- being turned on for anyone real -- Chidera's own explicit call,
-- 2026-09-17, after being burned once already today by a cost-cutting
-- change that shipped before it was fully proven: "build it first, roll
-- out later."
--
-- balance_kobo/rate_kobo_per_message: kobo (integer), not naira (numeric),
-- so a per-message deduction is always an exact integer subtraction --
-- never a float rounding error compounding over thousands of messages.
create table if not exists message_wallet (
  business_id uuid primary key references business(id),
  enabled boolean not null default false,
  balance_kobo bigint not null default 0,
  rate_kobo_per_message integer not null default 1400,
  free_messages_per_month integer not null default 1500,
  -- 'YYYY-MM' of the month free_messages_this_month currently counts --
  -- engine/wallet.js resets the counter itself the first time a new
  -- month's send comes through, rather than needing a cron job.
  free_reset_month text not null default to_char(now(), 'YYYY-MM'),
  free_messages_this_month integer not null default 0
);
