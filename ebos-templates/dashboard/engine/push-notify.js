// Real Web Push for the rider PWA -- delivered by the browser's own push
// service (not this app's own JS), so it can ring/vibrate a rider's phone
// even with the screen off or the app backgrounded, unlike the in-page
// alarm engine/offer-bus.js's SSE stream drives (which only ever runs
// while that page is actually open and executing).
//
// VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are ERA-wide, shared across every
// EBOS deployment (see secrets.env.example) -- not a per-business secret
// the way PAYMENT_ENCRYPTION_KEY is. If a push send fails because a
// subscription is gone (the rider uninstalled, cleared site data, or
// switched browsers), that's expected and routine, not an error worth
// logging loudly -- the next time they open the app and it re-subscribes,
// a fresh subscription replaces the dead one.
import webpush from 'web-push';
import { pool } from '../lib/db.js';

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails('mailto:ops@erasystems.com.ng', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

// One push per on-duty rider with a saved subscription, in the same
// branch-or-unassigned scope the SSE broadcast already uses (spec B3: a
// rider only ever sees offers from their own branch). Never blocks or
// throws the caller over one dead subscription -- a delivery still has to
// dispatch even if pushing to every rider isn't 100% reliable this second.
export async function pushOfferToOnDutyRiders(offer, details) {
  if (!ensureConfigured()) return; // not set up on this deployment yet -- SSE alarm still works for anyone with the app open

  const { rows: riders } = await pool.query(
    `select id, push_subscription from rider
     where status = 'on_duty' and push_subscription is not null
       and ($1::uuid is null or branch_id = $1 or branch_id is null)`,
    [offer.branch_id]
  );

  const payload = JSON.stringify({
    title: 'New delivery offer',
    body: `${details.zoneName} · ₦${Number(details.payout).toLocaleString()}`,
    offerId: offer.id,
  });

  await Promise.all(
    riders.map(async (rider) => {
      try {
        await webpush.sendNotification(rider.push_subscription, payload);
      } catch (err) {
        // 404/410 means the push service itself says this subscription is
        // gone for good -- clear it so this rider stops being queried every
        // broadcast for a subscription that will never work again. Any
        // other error (network blip, push service hiccup) is left alone;
        // it might just work next time.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('update rider set push_subscription = null where id = $1', [rider.id]);
        } else {
          console.error(`Push to rider ${rider.id} failed:`, err.message);
        }
      }
    })
  );
}
