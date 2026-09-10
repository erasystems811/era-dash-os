// Dine-in add-on, Stage 4-5: the guest-facing menu page
// (EBOS-Addon-Schema-Dine-In.md section 4) and the order review/confirm
// that sends it into the existing order engine (section 5). Public, no
// login (the qr_token is the identity) -- mounted at /t in server.js,
// same as routes/documents.js and routes/tracking.js.
import express from 'express';
import { pool } from '../lib/db.js';
import { renderMenuPage } from '../engine/menu-page-template.js';
import { sendConfirmButtons } from '../engine/flow.js';
import { getWhatsAppCredentials } from '../engine/branch-channel.js';
import { getWaDisplayNumber } from '../engine/whatsapp-send.js';

export const router = express.Router();

async function resolveTable(qrToken) {
  const { rows } = await pool.query(
    `select rt.*, b.name as branch_name, biz.name as business_name,
       (biz.cover_photo_data_url is not null) as has_cover_photo
     from restaurant_table rt join branch b on b.id = rt.branch_id, business biz
     where rt.qr_token = $1 and rt.status = 'active'`,
    [qrToken]
  );
  return rows[0] || null;
}

// has_cover_photo, not the photo itself -- shared with routes/menu-page.js,
// which has no table row to piggyback this onto the way resolveTable above
// does. Just the boolean means this never has to pull a potentially large
// data: URI into Node just to check whether one's set (routes/product-
// photo.js's /photo/cover serves the actual bytes, on its own request).
export async function resolveMenuBranding(branchId) {
  const { rows } = await pool.query(
    `select biz.name as business_name, (biz.cover_photo_data_url is not null) as has_cover_photo
     from branch b, business biz
     where b.id = $1`,
    [branchId]
  );
  return rows[0] || {};
}

// The real number a wa.me link needs -- NOT business.phone_number (a free-
// text contact field in Settings, not necessarily ever connected to
// WhatsApp: era-demo's is a placeholder, and a wa.me link built from it
// produced "this number isn't on WhatsApp, Invite / Cancel" every time.
// Chidera 2026-09-10. Resolved from Meta's own record of what's actually
// connected to this branch's phone_number_id (falls back to the single
// shared env-var pair when no branch_channel row exists, same as every
// other credentials lookup in this codebase).
export async function resolveWaNumber(branchId) {
  const credentials = await getWhatsAppCredentials(branchId);
  return getWaDisplayNumber(credentials);
}

async function openSessionFor(table) {
  const { rows } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [table.id]);
  return rows[0] || null;
}

// Own query, not fields.js's resolveMenu -- that one is shaped for AI
// prompt context (no images, no availability detail) and reused all over
// the order-taking engine; bloating it with base64 photos for every call
// site would be a real cost/latency regression there. This page needs the
// opposite: every real detail, for a human looking at pictures. Exported --
// routes/menu-page.js (the non-table, regular-ordering version of this
// same page) uses the exact same query.
export async function menuForBranch(branchId) {
  const { rows } = await pool.query(
    `select id, name, description, price, category, image_data_url, availability
     from product
     where (branch_id = $1 or branch_id is null) and import_status is distinct from 'new'
     order by category nulls last, name`,
    [branchId]
  );
  return rows;
}

router.get('/:qrToken/menu.json', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const products = await menuForBranch(table.branch_id);
  res.json({
    table: { label: table.label, branch_name: table.branch_name, business_name: table.business_name },
    products,
  });
});

router.post('/:qrToken/review', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).json({ error: 'Table not found.' });
  const session = await openSessionFor(table);
  if (!session || !session.customer_id) {
    // No consent-establishing scan on record for this table right now --
    // spec 2.1: WhatsApp requires the guest to have messaged first. Rare
    // in practice (this page is only ever opened FROM that chat), but a
    // stale bookmark or a shared link could hit this.
    return res.status(409).json({ error: 'Please message us on WhatsApp first by scanning the table QR code again.' });
  }
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Your basket is empty.' });

  const { rows: customerRows } = await pool.query('select * from customers where id = $1', [session.customer_id]);
  const customer = customerRows[0];
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });

  const products = await menuForBranch(table.branch_id);
  const byId = new Map(products.map((p) => [p.id, p]));
  const resolved = [];
  for (const item of items) {
    const p = byId.get(item.productId);
    if (!p || !p.availability) continue; // never trust the client's own price/availability claim
    const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
    resolved.push({ productId: p.id, name: p.name, price: p.price, quantity: qty });
  }
  if (!resolved.length) return res.status(400).json({ error: "Sorry, nothing in your basket is available right now." });

  const ref = `ORD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const { rows: orderRows } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status)
     values ($1, $2, $3, 'dinein', $4, $5, 'table', 'at_table', 'confirm_order', 'new') returning *`,
    [customer.id, ref, table.branch_id, table.id, session.id]
  );
  const order = orderRows[0];
  for (const item of resolved) {
    await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4)', [order.id, item.productId, item.quantity, item.price]);
  }
  const total = resolved.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);

  // The read-back happens in the chat, not on this page (spec 5.1/5.2) --
  // this page's own job is done once the order + items exist; dispatch()
  // picks the rest up the next time this customer's order is touched. A
  // dine-in order's very first message IS this read-back, sent directly
  // here rather than waiting for dispatch() (which only reacts to an
  // inbound customer message, and there isn't one right now).
  const lines = resolved.map((i) => `${i.quantity}x ${i.name}: NGN ${i.price}`).join('\n');
  await sendConfirmButtons(customer, `To confirm your order for Table ${table.label}:\n${lines}\nTotal: NGN ${total}`, 'dinein_review');

  res.json({ ok: true });
});

router.get('/:qrToken', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).send('Table not found.');
  const [products, waNumber] = await Promise.all([menuForBranch(table.branch_id), resolveWaNumber(table.branch_id)]);
  res.set('Content-Type', 'text/html').send(
    renderMenuPage({
      reviewPath: `/t/${req.params.qrToken}/review`,
      businessName: table.business_name,
      subtitle: `Table ${table.label} · ${table.branch_name}`,
      hasCoverPhoto: table.has_cover_photo,
      waNumber,
      products,
      // A dine-in round is always a fresh order (a table ordering drinks,
      // then food later, is two real separate rounds to the kitchen, not
      // one growing order) -- no pending-order basket to pre-load here.
      pendingOrder: null,
      initialCategory: req.query.cat || null,
    })
  );
});
