-- Staff PWA + push notifications -- Chidera, 2026-09-23: "make the
-- dashboard pwa so staff can get push notification or something." Same
-- shape as rider.push_subscription (engine/push-notify.js), reusing the
-- ERA-wide VAPID keys already configured for the rider app -- no new
-- per-business secret needed. Real Web Push, delivered by the browser's
-- own push service, works even with the dashboard tab backgrounded.
alter table staff add column if not exists push_subscription jsonb;
