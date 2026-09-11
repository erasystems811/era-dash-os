// Dine-in add-on (EBOS-Addon-Schema-Dine-In.md), Stage 1: tables + QR
// generation only -- scan handling, the menu page, ordering and feedback
// come in later stages. Mounted under /api/dinein in routes/api.js, after
// requireStaffApi/scopeToBranch, same as routes/delivery.js and
// routes/voice.js. Whether this add-on is even on for this business is
// dinein_config.enabled, toggled by ERA (POST /dinein-config in api.js,
// requireEraAdmin) -- never something a restaurant can flip for itself,
// same as voice_config/delivery_config.
import express from 'express';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { pool } from '../lib/db.js';
import { requireEditorApi } from '../lib/auth.js';
import { resolveWaNumber } from './dinein-menu.js';

export const router = express.Router();

// The number a table's QR code actually points at. NOT business.phone_
// number (a free-text contact field, not necessarily ever connected to
// WhatsApp -- era-demo's was a placeholder, meaning every dine-in QR code
// generated before this fix encoded a number that would show "this number
// isn't on WhatsApp" when scanned) -- resolveWaNumber asks Meta what's
// actually connected to this branch's phone_number_id. Digits only: wa.me
// takes a bare MSISDN, not a formatted number with a leading + or spaces.
async function whatsappNumberForBranch(branchId) {
  const raw = await resolveWaNumber(branchId);
  return raw ? raw.replace(/\D/g, '') : null;
}

async function qrDataUrlFor(table, whatsappNumber) {
  if (!whatsappNumber) return null;
  const text = encodeURIComponent(`Menu Table ${table.label}`);
  // _r isn't read by wa.me (it only recognizes "text") and never shows up
  // in the customer's prefilled message -- it exists purely so the QR
  // code's own encoded bytes, and so the image, actually change when
  // regenerate-qr below gives a table a fresh qr_token. Found live,
  // 2026-09-11, Chidera: "when i press new qr, no qr is actually
  // renewing" -- before this, the QR was built from only the WhatsApp
  // number and the table's label, neither of which regenerating touches,
  // so every "new" QR was pixel-identical to the one before it.
  const link = `https://wa.me/${whatsappNumber}?text=${text}&_r=${table.qr_token.slice(0, 8)}`;
  return QRCode.toDataURL(link, { margin: 1, width: 320 });
}

router.get('/tables', async (req, res) => {
  const { rows: tables } = await pool.query(
    `select rt.*, b.name as branch_name,
            exists(select 1 from table_session ts where ts.table_id = rt.id and ts.closed_at is null) as has_open_session
     from restaurant_table rt
     join branch b on b.id = rt.branch_id
     where ($1::uuid is null or rt.branch_id = $1)
     order by b.name, rt.label`,
    [req.branchId]
  );
  // One whatsapp-number lookup per distinct branch represented, not per
  // table -- a restaurant with 40 tables on one branch shouldn't mean 40
  // near-identical queries for the same answer.
  const numberByBranch = new Map();
  for (const t of tables) {
    if (!numberByBranch.has(t.branch_id)) {
      numberByBranch.set(t.branch_id, await whatsappNumberForBranch(t.branch_id));
    }
  }
  const withQr = await Promise.all(
    tables.map(async (t) => ({ ...t, qr_data_url: await qrDataUrlFor(t, numberByBranch.get(t.branch_id)) }))
  );
  res.json(withQr);
});

router.post('/tables', requireEditorApi, async (req, res) => {
  const f = req.body;
  // Trimmed before it ever reaches the database -- a stray leading/trailing
  // space here (an easy typo in the "Table label" input) breaks the QR scan
  // match downstream (handleDineinScan compares the label against a label
  // extracted with \s+, which collapses that stray space away, so it never
  // matches the stored value again). Found live, 2026-09-11, Chidera: "it
  // sint recognizinf the table, keps asking me what table am i on."
  const label = f.label?.trim();
  if (!f.branch_id || !label) return res.status(400).json({ error: 'branch_id and label are required.' });
  try {
    const { rows } = await pool.query(
      'insert into restaurant_table (branch_id, label, qr_token, seats) values ($1, $2, $3, $4) returning *',
      [f.branch_id, label, randomBytes(16).toString('hex'), f.seats || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Table "${label}" already exists for this branch -- a scan needs a label to mean exactly one table.` });
    throw err;
  }
});

router.post('/tables/:id', requireEditorApi, async (req, res) => {
  const f = req.body;
  try {
    const { rows } = await pool.query(
      'update restaurant_table set label = $1, seats = $2, status = $3 where id = $4 returning *',
      [f.label?.trim(), f.seats || null, f.status || 'active', req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Table not found.' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Table "${f.label}" already exists for this branch -- a scan needs a label to mean exactly one table.` });
    throw err;
  }
});

