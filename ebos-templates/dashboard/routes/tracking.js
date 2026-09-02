// The customer's own delivery tracking page -- own_riders mode only. Public,
// no login (a customer opens this straight from the WhatsApp message
// engine/flow.js's notifyDeliveryAssigned sends), same trust boundary as
// routes/documents.js's invoice/receipt pages. Server-rendered plain HTML
// on purpose, matching that same file's style -- this is a read-only page
// with no client state machine to justify a React bundle for it.
import express from 'express';
import { pool } from '../lib/db.js';
import { esc } from '../lib/render.js';

export const router = express.Router();

const STATUS_LABEL = {
  ASSIGNED: 'Rider assigned, heading to pick up your order',
  PICKED_UP: 'Your order is on the way',
  ARRIVED: 'Your rider has arrived',
  DELIVERED: 'Delivered',
  FAILED: 'Delivery could not be completed',
};

// Spec B6: link expires 2 hours after delivery -- not before, since an
// in-progress delivery has no natural expiry of its own.
const EXPIRY_HOURS = 2;

router.get('/:token', async (req, res) => {
  const { rows } = await pool.query(
    `select a.*, r.name as rider_name, r.phone as rider_phone, r.last_lat, r.last_lng, r.last_seen_at,
            o.reference, z.name as zone_name
     from delivery_assignment a
     join rider r on r.id = a.rider_id
     join delivery_offer off on off.id = a.offer_id
     join delivery_zone z on z.id = off.zone_id
     join "order" o on o.id = a.order_id
     where a.tracking_token = $1`,
    [req.params.token]
  );
  const row = rows[0];
  if (!row) return res.status(404).send('Not found.');

  const expired = row.delivered_at && new Date(row.delivered_at).getTime() < Date.now() - EXPIRY_HOURS * 60 * 60 * 1000;

  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tracking ${esc(row.reference)}</title>
${expired ? '' : '<meta http-equiv="refresh" content="20">'}
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 2.5rem auto; padding: 0 1.25rem; color: #111827; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .status { font-size: 17px; font-weight: 600; margin: 18px 0; padding: 14px 16px; border-radius: 10px; background: #eff6ff; color: #1d4ed8; }
  .status.delivered { background: #f0fdf4; color: #15803d; }
  .status.failed { background: #fef2f2; color: #b91c1c; }
  .rider { display: flex; align-items: center; gap: 12px; padding: 14px 0; border-top: 1px solid #e5e7eb; border-bottom: 1px solid #e5e7eb; }
  .rider .avatar { width: 44px; height: 44px; border-radius: 50%; background: #111827; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 18px; }
  .rider a { color: inherit; }
  .updated { color: #6b7280; font-size: 13px; margin-top: 16px; }
  .expired { color: #6b7280; text-align: center; margin-top: 60px; }
</style></head>
<body>
${
  expired
    ? `<div class="expired">This tracking link has expired.</div>`
    : `
  <h1>Order ${esc(row.reference)} &middot; ${esc(row.zone_name)}</h1>
  <div class="status ${row.status === 'DELIVERED' ? 'delivered' : row.status === 'FAILED' ? 'failed' : ''}">${esc(STATUS_LABEL[row.status] || row.status)}</div>
  <div class="rider">
    <div class="avatar">${esc((row.rider_name || '?')[0])}</div>
    <div>
      <div><strong>${esc((row.rider_name || 'Your rider').split(' ')[0])}</strong></div>
      <div><a href="tel:${esc(row.rider_phone)}">${esc(row.rider_phone)}</a></div>
    </div>
  </div>
  ${
    row.last_lat && row.last_lng
      ? `<p><a href="https://www.google.com/maps/search/?api=1&query=${row.last_lat},${row.last_lng}" target="_blank" rel="noreferrer">View current location</a></p>`
      : `<p style="color:#6b7280;">Waiting for the rider's next location update.</p>`
  }
  <div class="updated">${row.last_seen_at ? `Last updated ${new Date(row.last_seen_at).toLocaleTimeString()}` : ''}</div>
  `
}
</body></html>`);
});
