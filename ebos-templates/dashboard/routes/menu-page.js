// The real web menu page for REGULAR (non-dine-in) ordering -- Chidera
// 2026-09-10: "the menu is meant to be like a site now... not just in
// dine in[,] the normal conversation flow". Same page as dine-in's
// table-scoped version (engine/menu-page-template.js), just resolved by
// customer.menu_token instead of a table's qr_token, since there's no
// table here -- public, no login, mounted at /m in server.js.
import express from 'express';
import { pool } from '../lib/db.js';
import { renderMenuPage, renderSingleOrderPayPage } from '../engine/menu-page-template.js';
import { menuForBranch, resolveMenuBranding, resolveWaNumber, resolveInstagramHandle } from './dinein-menu.js';
import { handleWebMenuOrder, getOpenOrder, notifyCustomerClaimedPosPayment, ensureDynamicPosAccount } from '../engine/flow.js';
import { getDeliveryConfig } from '../engine/delivery-zones.js';
import { estimateFeeForAddress } from '../engine/delivery.js';
import { getPaymentConfig } from '../engine/payment.js';

export const router = express.Router();

async function resolveCustomer(token) {
  const { rows } = await pool.query('select * from customers where menu_token = $1', [token]);
  return rows[0] || null;
}

// Chidera, 2026-09-22: this same page is now also where the web-chat page
// (routes/web-chat.js) sends a customer to actually pick items -- same
// "in-memory override, real DB row untouched" pattern as flow.js's
// completePayment (see 0060_website_chat.sql's own comment), keyed off
// the same web_chat_active_at breadcrumb, touched on every request into
// either page. Without this, an order submitted here would send real
// WhatsApp messages for a customer who's actually mid-session on the chat
// page.
const WEB_CHAT_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
function isViaWebChat(customer) {
  return Boolean(customer.web_chat_active_at) && new Date(customer.web_chat_active_at) > new Date(Date.now() - WEB_CHAT_ACTIVE_WINDOW_MS);
}

router.get('/:token/menu.json', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  const products = await menuForBranch(customer.branch_id);
  const pendingOrder = await pendingOrderPayload(customer.id);
  res.json({ business_name: bizRows[0]?.name, products, pendingOrder });
});

