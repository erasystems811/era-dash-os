// Dine-in add-on, Stage 4-5: the guest-facing menu page
// (EBOS-Addon-Schema-Dine-In.md section 4) and the order review/confirm
// that sends it into the existing order engine (section 5). Public, no
// login (the qr_token is the identity) -- mounted at /t in server.js,
// same as routes/documents.js and routes/tracking.js.
import express from 'express';
import { pool } from '../lib/db.js';
import { getWhatsAppCredentials } from '../engine/branch-channel.js';
import { sendWhatsApp } from '../engine/whatsapp-send.js';

export const router = express.Router();

async function resolveTable(qrToken) {
  const { rows } = await pool.query(
    `select rt.*, b.name as branch_name, biz.name as business_name
     from restaurant_table rt join branch b on b.id = rt.branch_id, business biz
     where rt.qr_token = $1 and rt.status = 'active'`,
    [qrToken]
  );
  return rows[0] || null;
}

async function openSessionFor(table) {
  const { rows } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [table.id]);
  return rows[0] || null;
}

// Own query, not fields.js's resolveMenu -- that one is shaped for AI
// prompt context (no images, no availability detail) and reused all over
// the order-taking engine; bloating it with base64 photos for every call
// site would be a real cost/latency regression there. This page needs the
// opposite: every real detail, for a human looking at pictures.
async function menuForBranch(branchId) {
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
  const credentials = await getWhatsAppCredentials(table.branch_id);
  await sendWhatsApp(
    customer.phone_number,
    `To confirm your order for Table ${table.label}:\n${lines}\nTotal: NGN ${total}\n\nReply yes to send it to the kitchen, or let me know what you'd like to change.`,
    credentials
  );
  await pool.query(
    `insert into message (customer_id, direction, channel, sender, body, trigger) values ($1, 'outbound', 'whatsapp', 'bot', $2, 'dinein_review')`,
    [customer.id, `To confirm your order for Table ${table.label}: ${lines.replace(/\n/g, ', ')}. Total: NGN ${total}.`]
  );

  res.json({ ok: true });
});

router.get('/:qrToken', async (req, res) => {
  const table = await resolveTable(req.params.qrToken);
  if (!table) return res.status(404).send('Table not found.');
  res.set('Content-Type', 'text/html').send(renderMenuPage(req.params.qrToken, table));
});

