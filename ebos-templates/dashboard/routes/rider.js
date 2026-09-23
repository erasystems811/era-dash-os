// The rider-facing API -- a phone number, a staff-set PIN, on/off duty, and
// the offer/assignment lifecycle. Session-cookie
// authenticated, same mechanism as the staff dashboard (routes/api.js) but
// a wholly separate cookie/session, never mixed with a staff login -- a
// rider and a staff member are different kinds of account, and this app is
// mounted on its own path (/rider) precisely so the two sessions never
// collide (see server.js).
import express from 'express';
import { pool } from '../lib/db.js';
import { verifyRiderPin } from '../engine/rider-auth.js';
import { offerBus } from '../engine/offer-bus.js';
import { notifyDeliveryAssigned, sendFeedbackRequest } from '../engine/flow.js';
import { getDeliveryConfig } from '../engine/delivery-zones.js';
import { sendPayout } from '../engine/payout-providers.js';
import { resolveSource } from '../engine/delivery.js';
import { decrypt } from '../lib/crypto.js';

// The single source of truth for "what should this rider's app show right
// now" -- used by both /login and /me so a page refresh (or reopening the
// app after it was killed) always lands back on reality, never a client-
// side guess. Real bug this fixes (Chidera's report, 2026-09-03): the
// session only ever stored {id, name, phone} from login, so /me used to
// just echo that back with no `status` field at all -- the client
// defaulted a missing status to 'off_duty' on every single refresh,
// showing a rider as off duty (and silently dropping their in-progress
// delivery screen, since `active` was plain React state with nothing to
// restore it from) regardless of what was actually true in the database.
// A rider going off duty now only ever happens from their own explicit
// tap on /duty -- refreshing 100 times changes nothing.
export async function loadRiderState(riderId) {
  const { rows: riderRows } = await pool.query('select id, name, phone, status from rider where id = $1', [riderId]);
  const riderRow = riderRows[0];
  if (!riderRow) return null;

  const { rows: assignmentRows } = await pool.query(
    `select da.*, dz.name as zone_name, dz.rider_payout
     from delivery_assignment da
     join delivery_offer dof on dof.id = da.offer_id
     join delivery_zone dz on dz.id = dof.zone_id
     where da.rider_id = $1 and da.status in ('ASSIGNED', 'PICKED_UP', 'ARRIVED')
     order by da.created_at desc
     limit 1`,
    [riderId]
  );
  const assignmentRow = assignmentRows[0];

  let active = null;
  if (assignmentRow) {
    const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [assignmentRow.order_id]);
    const order = orderRows[0];
    const pickup = order ? await resolveSource(order) : {};
    const { rows: custRows } = await pool.query(
      `select c.address, c.phone_number from customers c join "order" o on o.customer_id = c.id where o.id = $1`,
      [assignmentRow.order_id]
    );
    active = {
      assignment: assignmentRow,
      offer: {
        id: assignmentRow.offer_id,
        zoneName: assignmentRow.zone_name,
        payout: assignmentRow.rider_payout,
        pickupName: pickup.name || null,
        pickupAddress: pickup.address || null,
      },
      dropoffAddress: custRows[0]?.address || null,
      customerPhone: custRows[0]?.phone_number || null,
    };
  }

  return {
    rider: { id: riderRow.id, name: riderRow.name, phone: riderRow.phone, status: riderRow.status },
    active,
  };
}

export const router = express.Router();

// A rider only ever sees offers from their own branch -- an offer or a
// rider with no branch (business has no branch rows, or this rider isn't
// locked to one) matches everyone, same "unassigned reaches everyone"
// idiom already used for unassigned products/customers (engine/fields.js's
// resolveMenu).
function offerMatchesBranch(offer, riderBranchId) {
  return !offer.branchId || !riderBranchId || offer.branchId === riderBranchId;
}

