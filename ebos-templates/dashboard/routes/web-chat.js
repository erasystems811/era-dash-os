// The real "WhatsApp-look" chat transcript -- Chidera, 2026-09-22: "meta
// will start charging 14 naira per message... i need the whole flow
// duplicated in a site." A customer's ONE real WhatsApp message (flow.js's
// sendStartOrderLink) sends them here; everything else -- the full welcome,
// item-question/fulfilment nudges, order-confirm yes/no, payment
// instructions, payment-confirmed -- happens as bubbles on this page,
// costing nothing no matter how long the conversation runs. Item selection
// itself is NOT rebuilt here -- the "See menu" bubble navigates out to the
// existing /m/:token shop page, reused exactly as it is (routes/
// menu-page.js), same hand-off shape as today's real WhatsApp CTA button.
//
// Public, token-authenticated like /m -- no staff session exists on this
// surface at all, same trust boundary as menu-page.js's resolveCustomer.
import express from 'express';
import { pool } from '../lib/db.js';
import { renderWebChatPage } from '../engine/web-chat-page-template.js';
import { resolveMenuBranding } from './dinein-menu.js';
import {
  buildGreetingContent,
  ensureMenuToken,
  handleWebChatMessage,
  handleWebChatMedia,
  handleUpsellListTap,
  handleOrderConfirmNoTap,
  logWebsiteBubble,
  getOpenOrder,
} from '../engine/flow.js';

export const router = express.Router();

async function resolveCustomer(token) {
  const { rows } = await pool.query('select * from customers where menu_token = $1', [token]);
  return rows[0] || null;
}

// Touched on every request into this page -- see 0060_website_chat.sql's
// own comment for why this exists (lets completePayment, fired from
// Paystack's webhook with no live customer object, know this customer's
// most recent turn was on this page).
async function touchWebChatActive(customerId) {
  await pool.query('update customers set web_chat_active_at = now() where id = $1', [customerId]);
}

// flow.js's logMessage calls append a raw "[payment link sent: url]" or
// "[invoice] url" style suffix onto body -- meant for the staff dashboard's
// own plain-text conversation view, which has no button UI. Redundant on
// THIS page, since the same url already drives the real tappable button
// rendered from `interactive` -- Chidera, 2026-09-23: "why is the chat
// restating the full url of https... the tap button already open the
// url." Two body shapes exist and both need handling: "label: url" wrapped
// entirely inside the brackets (payment/feedback links), and "[label] url"
// where the url trails outside the brackets (invoice/topup documents).
function displayBody(m) {
  if (!m.interactive || (m.interactive.type !== 'cta_url' && m.interactive.type !== 'document')) return m.body;
  const stripped = String(m.body || '')
    .replace(/\s*\[[^\]]*:\s*https?:\/\/[^\]]*\]\s*$/, '')
    .replace(/\s+https?:\/\/\S+$/, '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .trim();
  return stripped || (m.interactive.type === 'document' ? 'Here you go.' : 'Tap below.');
}

function withDisplayBody(rows) {
  return rows.map((r) => ({ ...r, body: displayBody(r) }));
}

async function messageHistory(customerId) {
  const { rows } = await pool.query(
    `select id, direction, sender, body, interactive, trigger, created_at from message
     where customer_id = $1 and channel = 'website'
     order by created_at asc`,
    [customerId]
  );
  return withDisplayBody(rows);
}

