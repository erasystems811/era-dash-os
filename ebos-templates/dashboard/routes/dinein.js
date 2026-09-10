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

export const router = express.Router();

// The number a table's QR code actually points at -- the branch's own
// dedicated WhatsApp number (branch_channel/branch.whatsapp_number) once
// it has one, else the one shared business number every table falls back
// to today. Digits only: wa.me takes a bare MSISDN, not a formatted
// number with a leading + or spaces.
async function whatsappNumberForBranch(branchId) {
  const { rows } = await pool.query(
    `select coalesce(b.whatsapp_number, biz.phone_number) as number
     from branch b, business biz
     where b.id = $1
     limit 1`,
    [branchId]
  );
  const raw = rows[0]?.number;
  return raw ? raw.replace(/\D/g, '') : null;
}

async function qrDataUrlFor(table, whatsappNumber) {
  if (!whatsappNumber) return null;
  const text = encodeURIComponent(`Menu Table ${table.label}`);
  const link = `https://wa.me/${whatsappNumber}?text=${text}`;
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
  if (!f.branch_id || !f.label) return res.status(400).json({ error: 'branch_id and label are required.' });
  const { rows } = await pool.query(
    'insert into restaurant_table (branch_id, label, qr_token, seats) values ($1, $2, $3, $4) returning *',
    [f.branch_id, f.label, randomBytes(16).toString('hex'), f.seats || null]
  );
  res.json(rows[0]);
});

router.post('/tables/:id', requireEditorApi, async (req, res) => {
  const f = req.body;
  const { rows } = await pool.query(
    'update restaurant_table set label = $1, seats = $2, status = $3 where id = $4 returning *',
    [f.label, f.seats || null, f.status || 'active', req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Table not found.' });
  res.json(rows[0]);
});

// A stolen or renumbered printed card is invalidated by giving the table a
// fresh qr_token -- the old printed code still decodes to a real wa.me
// link (it only ever encoded the number + table label text, not the
// token itself, see qrDataUrlFor above), so the actual protection here is
// operational (reprint and swap the card), not cryptographic. This exists
// so the dashboard has a real "regenerate" action to pair with that swap,
// and so a regenerated token shows up as a visibly different QR image.
router.post('/tables/:id/regenerate-qr', requireEditorApi, async (req, res) => {
  const { rows } = await pool.query(
    'update restaurant_table set qr_token = $1 where id = $2 returning *',
    [randomBytes(16).toString('hex'), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Table not found.' });
  res.json(rows[0]);
});

router.post('/waiter-calls/:id/resolve', async (req, res) => {
  const { rows } = await pool.query(
    `update waiter_call set status = 'resolved', resolved_by = $1, resolved_at = now() where id = $2 returning *`,
    [req.staff?.id || null, req.params.id]
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