// A stolen or renumbered printed card is invalidated by giving the table a
// fresh qr_token -- the old printed code still decodes to a real wa.me
// link with the same number + table label text (see qrDataUrlFor's own
// _r comment for why the token itself only affects the QR's encoded
// bytes, never what a customer sees or sends), so the actual protection
// here is operational (reprint and swap the card), not cryptographic.
// This exists so the dashboard has a real "regenerate" action to pair
// with that swap, and so a regenerated token shows up as a visibly
// different QR image.
router.post('/tables/:id/regenerate-qr', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    'update restaurant_table set qr_token = $1 where id = $2 returning *',
    [randomBytes(16).toString('hex'), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Table not found.' });
  res.json(rows[0]);
});

// Dine-in orders placed and waiting on the kitchen/bar, oldest first --
// the dashboard's "in-house guests" queue (Chidera 2026-09-10: "a tab for
// in house guests where it shows orders pending... and when fulfiled
// there should be a served button to take them off"). "Served" itself is
// just the existing POST /orders/:id/status {status:'completed'} -- same
// close-out every other order already gets, not a second parallel path.
router.get('/orders/pending', async (req, res) => {
  const { rows } = await pool.query(
    `select o.*, rt.label as table_label,
            (select coalesce(json_agg(json_build_object('name', p.name, 'quantity', oi.quantity)), '[]')
             from order_item oi join product p on p.id = oi.product_id where oi.order_id = o.id) as items
     from "order" o
     join restaurant_table rt on rt.id = o.table_id
     where o.channel = 'dinein' and o.status not in ('completed', 'cancelled')
       and ($1::uuid is null or o.branch_id = $1)
     order by o.created_at asc`,
    [req.branchId]
  );
  res.json(rows);
});

// Newest first, negative first (spec section 10) -- score isn't
// alphabetically 'bad' < 'good' < 'alright', so an explicit case order
// rather than relying on text sort.
router.get('/feedback', async (req, res) => {
  const { rows } = await pool.query(
    `select f.*, rt.label as table_label, c.name as customer_name, c.phone_number,
            (select string_agg(p.name || ' x' || oi.quantity, ', ') from order_item oi join product p on p.id = oi.product_id join "order" o on o.id = oi.order_id where o.session_id = f.session_id) as ordered
     from feedback f
     join table_session ts on ts.id = f.session_id
     join restaurant_table rt on rt.id = ts.table_id
     join customers c on c.id = f.customer_id
     where ($1::uuid is null or f.branch_id = $1)
     order by case f.score when 'bad' then 0 when 'alright' then 1 else 2 end, f.created_at desc
     limit 200`,
    [req.branchId]
  );
  res.json(rows);
});

router.post('/feedback/:id/action', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    `update feedback set status = 'actioned', actioned_by = $1 where id = $2 returning *`,
    [req.staff.id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
  res.json(rows[0]);
});

// Stage 6 -- the dashboard fallback for closing a table (spec 6.2: build
// this regardless of POS access, it's the only close path a client with no
// POS has at all). Schedules nothing itself yet -- feedback (stage 7)
// isn't built, so table_session.feedback_state just stays 'none' for now.
router.post('/tables/:id/close', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    `update table_session set closed_at = now(), closed_by = 'staff', closed_by_staff = $1
     where table_id = $2 and closed_at is null returning *`,
    [req.staff.id, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'No open session for this table.' });
  res.json(rows[0]);
});

router.delete('/tables/:id', requireEditorApi, async (req, res) => {
  try {
    await pool.query('delete from restaurant_table where id = $1', [req.params.id]);
  } catch (err) {
    // Real FK violation (table_session references it) -- a table with any
    // session history stays, same "referenced records don't silently
    // disappear" rule staff/payroll-adjacent tables already follow
    // elsewhere in EBOS. Deactivate (status='inactive') instead of
    // deleting a table that's actually been used.
    if (err.code === '23503') return res.status(409).json({ error: 'This table has session history and can\'t be deleted -- mark it inactive instead.' });
    throw err;
  }
  res.json({ ok: true });
});
