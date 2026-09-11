// Delivery add-on (own_riders mode) -- zone catalogue and rider roster.
// Mounted under /api/delivery in routes/api.js, after requireStaffApi/
// scopeToBranch, so req.staff and req.branchId are already set exactly
// like every other route in this file. Real business data (like the
// catalogue and branches), so any owner or manager can manage it -- not
// ERA-admin-only the way bot_field/bot_state are.
import express from 'express';
import { pool } from '../lib/db.js';
import { requireEditorApi } from '../lib/auth.js';
import { encrypt } from '../lib/crypto.js';
import { hashRiderPin } from '../engine/rider-auth.js';
import { sendFeedbackRequest } from '../engine/flow.js';

export const router = express.Router();

// --- Zones ----------------------------------------------------------------

router.get('/zones', async (req, res) => {
  const { rows } = await pool.query(
    `select * from delivery_zone where $1::uuid is null or branch_id = $1 order by name`,
    [req.branchId]
  );
  res.json(rows);
});

router.post('/zones', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    `insert into delivery_zone (branch_id, name, aliases, customer_fee, rider_payout, active)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [req.branchId || f.branch_id || null, f.name, f.aliases || [], f.customer_fee, f.rider_payout, f.active !== false]
  );
  res.status(201).json(rows[0]);
});

router.post('/zones/:id', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    `update delivery_zone set name = $1, aliases = $2, customer_fee = $3, rider_payout = $4, active = $5 where id = $6 returning *`,
    [f.name, f.aliases || [], f.customer_fee, f.rider_payout, f.active !== false, req.params.id]
  );
  res.json(rows[0]);
});

router.delete('/zones/:id', requireEditorApi, async (req, res) => {
  await pool.query('delete from delivery_zone where id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Riders -----------------------------------------------------------------
// bank_account_number is encrypted before it's ever written -- never
// returned to the client in the same form it was received (see the
// select list below, which reads it back only as "on file" status, not
// the real number).

function riderRow(r) {
  if (!r) return r;
  // pin_locked_until is kept (not sensitive, just a timestamp -- the
  // roster shows a locked-out rider so staff know to reset their PIN
  // rather than wondering why they can't sign in) -- pin_hash and the raw
  // attempt count are the only real secrets here.
  const { bank_account_number, pin_hash, pin_failed_attempts, otp_code, otp_expires_at, ...rest } = r;
  return { ...rest, hasBankDetails: Boolean(bank_account_number), hasPin: Boolean(pin_hash) };
}

router.get('/riders', async (req, res) => {
  const { rows } = await pool.query(
    `select * from rider where $1::uuid is null or branch_id = $1 order by created_at desc`,
    [req.branchId]
  );
  res.json(rows.map(riderRow));
});

// A PIN is required at creation -- a rider with no PIN could never sign
// in, so this isn't optional the way editing one later is (staff may add a
// rider before deciding/telling them their PIN in person, but not before
// setting SOME PIN, or the account is just dead on arrival).
router.post('/riders', requireEditorApi, async (req, res) => {
  const f = req.body;
  if (!f.pin || !/^\d{4,6}$/.test(f.pin)) return res.status(400).json({ error: 'A 4 to 6 digit PIN is required.' });
  const { rows } = await pool.query(
    `insert into rider (branch_id, name, phone, bank_account_number, bank_code, account_name, pin_hash)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [req.branchId || f.branch_id || null, f.name, f.phone, encrypt(f.bank_account_number), f.bank_code || null, f.account_name || null, await hashRiderPin(f.pin)]
  );
  res.status(201).json(riderRow(rows[0]));
});

// Every field here is optional and coalesced against the existing row --
// the "reset PIN" action sends only { pin }, and name/phone are NOT NULL
// columns, so treating a missing field as "set it to null" would throw
// instead of just doing the wrong thing, but it's still wrong: this has to
// behave as a real partial update, the same way bank_account_number
// already does below.
//
// pin itself is optional so editing a rider's name/bank details doesn't
// force staff to also re-type or reset their PIN. Sent only when staff
// actually wants to change it (also clears any existing lockout, since a
// new PIN staff just set in person is a legitimate reason to let them
// straight back in).
router.post('/riders/:id', requireEditorApi, async (req, res) => {
  const f = req.body;
  if (f.pin && !/^\d{4,6}$/.test(f.pin)) return res.status(400).json({ error: 'PIN must be 4 to 6 digits.' });
  const { rows } = await pool.query(
    `update rider set
       name = coalesce($1, name),
       phone = coalesce($2, phone),
       bank_code = coalesce($3, bank_code),
       account_name = coalesce($4, account_name),
       bank_account_number = coalesce($5, bank_account_number),
       pin_hash = coalesce($6, pin_hash),
       pin_failed_attempts = case when $6::text is null then pin_failed_attempts else 0 end,
       pin_locked_until = case when $6::text is null then pin_locked_until else null end
     where id = $7 returning *`,
    [f.name || null, f.phone || null, f.bank_code || null, f.account_name || null, f.bank_account_number ? encrypt(f.bank_account_number) : null, f.pin ? await hashRiderPin(f.pin) : null, req.params.id]
  );
  res.json(riderRow(rows[0]));
});

