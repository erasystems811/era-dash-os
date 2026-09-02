// The customer's own delivery tracking page -- own_riders mode only. Public,
// no login, same trust boundary as routes/documents.js's invoice/receipt
// pages. Server-rendered plain HTML, matching that same file's style.
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
import { esc } from '../lib/render.js';

export const router = express.Router();

const STAGES = [
  { key: 'waiting', label: 'Waiting for a rider to accept your order' },
  { key: 'accepted', label: 'Rider accepted your order' },
  { key: 'picked_up', label: 'Rider picked up your order, on the way' },
  { key: 'arrived', label: 'Your rider is here!' },
  { key: 'delivered', label: 'Delivered' },
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

router.get('/:token', async (req, res) => {
  const { rows } = await pool.query(
    `select o.status as offer_status, a.status as assignment_status, a.delivered_at,
            r.name as rider_name, r.phone as rider_phone,
            ord.reference, z.name as zone_name
     from delivery_offer o
     join delivery_zone z on z.id = o.zone_id
     join "order" ord on ord.id = o.order_id
     left join delivery_assignment a on a.offer_id = o.id
     left join rider r on r.id = a.rider_id
     where o.tracking_token = $1`,
    [req.params.token]
  );
  const row = rows[0];
  if (!row) return res.status(404).send('Not found.');

  const expired = row.delivered_at && new Date(row.delivered_at).getTime() < Date.now() - EXPIRY_HOURS * 60 * 60 * 1000;
  const failed = row.assignment_status === 'FAILED' || row.offer_status === 'CANCELLED' || row.offer_status === 'EXPIRED';
  const stageIndex = currentStageIndex(row);

  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tracking ${esc(row.reference)}</title>
${expired || failed ? '' : '<meta http-equiv="refresh" content="20">'}
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 2.5rem auto; padding: 0 1.25rem; color: #111827; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .rider { display: flex; align-items: center; gap: 12px; padding: 14px 0; margin-top: 18px; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; }
  .rider .avatar { width: 44px; height: 44px; border-radius: 50%; background: #111827; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; }
  .rider a { color: inherit; }
  .stages { list-style: none; margin: 22px 0; padding: 0; }
  .stages li { display: flex; align-items: center; gap: 12px; padding: 10px 0; color: #9ca3af; }
  .stages li.done { color: #111827; }
  .stages li.current { color: #1d4ed8; font-weight: 700; }
  .dot { width: 22px; height: 22px; border-radius: 50%; border: 2px solid #d1d5db; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 13px; }
  .stages li.done .dot { border-color: #111827; background: #111827; color: #fff; }
  .stages li.current .dot { border-color: #1d4ed8; background: #1d4ed8; color: #fff; }
  .expired, .failed-msg { color: #6b7280; text-align: center; margin-top: 60px; }
</style></head>
<body>
${
  expired
    ? `<div class="expired">This tracking link has expired.</div>`
    : failed
      ? `<h1>Order ${esc(row.reference)}</h1><div class="failed-msg">This delivery could not be completed. Please contact us.</div>`
      : `
  <h1>Order ${esc(row.reference)} &middot; ${esc(row.zone_name)}</h1>
  <ul class="stages">
    ${STAGES.map(
      (s, i) => `<li class="${i < stageIndex ? 'done' : i === stageIndex ? 'current' : ''}"><span class="dot">${i < stageIndex ? '✓' : i + 1}</span> ${esc(s.label)}</li>`
    ).join('')}
  </ul>
  ${
    row.rider_name
      ? `<div class="rider">
    <div class="avatar">${esc(row.rider_name[0])}</div>
    <div>
      <div><strong>${esc(row.rider_name.split(' ')[0])}</strong></div>
      <div><a href="tel:${esc(row.rider_phone)}">${esc(row.rider_phone)}</a></div>
    </div>
  </div>`
      : ''
  }
  `
}
</body></html>`);
});
