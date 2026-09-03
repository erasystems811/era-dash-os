// Own-riders dispatch: turns a "ready" order into a broadcast delivery_offer
// every on-duty rider's phone alarms for, and the timeout escalation that
// follows one nobody accepts (spec B4). Never guesses, never silently drops
// -- an offer nobody accepts becomes visible to a human, not a mystery.
import { randomBytes } from 'node:crypto';
import { pool } from '../lib/db.js';
import * as botEngine from '../bot-engine/index.js';
import { sendWhatsApp } from './whatsapp-send.js';
import { handoverRecipients, notifyDeliverySearching } from './flow.js';
import { getDeliveryConfig } from './delivery-zones.js';
import { resolveSource } from './delivery.js';
import { offerBus } from './offer-bus.js';
import { pushOfferToOnDutyRiders, pushReminderToRider } from './push-notify.js';

// Called from routes/api.js's /orders/:id/status the moment staff marks an
// order 'ready' -- "order reaches READY" is the addon spec's own trigger
// (B4), a kitchen decision, deliberately not tied to payment completing
// (see flow.js's completePayment comment on why those are different facts).
// A no-op for anything that isn't a delivery order on own_riders mode, and
// idempotent -- calling this twice for the same order (a staff double
// click, a retried request) never creates a second offer.
export async function maybeDispatchOwnRiders(orderId) {
  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = orderRows[0];
  if (!order || order.fulfilment_type !== 'delivery') return;

  const deliveryConfig = await getDeliveryConfig();
  if (deliveryConfig.mode !== 'own_riders') return;

  const { rows: existing } = await pool.query(
    `select 1 from delivery_offer where order_id = $1 and status not in ('CANCELLED')`,
    [orderId]
  );
  if (existing.length) return;

  if (!order.delivery_zone_id) {
    // Should not normally happen -- handleCollectFulfilment (engine/flow.js)
    // requires a resolved zone before payment. Only reachable if own_riders
    // was switched on mid-conversation, after this order already picked a
    // different provider's path. Logged, not silently ignored (spec 0.4) --
    // staff can still see and handle the order manually from the dashboard,
    // this only means it never gets an automatic rider offer.
    console.error(`Order ${order.reference} is ready for own_riders delivery but has no resolved delivery_zone_id -- skipping automatic dispatch.`);
    return;
  }

  const { rows: zoneRows } = await pool.query('select * from delivery_zone where id = $1', [order.delivery_zone_id]);
  const zone = zoneRows[0];
  if (!zone) return;

  const business = await resolveSource(order);

  // Generated here, not at accept time -- a Chowdeck-style stage tracker
  // (Chidera's call) needs no real coordinates the way a live-location
  // link would have, so there's no reason to make the customer wait for a
  // rider to accept before they get a real link to open.
  const trackingToken = randomBytes(18).toString('base64url');

  const { rows } = await pool.query(
    `insert into delivery_offer (order_id, branch_id, zone_id, tracking_token) values ($1, $2, $3, $4) returning *`,
    [order.id, order.branch_id, zone.id, trackingToken]
  );
  const offer = rows[0];

  broadcastOffer(offer, { zoneName: zone.name, payout: zone.rider_payout, pickupName: business.name, pickupAddress: business.address, reference: order.reference });

  // Fire-and-forget, same reasoning as every other post-commit customer
  // notification in this add-on -- a WhatsApp hiccup here must never turn
  // into a failed dispatch.
  notifyDeliverySearching(order.id, `/track/${trackingToken}`).catch((err) => console.error(`Failed to notify customer of dispatch for order ${order.id}:`, err));
}

function broadcastOffer(offer, details, { urgent = false } = {}) {
  offerBus.emit('offer', {
    id: offer.id,
    branchId: offer.branch_id,
    zoneName: details.zoneName,
    payout: details.payout,
    pickupName: details.pickupName,
    pickupAddress: details.pickupAddress,
    reference: details.reference,
    urgent,
  });
  // Fire and forget -- a push provider hiccup must never delay or fail the
  // dispatch itself. The SSE alarm above already reached anyone with the
  // app open; this is what reaches everyone else (Chidera's report: "there
  // wasnt any actual ring on my phone" -- the in-page alarm alone can't
  // ring a locked/backgrounded phone, only a real OS push can).
  pushOfferToOnDutyRiders(offer, details).catch((err) => console.error('pushOfferToOnDutyRiders failed:', err.message));
}