router.get('/:token', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).send('Link not found.');
  await touchWebChatActive(customer.id);
  // Chidera, 2026-09-23: "anytime they start using the link let whatever
  // stage they are in ... not be restarting ... let it keep them where
  // they stopped." getOpenOrder's own 3h freshness window only gets
  // refreshed by something that actually touches the order -- a customer
  // who reopens this link just to look, without immediately typing or
  // tapping anything, was getting nothing refreshed by that alone. If
  // their order was already close to 3h since its last real touch, the
  // page would still show their full past history (messageHistory has no
  // staleness filter) while their NEXT action silently fell through
  // resolveCustomerOrder into a brand new order -- restarting from
  // scratch even though the page looked like nothing had changed. Calling
  // getOpenOrder here (side effect only, same as routes/menu-page.js's
  // pendingOrderPayload already does for /m/:token) keeps a still-open
  // order alive for as long as the customer keeps checking back at least
  // once every 3 hours -- a genuinely days-old abandoned order still goes
  // stale on purpose (prices/availability may have changed by then), this
  // only stops "I was still looking at it" from silently counting as
  // abandonment.
  const openOrder = await getOpenOrder(customer.id);

  let history = await messageHistory(customer.id);
  // First visit -- nothing logged on the website channel for this customer
  // yet. Render the FULL welcome (buildGreetingContent, the same content
  // the real WhatsApp message used to carry in full before this feature)
  // as the first bubble, plus a "See menu" button navigating to /m/:token
  // -- never a real Cloud API send, just a logged row this page renders
  // straight back to itself.
  if (!history.length) {
    // Chidera, 2026-09-23: "i need customer complaint and all those in the
    // site as well." flow.js's sendComplaintLink sends this exact same
    // /wa/:token link (no new page) with ?ctx=complaint -- a first-time
    // visitor arriving that way shouldn't be greeted with "what would you
    // like to order?", they came here to explain a problem. A returning
    // customer (history already non-empty) is unaffected either way, this
    // only shapes the very first bubble a brand-new visit ever sees.
    if (req.query.ctx === 'complaint') {
      await logWebsiteBubble({
        customerId: customer.id,
        body: `Sorry to hear that. Please tell us what happened and we'll help sort it out.`,
        trigger: 'complaint_greeting',
      });
    } else {
      const { message, specialsCategory } = await buildGreetingContent(customer);
      const menuToken = await ensureMenuToken(customer);
      const menuUrl = `${process.env.PUBLIC_URL}/m/${menuToken}`;
      // Same specials line Instagram's own greeting already shows (flow.js's
      // buildGreetingContent/handleGreeting) -- a second, auto-linked URL
      // inside the body text, not a second bubble.
      const body = specialsCategory
        ? `${message}\n\nToday's specials: ${menuUrl}?cat=${encodeURIComponent(specialsCategory)}`
        : message;
      await logWebsiteBubble({ customerId: customer.id, body, trigger: 'greeting', interactive: { type: 'cta_url', buttonText: 'See menu', url: menuUrl } });
    }
    history = await messageHistory(customer.id);
  } else if (!openOrder) {
    // Chidera, 2026-09-24: "when i enter the web chat to place an order
    // again it should still resend that menu for a new order to be
    // placed." A returning customer whose last order already finished (or
    // went stale) had no active order for getOpenOrder to find, but also
    // nothing on the page nudging them to start again -- just old history
    // with no obvious next step. Only sent once per "no open order"
    // stretch (checked against the actual last row's trigger, not just
    // "history isn't empty") -- reopening the same link again before
    // they've typed or tapped anything doesn't resend it a second time.
    const last = history[history.length - 1];
    if (last?.trigger !== 'order_again_prompt') {
      const menuToken = await ensureMenuToken(customer);
      const menuUrl = `${process.env.PUBLIC_URL}/m/${menuToken}`;
      await logWebsiteBubble({
        customerId: customer.id,
        body: `Welcome back! Tap below to place a new order.`,
        trigger: 'order_again_prompt',
        interactive: { type: 'cta_url', buttonText: 'See menu', url: menuUrl },
      });
      history = await messageHistory(customer.id);
    }
  }

  const branding = await resolveMenuBranding();
  res.set('Content-Type', 'text/html').send(
    renderWebChatPage({
      businessName: branding.business_name || '',
      coverPhotoVersion: branding.cover_photo_version,
      history,
      messagePath: `/wa/${req.params.token}/message`,
      mediaPath: `/wa/${req.params.token}/media`,
      tapPath: `/wa/${req.params.token}/tap`,
      pollPath: `/wa/${req.params.token}/messages`,
    })
  );
});

