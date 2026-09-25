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
  const { rows: customerRows } = await pool.query('select name, phone_number, address, menu_token from customers where id = $1', [order.customer_id]);
  const { rows: bizRows } = await pool.query(
    'select name, address, phone_number, bank_name, bank_account_number, bank_account_name, logo_data_url, brand_color from business limit 1'
  );
  return { order, items, customer: customerRows[0] || {}, business: bizRows[0] || {} };
}

// A top-up invoice (engine/flow.js's sendTopupInvoice, for items added to an
// already-paid order) reuses the exact same documentPage() template -- just
// with the order_topup row's own snapshot items/amount in place of the
// order's full items/total, and its own reference so it never reads as a
// duplicate of the original invoice.
async function loadTopupForDocument(topupId) {
  const { rows: topupRows } = await pool.query('select * from order_topup where id = $1', [topupId]);
  const topup = topupRows[0];
  if (!topup) return null;
  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [topup.order_id]);
  const order = orderRows[0];
  if (!order) return null;
  const { rows: customerRows } = await pool.query('select name, phone_number, address, menu_token from customers where id = $1', [order.customer_id]);
  const { rows: bizRows } = await pool.query(
    'select name, address, phone_number, bank_name, bank_account_number, bank_account_name, logo_data_url, brand_color from business limit 1'
  );
  const topupOrder = {
    ...order,
    reference: `${order.reference}-TOPUP`,
    total: topup.amount,
    delivery_fee: 0,
    // Chidera, 2026-09-20: "totally stop sending account number... use
    // just paystack" -- a topup now gets its own real Paystack link
    // (engine/payment.js's initializePaystackTopupTransaction), so this
    // reads the topup's own real value instead of the hardcoded null that
    // used to force the bank-account fallback below unconditionally.
    payment_link_url: topup.payment_link_url,
    payment_status: topup.payment_status === 'confirmed' ? 'confirmed' : 'pending',
  };
  return { order: topupOrder, items: topup.items, customer: customerRows[0] || {}, business: bizRows[0] || {} };
}

// Chidera, 2026-09-25: "how it was paid" for the receipt template below --
// order.payment_method only ever gets set by the manual Mark-paid/POS
// flow (routes/api.js's /orders/:id/payment-method); every automated
// path (Paystack/Monnify/OPay/Moniepoint webhook) never sets it at all.
// "Online payment" is the honest label for that case -- naming a specific
// provider would be a guess this order row can't actually back up.
function paymentMethodLabel(order) {
  if (order.payment_method === 'cash') return 'Cash';
  if (order.payment_method === 'card') return 'Card';
  if (order.payment_method === 'transfer') return 'Bank transfer';
  return 'Online payment';
}

// Chidera, 2026-09-25: "let it have the business branding colour just the
// look of a receipt" -- the receipt's own checkmark/headline accent below
// needs a soft TINTED version of an arbitrary brand hex (badge background),
// not just the solid colour -- this is that tint, at whatever alpha the
// caller wants, computed from the same hex readableTextColor already
// parses rather than a second, different colour-parsing routine.
function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(28, 24, 21, ${alpha})`;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

// Same warm paper/Fraunces/Inter app-shell as the web menu, tracking, and
// feedback-form pages -- Chidera 2026-09-11: "can invoice be an internal
// web page too?" Font loading here is deliberately a normal, BLOCKING
// stylesheet <link> (not the async media="print" trick those other pages
// use) -- this same markup is also what Gotenberg screenshots straight to
// PDF (renderPdf below), which never waits around for a font to swap in
// after first paint the way a live browser tab would; a page that starts
// synchronous never sends a customer a PDF missing its own brand fonts.
function documentPage({ title, business, customer, order, items }) {
  const brand = business.brand_color || '#1C1815';
  const onBrand = readableTextColor(brand);
  const rows = items
    .map(
      (i) =>
        `<tr><td>${esc(i.name)}</td><td>${i.quantity}</td><td>${Number(i.price).toFixed(2)}</td><td>${(Number(i.price) * i.quantity).toFixed(2)}</td></tr>`
    )
    .join('');

  // Also gates whether the bank account box below even shows -- Chidera,
  // 2026-09-20: "when there is a paystack already no need for invoice to
  // have account number." Showing both used to hand a customer two
  // different ways to pay the same invoice, which is exactly the kind of
  // ambiguity a real Paystack link (card or transfer, already reconciled
  // automatically) exists to remove -- the bank box stays only for orders
  // with no real payment link at all (no showPayNow) or already settled.
  const showPayNow = order.payment_link_url && !['confirmed', 'accepted'].includes(order.payment_status);
  const deliveryFeeRow =
    Number(order.delivery_fee) > 0
      ? `<tr><td colspan="3">Delivery fee</td><td>${Number(order.delivery_fee).toFixed(2)}</td></tr>`
      : '';

  // Chidera, 2026-09-23, live report: "when i open an invoice it seems
  // like im stuck i cant go back to the web whatsapp i have to go back to
  // main chat." This page is reached by tapping the invoice bubble's link
  // ON the /wa chat page -- a normal same-tab navigation, which replaces
  // the chat page in whatever browser (often WhatsApp's own in-app one)
  // is showing it, with nothing here pointing back. Only shown when this
  // customer actually has a menu_token (i.e. genuinely reached via the
  // web-chat flow) -- a customer who got their real invoice PDF over
  // WhatsApp/Instagram directly has no chat page to return to, so no link
  // that would go nowhere useful.
  return `<!doctype html>
