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
import { notifyGuestsReadyToPay, closeTableSessionIfSettled } from '../engine/flow.js';

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
  // Chidera, 2026-09-25: "when qr is scanned instead of just menu table i
  // want a menu table 1(send this to proceed)." A prefilled WhatsApp
  // message still needs an explicit tap on Send before it actually goes
  // anywhere -- a bare "Menu Table 1" read as already sent to guests who'd
  // never used a wa.me link before. flow.js's handleDineinScan strips this
  // exact parenthetical back off before matching the table label.
  const text = encodeURIComponent(`Menu Table ${table.label}(send this to proceed)`);
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

// Dine-in orders placed and waiting on the kitchen/bar, oldest first -- the
// dashboard's "in-house guests" first pipeline (Chidera 2026-09-10: "a tab
// for in house guests where it shows orders pending... and when fulfiled
// there should be a served button to take them off"). Split into two real
// pipelines now -- Chidera 2026-09-11: "confirming payment is different
// from marking served so there should be 2 piplines, the fist one shows
// kanban with served button and the next one marks paid" -- this is
// pipeline one: served_at is null, meaning nothing's gone out to the table
// yet for this order. "Served" (POST /orders/:id/served below) is the only
// way out of this list; "paid" is a second, separate step (see
// /orders/serving below), not the same click.
// itemsWithServedDiff -- Chidera, 2026-09-20: "on the staff card let
// there be a clear demarcation for add on, so they know what has been
// served and what has just been added on." Diffs each item's CURRENT
// quantity against served_item_snapshot (captured the moment "Served"
// was last tapped, see POST /orders/:id/served) -- newQty is however
// much of this line's quantity wasn't there yet at that moment. A brand-
// new order (snapshot never taken) shows everything as new, correctly --
// nothing's been served at all yet.
function itemsWithServedDiff(order) {
  const snapshot = order.served_item_snapshot || {};
  return (order.items || []).map((item) => {
    const alreadyServed = Number(snapshot[item.product_id] || 0);
    const newQty = Math.max(0, item.quantity - alreadyServed);
    return { ...item, newQty };
  });
}

router.get('/orders/pending', async (req, res) => {
  const { rows } = await pool.query(
    `select o.*, rt.label as table_label,
            (select coalesce(json_agg(json_build_object('name', p.name, 'product_id', oi.product_id, 'quantity', oi.quantity)), '[]')
             from order_item oi join product p on p.id = oi.product_id where oi.order_id = o.id) as items
     from "order" o
     join restaurant_table rt on rt.id = o.table_id
     where o.channel = 'dinein' and o.status not in ('completed', 'cancelled') and o.served_at is null
       and ($1::uuid is null or o.branch_id = $1)
     order by o.created_at asc`,
    [req.branchId]
  );
  res.json(rows.map((o) => ({ ...o, items: itemsWithServedDiff(o) })));
});

// Pipeline two -- served, still owed. "Mark paid" is the existing POST
// /orders/:id/status {status:'completed'} (same close-out every other
// order already gets, not a second parallel path) -- reaching 'completed'
// from here is what /tables/:id/close below actually waits on.
router.get('/orders/serving', async (req, res) => {
  const { rows } = await pool.query(
    `select o.*, rt.label as table_label,
            (select coalesce(json_agg(json_build_object('name', p.name, 'product_id', oi.product_id, 'quantity', oi.quantity)), '[]')
             from order_item oi join product p on p.id = oi.product_id where oi.order_id = o.id) as items
     from "order" o
     join restaurant_table rt on rt.id = o.table_id
     where o.channel = 'dinein' and o.status not in ('completed', 'cancelled') and o.served_at is not null
       and ($1::uuid is null or o.branch_id = $1)
     order by o.served_at asc`,
    [req.branchId]
  );
  res.json(rows.map((o) => ({ ...o, items: itemsWithServedDiff(o) })));
});