router.post('/login', async (req, res) => {
  const phone = (req.body?.phone || '').trim();
  const pin = (req.body?.pin || '').trim();
  if (!phone || !pin) return res.status(400).json({ error: 'Phone number and PIN are required.' });
  const rider = await verifyRiderPin(phone, pin);
  if (!rider) return res.status(401).json({ error: 'Incorrect phone number or PIN.' });
  req.session.rider = { id: rider.id };
  res.json(await loadRiderState(rider.id));
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

function requireRider(req, res, next) {
  if (!req.session?.rider) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

router.get('/me', async (req, res) => {
  if (!req.session?.rider) return res.json({ rider: null, active: null });
  const state = await loadRiderState(req.session.rider.id);
  if (!state) {
    // The rider row is gone (deleted from the dashboard) but the browser
    // still has an old session cookie -- treat it as signed out rather
    // than crashing on a null rider.
    req.session = null;
    return res.json({ rider: null, active: null });
  }
  res.json(state);
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

// The rider PWA needs this to call pushManager.subscribe({applicationServerKey})
// -- public by design (it's a public key, meant to be handed to a
// browser), but still behind requireRider since there's no reason a
// signed-out visitor needs it either. Empty string (not an error) when
// this deployment hasn't got VAPID keys configured yet -- the client
// treats that as "push isn't available here", same "off is genuinely
// inert" idiom as every other optional capability in this codebase.
router.get('/push-public-key', requireRider, (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// Saved every time the rider PWA (re)subscribes -- overwriting whatever
// was there before is correct, not a merge: a subscription is tied to one
// specific browser/device, and a rider re-subscribing (a fresh install, a
// cleared cache) always means the OLD one is dead anyway.
router.post('/push-subscribe', requireRider, async (req, res) => {
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'A real push subscription is required.' });
  await pool.query('update rider set push_subscription = $1 where id = $2', [JSON.stringify(subscription), req.session.rider.id]);
  res.json({ ok: true });
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
    // The SAME token the customer's tracking link already uses, generated
    // at offer-broadcast time (engine/delivery-dispatch.js) -- one link for
    // the whole journey, not a second one issued now that would silently
    // break the link already sent.
    const trackingToken = offer.tracking_token;

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

    // The customer's own typed address and phone number -- withheld from
    // the offer itself (a rider deciding whether to accept only sees the
    // zone, per spec B3), handed over now that they actually have the job,
    // so the rider PWA can offer a nav handoff for the drop-off leg (same
    // as it already does for pickup) and a tap-to-call for reaching the
    // customer directly (Chidera's ask, 2026-09-03). Address is still just
    // the free text the customer typed, not a real coordinate (see the
    // tracking-link note below) -- Maps will do its own best-effort search
    // on it, same as typing it in by hand.
    const { rows: custRows } = await client.query(
      `select c.address, c.phone_number from customers c join "order" o on o.customer_id = c.id where o.id = $1`,
      [offer.order_id]
    );

    await client.query('COMMIT');
    res.json({
      assignment,
      deliveryCode,
      dropoffAddress: custRows[0]?.address || null,
      customerPhone: custRows[0]?.phone_number || null,
    });

    // Fire-and-forget, after the response -- the assignment is already
    // committed, so a WhatsApp hiccup here must never surface as a failed
    // accept (the rider already has the job either way).
    //
    // trackingPath now goes out for real (Chidera's call, 2026-09-02) --
    // the page behind it (routes/tracking.js) shows a stage tracker
    // (waiting for rider -> accepted -> picked up -> here -> delivered),
    // not a live location, so there's no real-coordinate gap left to
    // oversell the way there was when this was paused on 2026-09-01.
    notifyDeliveryAssigned(offer.order_id, {
      riderName,
      trackingPath,
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

// Polled by the rider app while it's sitting on the "enter their code"
// screen (Chidera's ask, 2026-09-11: "if a rider is manually marked
// complete let the code stuff stop pending") -- staff have their own
// override for a stuck delivery (routes/delivery.js's /assignments/:id/
// release: lost code, dead phone, handed to a neighbour), which closes it
// out on the dashboard side, but the rider's own phone had no way to find
// out and would just sit on the code-entry form forever, then get a
// confusing "already delivered" error the moment they actually typed a
// code in. This lets the app notice and move on by itself.
router.get('/assignments/:id', requireRider, async (req, res) => {
  const assignment = await loadOwnAssignment(req, res);
  if (assignment === null) return;
  res.json(assignment);
});

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
  // Automatic advance (Chidera's call, 2026-09-03: "when rider press ive
  // picked up, order is meant to go to in transit automatically") -- the
  // rider physically taking the order IS the real-world "in delivery"
  // event for an own_riders order, no separate staff click needed on top
  // of it. `and status = 'ready'` is a no-op guard, not a requirement: a
  // non-own_riders provider (Chowdeck/Bolt) never creates a
  // delivery_assignment row and never reaches this route at all, so staff's
  // own "Mark in delivery" button (OrderDetail.jsx/Orders.jsx) is still the
  // only path for those -- and if staff happened to click it first for an
  // own_riders order too, this simply does nothing rather than erroring.
  await pool.query(`update "order" set status = 'in_transit' where id = $1 and status = 'ready'`, [rows[0].order_id]);
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
  if (existing.status === 'DELIVERED') {
    // Staff's own override (routes/delivery.js's /assignments/:id/release)
    // already closed this out from the dashboard side -- a real race with
    // the rider's own code-entry poll above, not an error worth alarming
    // them over. `alreadyDelivered: true` lets the app show the normal
    // Delivered screen instead of a confusing "mark arrived first".
    return res.status(409).json({ error: 'This delivery was already completed.', alreadyDelivered: true });
  }
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
  // Same automatic advance as picked-up above -- the real code entry the
  // customer just gave the rider IS the completion event, no staff click
  // needed on top of it.
  // completed_at drives the 24h "want to order again?" window (see
  // schema.sql's comment on the column) -- explicit here since this path
  // never goes through the staff-driven /orders/:id/status route that
  // otherwise sets it. engine_state also has to move to 'completed' here,
  // not just status -- found live, 2026-09-03, building that same 24h
  // feature: engine/flow.js's getOpenOrder gates on engine_state, not
  // status, so without this an auto-completed delivery order (rider
  // entered the code, no staff click at all) would still look "open"
  // forever and the customer's next message would keep routing into the
  // finished order's own fulfilment-stage handler instead of ever reaching
  // the post-completion flow.
  await pool.query(
    `update "order" set status = 'completed', engine_state = 'completed', completed_at = now() where id = $1 and status = 'in_transit'`,
    [existing.order_id]
  );
  // Second of the three real completion sites -- see engine/flow.js's own
  // comment on sendFeedbackRequest. Fire-and-forget: never block the
  // rider's own "delivery complete" response on this.
  sendFeedbackRequest(existing.order_id).catch((err) => console.error('sendFeedbackRequest failed:', err.message));
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
