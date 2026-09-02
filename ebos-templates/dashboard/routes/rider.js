// The rider-facing API -- a phone number, a WhatsApp OTP, on/off duty, and
// (later stages) the offer/assignment lifecycle. Session-cookie
// authenticated, same mechanism as the staff dashboard (routes/api.js) but
// a wholly separate cookie/session, never mixed with a staff login -- a
// rider and a staff member are different kinds of account, and this app is
// mounted on its own path (/rider) precisely so the two sessions never
// collide (see server.js).
import express from 'express';
import { pool } from '../lib/db.js';
import { requestRiderOtp, verifyRiderOtp } from '../engine/rider-auth.js';
import { offerBus } from '../engine/offer-bus.js';
import { notifyDeliveryAssigned } from '../engine/flow.js';
import { getDeliveryConfig } from '../engine/delivery-zones.js';
import { sendPayout } from '../engine/payout-providers.js';
import { decrypt } from '../lib/crypto.js';

export const router = express.Router();

// A rider only ever sees offers from their own branch -- an offer or a
// rider with no branch (business has no branch rows, or this rider isn't
// locked to one) matches everyone, same "unassigned reaches everyone"
// idiom already used for unassigned products/customers (engine/fields.js's
// resolveMenu).
function offerMatchesBranch(offer, riderBranchId) {
  return !offer.branchId || !riderBranchId || offer.branchId === riderBranchId;
}

router.post('/otp/request', async (req, res) => {
  const phone = (req.body?.phone || '').trim();
  if (!phone) return res.status(400).json({ error: 'Phone number is required.' });
  await requestRiderOtp(phone);
  // Same response whether or not that phone is a real rider -- see
  // engine/rider-auth.js's own comment on why this never reveals a match.
  res.json({ ok: true });
});