router.get('/:token/messages', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const since = req.query.since;
  // Chidera, 2026-09-23, live report + screenshot: the same bubble (an
  // upsell offer, in her case) repeating forever, ~every 3s -- matches
  // this page's own poll() interval exactly. Root cause: Postgres stores
  // created_at at microsecond precision, but the client's own cursor
  // (lastCursor, built from JSON.stringify-ing a JS Date it got back from
  // a previous poll) can only round-trip millisecond precision -- JS Date
  // has no microseconds. So the real stored value (...522672) is ALWAYS
  // strictly greater than the truncated cursor sent back (...522000),
  // and the exact same last row matches `created_at > $2` on every single
  // poll, forever, well past the first time it was genuinely new. Both
  // sides truncated to millisecond precision before comparing so a
  // message whose timestamp only differs in microseconds from the cursor
  // is correctly treated as already-seen.
  const { rows } = await pool.query(
    since
      ? `select id, direction, sender, body, interactive, trigger, created_at from message
         where customer_id = $1 and channel = 'website'
           and date_trunc('milliseconds', created_at) > date_trunc('milliseconds', $2::timestamptz)
         order by created_at asc`
      : `select id, direction, sender, body, interactive, trigger, created_at from message
         where customer_id = $1 and channel = 'website' order by created_at asc`,
    since ? [customer.id, since] : [customer.id]
  );
  res.json(withDisplayBody(rows));
});

router.post('/:token/message', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Type something first.' });
  customer.channel = 'website';
  await touchWebChatActive(customer.id);
  await handleWebChatMessage({ customer, text });
  res.json({ ok: true });
});

// The "+" icon's own upload -- Chidera, 2026-09-23: "actually enable them
// to upload photo of file." The browser reads the file itself (FileReader,
// see web-chat-page-template.js) and posts it straight here as a data URL
// -- no separate storage step, same data_url column handleInboundMedia
// already writes proof images into for real WhatsApp.
router.post('/:token/media', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  const dataUrl = String(req.body?.dataUrl || '');
  if (!/^data:(image\/|application\/pdf)/.test(dataUrl)) return res.status(400).json({ error: 'Only a photo or PDF can be sent here.' });
  customer.channel = 'website';
  await touchWebChatActive(customer.id);
  await handleWebChatMedia(customer, dataUrl, dataUrl.startsWith('data:application/pdf') ? 'file' : 'photo');
  res.json({ ok: true });
});

// Mirrors webhook-whatsapp.js's button_reply/list_reply routing, minus
// Meta's envelope -- every button/list this engine sends on the website
// channel is one of these exact ids (see flow.js's sendConfirmButtons/
// sendFieldPrompt/sendYesNoConfirm/sendUpsellList). Most of them have no
// dedicated handler, same as the real WhatsApp path -- a tap just puts the
// button's own title through the normal text pipeline (handleWebChatMessage,
// NOT handleInboundMessage -- see that function's own comment for why the
// debounced path would silently break the channel override here).
router.post('/:token/tap', async (req, res) => {
  const customer = await resolveCustomer(req.params.token);
  if (!customer) return res.status(404).json({ error: 'Link not found.' });
  customer.channel = 'website';
  await touchWebChatActive(customer.id);

  const { buttonId, title, rowId } = req.body || {};

  if (rowId) {
    // Every list bubble sent on this channel is an upsell list today (see
    // sendUpsellList's website branch) -- general menu browsing lives on
    // /m/:token instead, reached by a plain link, not a tap here.
    if (String(rowId).startsWith('upsell::')) {
      await handleUpsellListTap({ rowId, channel: 'website', branchId: customer.branch_id, customer });
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: 'Unrecognized selection.' });
  }

  if (buttonId === 'order_confirm_no') {
    await handleOrderConfirmNoTap({ channel: 'website', branchId: customer.branch_id, customer });
    return res.json({ ok: true });
  }
  // order_confirm_yes, fulfilment_delivery/pickup, confirm_yes/no -- same
  // "button's own title through the normal text pipeline" shape the real
  // WhatsApp webhook already uses for all four of these.
  if (['order_confirm_yes', 'fulfilment_delivery', 'fulfilment_pickup', 'confirm_yes', 'confirm_no'].includes(buttonId) && title) {
    await handleWebChatMessage({ customer, text: String(title) });
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'Unrecognized selection.' });
});