<html style="background:#F6F1E8"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} ${esc(order.reference)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap">
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB}
  *{box-sizing:border-box}
  html,body{background:var(--paper)}
  body { font-family: "Inter", system-ui, sans-serif; max-width: 640px; margin: 2.5rem auto; padding: 0 1rem 3rem; color: var(--ink); }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
  .logo { max-height: 48px; max-width: 200px; margin-bottom: 6px; border-radius: 6px; }
  .biz-name { font-family: "Fraunces", serif; font-weight: 700; font-size: 17px; }
  .doc-title { font-family: "Fraunces", serif; font-size: 24px; font-weight: 700; text-align: right; letter-spacing: 0.01em; }
  .doc-meta { text-align: right; font-size: 12.5px; color: var(--mid); margin-top: 4px; }
  .bill-to { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin: 18px 0; }
  .bill-to .label { font-size: 11px; font-weight: 700; color: var(--mid); letter-spacing: 0.04em; }
  table { border-collapse: collapse; width: 100%; margin: 18px 0; background: #fff; border-radius: 12px; overflow: hidden; border: 1px solid var(--line); }
  th { background: ${brand}; color: ${onBrand}; text-align: left; padding: 10px 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; }
  tr:last-child td { border-bottom: 0; }
  .total-row { text-align: right; font-size: 17px; font-weight: 700; margin: 14px 4px 26px; }
  .boxes { display: flex; gap: 16px; flex-wrap: wrap; }
  .box { flex: 1; min-width: 200px; background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .box .label { font-size: 11px; font-weight: 700; color: var(--mid); letter-spacing: 0.04em; margin-bottom: 8px; }
  .pay-btn { display: inline-block; margin-top: 10px; background: ${brand}; color: ${onBrand}; text-decoration: none; padding: 9px 16px; border-radius: 999px; font-weight: 600; font-size: 13.5px; }
  .footer { text-align: center; color: var(--mid); font-size: 12px; margin-top: 32px; }
  /* Chidera: "let my invoices now have a powered by era systems imprint
     like a branking not too shouty or attention seeking." Small, muted,
     below the business's own footer -- their own name/address/phone stays
     the primary thing a customer reads, this is a quiet mark underneath
     it, not a second brand competing for attention. Ported from main
     (fd5a018) -- this branch's own routes/documents.js never had it. */
  .era-mark { text-align: center; color: var(--mid); font-size: 10.5px; letter-spacing: 0.03em; margin-top: 8px; opacity: 0.65; }
  /* Chidera, 2026-09-24: "that back to chat in invoice is not visibly
     obvious." Was plain small gray text, easy to miss above the header --
     a real chip button now, same white-card-on-paper weight as .bill-to/
     .box already use elsewhere on this page, so it actually reads as a
     tappable control. */
  .back-link { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 18px; background: #fff; border: 1px solid var(--line); color: var(--ink); text-decoration: none; font-weight: 600; font-size: 13.5px; padding: 9px 16px 9px 12px; border-radius: 999px; }
  .back-link:active { background: var(--paper); }
</style></head>
<body>
  ${
    customer.menu_token && process.env.PUBLIC_URL
      ? `<a class="back-link" href="${esc(process.env.PUBLIC_URL)}/wa/${esc(customer.menu_token)}">&#8249; Back to chat</a>`
      : ''
  }
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
      ${showPayNow
        ? `Tap below to pay securely by card or transfer.<br><a class="pay-btn" href="${esc(order.payment_link_url)}">Pay now</a>`
        : business.bank_name
          ? `Bank: ${esc(business.bank_name)}<br>Account: ${esc(business.bank_account_number)}<br>Name: ${esc(business.bank_account_name)}`
          : 'Contact the business for payment details.'}
    </div>
    <div class="box">
      <div class="label">STATUS</div>
      Payment: ${esc(order.payment_status)}<br>
      Order: ${esc(order.status)}
    </div>
  </div>

  <div class="footer">${esc(business.name)} &middot; ${esc(business.address || '')} &middot; ${esc(business.phone_number || '')}</div>
  <div class="era-mark">Powered by ERA Systems</div>
</body></html>`;
}

// Chidera, 2026-09-25: "after payment is confirmed instead of the bare
// payment received, send customer a receipt, but receipt shouldnt look
// like invoice it is a receipt." First version deliberately avoided the
// invoice's pending-payment language, but kept its same wide bordered
// item-table layout with a different badge stuck on top -- follow-up,
// same day: "the styling of the receipt i dont like it, it looks almost
// like the invoice, have you seen all these paystack them receipt
// before?" Rebuilt around the pattern real payment confirmations
// actually use (Paystack/Stripe-style): a narrow centered card, a big
// green checkmark, the amount as the single dominant thing on the page,
// then a short clean list of details -- not a wide invoice grid. Items
// still shown for record-keeping, but as a de-emphasized plain list
// underneath, not the page's main event.
// Chidera, 2026-09-25, follow-up: "let it have the business branding
// colour just the look of a receipt" -- the checkmark badge/headline
// below were a fixed success-green; now the business's own brand_color
// (same field the invoice/menu/tracking pages already brand with), so
// this still reads as THIS business's receipt, not a generic template.
function receiptPage({ business, customer, order, items }) {
  const brand = business.brand_color || '#1C1815';
  const itemRows = items
    .map(
      (i) =>
        `<div class="item-row"><span><span class="qty">${i.quantity}&times;</span>${esc(i.name)}</span><span>${Number(i.price * i.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>`
    )
    .join('');
  const deliveryFeeRow =
    Number(order.delivery_fee) > 0
      ? `<div class="item-row"><span>Delivery fee</span><span>${Number(order.delivery_fee).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></div>`
      : '';

  return `<!doctype html>
<html style="background:#F6F1E8"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Receipt ${esc(order.reference)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Inter:wght@400;500;600&display=swap">
<style>
  :root{--paper:#F6F1E8;--ink:#1C1815;--mid:#6E6156;--line:#E2D9CB;--accent:${brand};--accent-soft:${hexToRgba(brand, 0.12)}}
  *{box-sizing:border-box}
  html,body{background:var(--paper)}
  body { font-family: "Inter", system-ui, sans-serif; max-width: 420px; margin: 2.5rem auto; padding: 0 1rem 3rem; color: var(--ink); }
  .card { background: #fff; border-radius: 20px; padding: 32px 26px 26px; text-align: center; box-shadow: 0 1px 3px rgba(28,24,21,0.06), 0 10px 28px rgba(28,24,21,0.06); }
  .check-badge { width: 60px; height: 60px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; margin: 0 auto 16px; }
  .check-badge svg { width: 28px; height: 28px; }
  .headline { font-family: "Fraunces", serif; font-weight: 700; font-size: 19px; color: var(--accent); }
  .biz-name { font-size: 13px; color: var(--mid); margin-top: 3px; }
  .amount { font-family: "Fraunces", serif; font-size: 36px; font-weight: 700; margin: 18px 0 22px; letter-spacing: -0.01em; }
  .divider { border-top: 1px dashed var(--line); margin: 4px 0 14px; }
  .detail-row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 13.5px; text-align: left; }
  .detail-row span:first-child { color: var(--mid); }
  .detail-row span:last-child { font-weight: 600; text-align: right; }
  .items-label { font-size: 10.5px; font-weight: 700; color: var(--mid); letter-spacing: 0.05em; text-align: left; margin: 20px 0 6px; }
  .item-row { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; font-size: 13px; text-align: left; color: var(--mid); }
  .item-row .qty { color: var(--ink); font-weight: 600; margin-right: 4px; }
  .footer { text-align: center; color: var(--mid); font-size: 12px; margin-top: 26px; }
  .era-mark { text-align: center; color: var(--mid); font-size: 10.5px; letter-spacing: 0.03em; margin-top: 8px; opacity: 0.65; }
  /* Chidera, 2026-09-25: "receipt doesnt have the back to chat" -- same
     real chip button the invoice page already has (.back-link there),
     never ported over when this page was rebuilt around the receipt-card
     layout. */
  .back-link { display: inline-flex; align-items: center; gap: 4px; margin-bottom: 18px; background: #fff; border: 1px solid var(--line); color: var(--ink); text-decoration: none; font-weight: 600; font-size: 13.5px; padding: 9px 16px 9px 12px; border-radius: 999px; }
  .back-link:active { background: var(--paper); }
</style></head>
<body>
  ${
    customer.menu_token && process.env.PUBLIC_URL
      ? `<a class="back-link" href="${esc(process.env.PUBLIC_URL)}/wa/${esc(customer.menu_token)}">&#8249; Back to chat</a>`
      : ''
  }
  <div class="card">
    ${business.logo_data_url ? `<img src="${esc(business.logo_data_url)}" alt="${esc(business.name)}" style="max-height:36px;max-width:160px;border-radius:6px;margin-bottom:14px;">` : ''}
    <div class="check-badge">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
    </div>
    <div class="headline">Payment successful</div>
    <div class="biz-name">${esc(business.name)}</div>
    <div class="amount">NGN ${Number(order.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>

    <div class="divider"></div>
    <div class="detail-row"><span>Received from</span><span>${esc(customer.name || customer.phone_number)}</span></div>
    <div class="detail-row"><span>Reference</span><span>${esc(order.reference)}</span></div>
    <div class="detail-row"><span>Date</span><span>${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span></div>
    <div class="detail-row"><span>Paid via</span><span>${esc(paymentMethodLabel(order))}</span></div>

    <div class="items-label">ITEMS</div>
    ${itemRows}
    ${deliveryFeeRow}
  </div>

  <div class="footer">Thank you for your order &middot; ${esc(business.name)}</div>
  <div class="era-mark">Powered by ERA Systems</div>
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

// Chidera, 2026-09-20: "when i changed the order the invoice did not
// update it was still the old order" -- all four routes below already
// re-read order_item live on every single request (loadOrderForDocument),
// no caching, no stored PDF file, so an edit really is reflected the next
// time any of these actually runs on the server. Never found a server-
// side reason it wouldn't -- but neither this route nor Express set any
// cache header at all, which leaves the door open for the browser (or
// WhatsApp's own in-app browser, already known to cache a media URL
// harder than a normal browser does -- see businessCoverPhotoUrl's own
// comment on the exact same class of problem) to just serve back whatever
// it fetched from this same URL the first time, never asking the server
// again. Explicit no-store closes that off regardless of which browser is
// asking. Doesn't help a PDF that was already generated and sent/
// downloaded before the edit, though -- that's a real, separate file by
// then, not a link, and no server-side change can make an already-
// delivered file update itself.
function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

router.get('/invoice/:orderId', async (req, res) => {
  const data = await loadOrderForDocument(req.params.orderId);
  if (!data) return res.status(404).send('Not found.');
  noStore(res);
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
  noStore(res);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="invoice-${data.order.reference}.pdf"`);
  res.send(pdf);
});

router.get('/topup/:topupId', async (req, res) => {
  const data = await loadTopupForDocument(req.params.topupId);
  if (!data) return res.status(404).send('Not found.');
  noStore(res);
  res.send(documentPage({ title: 'Top-up invoice', ...data }));
});

router.get('/topup/:topupId/pdf', async (req, res) => {
  const data = await loadTopupForDocument(req.params.topupId);
  if (!data) return res.status(404).send('Not found.');
  const pdf = await renderPdf(documentPage({ title: 'Top-up invoice', ...data }));
  noStore(res);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="topup-${data.order.reference}.pdf"`);
  res.send(pdf);
});

router.get('/receipt/:orderId', async (req, res) => {
  const data = await loadOrderForDocument(req.params.orderId);
  if (!data) return res.status(404).send('Not found.');
  noStore(res);
  res.send(receiptPage(data));
});

router.get('/receipt/:orderId/pdf', async (req, res) => {
  const data = await loadOrderForDocument(req.params.orderId);
  if (!data) return res.status(404).send('Not found.');
  const pdf = await renderPdf(receiptPage(data));
  noStore(res);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="receipt-${data.order.reference}.pdf"`);
  res.send(pdf);
});

// order_payment_proof holds every proof image a customer has ever sent for
// this order (engine/flow.js's handleInboundMedia -- a top-up needs its own
// proof without losing the original one), most recent first. Falls back to
// the old single order.payment_proof_url column only when there's no row
// yet in the new table -- an order already mid-flow the moment this shipped
// shouldn't lose its already-submitted proof. Data URIs are useless pasted
// directly into a WhatsApp text message (often tens of thousands of
// characters, and not a URL WhatsApp will render as a link anyway); this
// re-serves the latest one as a real, short, clickable URL, decoding it
// back into actual bytes with the right Content-Type -- the same trick the
// invoice/receipt pages already rely on for logos.
router.get('/payment-proof/:orderId', async (req, res) => {
  const { rows } = await pool.query(
    'select data_url from order_payment_proof where order_id = $1 order by created_at desc limit 1',
    [req.params.orderId]
  );
  let dataUrl = rows[0]?.data_url;
  if (!dataUrl) {
    const { rows: orderRows } = await pool.query('select payment_proof_url from "order" where id = $1', [req.params.orderId]);
    dataUrl = orderRows[0]?.payment_proof_url;
  }
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
