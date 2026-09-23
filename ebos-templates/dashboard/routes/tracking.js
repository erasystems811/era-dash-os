// The customer's own delivery tracking page -- own_riders mode only. Public,
// no login, same trust boundary as routes/documents.js's invoice/receipt
// pages. Styled as an in-app page now, not a plain server-rendered document
// -- Chidera 2026-09-11: "make that delivery tracking link be an in app web
// page too" (engine/tracking-page-template.js, same paper-background/
// app-shell treatment as the web menu page).
//
// A Chowdeck-style STAGE tracker (Chidera's call, 2026-09-02), not a live
// map -- "waiting for a rider" -> "rider accepted" -> "picked up" -> "rider
// is here" -> "delivered". Deliberately not a live-location link: nothing
// in this system geocodes a customer's typed address into real
// coordinates, so a map pin would oversell what's actually known (the
// earlier reason this link was paused entirely, 2026-09-01) -- a stage
// list has no such gap, since every stage here is a real, known fact.
//
// Looked up by delivery_offer.tracking_token (generated the moment the
// offer broadcasts, engine/delivery-dispatch.js -- before any rider has
// accepted, so the link works from the very first stage, not only once
// one does) with delivery_assignment LEFT JOINed in, since it may not
// exist yet.
import express from 'express';
import { pool } from '../lib/db.js';
import { renderTrackingPage } from '../engine/tracking-page-template.js';

export const router = express.Router();

const STAGES = [
  'Waiting for a rider to accept your order',
  'Rider accepted your order',
  'Rider picked up your order, on the way',
  'Your rider is here!',
  'Delivered',
];

// Maps the real, known state to one of the stages above -- never a guess,
// every branch here is a real column value.
function currentStageIndex(row) {
  if (!row.assignment_status) return 0; // offer OPEN, nobody's accepted yet
  switch (row.assignment_status) {
    case 'ASSIGNED':
      return 1;
    case 'PICKED_UP':
      return 2;
    case 'ARRIVED':
      return 3;
    case 'DELIVERED':
      return 4;
    default:
      return 0;
  }
}

// Spec B6: link expires 2 hours after delivery -- not before, since an
// in-progress delivery has no natural expiry of its own.
const EXPIRY_HOURS = 2;

async function loadTrackingStatus(token) {
  const { rows } = await pool.query(
    `select o.status as offer_status, a.status as assignment_status, a.delivered_at, a.delivery_code,
            r.name as rider_name, r.phone as rider_phone,
            ord.reference, z.name as zone_name, biz.name as business_name
     from delivery_offer o
     join delivery_zone z on z.id = o.zone_id
     join "order" ord on ord.id = o.order_id
     left join delivery_assignment a on a.offer_id = o.id
     left join rider r on r.id = a.rider_id
     cross join (select name from business limit 1) biz
     where o.tracking_token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;

  const expired = row.delivered_at && new Date(row.delivered_at).getTime() < Date.now() - EXPIRY_HOURS * 60 * 60 * 1000;
  const failed = row.assignment_status === 'FAILED' || row.offer_status === 'CANCELLED' || row.offer_status === 'EXPIRED';
  return {
    reference: row.reference,
    businessName: row.business_name || '',
    zoneName: row.zone_name,
    stageIndex: currentStageIndex(row),
    rider: row.rider_name ? { name: row.rider_name, phone: row.rider_phone } : null,
    // Chidera, 2026-09-23: "usually they send 2, one with normal link and
    // one to track ride... so now i need it to be 1, the code should be in
    // the link" -- notifyDeliveryAssigned (flow.js) used to be a SECOND
    // real WhatsApp message, sent purely to hand over this same code, the
    // instant a rider accepted. The tracking link already went out once,
    // at dispatch (notifyDeliverySearching), and this page already
    // live-polls its own status -- the code just needed to actually be on
    // the page once a rider's assigned, not a second message to reveal it.
    deliveryCode: row.delivery_code || null,
    expired: Boolean(expired),
    failed,
  };
}

router.get('/:token/status', async (req, res) => {
  const status = await loadTrackingStatus(req.params.token);
  if (!status) return res.status(404).json({ error: 'Not found.' });
  res.json(status);
});

router.get('/:token', async (req, res) => {
  const status = await loadTrackingStatus(req.params.token);
  if (!status) return res.status(404).send('Not found.');
  res.set('Content-Type', 'text/html').send(
    renderTrackingPage({
      reference: status.reference,
      businessName: status.businessName,
      zoneName: status.zoneName,
      stages: STAGES,
      stageIndex: status.stageIndex,
      rider: status.rider,
      deliveryCode: status.deliveryCode,
      expired: status.expired,
      failed: status.failed,
      statusPath: `/track/${req.params.token}/status`,
    })
  );
});