// Run on an interval from server.js (see the addon's B4: no acceptance
// within offer_timeout_seconds, re-broadcast marked urgent; another
// offer_timeout_seconds, alert staff). A cheap single-row read when
// mode !== 'own_riders' or nothing is OPEN, same "genuinely inert until
// switched on" shape as flow.js's own closeStaleOrders sweep.
export async function sweepOfferEscalation() {
  const deliveryConfig = await getDeliveryConfig();
  if (deliveryConfig.mode !== 'own_riders') return;

  const timeoutSeconds = deliveryConfig.offer_timeout_seconds || 90;

  const { rows: toEscalate } = await pool.query(
    `select o.*, z.name as zone_name, z.rider_payout
     from delivery_offer o join delivery_zone z on z.id = o.zone_id
     where o.status = 'OPEN' and o.escalated_at is null
       and o.broadcast_at < now() - make_interval(secs => $1)`,
    [timeoutSeconds]
  );
  for (const offer of toEscalate) {
    await pool.query('update delivery_offer set escalated_at = now() where id = $1', [offer.id]);
    const { rows: orderRows } = await pool.query('select reference, branch_id from "order" where id = $1', [offer.order_id]);
    const { rows: bizRows } = await pool.query(
      offer.branch_id ? 'select name, address from branch where id = $1' : 'select name, address from business limit 1',
      offer.branch_id ? [offer.branch_id] : []
    );
    const business = bizRows[0] || {};
    broadcastOffer(offer, { zoneName: offer.zone_name, payout: offer.rider_payout, pickupName: business.name, pickupAddress: business.address, reference: orderRows[0]?.reference }, { urgent: true });
  }

  const { rows: toAlertStaff } = await pool.query(
    `select o.*, z.name as zone_name from delivery_offer o join delivery_zone z on z.id = o.zone_id
     where o.status = 'OPEN' and o.staff_alerted_at is null
       and o.broadcast_at < now() - make_interval(secs => $1)`,
    [timeoutSeconds * 2]
  );
  for (const offer of toAlertStaff) {
    await pool.query('update delivery_offer set staff_alerted_at = now() where id = $1', [offer.id]);
    const { rows: orderRows } = await pool.query('select reference from "order" where id = $1', [offer.order_id]);
    const recipients = await handoverRecipients();
    const text = `No rider has accepted the delivery for order ${orderRows[0]?.reference || offer.order_id} (${offer.zone_name}) after ${(timeoutSeconds * 2) / 60} minutes. Please call a rider directly.`;
    for (const to of recipients) {
      try {
        await botEngine.sendMessage({ trigger: 'staff_handoff_intro', to, text, whatsappSend: sendWhatsApp });
      } catch (err) {
        console.error(`Failed to alert ${to} about unaccepted delivery offer ${offer.id}:`, err);
      }
    }
  }
}

// Staff's manual "Ring rider" button on a Ready-stage order (Chidera's
// ask, 2026-09-03, right after "it didnt even ring atall" -- a real push
// can still get lost to a battery-killed browser, and staff shouldn't
// have to wait out sweepOfferEscalation's own timeout for a second try).
// Branches on the offer's real status rather than assuming one shape:
// nobody's accepted yet -> re-broadcast to every on-duty rider, exactly
// like the automatic timeout escalation above; someone already accepted
// -> a direct reminder to that one rider specifically, never a broadcast
// that would wrongly imply the job is still up for grabs.
export async function manuallyRingForRider(orderId) {
  const { rows: offerRows } = await pool.query(
    `select o.*, z.name as zone_name, z.rider_payout
     from delivery_offer o join delivery_zone z on z.id = o.zone_id
     where o.order_id = $1 and o.status in ('OPEN', 'CLAIMED')
     order by o.broadcast_at desc limit 1`,
    [orderId]
  );
  const offer = offerRows[0];
  if (!offer) throw new Error('No rider offer exists for this order -- it may not have dispatched yet, or the offer expired.');

  const { rows: orderRows } = await pool.query('select reference, branch_id from "order" where id = $1', [orderId]);
  const order = orderRows[0];

  if (offer.status === 'OPEN') {
    const { rows: bizRows } = await pool.query(
      offer.branch_id ? 'select name, address from branch where id = $1' : 'select name, address from business limit 1',
      offer.branch_id ? [offer.branch_id] : []
    );
    const business = bizRows[0] || {};
    broadcastOffer(offer, { zoneName: offer.zone_name, payout: offer.rider_payout, pickupName: business.name, pickupAddress: business.address, reference: order?.reference }, { urgent: true });
    return { mode: 'broadcast' };
  }

  // CLAIMED -- someone already has it, so this is a direct nudge, not a
  // second offer to the whole fleet.
  const { rows: assignmentRows } = await pool.query(
    `select da.rider_id, r.name as rider_name
     from delivery_assignment da join rider r on r.id = da.rider_id
     where da.offer_id = $1`,
    [offer.id]
  );
  const assignment = assignmentRows[0];
  if (!assignment) throw new Error('This offer was accepted but the assignment record is missing -- check the order manually.');

  const delivered = await pushReminderToRider(assignment.rider_id, {
    title: 'Reminder: pick up this order',
    body: `Order ${order?.reference || orderId} (${offer.zone_name}) is waiting for pickup.`,
  });
  return { mode: 'reminder', riderName: assignment.rider_name, delivered };
}