// So a guest who reopens "View menu" sees (and can edit) what's already
// pending instead of a page with no memory of it -- Chidera 2026-09-10:
// "how are they aware that the first one is still pending... how can they
// remove as well?" getOpenOrder is the same lookup the actual order
// engine uses (flow.js), so this always agrees with what a chat message
// would say.
async function pendingOrderPayload(customerId) {
  const order = await getOpenOrder(customerId);
  if (!order) return null;
  // p.name too -- Chidera 2026-09-10: "when you say they have 5 items
  // pending but they can't see the 5 orders". A count alone meant seeing
  // WHAT those items actually were required clicking through every
  // category looking for a stepper that wasn't at zero; the page can now
  // just list them by name.
  // answers -- Chidera, 2026-09-17: so a reopened link's basket rebuilds
  // the exact same distinct lines it left with (menu-page-template.js's
  // own PENDING_ORDER pre-load), not one merged line that's lost which
  // answer belonged to which unit. Same coalesce-to-'{}' reasoning as
  // flow.js's handleWebMenuOrder -- a plain item with no answers must
  // still come back as {}, matching the {} key the client always uses
  // for it, never NULL.
  const { rows: items } = await pool.query(
    `select oi.product_id, oi.quantity, p.name,
       coalesce(
         (select json_object_agg(oa.question_id, oa.answer) from order_item_answer oa where oa.order_item_id = oi.id),
         '{}'
       ) as answers
     from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
    [order.id]
  );
  if (!items.length) return null;
  // fulfilment -- Chidera, 2026-09-17: reopening a link should re-show
  // delivery/pickup + address/zone exactly as already decided, same "how
  // are they aware... how can they remove/change it" reasoning as the
  // basket items themselves.
  const { rows: customerRows } = await pool.query('select address from customers where id = $1', [customerId]);
  return {
    items: items.map((i) => ({ productId: i.product_id, quantity: i.quantity, name: i.name, answers: i.answers || {} })),
    total: Number(order.total) || 0,
    fulfilment: order.fulfilment_type
      ? { type: order.fulfilment_type, address: customerRows[0]?.address || null, zoneId: order.delivery_zone_id || null }
      : null,
  };
}

// Chidera, 2026-09-17: "the birthday pop up is meant to be on the
// customers website they place others not the staff dashboard" -- schema.sql's
// own crm_config migration already said this ("filled in via the... popup
// on an order's own page"), the first build just put it in the wrong
// place. Public, token-authenticated like /review above -- no staff
// session exists on this surface at all.
router.post('/:token/birthday', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const birthday = /^\d{4}-\d{2}-\d{2}$/.test(req.body?.birthday || '') ? req.body.birthday : null;
  if (!birthday) return res.status(400).json({ error: 'A valid date is required.' });
  await pool.query('update customers set birthday = $1 where id = $2', [birthday, customer.id]);
  res.json({ ok: true });
});

// Chidera, 2026-09-20: "we agreed a name so bot can refer to customer" --
// same shape/placement as the birthday popup just above (public, token-
// authenticated, the customer's own web menu rather than the staff
// dashboard). flow.js's handleGreeting is the one place this is actually
// read back so far -- "Hello [Name]!" instead of a plain "Hello!" once set.
router.post('/:token/name', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'A name is required.' });
  await pool.query('update customers set name = $1 where id = $2', [name, customer.id]);
  res.json({ ok: true });
});

// Chowdeck/manual mode -- the own_riders case never needs a live quote
// (the page already has every zone's real fee embedded, see GET /:token
// below), so this only ever runs for the address+"Check delivery fee"
// path. Public, token-authenticated like /review -- no order needs to
// exist yet, this can be asked while still just picking items.
router.post('/:token/delivery-quote', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const address = String(req.body?.address || '').trim();
  if (!address) return res.status(400).json({ error: 'Please enter a delivery address.' });
  const fee = await estimateFeeForAddress(address, customer.branch_id);
  res.json({ fee: fee || 0 });
});

router.post('/:token/review', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'Your basket is empty.' });

  // Never trust the client's own zoneId/fee claim any further than "which
  // zone did they mean" -- applyWebFulfilment (flow.js) re-reads the real
  // zone row itself before ever touching order.delivery_fee, same as
  // price/availability just below never trust the client's own claim.
  const fulfilmentType = ['delivery', 'pickup'].includes(req.body?.fulfilment?.type) ? req.body.fulfilment.type : null;
  const fulfilment = fulfilmentType
    ? {
        type: fulfilmentType,
        address: fulfilmentType === 'delivery' ? String(req.body.fulfilment.address || '').trim().slice(0, 500) || null : null,
        zoneId: fulfilmentType === 'delivery' && req.body.fulfilment.zoneId ? String(req.body.fulfilment.zoneId) : null,
      }
    : null;

  const products = await menuForBranch(customer.branch_id);
  const byId = new Map(products.map((p) => [p.id, p]));
  const resolved = [];
  for (const item of items) {
    const p = byId.get(item.productId);
    if (!p || !p.availability) continue; // never trust the client's own price/availability claim
    const qty = Number(item.quantity) > 0 ? Number(item.quantity) : 1;
    // Never trust the client's own answers object either -- only keep an
    // answer for a question that genuinely belongs to this product, same
    // "never trust the client's own claim" reasoning as price/availability
    // just above. A question id the client made up (or one belonging to a
    // different product) is silently dropped, not persisted.
    const validQuestionIds = new Set((p.questions || []).map((q) => q.id));
    const answers = {};
    if (item.answers && typeof item.answers === 'object') {
      for (const qid of Object.keys(item.answers)) {
        if (validQuestionIds.has(qid) && String(item.answers[qid] || '').trim()) {
          answers[qid] = String(item.answers[qid]).trim();
        }
      }
    }
    resolved.push({ productId: p.id, name: p.name, price: p.price, quantity: qty, answers });
  }
  if (!resolved.length) return res.status(400).json({ error: 'Sorry, nothing in your basket is available right now.' });

  // In-memory only -- see isViaWebChat's own comment. Without this, every
  // reply handleWebMenuOrder triggers (confirm-order, payment instructions)
  // for a web-chat customer would go out as a real WhatsApp send instead
  // of landing back in the chat transcript.
  if (isViaWebChat(customer)) {
    customer.channel = 'website';
    await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer.id]);
  }
  await handleWebMenuOrder(customer, resolved, fulfilment);
  res.json({ ok: true });
});

router.get('/:token', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).send('Link not found.');
  const viaWebChat = isViaWebChat(customer);
  if (viaWebChat) await pool.query('update customers set web_chat_active_at = now() where id = $1', [customer.id]);
  const [branding, products, pendingOrder, waNumber, instagramHandle, crmRows, deliveryConfig] = await Promise.all([
    resolveMenuBranding(),
    menuForBranch(customer.branch_id),
    pendingOrderPayload(customer.id),
    resolveWaNumber(customer.branch_id),
    resolveInstagramHandle(customer.branch_id),
    pool.query('select enabled, birthday_prompt_enabled, name_prompt_enabled from crm_config limit 1'),
    getDeliveryConfig(),
  ]);
  // Zones embedded up front, real names and real fees -- own_riders
  // customers pick directly from a dropdown instead of typing an address
  // and hoping resolveZoneForAddress's plain text match (delivery-
  // zones.js, the same one the WhatsApp path still uses) guesses right.
  // Chowdeck/manual businesses have no fixed zone list at all, so this
  // stays empty for them and the page falls back to the address+quote
  // path instead (menu-page-template.js).
  let deliveryZones = [];
  if (deliveryConfig.mode === 'own_riders') {
    const { rows } = await pool.query(
      `select id, name, customer_fee from delivery_zone where active = true and ($1::uuid is null or branch_id = $1 or branch_id is null) order by name`,
      [customer.branch_id]
    );
    deliveryZones = rows;
  }
  res.set('Content-Type', 'text/html').send(
    renderMenuPage({
      reviewPath: `/m/${req.params.token}/review`,
      birthdayPath: `/m/${req.params.token}/birthday`,
      namePath: `/m/${req.params.token}/name`,
      askFulfilment: true,
      deliveryQuotePath: `/m/${req.params.token}/delivery-quote`,
      deliveryMode: deliveryConfig.mode,
      deliveryZones,
      showBirthdayPrompt: Boolean(crmRows.rows[0]?.enabled) && crmRows.rows[0]?.birthday_prompt_enabled !== false && !customer.birthday,
      showNamePrompt: Boolean(crmRows.rows[0]?.enabled) && crmRows.rows[0]?.name_prompt_enabled !== false && !customer.name,
      businessName: branding.business_name || '',
      subtitle: 'Pick what you would like, then review your order.',
      coverPhotoVersion: branding.cover_photo_version,
      waNumber,
      channel: viaWebChat ? 'website' : customer.channel,
      webChatPath: viaWebChat ? `/wa/${req.params.token}` : null,
      instagramHandle,
      products,
      pendingOrder,
      initialCategory: req.query.cat || null,
    })
  );
});

// Chidera, 2026-09-20: "when pos is selected the whole thing will still be
// inside the web na, for dine in it can be where the shared order ready to
// pay lives... make it 'ready to pay? click here'." flow.js's
// sendPosPaymentChoice sends a link straight here instead of WhatsApp
// quick-reply buttons -- one customer, the whole order, no guest-selection
// step (unlike dine-in's own /pay, which is genuinely per-table/joint).
async function findPayment(order) {
  const { rows } = await pool.query(
    `select * from order_payment where order_id = $1 and covers_item_ids is null order by created_at desc limit 1`,
    [order.id]
  );
  return rows[0] || null;
}

router.get('/:token/pay', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).send('Link not found.');
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  const order = await getOpenOrder(customer.id);
  const payment = order ? await findPayment(order) : null;
  const paymentConfig = await getPaymentConfig();
  let posTransfer =
    paymentConfig?.provider === 'pos' && paymentConfig.transfer_account_number && paymentConfig.transfer_account_name && paymentConfig.transfer_bank_name
      ? {
          accountNumber: paymentConfig.transfer_account_number,
          accountName: paymentConfig.transfer_account_name,
          bankName: paymentConfig.transfer_bank_name,
        }
      : null;
  let dynamicExpiresAt = null;
  let dynamicReadyAt = null;
  // Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
  // PAYSTACK DOES" -- a real, one-time account for THIS payment instead
  // of the same static one every customer sees, confirmed live. Only
  // attempted for a genuinely pending payment (a confirmed/failed one has
  // nothing left to pay) -- falls straight back to the static account
  // above on any failure, so a Moniepoint hiccup never breaks the page.
  if (posTransfer && payment?.status === 'pending') {
    const dynamic = await ensureDynamicPosAccount(payment);
    if (dynamic) {
      posTransfer = { accountNumber: dynamic.accountNumber, accountName: dynamic.accountName, bankName: posTransfer.bankName };
      dynamicExpiresAt = dynamic.expiresAt;
      dynamicReadyAt = dynamic.readyAt;
    }
  }
  res.set('Content-Type', 'text/html').send(
    renderSingleOrderPayPage({
      businessName: bizRows[0]?.name || '',
      amount: payment ? Number(payment.amount) : Number(order?.total || 0),
      confirmed: payment?.status === 'confirmed',
      posTransfer,
      dynamicExpiresAt,
      dynamicReadyAt,
      statusPath: `/m/${req.params.token}/pay/status`,
      claimPath: `/m/${req.params.token}/pay/claim`,
    })
  );
});

router.get('/:token/pay/status', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const order = await getOpenOrder(customer.id);
  // No open order left for this customer any more -- either paid and
  // moved on (getOpenOrder still returns a non-completed order right
  // through 'fulfilment', so this really means gone/cancelled) or nothing
  // ever existed -- either way, nothing left to poll for.
  if (!order) return res.json({ confirmed: true });
  const payment = await findPayment(order);
  res.json({ confirmed: payment?.status === 'confirmed' });
});

// Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
// PAYSTACK DOES" -- the pay page's own "I've sent it" button. Checks
// Moniepoint directly first and auto-confirms instantly if it already
// shows paid; only falls back to alerting staff if it doesn't (see
// notifyCustomerClaimedPosPayment's own comment for why that's never
// treated as a failure).
router.post('/:token/pay/claim', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const order = await getOpenOrder(customer.id);
  if (!order) return res.status(404).json({ error: 'No open order right now.' });
  const payment = await findPayment(order);
  if (payment?.status === 'confirmed') return res.json({ ok: true, alreadyConfirmed: true });
  await notifyCustomerClaimedPosPayment(payment, order, customer);
  res.json({ ok: true });
});
