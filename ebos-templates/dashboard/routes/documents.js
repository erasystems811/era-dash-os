import express from 'express';
import { pool } from '../lib/db.js';
import { esc } from '../lib/render.js';

export const router = express.Router();

async function loadOrderForDocument(orderId) {
  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = orderRows[0];
  if (!order) return null;
  const { rows: items } = await pool.query(
    `select p.name, oi.quantity, oi.price from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
    [orderId]
  );
  const { rows: customerRows } = await pool.query('select name, phone_number, address from customers where id = $1', [order.customer_id]);
  const { rows: bizRows } = await pool.query(
    'select name, address, phone_number, bank_name, bank_account_number, bank_account_name, logo_data_url, brand_color from business limit 1'
  );
  return { order, items, customer: customerRows[0] || {}, business: bizRows[0] || {} };
}

// Picks readable text over an arbitrary brand colour instead of assuming
// it's always dark -- a business that picks a pale brand colour would
// otherwise get white-on-white header text.
function readableTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#111827' : '#ffffff';
}

function documentPage({ title, business, customer, order, items }) {
  const brand = business.brand_color || '#111827';
  const onBrand = readableTextColor(brand);
  const rows = items
    .map(
      (i) =>
        `<tr><td>${esc(i.name)}</td><td>${i.quantity}</td><td>${Number(i.price).toFixed(2)}</td><td>${(Number(i.price) * i.quantity).toFixed(2)}</td></tr>`
    )
    .join('');

  const showPayNow = order.payment_link_url && !['confirmed', 'accepted'].includes(order.payment_status);
  const deliveryFeeRow =
    Number(order.delivery_fee) > 0
      ? `<tr><td colspan="3">Delivery fee</td><td>${Number(order.delivery_fee).toFixed(2)}</td></tr>`
      : '';

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} ${esc(order.reference)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 680px; margin: 2.5rem auto; padding: 0 1rem; color: #111827; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
  .logo { max-height: 48px; max-width: 200px; margin-bottom: 6px; }
  .biz-name { font-weight: 700; font-size: 16px; }
  .doc-title { font-size: 26px; font-weight: 800; text-align: right; letter-spacing: 0.02em; }
  .doc-meta { text-align: right; font-size: 12.5px; color: #6b7280; margin-top: 4px; }
  .bill-to { background: #f3f4f6; border-radius: 8px; padding: 14px 16px; margin: 18px 0; }
  .bill-to .label { font-size: 11px; font-weight: 700; color: #6b7280; letter-spacing: 0.04em; }
  table { border-collapse: collapse; width: 100%; margin: 18px 0; }
  th { background: ${brand}; color: ${onBrand}; text-align: left; padding: 9px 12px; font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.03em; }
  td { padding: 10px 12px; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
  .total-row { text-align: right; font-size: 16px; font-weight: 800; margin: 14px 0 26px; }
  .boxes { display: flex; gap: 16px; }
  .box { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; }
  .box .label { font-size: 11px; font-weight: 700; color: #6b7280; letter-spacing: 0.04em; margin-bottom: 8px; }
  .pay-btn { display: inline-block; margin-top: 10px; background: ${brand}; color: ${onBrand}; text-decoration: none; padding: 9px 16px; border-radius: 8px; font-weight: 700; font-size: 13.5px; }
  .footer { text-align: center; color: #9ca3af; font-size: 12px; margin-top: 32px; }
</style></head>
<body>
  <div class="header">
    <div>
      ${business.logo_data_url ? `<img class="logo" src="${esc(business.logo_data_url)}" alt="${esc(business.name)}">` : ''}
      <div class="biz-name">${esc(business.name)}</div>
    </div>
    <div>
      <div class="doc-title">${esc(title).toUpperCase()}</div>
      <div class="doc-meta">Reference: ${esc(order.reference)}<br>Date: ${new Date(order.created_at).toLocaleDateString()}</div>
    </div>
  </div>

  <div class="bill-to">
    <div class="label">BILLED TO</div>
    <strong>${esc(customer.name || customer.phone_number)}</strong>
    ${customer.address ? `<br>${esc(customer.address)}` : ''}
  </div>

  <table>
    <tr><th>Item</th><th>Qty</th><th>Price</th><th>Line total</th></tr>
    ${rows}
    ${deliveryFeeRow}
  </table>
  <div class="total-row">Total: NGN ${Number(order.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>

  <div class="boxes">
    <div class="box">
      <div class="label">PAYMENT INFORMATION</div>
      ${business.bank_name ? `Bank: ${esc(business.bank_name)}<br>Account: ${esc(business.bank_account_number)}<br>Name: ${esc(business.bank_account_name)}` : 'Contact the business for payment details.'}
      ${showPayNow ? `<br><a class="pay-btn" href="${esc(order.payment_link_url)}">Pay now</a>` : ''}
    </div>
    <div class="box">
      <div class="label">STATUS</div>
      Payment: ${esc(order.payment_status)}<br>
      Order: ${esc(order.status)}
    </div>
  </div>

  <div class="footer">${esc(business.name)} &middot; ${esc(business.address || '')} &middot; ${esc(business.phone_number || '')}</div>
</body></html>`;
}

// Gotenberg's Chromium route renders whatever HTML file is named
// "index.html" in the multipart body -- that's Gotenberg's own requirement,
// not a choice made here. Internal-only service (docker-compose.yml.template),
// reached by its service name, same network, no port published.
const GOTENBERG_URL = 'http://gotenberg:3000';

async function renderPdf(html) {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  const res = await fetch(`${GOTENBERG_URL}/forms/chromium/convert/html`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`PDF render failed ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

router.get('/invoice/:orderId', async (req, res) => {
  const data = await loadOrderForDocument(req.params.orderId);
  if (!data) return res.status(404).send('Not found.');
  res.send(documentPage({ title: 'Invoice', ...data }));
});

// A link to the HTML page above is useless as "the invoice" in a WhatsApp
// message -- customers expect an actual file. This renders the identical
// page to a real PDF on the fly (no separate template to keep in sync) --
// sent as a WhatsApp document via its own public URL (whatsapp-send.js's
// sendWhatsAppDocument), not the raw HTML link.
router.get('/invoice/:orderId/pdf', async (req, res) => {
  const data = await loadOrderForDocument(req.params.orderId);
  if (!data) return res.status(404).send('Not found.');
  const pdf = await renderPdf(documentPage({ title: 'Invoice', ...data }));
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="invoice-${data.order.reference}.pdf"`);
  res.send(pdf);
});

