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

// Shared by both the broadcast (every on-duty rider) and the single-rider
// reminder below -- same send call, same cleanup-on-dead-subscription
// logic, one place to get it right. Never throws -- a delivery still has
// to dispatch (or a manual "ring" still has to return something to staff)
// even if pushing to one particular rider isn't 100% reliable this second.
async function pushToRider(rider, payload) {
  try {
    // 'high' urgency (Chidera's report, 2026-09-03: "when a rider ... is
    // sleeping the phone alarm doesnt ring") -- Android's Doze mode
    // normally holds a push until the next maintenance window once the
    // screen's been off a while; FCM (what Chrome's push service runs on)
    // treats a high-urgency message as allowed to wake the device
    // immediately instead of waiting. Real ceiling, not fixed by this:
    // some phones (Xiaomi/Tecno/Infinix/Samsung's own extra battery
    // managers on top of stock Android) can still kill Chrome's
    // background process regardless of urgency unless the rider explicitly
    // allows it unrestricted battery/autostart access for their browser --
    // a device setting only the rider can change, same ceiling as the
    // notification SOUND length fix already hit.
    await webpush.sendNotification(rider.push_subscription, payload, { urgency: 'high' });
  } catch (err) {
    // 404/410 means the push service itself says this subscription is
    // gone for good -- clear it so this rider stops being queried every
    // broadcast for a subscription that will never work again. Any other
    // error (network blip, push service hiccup) is left alone; it might
    // just work next time.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await pool.query('update rider set push_subscription = null where id = $1', [rider.id]);
    } else {
      console.error(`Push to rider ${rider.id} failed:`, err.message);
    }
  }
}

// Staff PWA push -- Chidera, 2026-09-23: "make the dashboard pwa so staff
// can get push notification or something," aimed at replacing real
// WhatsApp staff alerts (sendStaffAlert, flow.js) with a free push once a
// staff member has actually installed/subscribed. Same shape as
// pushToRider above, same ERA-wide VAPID keys, own table/cleanup column
// (staff.push_subscription) since a staff member and a rider are
// different accounts entirely.
async function pushToStaffMember(staff, payload) {
  try {
    await webpush.sendNotification(staff.push_subscription, payload, { urgency: 'high' });
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await pool.query('update staff set push_subscription = null where id = $1', [staff.id]);
    } else {
      console.error(`Push to staff ${staff.id} failed:`, err.message);
    }
    return false;
  }
}

// Called from every real-alert call site (flow.js's sendStaffAlert callers)
// BEFORE falling back to a real WhatsApp send -- returns whether a push was
// actually delivered, so the caller knows whether it still needs to fall
// back. false covers every "this staff member hasn't set up push yet" case
// the same way (no VAPID configured on this deployment, no subscription
// saved, or the one saved subscription turned out to be dead) -- the
// caller doesn't need to tell those apart, just whether the alert got
// through some free channel or still needs the real one.
export async function pushToStaff(staffId, { title, body, url }) {
  if (!ensureConfigured() || !staffId) return false;
  const { rows } = await pool.query('select id, push_subscription from staff where id = $1 and push_subscription is not null', [staffId]);
  if (!rows[0]) return false;
  return pushToStaffMember(rows[0], JSON.stringify({ title, body, url }));
}

// One push per on-duty rider with a saved subscription, in the same
// branch-or-unassigned scope the SSE broadcast already uses (spec B3: a
// rider only ever sees offers from their own branch).
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

  await Promise.all(riders.map((rider) => pushToRider(rider, payload)));
}

// Staff's manual "Ring rider" button (Chidera's ask, 2026-09-03) -- a
// direct nudge to one specific rider (the one who already accepted this
// delivery, per engine/delivery-dispatch.js's manuallyRingForRider), for
// the case a real push genuinely got lost (a device battery-killed Chrome,
// a dropped connection) and staff don't want to wait for anything
// automatic. Returns whether a push was actually attempted, not just
// "the function ran," so the route can tell staff the truth if this
// rider never had a working subscription to begin with.
export async function pushReminderToRider(riderId, { title, body }) {
  if (!ensureConfigured()) return false;
  const { rows } = await pool.query('select id, push_subscription from rider where id = $1 and push_subscription is not null', [riderId]);
  if (!rows[0]) return false;
  await pushToRider(rows[0], JSON.stringify({ title, body }));
  return true;
}