// One self-contained HTML page, no build step -- vanilla JS, inline CSS.
// This is a guest-facing surface opened inside WhatsApp's in-app browser
// (spec 4.3: no external links, no login, fast on 3G), deliberately not
// folded into the React dashboard SPA, which is a completely different
// (staff-only, authenticated) application.
function renderMenuPage(qrToken, table) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${escapeHtml(table.business_name)} -- Table ${escapeHtml(table.label)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #fafafa; color: #111; padding-bottom: 90px; }
  header { position: sticky; top: 0; background: #fff; padding: 14px 16px; border-bottom: 1px solid #eee; z-index: 5; }
  header h1 { font-size: 18px; margin: 0; }
  header p { margin: 2px 0 0; color: #666; font-size: 13px; }
  .cats { display: flex; gap: 8px; overflow-x: auto; padding: 10px 16px; position: sticky; top: 56px; background: #fafafa; z-index: 4; }
  .cat-btn { flex: none; padding: 6px 14px; border-radius: 999px; border: 1px solid #ddd; background: #fff; font-size: 13px; white-space: nowrap; }
  .cat-btn.active { background: #111; color: #fff; border-color: #111; }
  .item { display: flex; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #eee; background: #fff; }
  .item img { width: 84px; height: 84px; border-radius: 8px; object-fit: cover; flex: none; background: #eee; }
  .item .tile { width: 84px; height: 84px; border-radius: 8px; flex: none; background: #d9c9a3; display: flex; align-items: center; justify-content: center; font-size: 11px; text-align: center; padding: 4px; color: #333; }
  .item .info { flex: 1; min-width: 0; }
  .item .name { font-weight: 600; font-size: 15px; }
  .item .desc { color: #666; font-size: 12px; margin-top: 2px; }
  .item .price { font-weight: 600; margin-top: 6px; }
  .item .add { margin-top: 6px; padding: 6px 14px; border-radius: 6px; border: none; background: #111; color: #fff; font-size: 13px; }
  .item.soldout .add { background: #ccc; color: #666; }
  .item .qty { font-size: 13px; color: #111; margin-top: 6px; }
  .basket { position: fixed; bottom: 0; left: 0; right: 0; background: #111; color: #fff; padding: 14px 16px; display: flex; justify-content: space-between; align-items: center; }
  .basket button { background: #fff; color: #111; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; }
  .basket.hidden { display: none; }
  .err { padding: 12px 16px; background: #fdecea; color: #611; }
</style></head>
<body>
<header><h1>${escapeHtml(table.business_name)}</h1><p>Table ${escapeHtml(table.label)}</p></header>
<div id="cats" class="cats"></div>
<div id="items"></div>
<div id="basket" class="basket hidden"><span id="basketText"></span><button id="reviewBtn">Review order</button></div>
<script>
const QR = ${JSON.stringify(qrToken)};
let products = [];
let basket = {}; // productId -> qty

function moneyLine(p) { return 'NGN ' + Number(p.price); }

function render(category) {
  const catsEl = document.getElementById('cats');
  const cats = ['All', ...new Set(products.map(p => p.category || 'Menu'))];
  catsEl.innerHTML = cats.map(c => '<button class="cat-btn' + (c === category ? ' active' : '') + '" data-cat="' + c + '">' + c + '</button>').join('');
  catsEl.querySelectorAll('.cat-btn').forEach(b => b.onclick = () => render(b.dataset.cat));

  const list = category === 'All' ? products : products.filter(p => (p.category || 'Menu') === category);
  document.getElementById('items').innerHTML = list.map(p => {
    const qty = basket[p.id] || 0;
    const media = p.image_data_url
      ? '<img src="' + p.image_data_url + '" alt="">'
      : '<div class="tile">' + p.name + '</div>';
    return '<div class="item' + (p.availability ? '' : ' soldout') + '">' + media +
      '<div class="info"><div class="name">' + p.name + '</div>' +
      (p.description ? '<div class="desc">' + p.description + '</div>' : '') +
      '<div class="price">' + moneyLine(p) + '</div>' +
      (p.availability
        ? '<button class="add" data-id="' + p.id + '">' + (qty ? 'Add another (' + qty + ')' : 'Add') + '</button>'
        : '<div class="qty">Sold out</div>') +
      '</div></div>';
  }).join('');
  document.querySelectorAll('.add').forEach(b => b.onclick = () => { basket[b.dataset.id] = (basket[b.dataset.id] || 0) + 1; render(category); updateBasket(); });
}

function updateBasket() {
  const count = Object.values(basket).reduce((a, b) => a + b, 0);
  const total = Object.entries(basket).reduce((sum, [id, qty]) => {
    const p = products.find(p => p.id === id);
    return sum + (p ? Number(p.price) * qty : 0);
  }, 0);
  const el = document.getElementById('basket');
  if (!count) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  document.getElementById('basketText').textContent = count + ' item' + (count > 1 ? 's' : '') + ' -- NGN ' + total;
}

document.getElementById('reviewBtn').onclick = async () => {
  const items = Object.entries(basket).map(([productId, quantity]) => ({ productId, quantity }));
  const res = await fetch('/t/' + QR + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Something went wrong.'); return; }
  document.body.innerHTML = '<div style="padding:40px 20px;text-align:center;font-family:sans-serif;"><h2>Order sent!</h2><p>Check WhatsApp to confirm it.</p></div>';
};

fetch('/t/' + QR + '/menu.json').then(r => r.json()).then(data => {
  products = data.products;
  render('All');
}).catch(() => {
  document.getElementById('items').innerHTML = '<div class="err">Could not load the menu. Please try again.</div>';
});
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