router.get('/receipt/:orderId', async (req, res) => {
  const data = await loadOrderForDocument(req.params.orderId);
  if (!data) return res.status(404).send('Not found.');
  res.send(documentPage({ title: 'Receipt', ...data }));
});

// payment_proof_url is stored as a data: URI (same reasoning as
// logo_data_url -- no file storage needed for what's realistically always a
// small image or PDF), which is useless pasted directly into a WhatsApp
// text message (often tens of thousands of characters, and not a URL
// WhatsApp will render as a link anyway). This re-serves it as a real,
// short, clickable URL, decoding the data: URI back into actual bytes with
// the right Content-Type -- the same trick the invoice/receipt pages
// already rely on for logos.
router.get('/payment-proof/:orderId', async (req, res) => {
  const { rows } = await pool.query('select payment_proof_url from "order" where id = $1', [req.params.orderId]);
  const dataUrl = rows[0]?.payment_proof_url;
  if (!dataUrl) return res.status(404).send('Not found.');
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return res.status(404).send('Not found.');
  res.set('Content-Type', match[1]);
  res.send(Buffer.from(match[2], 'base64'));
});

// Same decode-on-read trick as payment-proof above, for the business's own
// menu photo(s) (menu_photo.data_url) -- WhatsApp/Instagram fetch outbound
// media by a real URL, not inline base64, so engine/flow.js sends this link
// rather than the raw data: URI.
router.get('/menu-photo/:id', async (req, res) => {
  const { rows } = await pool.query('select data_url from menu_photo where id = $1', [req.params.id]);
  const dataUrl = rows[0]?.data_url;
  if (!dataUrl) return res.status(404).send('Not found.');
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return res.status(404).send('Not found.');
  res.set('Content-Type', match[1]);
  res.send(Buffer.from(match[2], 'base64'));
});

// Same decode-on-read trick, for a single catalogue item's own photo
// (product.image_data_url) -- Meta's WhatsApp Catalogue fetches each item's
// image by a real URL (see engine/whatsapp-catalog.js), not inline base64.
router.get('/product-image/:id', async (req, res) => {
  const { rows } = await pool.query('select image_data_url from product where id = $1', [req.params.id]);
  const dataUrl = rows[0]?.image_data_url;
  if (!dataUrl) return res.status(404).send('Not found.');
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return res.status(404).send('Not found.');
  res.set('Content-Type', match[1]);
  res.send(Buffer.from(match[2], 'base64'));
});