// Chidera, 2026-09-25: "can in house have its own dashboard, with cash
// collected." /orders/stats/today already has an in_house-scoped branch,
// but only for a staff account whose OWN work_area happens to be
// 'in_house' (req.workArea, set from the logged-in staff's own row) -- an
// owner/manager (work_area null, unrestricted) viewing In House itself
// would get the WHOLE business's numbers back, online orders included.
// This is always dine-in-only regardless of who's asking, same
// cash/card/transfer split /finance/summary already established for
// cash_collected (POST /orders/:id/payment-method is the only thing that
// ever sets payment_method/cash_collected at all) -- "other" covers a
// dine-in table that paid through a real payment link (Paystack/Monnify)
// or an auto-matched POS transfer instead of the manual Mark-paid flow,
// computed as a remainder in JS so the four figures always sum to
// exactly `collected`, never drift apart from independent rounding.
router.get('/stats/today', async (req, res) => {
  const { rows } = await pool.query(
    `select count(*) as orders,
            coalesce(sum(total) filter (where payment_status in ('confirmed', 'accepted')), 0) as collected,
            coalesce(sum(cash_collected) filter (where payment_method = 'cash'), 0) as cash,
            coalesce(sum(total) filter (where payment_method = 'card' and payment_status in ('confirmed', 'accepted')), 0) as card,
            coalesce(sum(total) filter (where payment_method = 'transfer' and payment_status in ('confirmed', 'accepted')), 0) as transfer,
            count(distinct table_id) as tables
     from "order"
     where channel = 'dinein' and created_at >= date_trunc('day', now())
       and ($1::uuid is null or branch_id = $1)`,
    [req.branchId]
  );
  const r = rows[0];
  const collected = Number(r.collected);
  const cash = Number(r.cash);
  const card = Number(r.card);
  const transfer = Number(r.transfer);
  res.json({
    orders: Number(r.orders),
    tablesServed: Number(r.tables),
    collected,
    cash,
    card,
    transfer,
    other: Math.max(0, collected - cash - card - transfer),
  });
});

// The only way an order leaves pipeline one -- sets served_at, nothing
// else (status/payment are untouched, still tracked separately in
// pipeline two). engine/flow.js's applyOrderModifications resets this back
// to null if more items get added afterward, so an order can cycle through
// here more than once in the same sitting.
router.post('/orders/:id/served', async (req, res) => {
  // served_item_snapshot -- Chidera, 2026-09-20: "on the staff card let
  // there be a clear demarcation for add on, so they know what has been
  // served and what has just been added on." Captured in the same
  // request as served_at itself so the two facts can never drift apart
  // -- {productId: quantity} as it stands right now, the thing the
  // kanban card's own items diff against to know what's new.
  const { rows: snapshotRows } = await pool.query(
    `select product_id, sum(quantity) as quantity from order_item where order_id = $1 group by product_id`,
    [req.params.id]
  );
  const snapshot = Object.fromEntries(snapshotRows.map((r) => [r.product_id, Number(r.quantity)]));
  const { rows } = await pool.query(
    `update "order" set served_at = now(), served_item_snapshot = $2 where id = $1 and channel = 'dinein' returning *`,
    [req.params.id, JSON.stringify(snapshot)]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found.' });
  res.json(rows[0]);
  // Joint dine-in, Stage 2: "food comes first before payment... they can
  // pay when ever they are ready" -- fires after the response so a slow
  // WhatsApp send never holds up the staff member's own "Served" tap.
  // Best-effort internally (see notifyGuestsReadyToPay) -- one guest's
  // send failing never blocks another's, and this whole step failing
  // never undoes the serve itself, which has already happened.
  notifyGuestsReadyToPay(rows[0]).catch((err) => console.error('notifyGuestsReadyToPay failed:', err.message));
});

// Stage 6 -- the dashboard fallback for closing a table (spec 6.2: build
// this regardless of POS access, it's the only close path a client with no
// POS has at all). Doesn't send feedback itself -- that already went out
// per-order the moment each one was marked paid (POST /orders/:id/status,
// see engine/flow.js's sendFeedbackRequest), not once at table-close.
// Blocked while any order from this sitting is still outstanding -- a
// table can't free up (a new party seated, a new session started on the
// same physical table) until every round has actually been paid, not just
// served. Chidera 2026-09-11: "until the waiter marked paid/fulfilled from
// the second pipline then the table can reopen." In practice this manual
// button is now the fallback -- marking the last order paid closes the
// table on its own (see closeTableSessionIfSettled's call site), this
// stays for a table someone needs to force-close (e.g. a walked-out,
// never-paid order got cancelled instead of completed).
router.post('/tables/:id/close', requireEditorApi, async (req, res) => {
  const { rows: session } = await pool.query(
    `select id from table_session where table_id = $1 and closed_at is null`,
    [req.params.id]
  );
  if (!session[0]) return res.status(404).json({ error: 'No open session for this table.' });
  const closed = await closeTableSessionIfSettled(session[0].id, { closedBy: 'staff', staffId: req.staff.id });
  if (!closed) {
    return res.status(409).json({ error: 'This table still has an order awaiting payment -- mark it paid first.' });
  }
  res.json(closed);
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