router.post('/riders/:id/status', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query('update rider set status = $1 where id = $2 returning *', [req.body.status, req.params.id]);
  res.json(riderRow(rows[0]));
});

router.delete('/riders/:id', requireEditorApi, async (req, res) => {
  await pool.query('delete from rider where id = $1', [req.params.id]);
  res.json({ ok: true });
});

// --- Payouts --------------------------------------------------------------
// Manual mode first, on purpose (spec B9): same ledger a human presses a
// button against, so the whole delivery flow is live and real money can
// move to riders well before any payment-provider integration exists to
// get wrong. `amount` was already frozen at assignment time (see routes/
// rider.js's /offers/:id/accept) -- this never re-reads delivery_zone.

router.get('/payouts', async (req, res) => {
  const { rows } = await pool.query(
    `select p.*, r.name as rider_name, r.phone as rider_phone, o.reference as order_reference
     from rider_payout p
     join rider r on r.id = p.rider_id
     join delivery_assignment a on a.id = p.assignment_id
     join "order" o on o.id = a.order_id
     where $1::uuid is null or p.branch_id = $1
     order by p.created_at desc`,
    [req.branchId]
  );
  res.json(rows);
});

router.post('/payouts/:id/mark-paid', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    `update rider_payout set status = 'PAID_MANUALLY', provider = 'manual', settled_at = now()
     where id = $1 and status in ('PENDING', 'FAILED') returning *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'This payout is not in a state that can be marked paid.' });
  res.json(rows[0]);
});

// --- Staff override / escalation -----------------------------------------

// Spec B7: "always provide a human override" -- the customer lost the
// code, their phone died, they handed the bag to a neighbour. Marks the
// delivery DELIVERED with the real reason recorded, exactly like the
// rider's own /rider/api/assignments/:id/deliver would, except a person is
// vouching for it instead of a code. The rider_payout row was already
// queued PENDING at assignment time (spec B7's own "copied at assignment
// time") -- this never touches it, so overriding a stuck delivery never
// costs the rider their payout.
router.post('/assignments/:id/release', requireEditorApi, async (req, res) => {
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'A reason is required.' });
  const { rows } = await pool.query(
    `update delivery_assignment set status = 'DELIVERED', delivered_at = now(), released_by_staff = $1, override_reason = $2
     where id = $3 and status not in ('DELIVERED', 'FAILED') returning *`,
    [req.staff.id, reason, req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'This delivery is not in a state that can be released.' });
  await pool.query(`update delivery set status = 'delivered' where order_id = $1`, [rows[0].order_id]);
  // Same automatic advance the rider's own real deliver action would have
  // caused -- a staff override closing out a stuck delivery is just as
  // real a completion as the rider entering the code themselves.
  await pool.query(`update "order" set status = 'completed' where id = $1 and status in ('ready', 'in_transit')`, [rows[0].order_id]);
  // Third of the three real completion sites -- see engine/flow.js's own
  // comment on sendFeedbackRequest. Fire-and-forget, never blocks the
  // release itself.
  sendFeedbackRequest(rows[0].order_id).catch((err) => console.error('sendFeedbackRequest failed:', err.message));
  res.json(rows[0]);
});

// A delivery nobody ever accepted has no assignment to release -- this is
// the other half of the same override principle, for the offer itself.
// Staff have already called a rider directly by the time they use this
// (the WhatsApp alert that put it in Needs Attention said as much); this
// just clears it from the queue so it doesn't sit there forever. The order
// itself is untouched -- staff handle the actual delivery outside this
// system from here, same as any business without own_riders at all does
// today.
router.post('/offers/:id/cancel', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    `update delivery_offer set status = 'CANCELLED' where id = $1 and status = 'OPEN' returning *`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(409).json({ error: 'This offer is not open.' });
  res.json({ ok: true });
});