router.post('/otp/verify', async (req, res) => {
  const phone = (req.body?.phone || '').trim();
  const code = (req.body?.code || '').trim();
  if (!phone || !code) return res.status(400).json({ error: 'Phone number and code are required.' });
  const rider = await verifyRiderOtp(phone, code);
  if (!rider) return res.status(401).json({ error: 'That code is incorrect or has expired.' });
  req.session.rider = { id: rider.id, name: rider.name, phone: rider.phone };
  res.json({ rider: req.session.rider });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

function requireRider(req, res, next) {
  if (!req.session?.rider) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

router.get('/me', (req, res) => {
  res.json({ rider: req.session?.rider || null });
});

router.get('/status', requireRider, async (req, res) => {
  const { rows } = await pool.query('select id, name, phone, status from rider where id = $1', [req.session.rider.id]);
  res.json(rows[0] || null);
});

router.post('/duty', requireRider, async (req, res) => {
  const status = req.body?.status;
  if (!['on_duty', 'off_duty'].includes(status)) return res.status(400).json({ error: 'status must be "on_duty" or "off_duty".' });
  const { rows } = await pool.query(
    `update rider set status = $1, last_seen_at = now() where id = $2 and status != 'suspended' returning id, name, phone, status`,
    [status, req.session.rider.id]
  );
  if (!rows[0]) return res.status(403).json({ error: 'This rider account has been suspended.' });
  res.json(rows[0]);
});

// Interval is entirely the rider-pwa client's own choice (spec B6: 15s
// during an active delivery, 60s on-duty idle, none off-duty) -- this
// endpoint just records whatever it's sent, it has no timer of its own.
// Only the latest position is kept (schema.sql's own comment on
// rider.last_lat/last_lng) -- no history table unless a real audit need
// for one turns up.
router.post('/location', requireRider, async (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng are required numbers.' });
  await pool.query('update rider set last_lat = $1, last_lng = $2, last_seen_at = now() where id = $3', [lat, lng, req.session.rider.id]);
  res.json({ ok: true });
});

// --- Delivery offers --------------------------------------------------

// A single long-lived connection, not a poll loop -- spec 0.3/B6 bans
// continuous cost passed to the rider, but a poll loop would either burn
// his data polling every few seconds or lose the "first accept wins" race
// by however long the poll interval is. SSE is near-zero idle bytes and
// delivers the instant an offer broadcasts; EventSource auto-reconnects on
// a dropped connection for free, and the immediate replay below (every
// still-OPEN offer for this rider's branch, sent the moment they connect)
// means a rider who reconnects mid-outage never misses an offer that was
// already broadcast while they were down.
router.get('/offers/stream', requireRider, async (req, res) => {
  const { rows } = await pool.query('select branch_id from rider where id = $1', [req.session.rider.id]);
  const riderBranchId = rows[0]?.branch_id || null;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const { rows: openOffers } = await pool.query(
    `select o.*, z.name as zone_name, z.rider_payout
     from delivery_offer o join delivery_zone z on z.id = o.zone_id
     where o.status = 'OPEN'`
  );
  for (const offer of openOffers) {
    const event = { id: offer.id, branchId: offer.branch_id, zoneName: offer.zone_name, payout: offer.rider_payout, urgent: Boolean(offer.escalated_at) };
    if (offerMatchesBranch(event, riderBranchId)) send(event);
  }

  const onOffer = (event) => {
    if (offerMatchesBranch(event, riderBranchId)) send(event);
  };
  offerBus.on('offer', onOffer);
  // A comment line every 20s keeps intermediary proxies/load balancers
  // from deciding the connection is idle and closing it -- SSE's own
  // convention, invisible to EventSource's onmessage.
  const keepAlive = setInterval(() => res.write(':\n\n'), 20_000);
  req.on('close', () => {
    offerBus.off('offer', onOffer);
    clearInterval(keepAlive);
  });
});

// The atomic claim (spec B4): a single conditional UPDATE inside a
// transaction that also creates the assignment and the rider_payout row --
// never a read then a separate write, which is exactly how two riders could
// both "win" the same offer. Whichever request's UPDATE actually flips the
// row from OPEN wins; every other request (including a genuinely
// simultaneous one) sees zero rows affected and gets a clean 409, never a
// silent double-assignment.
router.post('/offers/:id/accept', requireRider, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: claimed } = await client.query(
      `update delivery_offer set status = 'CLAIMED', claimed_by = $1, claimed_at = now()
       where id = $2 and status = 'OPEN' returning *`,
      [req.session.rider.id, req.params.id]
    );
    if (!claimed[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Someone else already accepted this delivery.' });
    }
    const offer = claimed[0];

    const { rows: zoneRows } = await client.query('select rider_payout from delivery_zone where id = $1', [offer.zone_id]);
    const payout = zoneRows[0]?.rider_payout || 0;

    const deliveryCode = String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    const trackingToken = Buffer.from(`${offer.id}:${Date.now()}:${Math.random()}`).toString('base64url');

    const { rows: assignmentRows } = await client.query(
      `insert into delivery_assignment (offer_id, order_id, rider_id, delivery_code, tracking_token)
       values ($1, $2, $3, $4, $5) returning *`,
      [offer.id, offer.order_id, req.session.rider.id, deliveryCode, trackingToken]
    );
    const assignment = assignmentRows[0];

    // Copied from the zone right now, at assignment time -- never re-read
    // at payout time (spec B7). If the restaurant edits this zone's price
    // later, this delivery keeps the rate the rider actually saw and
    // agreed to when they accepted it.
    await client.query(
      `insert into rider_payout (assignment_id, rider_id, branch_id, amount) values ($1, $2, $3, $4)`,
      [assignment.id, req.session.rider.id, offer.branch_id, payout]
    );

    const { rows: riderRows } = await client.query('select name, phone from rider where id = $1', [req.session.rider.id]);
    const riderName = riderRows[0]?.name || null;
    const trackingPath = `/track/${trackingToken}`;
    await client.query(
      `update delivery set status = 'dispatched', rider_name = $1, rider_phone = $2, tracking_url = $3 where order_id = $4`,
      [riderName, riderRows[0]?.phone || null, trackingPath, offer.order_id]
    );

    // The customer's own typed address -- withheld from the offer itself
    // (a rider deciding whether to accept only sees the zone, per spec B3),
    // handed over now that they actually have the job, so the rider PWA
    // can offer a nav handoff for the drop-off leg the same way it already
    // does for pickup. Still just the free text the customer typed, not a
    // real coordinate (see the tracking-link note below) -- Maps will do
    // its own best-effort search on it, same as typing it in by hand.
    const { rows: custRows } = await client.query(
      `select c.address from customers c join "order" o on o.customer_id = c.id where o.id = $1`,
      [offer.order_id]
    );

    await client.query('COMMIT');
    res.json({ assignment, deliveryCode, dropoffAddress: custRows[0]?.address || null });

    // Fire-and-forget, after the response -- the assignment is already
    // committed, so a WhatsApp hiccup here must never surface as a failed
    // accept (the rider already has the job either way).
    //
    // trackingUrl deliberately withheld from the customer message for now
    // (Chidera's call, 2026-09-01): the page it points to only ever shows
    // the RIDER's real position, never the customer's own -- nothing in
    // this system geocodes a customer's typed address into map
    // coordinates yet, so sending a "track your delivery" link oversells
    // what the page can actually show. The route/page itself (routes/
    // tracking.js) and `delivery.tracking_url` on the order are both left
    // fully working, deliberately -- this only stops it being proactively
    // texted out until the location gap above is closed. The delivery
    // code (the part that actually matters for the handoff) still goes
    // out regardless.
    notifyDeliveryAssigned(offer.order_id, {
      riderName,
      trackingUrl: null,
      deliveryCode,
    }).catch((err) => console.error(`Failed to notify customer of delivery assignment for order ${offer.order_id}:`, err));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// --- Assignment lifecycle -----------------------------------------------
// picked-up -> arrived -> deliver, strictly in order (spec B4). Each step
// requires the CURRENT rider to actually own this assignment -- never just
// "any signed-in rider", or one rider could close out another's job.

async function loadOwnAssignment(req, res) {
  const { rows } = await pool.query('select * from delivery_assignment where id = $1 and rider_id = $2', [req.params.id, req.session.rider.id]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Assignment not found.' });
    return null;
  }
  return rows[0];
}

router.post('/assignments/:id/picked-up', requireRider, async (req, res) => {
  const { rows } = await pool.query(
    `update delivery_assignment set status = 'PICKED_UP', picked_up_at = now()
     where id = $1 and rider_id = $2 and status = 'ASSIGNED' returning *`,
    [req.params.id, req.session.rider.id]
  );
  if (!rows[0]) {
    const existing = await loadOwnAssignment(req, res);
    if (existing === null) return; // loadOwnAssignment already responded
    return res.status(409).json({ error: `Can't mark picked up from status "${existing.status}".` });
  }
  res.json(rows[0]);
});

router.post('/assignments/:id/arrived', requireRider, async (req, res) => {
  const { rows } = await pool.query(
    `update delivery_assignment set status = 'ARRIVED'
     where id = $1 and rider_id = $2 and status = 'PICKED_UP' returning *`,
    [req.params.id, req.session.rider.id]
  );
  if (!rows[0]) {
    const existing = await loadOwnAssignment(req, res);
    if (existing === null) return;
    return res.status(409).json({ error: `Can't mark arrived from status "${existing.status}".` });
  }
  res.json(rows[0]);
});

router.post('/assignments/:id/deliver', requireRider, async (req, res) => {
  const code = (req.body?.code || '').trim();
  const existing = await loadOwnAssignment(req, res);
  if (existing === null) return;
  if (existing.status !== 'ARRIVED') {
    return res.status(409).json({ error: `Can't complete delivery from status "${existing.status}" -- mark arrived first.` });
  }
  if (code !== existing.delivery_code) {
    return res.status(400).json({ error: 'That code does not match.' });
  }
  const { rows } = await pool.query(
    `update delivery_assignment set status = 'DELIVERED', delivered_at = now(), code_entered_at = now()
     where id = $1 returning *`,
    [existing.id]
  );
  // Own-riders' rider_payout was already queued (status PENDING) at
  // assignment time, per spec B7's own "copied at assignment time" -- there
  // is nothing further to queue here, only the delivery's own status to
  // close out. The existing `delivery` row is the one OrderDetail.jsx
  // actually renders, so that's what has to change for staff to see it.
  await pool.query(`update delivery set status = 'delivered' where order_id = $1`, [existing.order_id]);
  res.json(rows[0]);

  // Manual payout (the default, spec B9's own "manual before automatic")
  // needs nothing further here -- the PENDING row already sits on the
  // Payouts tab for a human to press. Automatic is an optimisation of that
  // same working process, never a prerequisite for it (see engine/payout-
  // providers.js's own header). Runs after the response, same reasoning as
  // notifyDeliveryAssigned above -- a provider outage must never turn a
  // real, completed delivery into a failed HTTP response to the rider.
  attemptAutomaticPayout(existing.id).catch((err) => console.error(`Automatic payout attempt failed for assignment ${existing.id}:`, err));
});

async function attemptAutomaticPayout(assignmentId) {
  const deliveryConfig = await getDeliveryConfig();
  if (deliveryConfig.payout_mode !== 'automatic') return;
  if (!deliveryConfig.provider || !deliveryConfig.provider_keys) {
    console.error(`Automatic payout is on but no provider/keys are configured -- assignment ${assignmentId} stays PENDING for manual payout.`);
    return;
  }

  const { rows } = await pool.query(
    `select p.*, r.name as rider_name, r.bank_account_number, r.bank_code, r.account_name
     from rider_payout p join rider r on r.id = p.rider_id
     where p.assignment_id = $1 and p.status = 'PENDING'`,
    [assignmentId]
  );
  const payout = rows[0];
  if (!payout) return; // already handled (paid manually in the meantime, or genuinely nothing to pay)

  const result = await sendPayout({
    provider: deliveryConfig.provider,
    providerKeys: deliveryConfig.provider_keys,
    rider: {
      name: payout.rider_name,
      bankAccountNumber: payout.bank_account_number ? decrypt(payout.bank_account_number) : null,
      bankCode: payout.bank_code,
      accountName: payout.account_name,
    },
    amount: payout.amount,
    reference: payout.id,
  });

  if (result.ok) {
    await pool.query(
      `update rider_payout set status = 'SENT', provider = $1, provider_reference = $2, settled_at = now(), error = null where id = $3`,
      [deliveryConfig.provider, result.reference, payout.id]
    );
  } else {
    // Visible and retryable (the Payouts tab's "Mark paid" button still
    // works from FAILED) -- never left as PENDING forever with no
    // explanation, which is indistinguishable from "nobody's looked at it
    // yet" (spec 0.4: never silently drop).
    await pool.query(`update rider_payout set status = 'FAILED', provider = $1, error = $2 where id = $3`, [deliveryConfig.provider, result.error, payout.id]);
  }
}
