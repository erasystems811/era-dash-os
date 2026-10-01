// The generic order engine -- one implementation for every business type,
// driven by bot_state/bot_field/product instead of a hand-written flow per
// type. This is the "chat bot that understands its flow" piece.
import { randomBytes } from 'node:crypto';
import { pool } from '../lib/db.js';
import * as botEngine from '../bot-engine/index.js';
import { classifyIntent, detectWantsHuman, detectDelayComplaint } from './classify.js';
import { missingFieldsForOrder, missingFulfilmentFields, extractAndApply, extractOrderItems, extractOrderModifications, extractFulfilmentChange, loadBotFields, describeForExtraction, branchOptions, resolveMenu, getSharingMode } from './fields.js';
import { loadStateMachine } from './state-machine.js';
import { askJson, askText } from './claude.js';
import { sendWhatsApp, sendWhatsAppDocument, sendWhatsAppButtons, sendWhatsAppCtaUrl, sendWhatsAppTemplate, markTypingIndicator, downloadWhatsAppMedia, getWaDisplayNumber } from './whatsapp-send.js';
import { sendListMessage, productForRowId } from './menu-message.js';
import { sendInstagram, sendInstagramDocument, markInstagramTypingIndicator, downloadInstagramMedia } from './instagram-send.js';
import { createInvoice, createReceipt } from './documents.js';
import { initializePaystackTransaction, initializePaystackTopupTransaction, initializeMonnifyTransaction, initializeOpayTransaction, getPaymentConfig } from './payment.js';
import { pushPaymentRequest, lookupTransactionByReference } from './moniepoint-api.js';
import { createDelivery, estimateDeliveryFee } from './delivery.js';
import { getWhatsAppCredentials } from './branch-channel.js';
import { getDeliveryConfig, resolveZoneForAddress } from './delivery-zones.js';
import { createMagicLink, findStaffByPhoneNumber, toWhatsAppDigits } from '../lib/auth.js';
import { checkOperatingHours } from './hours.js';
import { messageEvents } from './message-events.js';
import { pushToStaff } from './push-notify.js';
import { voiceReplyBuffers } from './voice-turn.js';

// The one place that decides "who is this customer and how do we reach
// them" by channel -- WhatsApp uses their phone number, Instagram uses
// their channel-scoped id (Instagram DMs never expose a phone number at
// all). Every send call site below goes through these two instead of
// hardcoding WhatsApp, so adding a channel means adding a case here, not
// hunting down every place a message goes out.
export function recipientFor(customer) {
  return customer.channel === 'instagram' ? customer.channel_id : customer.phone_number;
}
// Resolves which underlying transport function to hand to bot-engine's
// generic sendMessage -- and for WhatsApp, which branch's own number/token
// to send it from, via customer.branch_id (set at customer creation, see
// findOrCreateCustomer). getWhatsAppCredentials returns null for every
// customer today (no branch has real credentials configured yet -- see
// engine/branch-channel.js), which sendWhatsApp treats as "use the single
// shared env-var pair", so this is a no-op until a branch actually gets its
// own number connected from the dashboard.
// Voice add-on only. A phone call has nowhere to "push" a reply to -- there
// is no API to call the way sendWhatsApp/sendInstagram do, only a caller
// waiting on the line. So a voice customer's replies are collected here
// instead, keyed by customer.id (same per-customer keying pendingTimers
// below already uses -- a customer is never on two calls at once), and
// handleVoiceTurn reads them back out once the shared engine (dispatch/
// handlePendingBatch, completely unchanged for voice) finishes reacting to
// one utterance. This is the ONLY voice-specific branch reply()/senderFor()
// need -- everything upstream of send() stays exactly as it is for
// WhatsApp/Instagram today. The Map itself now lives in ./voice-turn.js
// (2026-10-01, second phase of breaking up this file -- see that file's own
// header), imported back here since senderFor below is shared across every
// channel, not voice-specific.

export async function senderFor(customer) {
  if (customer.channel === 'instagram') return sendInstagram;
  if (customer.channel === 'voice') {
    return (to, text) => {
      const buffered = voiceReplyBuffers.get(customer.id) || [];
      buffered.push(text);
      voiceReplyBuffers.set(customer.id, buffered);
      return {};
    };
  }
  // website: nothing to actually deliver anywhere -- the message ROW itself
  // (written right after this by reply()'s own logMessage call) is what the
  // web-chat page's poll endpoint picks up. Same no-op shape as voice's
  // buffer above, just with nothing to buffer.
  if (customer.channel === 'website') return () => ({});
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  return (to, text) => sendWhatsApp(to, text, credentials);
}
// Pure display text for staff-facing alerts -- customer.phone_number is
// always null for an Instagram customer (DMs never expose one), so that
// fallback alone would just show nothing useful there.
export function displayNameFor(customer) {
  return customer.name || customer.phone_number || customer.channel_id || 'a customer';
}

// The single place every message (inbound or outbound, bot or staff) gets
// logged -- also the single place customers.last_message_at/last_message get
// stamped, so the conversations list (routes/api.js) can sort/filter off a
// plain indexed column on customers instead of a per-row subquery into
// message. Whoever spoke most recently (customer, bot, or staff) is what
// "last message" means here, matching what the conversations list actually
// shows.
// `processed: true` marks an INBOUND log row as already handled at insert
// time -- for a button/list tap, handled synchronously and directly, never
// through processPendingMessages (see scheduleDebouncedProcessing/
// handlePendingBatch). Without this, that row sits with processed_at still
// null forever, and processPendingMessages' own "every unprocessed inbound
// message" batch query (it only ever sets processed_at itself, at the end
// of a normal debounce cycle) sweeps it into the NEXT real text message's
// batch, silently prepending a stale "[tapped: ...]" marker onto whatever
// the customer types next. Found live, 2026-09-10, testing dine-in
// feedback: a "not good" tap's own log line ended up prepended to the
// customer's real follow-up comment.
// interactive -- structured payload (buttons/list/cta_url/document) for an
// outbound website-channel message, added 2026-09-22 (see
// 0060_website_chat.sql). Null for every other channel; the web-chat page
// (routes/web-chat.js) renders a real bubble/button/list from this instead
// of flattened text.
// tableSessionId -- Chidera, 2026-09-24: "let table dine in and online
// delivery have their complete different web chat so a person can be
// doing both at same time in 2 different web chats." NULL means "the
// customer's own general /wa/:token thread" (online); a real
// table_session id scopes a bubble to that table's own separate thread
// (routes/dinein-menu.js's /t/:qrToken/chat) instead, see
// migrations/0066_message_table_session.sql. Almost never passed
// explicitly -- reply() below forwards customer.tableSessionId
// automatically (an in-memory-only marker the dine-in chat route sets
// before calling in, same pattern customer.channel = 'website' already
// uses), so the ~70 existing reply() call sites needed no changes at all.
export async function logMessage({ customerId, direction, channel, sender, body, trigger, platformMessageId, processed, interactive, tableSessionId }) {
  await pool.query(
    `insert into message (customer_id, direction, channel, sender, body, trigger, platform_message_id, processed_at, interactive, table_session_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [customerId, direction, channel, sender, body, trigger || null, platformMessageId || null, processed ? new Date() : null, interactive ? JSON.stringify(interactive) : null, tableSessionId || null]
  );
  await pool.query(`update customers set last_message = $1, last_message_at = now() where id = $2`, [body, customerId]);
  // Chidera, 2026-09-24: "even though a conversation is deleted it should
  // be counted on my dash... the client dashboard shouldnt be what is
  // used to count outbound but the bot itself." A real WhatsApp send
  // genuinely happened and was genuinely billed regardless of whether
  // this conversation survives to be looked at later -- DELETE
  // /customers/:id (routes/api.js) hard-deletes `message` as a deliberate
  // content cleanup, which used to silently erase this fact along with
  // it. whatsapp_send_log is permanent and content-free on purpose (see
  // its own migration comment) -- nothing ever deletes from it.
  if (direction === 'outbound' && channel === 'whatsapp') {
    await pool.query(`insert into whatsapp_send_log default values`);
  }
  // Chidera, 2026-09-25: "for my dashboard the upsell and all, even though
  // a conversation is deleted it should keep calculating that, it shouldnt
  // delete or reduce the rate." Same reasoning as whatsapp_send_log above,
  // generalized -- see business_metrics_log's own migration comment
  // (0064) for why order/upsell/abandoned metrics are logged by a
  // database trigger instead of here, while this one (a customer's first
  // inbound message of the calendar month) is decided in exactly this one
  // place, so it just logs directly.
  if (direction === 'inbound') {
    const { rows: monthRows } = await pool.query(
      `select count(*) as count from message where customer_id = $1 and direction = 'inbound'
         and date_trunc('month', created_at) = date_trunc('month', now())`,
      [customerId]
    );
    if (Number(monthRows[0].count) === 1) await logMetric('active_customer');
  }
  // Chidera, 2026-09-25: "that customer reply coming in and staff seeing
  // it pop in live without refreshing it." Every real message emits here
  // (not just inbound) -- if two staff members have the same conversation
  // open, or one has it open while another sends from a different device,
  // both tabs should update instantly, not just the one that sent it.
  messageEvents.emit('message', { customerId });
}

// Exported so routes/complaint.js can log the real thing it creates (a
// row in `complaint`) at the one place that's actually true, instead of
// this file guessing at complaint intent before a customer even submits
// anything -- see this file's own complaint-metric comment further down
// for the full story.
export async function logMetric(metric) {
  await pool.query(`insert into business_metrics_log (metric) values ($1)`, [metric]);
}

// A thin, purpose-built export for routes/web-chat.js's own first-load
// render (the first bubble, before any real dispatch has run for this
// customer) -- logMessage itself stays module-private, this just fixes the
// direction/channel/sender every caller outside this file needs, rather
// than handing a route the full logMessage signature.
export async function logWebsiteBubble({ customerId, body, trigger, interactive, tableSessionId }) {
  await logMessage({ customerId, direction: 'outbound', channel: 'website', sender: 'bot', body, trigger, interactive, tableSessionId });
}

// Chidera, 2026-09-24: "now feedback can have a fill a complaint form kind
// of thing" -- routes/complaint.js's own form submit logs the customer's
// typed complaint as a real inbound turn (so handover()'s own transcript
// summary actually includes what they wrote) without running it through
// handlePendingBatch/dispatch -- a complaint form submit is a deterministic
// handover, not a bot conversation turn that needs the AI engine's
// classifyIntent/order-state logic at all.
export async function logInboundWebsiteMessage(customer, text) {
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel: 'website', sender: 'customer', body: text, processed: true });
}

// Instagram's send response carries the new message's own id (message_id).
// WhatsApp's carries its own wamid too (sendResult.messages[0].id) -- kept
// unused here until 2026-09-02, when a real live bug (a plain-text send
// outside the 24h window, accepted synchronously then failed later via a
// status webhook, with no way to know which conversation row it belonged
// to) made it clear webhook-whatsapp.js's status handler needs this to
// correlate a failure back to the message that produced it. See message.
// platform_message_id's schema comment for the full story.
export function platformMessageIdFrom(customer, sendResult) {
  if (customer.channel === 'instagram') return sendResult?.message_id || null;
  if (customer.channel === 'whatsapp') return sendResult?.messages?.[0]?.id || null;
  return null;
}

// AI-generated text (greetings, KB answers) sometimes reaches for a dash
// for a pause -- em, en, or a plain "-" -- and that voice is never wanted
// in chat, only a comma. bot-engine's own sanitizeText only catches a
// standalone "-" with a space on BOTH sides and throws instead of fixing
// it, which is too narrow (a dash with a space on only one side slips
// through) and too risky here (a throw mid-reply means the customer gets
// nothing, which is worse than the wrong punctuation). So every dash used
// as punctuation -- meaning it has whitespace on at least one side -- is
// rewritten to a comma before a reply is ever sent. A hyphen with no
// whitespace on either side is left alone, since that's a real compound
// word ("check-in") or a date ("12-08-2026"), not a paused-thought dash.
function normalizeDashes(text) {
  return text
    .replace(/[–—]/g, ',')
    .replace(/\s*-\s+/g, ', ')
    .replace(/\s+-(?=\S)/g, ', ')
    .replace(/\s+,/g, ',')
    .replace(/,\s*,/g, ',')
    .replace(/,(?=\S)/g, ', ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// `logTag` is our own bookkeeping (message.trigger, any string), separate
// from bot-engine/send.js's ALLOWED_TRIGGERS, which every real send here
// satisfies with 'bot_flow_step'.
export async function reply(customer, text, logTag = 'bot_flow_step') {
  const clean = normalizeDashes(text);
  const sendResult = await botEngine.sendMessage({ trigger: 'bot_flow_step', to: recipientFor(customer), text: clean, whatsappSend: await senderFor(customer) });
  await logMessage({
    customerId: customer.id,
    direction: 'outbound',
    channel: customer.channel,
    sender: 'bot',
    body: clean,
    trigger: logTag,
    platformMessageId: platformMessageIdFrom(customer, sendResult),
    // Chidera, 2026-09-24: dine-in's own separate web chat -- see
    // logMessage's own comment on tableSessionId. customer.tableSessionId
    // only exists in-memory, set by routes/dinein-menu.js's own /chat
    // route before calling in here, same pattern customer.channel =
    // 'website' already uses -- every other caller (whatsapp, online
    // website) leaves it undefined and this is simply omitted, unchanged.
    tableSessionId: customer.tableSessionId,
  });
}

// The order read-back's yes/no ask, as tappable buttons instead of a
// "reply yes" text prompt -- Chidera 2026-09-10: "that press yes to
// confirm or change something let it be buttons to like in the demo we
// saw" (EBOS-Web-Menu-Demo.html's "Yes, send it" / "No, let me change
// it"). Tapping either just puts that exact wording through the normal
// text pipeline (webhook-whatsapp.js's button_reply handling), so every
// state-dependent yes/no branch already in dispatch() (handleConfirmOrder,
// handleReconfirmAfterEdit, ...) handles it correctly with no new logic
// here -- a tap is just a faster way to say the same thing typing would.
// Non-WhatsApp channels (Instagram) keep the plain text prompt, same as
// every other button-vs-text gate in this file.
export async function sendConfirmButtons(customer, bodyText, trigger) {
  const buttons = [
    { id: 'order_confirm_yes', title: 'Yes, confirm' },
    { id: 'order_confirm_no', title: 'No, change it' },
  ];
  // website: a real tappable-button bubble on the chat page (routes/
  // web-chat.js), same tap-through-the-normal-text-pipeline shape as
  // WhatsApp's own buttons -- see that route's POST /:token/tap.
  if (customer.channel === 'website') {
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: bodyText, trigger, interactive: { type: 'buttons', buttons } });
    return;
  }
  if (customer.channel !== 'whatsapp') {
    await reply(customer, `${bodyText} Reply yes to confirm, or let me know what you'd like to change.`, trigger);
    return;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppButtons(recipientFor(customer), bodyText, buttons, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: bodyText, trigger });
}

// Moved to ./staff.js, 2026-10-01 (fourth phase of breaking up this file --
// see that file's own header). handover() itself stays here -- it's
// called from 24+ places deep inside the order/payment/media state
// machine below, not just from the edges the way everything in staff.js
// is. resumeBotControl is imported back since handlePendingBatch/
// handleInboundMedia check it directly; every exported name here is also
// re-exported so no existing EXTERNAL import site has to change.
import {
  sendStaffReply,
  startConversation,
  retryFailedSendAsTemplate,
  takeOverConversation,
  recordAppReply,
  recordAppReplyInstagram,
  handoverRecipients,
  orderAlertRecipients,
  sendStaffAlert,
  notifyStaff,
  handleStaffCommand,
  resumeBotControl,
} from './staff.js';
export {
  sendStaffReply,
  startConversation,
  retryFailedSendAsTemplate,
  takeOverConversation,
  recordAppReply,
  recordAppReplyInstagram,
  handoverRecipients,
  orderAlertRecipients,
  sendStaffAlert,
  notifyStaff,
  handleStaffCommand,
  resumeBotControl,
};

// WhatsApp customers are found/created by phone_number (unique index on
// that column already); Instagram never gives a phone number at all, only
// a channel-scoped id (unique per (channel, channel_id), see schema.sql) --
// so channelId is the identifier there instead. Exactly one of
// phoneNumber/channelId is expected per call, matching which channel the
// message actually came in on.
// branchId is only used for a brand-new customer's initial branch_id --
// resolved by the webhook from which number the message arrived on when
// that's known (see webhook-whatsapp.js's resolveBranchByPhoneNumberId),
// null otherwise. An existing customer keeps whatever branch_id it already
// has; this never moves a returning customer to a different branch.
//
// The lookup itself only scopes by branch when BOTH sharing_mode is
// 'independent' AND branchId is actually known -- same "unscoped until
// proven otherwise" idiom as resolveMenu, and for the same reason: with no
// branch known yet, there's nothing correct to scope by, so matching on
// phone/channel_id alone (today's only behaviour) is the safe fallback,
// not a special case. Under independent with a known branch, a customer
// with no branch_id yet (created before this business had branches, or
// under merged) still matches -- treated as "not yet claimed by a branch",
// same as resolveMenu's unassigned-product rule, not a second customer.
// Exported for routes/api.js's manual order creation (a staff-entered
// phone number for a delivery/order that came in outside any channel this
// system listens on itself) -- same lookup, same branch-scoping rule,
// rather than a second copy of this logic living in the route.
export async function findOrCreateCustomer({ phoneNumber, channelId, channel = 'whatsapp', branchId = null }) {
  const scoped = branchId && (await getSharingMode()) === 'independent';
  const { rows } = await pool.query(
    phoneNumber
      ? `select * from customers where phone_number = $1 ${scoped ? 'and (branch_id = $2 or branch_id is null)' : ''}`
      : `select * from customers where channel = $1 and channel_id = $2 ${scoped ? 'and (branch_id = $3 or branch_id is null)' : ''}`,
    phoneNumber ? (scoped ? [phoneNumber, branchId] : [phoneNumber]) : scoped ? [channel, channelId, branchId] : [channel, channelId]
  );
  if (rows[0]) return rows[0];
  const { rows: created } = await pool.query(
    `insert into customers (phone_number, channel_id, channel, branch_id) values ($1, $2, $3, $4) returning *`,
    [phoneNumber || null, channelId || null, channel, branchId]
  );
  return created[0];
}

export function newReference(prefix) {
  return `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

// An order already marked completed/cancelled naturally starts a fresh one
// on the next message (excluded below) -- but an order just left hanging,
// no communication either way for hours, needs the same fresh start even
// though nobody ever formally closed it. `updated_at` is bumped every time
// this actually returns an order (the "touch" below), so the 3-hour window
// is since the last REAL interaction, not since the order was created.
// Chidera, 2026-09-24: "let table dine in and online delivery have their
// complete different web chat so a person can be doing both at same time
// in 2 different web chats." channel <> 'dinein' added here -- every real
// caller (routes/menu-page.js, routes/web-chat.js) is an online-only
// surface, so a customer who's simultaneously mid a dine-in table session
// (their own dine-in order shares this same customer_id when they're the
// table's original scanner) never had this silently steal their online
// order resolution before. resolveCustomerOrder below already has its
// own separate, deliberate table_session lookup for the dine-in case --
// this exclusion is what actually forces it to be reached instead of
// getOpenOrder grabbing whichever order is simply more recent.
export async function getOpenOrder(customerId) {
  const { rows } = await pool.query(
    `select * from "order" where customer_id = $1 and channel <> 'dinein' and engine_state not in ('completed', 'cancelled')
       and updated_at > now() - interval '3 hours'
     order by created_at desc limit 1`,
    [customerId]
  );
  const order = rows[0] || null;
  if (order) await pool.query(`update "order" set updated_at = now() where id = $1`, [order.id]);
  return order;
}

// Joint dine-in, Stage 1 gap -- confirmed live, 2026-09-20 (Table 1, Chidera:
// "for delivery and pick up why is jv on my table already ordering through
// table qr and bot start process an online delivery for him?"). getOpenOrder
// above is customer_id-scoped, but a joint dine-in order's customer_id is
// ALWAYS the original table scanner (getOrCreateTableOrder below never
// changes it) -- so every OTHER guest at the table got null back from every
// caller still using getOpenOrder(customer.id) directly, no matter how many
// of the specific web-link call sites already learned to route around it
// earlier this session. Real cost: a non-owner guest's own "Yes, confirm"
// reply found no order here, fell through handlePendingBatch's dispatch gate
// into fresh-inquiry handling, and created a brand new, unrelated online
// order -- confirmed against the real order rows (bfe3a420 stuck at
// confirm_order, never reaching the kitchen; 8c9e8a55 the rogue separate
// order that got the real Paystack link instead). Falls back to the same
// table_session_guest membership check currentDineinSession already uses
// (further below), joined through session_id the same way
// getOrCreateTableOrder resolves the shared order -- so a guest's plain
// text/button reply reaches their REAL shared order exactly like their
// web-link taps already do. Every existing non-dine-in caller is unaffected:
// the direct lookup either succeeds (nothing changes) or there's no open
// table_session to fall back to either (still null, same as before).
export async function resolveCustomerOrder(customer) {
  const direct = await getOpenOrder(customer.id);
  if (direct) return direct;
  const { rows } = await pool.query(
    `select o.* from "order" o
     join table_session ts on ts.id = o.session_id
     where ts.closed_at is null
       and o.status not in ('completed', 'cancelled')
       and (ts.customer_id = $1 or exists (select 1 from table_session_guest g where g.session_id = ts.id and g.customer_id = $1))
     order by o.created_at desc limit 1`,
    [customer.id]
  );
  const order = rows[0] || null;
  if (order) await pool.query(`update "order" set updated_at = now() where id = $1`, [order.id]);
  return order;
}

// Drives the 24h "want to order again?" window (Chidera's call,
// 2026-09-03): once completed_at is more than 24h old, this returns null
// and a bare greeting goes back to the normal cold-open flow -- exactly
// "back to root" after 24h, no separate cleanup job needed, the interval
// check alone does it. Now only the FALLBACK for a completed order that
// never actually got a feedback request out (see wasSentFeedbackRequestFor
// below, which takes priority) -- e.g. no PUBLIC_URL configured, or a
// non-WhatsApp customer sendFeedbackRequest skips outright.
async function recentlyCompletedOrder(customerId) {
  const { rows } = await pool.query(
    `select id from "order" where customer_id = $1 and status = 'completed' and completed_at > now() - interval '24 hours'
     order by completed_at desc limit 1`,
    [customerId]
  );
  return rows[0] || null;
}

// Chidera 2026-09-11: "in era-demo the bot should always restart a
// conversation after the have been sent the rate message, meaning upon
// next text a menu with image should be sent" -- then, clarifying, "not
// just the menu": the real handleGreeting experience (welcome text + menu
// button + cover photo), not a bare link. Once a customer's been sent the
// rating request, that's the end of that order's own conversation -- their
// next message is treated as a brand new inquiry, same as a first-ever
// contact, rather than the softer "want another order?" prompt
// recentlyCompletedOrder alone would still give every completed order.
//
// Checks order_feedback (a real, permanent record of "was this order's
// rating request actually sent"), NOT "was the feedback request literally
// the last outbound message" -- found live, 2026-09-11: an unrelated
// message sent to the same customer afterward (in this case, a stray
// kb_miss reply from testing something else entirely) broke that literal
// reading even though the rating request genuinely had gone out for their
// most recent completed order. Whether anything else got sent afterward is
// irrelevant to the actual question being asked.
async function wasSentFeedbackRequestFor(orderId) {
  const { rows } = await pool.query(`select 1 from order_feedback where order_id = $1`, [orderId]);
  return rows.length > 0;
}

// An order a customer never confirmed or actively walked away from just
// ages out on its own -- there's no customer-facing "cancel" anymore (see
// handleConfirmOrder), so without this an abandoned order would sit open
// forever, exactly the zombie-order confusion a real customer hit live
// (an old, long-abandoned order from a previous day resurfaced once a
// newer one was closed out from under it). Silent on purpose -- a
// day-old, never-confirmed order closing quietly is normal, not something
// worth messaging a customer about out of nowhere. Reuses the existing
// 'cancelled' terminal state rather than adding a new one -- everywhere
// that already excludes cancelled orders (getOpenOrder, the panel's order
// list, etc.) handles this correctly with no other change needed.
// Chidera, real live report: "that dynamic monify account is showing me
// as invalid and unavailable" -- confirmed live: the checkout session
// Monnify sent back had genuinely expired, a real time limit on their own
// end. Follow-up: "i cant text you, it should be auto regenerated" --
// also confirmed live that Monnify's own "Try again" button on an expired
// session doesn't actually work either, it just loops back to the same
// dead transaction. The only real fix is OUR OWN system issuing a
// genuinely new one, proactively, before the customer would ever see
// "expired" at all.
// monnify_account_expires_at naturally self-limits how often any one
// order re-matches here: sendPaymentInstructions below regenerates a
// fresh ~25-minute link (monnify-api.js's callMonnifyCheckoutLink) every
// time it runs, which pushes this same order's own expires_at back out
// past the lead window immediately -- so a customer who's still mid-
// checkout never sees "expired," and one who's genuinely gone quiet just
// keeps getting a fresh link roughly every 20 minutes until
// closeStaleOrders' own 24h sweep below eventually cancels the order
// outright.
// Chidera, 2026-09-26: moved to ./sweeps.js along with every other periodic
// background job (see that file's own header) -- re-exported here so no
// existing import site (server.js, tests) has to change.
export { refreshExpiringPaymentLinks, closeStaleOrders } from './sweeps.js';

// branchId is only ever non-null here when the channel itself already told
// us (a real per-branch WhatsApp number, see webhook-whatsapp.js/branch-
// channel.js) -- that's "store the resolved branch once known, never
// re-resolve" for the channel-routed case: the order starts with branch_id
// already set, so missingFieldsForOrder's own branch question (fields.js)
// never triggers at all, exactly as if there were only one branch. A
// shared-number business (no per-branch numbers configured) still gets
// null here and keeps asking the existing way, after items -- reordering
// that to ask first is real conversational-flow surgery with no live
// business needing it yet, deliberately left for when one does.
async function createDraftOrder(customerId, branchId = null) {
  const { rows } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id) values ($1, $2, $3) returning *`,
    [customerId, newReference('ORD'), branchId]
  );
  return rows[0];
}

export async function transitionOrder(order, toState) {
  const sm = await loadStateMachine();
  sm.assertTransition(order.engine_state, toState);
  await pool.query(`update "order" set engine_state = $1, updated_at = now() where id = $2`, [toState, order.id]);
  order.engine_state = toState;
}


// Shared between the error-recovery handover() call below and
// handlePendingBatch's own gate on it -- a customer stuck in exactly this
// handover shouldn't get the bot retried (it just failed) or re-greeted on
// every later message, only the first one.
const SYSTEM_ERROR_HANDOVER_REASON = 'Unexpected error while processing customer message';

// `extra` is for context a plain conversation summary can't produce itself
// -- specifically the invoice and payment-proof links on a payment-related
// handover, so whoever's confirming payment has both right there instead of
// having to go look them up on the dashboard first.
// ackText overrides the default "let me confirm this properly" line for a
// handover that isn't really about confirming anything -- e.g. the bot
// itself broke (see the error-recovery catch in scheduleDebouncedProcessing)
// and that phrasing reads as evasive rather than honest about what happened.
// primaryLink: Chidera, 2026-09-20: "when you sent handover for receipt
// confirmation the board opened the conversation instead of where the
// receipt actually is" -- the payment-proof handover already built a real
// `confirm: .../orders/<id>` link (straight into the order card, see its
// own 2026-09-03 comment on that), but only ever as a plain text LINE
// inside the alert body -- the actual tappable BUTTON below was hardcoded
// to the generic /conversations/<id> board regardless, so that's the one
// staff actually tapped. { path, title } overrides both the magic-link
// destination and the button's own title; every other call site passes
// nothing and keeps getting the generic conversation link exactly as
// before, since none of them have anywhere more specific to send staff.
export async function handover(customer, reason, extra, ackText, primaryLink) {
  await pool.query(`update customers set handled_by = 'staff', handover_at = now(), handover_reason = $1 where id = $2`, [reason, customer.id]);

  // Voice add-on only (spec A8, Phase 1/call-forwarding -- no live transfer
  // built yet, see engine/voice.js). One handover() branching by channel,
  // not a second parallel implementation -- every A8 trigger already flows
  // through THIS function via the shared dispatch tree (asks for a person,
  // a complaint, a change to an already-paid order), so branching here is
  // what makes every one of those triggers work for voice for free, without
  // forking handlePendingBatch/dispatch itself.
  if (customer.channel === 'voice') {
    // Can't put a live call "on hold" the way a chat thread waits for a
    // later reply -- Phase 1 has no live transfer, so the honest thing to
    // say is that someone will call back (spec A8's own wording), not
    // WhatsApp's "I'll get back to you here shortly".
    await reply(customer, `Let me get someone to call you back on this number shortly.`, 'handover_ack');

    // Matched by caller_number, not customer_id -- on a customer's very
    // FIRST call, voice_call.customer_id isn't written until after this
    // turn's engine call resolves (see engine/voice.js), but caller_number
    // is set the instant the call itself started. A customer is never on
    // two calls at once, so caller_number alone is already unambiguous.
    const { rows: callRows } = await pool.query(
      `select id, branch_id from voice_call where caller_number = $1 and ended_at is null order by started_at desc limit 1`,
      [customer.phone_number]
    );
    const call = callRows[0];
    if (call) {
      const { rows: recent } = await pool.query(
        `select sender, body from message where customer_id = $1 order by created_at desc limit 20`,
        [customer.id]
      );
      const transcript = recent.reverse().map((m) => `${m.sender}: ${m.body}`).join('\n');
      // A summarisation failure must never silently drop the callback
      // itself (0.4) -- fall back to the raw transcript rather than
      // throwing and losing the whole handover.
      const summary = await askText(
        'Summarise this phone call transcript in exactly three short lines: "What they want:", "So far:", "Outstanding:". No markdown, no asterisks, and no dash of any kind anywhere in the text. Use a comma or period instead of a dash wherever you would normally use one. Be terse.',
        transcript
      ).catch(() => transcript.slice(0, 500));
      await pool.query(
        `insert into callback_task (branch_id, call_id, customer_id, reason, context_summary) values ($1, $2, $3, $4, $5)`,
        [call.branch_id, call.id, customer.id, reason, summary]
      );
    }

    const voiceRecipients = await handoverRecipients();
    if (voiceRecipients.length) {
      // Chidera, 2026-09-23: "handover be structured not a paragraph" --
      // same fix as the text-channel alert just below, same reasoning.
      const alert = `Customer: ${displayNameFor(customer)}\nReason: ${reason}\nNote: They were told someone will call them back on this number.`;
      for (const { phoneNumber: to, staffId } of voiceRecipients) {
        await notifyStaff({ staffId, phoneNumber: to, title: 'Voice callback needed', body: alert });
      }
    }
    return;
  }

  // Never leave the customer with silence just because the bot handed off
  // -- they get an ack here regardless of whether anyone is even configured
  // to receive the internal staff alert below. ackText === false means the
  // caller already sent its own tailored ack right before calling handover
  // (e.g. "Noted, I will confirm the payment...") -- found live, 2026-09-03:
  // that case still fell through to this default line too, so the customer
  // got two stitched-together acks back to back, same bug as the earlier
  // error-recovery fix, different call site.
  if (ackText !== false) {
    await reply(customer, ackText || `Let me confirm this properly for you, I'll get back to you here shortly.`, 'handover_ack');
  }

  const recipients = await handoverRecipients();
  if (!recipients.length) return;

  const { rows: recent } = await pool.query(
    `select sender, body from message where customer_id = $1 order by created_at desc limit 20`,
    [customer.id]
  );
  const transcript = recent.reverse().map((m) => `${m.sender}: ${m.body}`).join('\n');
  const summary = await askText(
    'Summarise this WhatsApp conversation in exactly three short lines: "What they want:", "Agreed so far:", "Outstanding:". No markdown, no asterisks, and no dash of any kind anywhere in the text, not even mid-sentence as punctuation (no em dash, en dash, hyphen-as-punctuation, or bullet dash) -- outbound messages are hard-rejected if they contain one. Use a comma or period instead of a dash wherever you would normally use one. Be terse.',
    transcript
  );
  // Chidera, 2026-09-25: "for handover alert for that dine in when
  // customer want to remove something already places- customer, reason,
  // table, agreed so far want to remove is onay" -- table belongs right
  // after Reason, ahead of the AI summary (which is what actually
  // contains "Agreed so far:"); everything else in `extra` (e.g. "Wants
  // to remove:") stays after the summary, same as before. Only the two
  // dine-in kitchen-removal handover call sites pass a `table` key today.
  const { table: beforeSummaryLine, ...afterSummaryExtra } = extra || {};
  const beforeSummary = beforeSummaryLine ? `\n${beforeSummaryLine}` : '';
  const extraLines = Object.values(afterSummaryExtra).filter(Boolean).length
    ? `\n${Object.values(afterSummaryExtra).filter(Boolean).join('\n')}`
    : '';
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  for (const { phoneNumber: to, staffId } of recipients) {
    // Chidera, 2026-09-23: "handover be structured not a paragraph" --
    // same one-fact-per-line convention every other staff alert in this
    // file already follows (completePayment's "ready to prepare" ping,
    // notifyCustomerClaimedPosPayment's claim alert). "Handing over a
    // chat from X to you." read as a sentence to parse, not a field to
    // scan -- "Customer:" is the same label shape as "Reason:" right
    // below it.
    const alert = `Customer: ${displayNameFor(customer)}\nReason: ${reason}${beforeSummary}\n${summary}${extraLines}`;

    // Chidera, 2026-09-23: "make handover chats in ebos one, meaning add
    // both the tap to open and message in one text to reduce my charges"
    // -- the alert text and the conversation-link button used to be two
    // separate WhatsApp sends (two billable messages, matters with Meta's
    // per-message pricing) per staff member. Now one cta_url message
    // carries the alert as its body AND the button, when a link is even
    // possible (see the magic-link comment below).
    if (!process.env.PUBLIC_URL) {
      await sendStaffAlert(to, alert);
      continue;
    }
    // Chidera, 2026-09-16: "when a handover is sent the link should be
    // open in the whatsapp chat, they dnt have to leave to a site" -- this
    // used to append the link as plain text onto the alert above, which
    // opens the device's own external browser when tapped. A real CTA-URL
    // button instead, same mechanism handleStaffCommand's "text dashboard"
    // link already uses (opens inside WhatsApp's own in-app browser). A
    // magic link (not a bare dashboard URL) signs this exact staff member
    // straight in and lands them on this conversation, no separate login
    // -- falls back to the old bare (login-required) link when this
    // recipient has no staffId, since business.handover_number's fallback
    // isn't a real staff account with a session to bind a token to.
    const path = primaryLink?.path || `/conversations/${customer.id}`;
    const title = primaryLink?.title || 'Open Conversation';
    const link = !process.env.PUBLIC_URL
      ? null
      : staffId
        ? `${process.env.PUBLIC_URL}/api/auth/magic/${await createMagicLink(staffId, path)}`
        : `${process.env.PUBLIC_URL}${path}`;
    await notifyStaff({ staffId, phoneNumber: to, title: 'Handover', body: alert, linkUrl: link, linkButtonText: title, credentials });
  }
}


// A combo/special offer is a real product (product.is_combo) created
// through its own form (routes/api.js's POST /catalogue/combo) -- Chidera
// 2026-09-10: "a special offer is a combo so it should be created not
// marked... with form style adding the items in the deal and how much and
// name of deal." is_combo is the one deterministic signal this checks;
// every combo the form creates is always filed under this exact category,
// which is what lets the general "See menu" link's category tabs and the
// web menu's ?cat= filtering (both keyed on the string, not the flag) find
// it without their own is_combo-aware logic.
const SPECIALS_CATEGORY = 'Special Offers';
export async function findSpecialsCategory(branchId) {
  const menu = await resolveMenu(branchId);
  return menu.some((p) => p.is_combo) ? SPECIALS_CATEGORY : null;
}

// Moved to ./greeting.js, 2026-10-01 (fifth phase of breaking up this file
// -- see that file's own header). needsChatRedirect/markChatRedirectSent/
// sendChatRedirectPing/handleClosedHoursMessage/branchHoursFor stay here
// even though greeting.js uses some of them -- cross-cutting
// infrastructure used by dispatch and the top-level entry points below,
// not greeting-specific. buildGreetingContent/handleGreeting/
// greetingAckFor/isPureGreeting/handleEnquiry/sendComplaintLink are
// imported back since dispatch() and sendStartOrderLink call them
// directly; every exported name here is also re-exported so no existing
// EXTERNAL import site has to change.
import {
  buildGreetingContent,
  sendComplaintLink,
  notifyComplaintReply,
  handleGreeting,
  greetingAckFor,
  isPureGreeting,
  handleEnquiry,
  buildBusinessKnowledgeContext,
} from './greeting.js';
export {
  buildGreetingContent,
  sendComplaintLink,
  notifyComplaintReply,
  handleGreeting,
  greetingAckFor,
  isPureGreeting,
  handleEnquiry,
};

// Chidera, 2026-09-24: "even any text going out to the customer, the
// customer should get a one time we are trying to reach out to you tap
// here to text... bot must not answer every reply customer makes on bare
// chat, just resend them the place to text once if they text bare and if
// they text bare again, leave it stay silent." The BOT's own automatic
// bare-WhatsApp redirect (handlePendingBatch) -- see needsStaffChatRedirect
// just below for the separate, independently-tracked staff version of
// this same idea (Chidera, 2026-09-25: two real live bugs taught this
// they can't safely share one counter -- see that function's own comment).
export async function needsChatRedirect(customer) {
  // Actively on the page right now (same 30-min freshness window
  // completePayment already uses) -- they'll see a free bubble live via
  // the page's own poll, no real ping needed at all regardless of history.
  const activelyOnPage = customer.web_chat_active_at && new Date(customer.web_chat_active_at) > new Date(Date.now() - 30 * 60 * 1000);
  if (activelyOnPage) return false;
  if (!customer.chat_redirect_sent_at) return true;
  // Pinged before, and genuinely visited the chat again since that ping
  // (even if not "actively on it" right now) -- worth a fresh one next
  // time they drift back to bare WhatsApp (markChatRedirectSent resets
  // the count below once this ping actually goes out).
  const visitedSinceLastPing = customer.web_chat_active_at && new Date(customer.web_chat_active_at) > new Date(customer.chat_redirect_sent_at);
  if (visitedSinceLastPing) return true;
  // Chidera, 2026-09-25: "the bot cant be silent forever after the first
  // five times, after 24 hours renew the 5 times trial." A customer who
  // never once revisits the chat would otherwise stay capped and silent
  // permanently -- 24h of real silence since the last ping is its own
  // reset, same as a genuine visit would be (markChatRedirectSent's own
  // "fresh count of 1" logic already treats this the same way once this
  // returns true).
  const moreThan24hSinceLastPing = new Date(customer.chat_redirect_sent_at) < new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (moreThan24hSinceLastPing) return true;
  // No visit at all since the last ping, and still within 24h of it --
  // Chidera, 2026-09-24: "i said after the first greeting there should be
  // a second resend of the tap here to chat to redirect customer again
  // before silent, but this one only did first greeting and went quiet."
  // Chidera, 2026-09-25: "let bot resend that greeting text to chat a max
  // time of 5 cause that 2 is risky, going silent on a customer is
  // risky" -- then, same day, on reflection: "make it 3 now sef, 5 is
  // much." Up to 3 consecutive pings total before staying silent until
  // either a real visit or the 24h renewal above.
  return (customer.chat_redirect_count || 0) < 3;
}

// Chidera, 2026-09-25: a separate function, deliberately NOT sharing
// needsChatRedirect's own chat_redirect_sent_at/chat_redirect_count
// columns -- two real live bugs in a row proved those can't be reused for
// staff:
// 1. "i texted a customer on dee from staff dashboard on conversations
//    and the customer didnt get the text? when a staff is texting... why
//    isnt it sending atall?" -- the bot's own 3-ping numeric cap had
//    already been exhausted by earlier automated pings, so needsChatRedirect
//    went permanently silent for staff too, sharing that same count.
// 2. "its not every single text that you send we are trying to reach out
//    to you, only the first staff reach out text, everything else is
//    expected to go on in web chat" -- the first attempt at fixing #1
//    (an override flag that skipped the numeric cap) over-corrected: once
//    it shared chat_redirect_sent_at with the bot's own history, it either
//    fired on every single staff message, or -- worse -- could silently
//    skip staff's own genuine first ping just because the BOT happened to
//    have pinged recently and exhausted its cap (the exact #1 scenario).
// A staff ping's own history (was staff's OWN first ping already sent,
// and has this customer visited or gone 24h quiet since) can only be
// answered correctly by looking at staff's own pings specifically --
// message's own staff_reply_ping rows, untangled from the bot's count.
// Chidera, 2026-10-01, real live report: "after i took over from bot it
// sent me one we are trying to reach out to you, upon handing back to bot
// why did it send another... it ended up sending 3 times, i said its once
// per take over." Root cause, confirmed against era-demo's real message
// log: the "visited since last ping" re-arm below (added for the
// 2026-09-25 fix documented in this function's own comment above) treated
// ANY touch of web_chat_active_at as a genuine re-engagement worth
// pinging again for -- but web_chat_active_at gets touched by a bare page
// LOAD too (routes/web-chat.js's own GET /:token), not just real
// activity, and a customer tapping the SAME ping's own link to go see
// what staff said is exactly that: a page load. So the ping doing its job
// (getting them to open the page) was itself being read as "they need
// another ping," re-arming on the very next staff reply -- backwards.
// "Once per takeover" (her own words) is a session-scoped fact, not a
// time/visit-based cooldown -- handover_at IS that session's start (set
// once at the original handover, cleared back to null by
// resumeBotControl): a ping already sent since THIS handover_at means
// this takeover already got its one ping, full stop, regardless of
// anything the customer does with the page in the meantime; a fresh
// handover_at (a brand new takeover) naturally allows exactly one more.
export async function needsStaffChatRedirect(customer) {
  const { rows } = await pool.query(
    `select created_at from message where customer_id = $1 and trigger = 'staff_reply_ping' order by created_at desc limit 1`,
    [customer.id]
  );
  const lastStaffPing = rows[0]?.created_at;
  if (!lastStaffPing) return true; // staff has never pinged this customer before
  if (customer.handover_at && new Date(lastStaffPing) >= new Date(customer.handover_at)) {
    return false; // already pinged once during this exact takeover
  }
  // The last ping predates this takeover (a stale ping from a PRIOR,
  // already-ended session) -- this is genuinely the first ping of a new
  // one, same as never having pinged at all.
  return true;
}
export async function markChatRedirectSent(customer) {
  // A genuine visit since the last ping, 24h+ of real silence since the
  // last ping (Chidera, 2026-09-25: "after 24 hours renew the 5 times
  // trial"), or this being the very first ping ever, all start a fresh
  // count of 1 -- otherwise this is one more consecutive ping in the
  // current silent-run, see needsChatRedirect's own comment for why
  // that's capped at 5.
  const visitedSinceLastPing =
    customer.chat_redirect_sent_at && customer.web_chat_active_at && new Date(customer.web_chat_active_at) > new Date(customer.chat_redirect_sent_at);
  const renewed24h = customer.chat_redirect_sent_at && new Date(customer.chat_redirect_sent_at) < new Date(Date.now() - 24 * 60 * 60 * 1000);
  const nextCount = !customer.chat_redirect_sent_at || visitedSinceLastPing || renewed24h ? 1 : (customer.chat_redirect_count || 0) + 1;
  await pool.query('update customers set chat_redirect_sent_at = now(), chat_redirect_count = $2 where id = $1', [customer.id, nextCount]);
}

// Sends ONLY the real ping itself (send + log + mark chat_redirect_sent_at)
// -- shared by sendStaffReplyRedirect, notifyComplaintReply, and
// notifyGuestsReadyToPay, which each had their own near-identical copy of
// this exact "real CTA-URL send, 24h-window template fallback, log the
// ping (never the real content)" logic. Whether to call this at all is
// each caller's own decision -- notifyComplaintReply always does (a
// manager's reply is unscheduled); the others gate it on
// needsChatRedirect(customer) first.
export async function sendChatRedirectPing(customer, pingText, { trigger = 'chat_redirect_ping', sender = 'bot' } = {}) {
  const token = await ensureMenuToken(customer);
  const chatUrl = `${process.env.PUBLIC_URL}/wa/${token}`;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  let sendResult;
  try {
    sendResult = await sendWhatsAppCtaUrl(recipientFor(customer), pingText, 'Tap here to text', chatUrl, credentials);
  } catch (err) {
    // Same 131047 (24h session window closed) fallback every real send in
    // this file already relies on -- the ping itself must not just fail
    // silently either.
    if (!/131047/.test(err.message)) throw err;
    const components = [{ type: 'body', parameters: [{ type: 'text', text: pingText }] }];
    sendResult = await sendWhatsAppTemplate(customer.phone_number, 'business_outreach', 'en_US', components, credentials);
  }
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender, body: pingText, trigger, platformMessageId: platformMessageIdFrom(customer, sendResult) });
  await markChatRedirectSent(customer);
}

// Chidera, 2026-09-22: "meta will start charging 14 naira per message...
// there should be a greeting text o, like hello tap the link below to
// place an order." The one real WhatsApp message a customer's first
// contact gets (a plain "hi", or a "Place an order" button tap) -- shared
// by handleGreeting and handleStartOrderTap so both converge on the exact
// same short send. The FULL welcome text (buildGreetingContent above)
// moves to the web-chat page's own first bubble (routes/web-chat.js),
// never sent over the real Cloud API -- only this short line + one CTA
// button is.
export async function sendStartOrderLink(customer, { dineinTableLabel = null, dineinQrToken = null, readyToPay = false } = {}) {
  if (!process.env.PUBLIC_URL) {
    const { message } = await buildGreetingContent(customer);
    await reply(customer, message, 'greeting');
    return;
  }
  // Chidera, 2026-09-24: "that first greeting text should be tap here to
  // text... instead of bot sending menu immediately, it should send a
  // hey, what would you like to do? with 2 buttons." The chat page this
  // links to now asks first (order vs feedback) instead of assuming
  // ordering -- the real WhatsApp CTA shouldn't presuppose that either.
  // Chidera, 2026-09-24: "that first text should still have the welcome
  // to <restaurant name>, tap below to get started" -- a bare "Hello!"
  // read as too generic/anonymous for the one real message every customer
  // actually sees; the business's own name belongs in it even though the
  // rest of the welcome moved to the free chat bubble.
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  const bizName = bizRows[0]?.name || 'us';
  // Chidera, 2026-09-25: "let the greeting text difference be welcome to
  // <restaurant name> tap below to get started on for your dine in
  // session." A table scanner already knows exactly why they're texting
  // (they just scanned a table's QR code) -- the one real WhatsApp message
  // they get should say so, not the generic online-order wording.
  // Chidera, 2026-09-25 (live report): "i just realized in dine in that
  // served you can pay now is inside web and they may not see it" --
  // rescanning the table's own QR is the only way back for a guest who
  // closed the web chat tab, and it used to say the exact same generic
  // "tap below to get started" whether or not their own real "ready to
  // pay" bubble (notifyGuestsReadyToPay) was already sitting there
  // waiting -- nothing here signalled it was worth tapping through for.
  // Chidera, 2026-09-25: "that greeing add Hello! at the begining" --
  // said right after the 3x re-greet cap fix above, about this exact
  // message. Doesn't undo the 2026-09-24 call above (a BARE "Hello!"
  // alone was too generic/anonymous) -- this adds it as a warm opener
  // ahead of the specific "Welcome to X" that already answers that.
  const tail = dineinTableLabel ? 'get started on your dine-in session.' : 'get started.';
  const shortGreeting = readyToPay
    ? (customer.name
        ? `Welcome back to ${bizName}, ${customer.name}! Your table's ready to pay -- tap below.`
        : `Welcome back to ${bizName}! Your table's ready to pay -- tap below.`)
    : (customer.name
        ? `Hello! Welcome to ${bizName}, ${customer.name}! Tap below to ${tail}`
        : `Hello! Welcome to ${bizName}! Tap below to ${tail}`);
  const token = await ensureMenuToken(customer);
  // Chidera, 2026-09-25: "let table dine in and online delivery have their
  // complete different web chat." Routes/web-chat.js's own ?table= is what
  // actually opens THIS table's separate thread instead of the generic
  // online one -- without it a table scan and a plain "hi" would land on
  // the exact same page/thread for the same customer_id.
  const chatUrl = dineinQrToken
    ? `${process.env.PUBLIC_URL}/wa/${token}?table=${encodeURIComponent(dineinQrToken)}`
    : `${process.env.PUBLIC_URL}/wa/${token}`;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  // Chidera, 2026-09-23: "let first message still have that cover photo"
  // -- handleGreeting (the original, full-length greeting) always resolved
  // this; sendStartOrderLink replaced it as the real send for the SHORT
  // first-contact message this feature introduced, and dropped the cover
  // photo along the way. Same businessCoverPhotoUrl() fallback every other
  // real send in this file already uses (sendWebMenuLink's own comment:
  // "ensure image appear on chat cause its not still appearing").
  await sendWhatsAppCtaUrl(recipientFor(customer), shortGreeting, 'Tap here to text', chatUrl, credentials, await businessCoverPhotoUrl());
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: shortGreeting, trigger: 'greeting', processed: true });
}



export async function summariseOrder(order) {
  // Chidera, 2026-09-17: "when you ask those penne or spaghetti questions
  // or cold or room temperature, you dont record it anywhere??" -- it was
  // recorded (order_item_answer), just never read back into any message
  // anyone actually sees. Joined in here since summariseOrder already
  // feeds both the customer's own confirm message and the staff prep
  // alert -- one fix covers both.
  const { rows } = await pool.query(
    `select p.name, oi.quantity, oi.price,
       coalesce(
         (select string_agg(oa.answer, ', ' order by oa.created_at)
          from order_item_answer oa where oa.order_item_id = oi.id),
         ''
       ) as answer_summary
     from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
    [order.id]
  );
  const lines = rows.map((r) => `${r.quantity}x ${r.name} (NGN ${r.price} each)`).join(', ');
  // One item per line, for callers that want a structured breakdown
  // (finishItemsCollection's own confirm message) instead of `lines`
  // above's single comma-run paragraph -- Chidera's call, 2026-09-10:
  // "can it start stating price confirmation in a structured line by line
  // way not paragraph". Colon separator, not a dash -- reply()'s own
  // normalizeDashes turns " - " into ", ", which would silently collapse
  // this right back into a run-on line.
  const itemLines = rows.map((r) => `${r.quantity}x ${r.name}${r.answer_summary ? ` (${r.answer_summary})` : ''}: NGN ${r.price}`);
  const itemsTotal = rows.reduce((sum, r) => sum + Number(r.price) * r.quantity, 0);
  // delivery_fee is 0 until handleCollectFulfilment sets it (only known once
  // fulfilment_type/address are collected, and only for real Chowdeck
  // delivery) -- reading it straight off the order row here means callers
  // before and after that point both get the right total automatically.
  const deliveryFee = Number(order.delivery_fee || 0);
  return { lines, itemLines, itemsTotal, deliveryFee, total: itemsTotal + deliveryFee };
}

// Moved to ./payment-flow.js, 2026-10-01 (sixth phase of breaking up this
// file -- see that file's own header). sendPaymentInstructions/
// handleWaitingOnPayment are imported back since dispatch below calls
// them directly; sendPaymentLinkButton is no longer used in THIS file
// (its last caller, sendTopupInvoice, moved to ./ordering.js in the
// seventh phase -- that file imports it straight from payment-flow.js
// instead). Every exported name here is also re-exported so no existing
// EXTERNAL import site has to change.
import {
  sendPaymentInstructions,
  resolveBackToChatUrl,
  sendOutstandingBalanceLink,
  sendPaymentReminder,
  handleWaitingOnPayment,
  completeTopupPayment,
  sendReceiptMessage,
  completePayment,
  checkMoniepointPaymentPaid,
  ensureDynamicPosAccount,
  notifyCustomerClaimedPosPayment,
} from './payment-flow.js';
export {
  sendPaymentInstructions,
  resolveBackToChatUrl,
  sendOutstandingBalanceLink,
  sendPaymentReminder,
  completeTopupPayment,
  sendReceiptMessage,
  completePayment,
  checkMoniepointPaymentPaid,
  ensureDynamicPosAccount,
  notifyCustomerClaimedPosPayment,
};

// A customer with an open order doesn't stop asking real questions just
// because the bot's mid-flow -- "how much again?", "what's in my order?"
// deserve a direct, real answer grounded in the actual order, not whatever
// canned line this stage would otherwise send regardless of what was
// actually asked. Found live: "How much again?" while awaiting payment got
// answered with the payment-waiting nudge, ignoring the question entirely.
// null means this message wasn't actually asking anything (idle chatter,
// "ok", "thanks") -- caller falls through to its normal canned handling.
// A cheap word-overlap check against real catalogue item names -- used as
// a deterministic net under the AI's own "not available" verdict below,
// same idiom as BROWSE_PATTERNS is for its "general browse" verdict.
// Found live, 2026-09-10: "is there rice?" got a false "No, we don't have
// that" from the model twice running, despite two real rice items on the
// menu -- real product-name overlap with the question always outranks a
// per-call judgment on whether something exists.
function menuKeywordMatch(text, menu) {
  const words = (text.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOPWORDS.has(w));
  if (!words.length) return [];
  return menu.filter((p) => {
    const nameLower = p.name.toLowerCase();
    return words.some((w) => nameLower.includes(w));
  });
}
const STOPWORDS = new Set(['the', 'you', 'any', 'are', 'and', 'for', 'have', 'there', 'got', 'that', 'this']);

async function answerOrderQuestion(order, text, statusLine) {
  const { lines, total, deliveryFee } = await summariseOrder(order);
  // Not just menu prices -- "when do you close?" mid-order needs the same
  // knowledge base and business facts answerFromKnowledgeBase already has
  // access to, not a smaller private copy of just the catalogue. Found
  // live: without this, a real answer ("24/7", already in the knowledge
  // base) got replaced with a made-up "let me check with the team."
  const { businessContext, menuContext, kbContext } = await buildBusinessKnowledgeContext(order.branch_id);
  const orderLine = lines ? `their order so far: ${lines}${deliveryFee > 0 ? `, plus NGN ${deliveryFee} delivery fee` : ''}, total NGN ${total}` : `nothing added to their order yet`;
  const system = `You're a staff member replying MID-CONVERSATION to an existing customer you're already talking to -- ${orderLine}. ${statusLine}\n\nThis is not an opening message. Never use first-contact phrases like "thanks for reaching out" or any greeting -- reply exactly like someone already in the middle of a conversation would.\n\n${businessContext}\n\n${menuContext}\n\n${kbContext}\n\nDoes this message ask a real question (their order, the menu, business hours/location, delivery, payment, anything covered above) that deserves a direct answer? If yes, answer it directly and warmly using ONLY the real details given here. A direct, unambiguous consequence of a stated fact counts as answerable too -- e.g. "open 24/7" directly means "we don't close", and the menu above is the FULL list of what's available, so asked about anything not on it, the real answer is a short "no, we don't have that" (that clause only -- never also name what's actually available yourself, see the special case below for how that part is handled) rather than a non-answer. Never invent a fact that isn't supported by what's given, and never claim you're checking with the team or will follow up unless that's real (nothing here authorizes that) -- if it's genuinely not covered, just say plainly you don't have that info right now. Answer ONLY what was actually asked -- never ask your own follow-up question about delivery vs pickup, or which branch, even in passing. Those are asked separately, once, at the right point in the flow by a different fixed step -- asking about them here creates a second, fake version that doesn't actually get saved anywhere, so when the real fixed step asks for real later, it looks like a broken repeat of something they already answered. If the message isn't actually asking anything (small talk, "ok", "thanks"), reply with exactly {"answer": null, "isGeneralAvailability": false}.\n\nSpecial case -- does answering properly involve the full list of what's available? Either a BROAD browse question naming no specific item ("what do you have", "what's on the menu", "what's available", "can I see the menu/catalogue"), OR a specific item that's NOT available (where "here's what we do have" would be the natural next thing to say). For either, set "isGeneralAvailability": true -- for the broad case leave "answer" null, for the not-available case "answer" is only the short "no" clause. Never write out the item list yourself in either case -- a real, always-current menu with photos and prices is shown separately as an interactive button right after (this JSON's "answer" is only a fallback for whenever that button truly can't be shown). This is different from a question naming or clearly implying a specific item that IS available ("do you have jollof", "how much is suya", "any rice dish?", "is there something spicy") -- that's answerable, not general, so answer it directly as usual with real semantic matching against the actual menu (meaning, not exact wording), isGeneralAvailability false.\n\nReply ONLY with JSON: {"answer": "<direct answer text>" or null, "isGeneralAvailability": true or false}.`;
  const result = await askJson(system, text);
  const answer = typeof result?.answer === 'string' && result.answer.trim() ? result.answer.trim() : null;
  const isGeneralAvailability = Boolean(result?.isGeneralAvailability);

  // Per this prompt's own contract, isGeneralAvailability + a real answer
  // together only ever mean the "specific item, NOT available" case (the
  // broad-browse case always leaves answer null) -- exactly the verdict
  // menuKeywordMatch above exists to double-check.
  if (isGeneralAvailability && answer) {
    const menu = await resolveMenu(order.branch_id);
    const matches = menuKeywordMatch(text, menu);
    if (matches.length) {
      return {
        answer: `We do have that -- ${matches.map((m) => m.name).join(' and ')} ${matches.length > 1 ? 'are' : 'is'} available.`,
        isGeneralAvailability: false,
      };
    }
  }
  return { answer, isGeneralAvailability };
}

// A fast, deterministic net under the AI's own isGeneralAvailability
// classification -- found live: the AI's per-message judgment isn't
// perfectly consistent (a plain "What do you have?" got silently skipped
// once because the customer was already mid-order, being asked for a
// branch). The rule as stated is absolute -- a broad browse question
// always gets the real menu, no exceptions for where they are in the
// order -- so it can't be left to per-call AI judgment alone. These are
// the common, unambiguous ways a customer actually asks to browse;
// matching any of them guarantees the menu shows regardless of what the
// AI decided this specific time. Deliberately narrow (only the plainly
// general phrasings) -- a specific-item question ("do you have jollof")
// must still fall through to real text/semantic matching, never this.
const BROWSE_PATTERNS = [
  /\bwhat.*(do you|d(o|')ya|you).*(have|sell|offer)\b/i,
  /\bwhat.*(is|'s|are).*(on the )?menu\b/i,
  /\bwhat.*(is|'s).*available\b/i,
  /\b(show|see|view|send).*(me\s+)?(the\s+)?(menu|catalogue|catalog)\b/i,
  /^\s*menu\s*(please|pls)?\s*[.?!]*\s*$/i,
  /\bwhat.*options\b/i,
];
export function looksLikeBrowseQuestion(text) {
  return typeof text === 'string' && BROWSE_PATTERNS.some((re) => re.test(text.trim()));
}

// Shared by every place that can be asked a broad "what do you have" --
// Instagram has no equivalent of WhatsApp's cta_url interactive message,
// so sendWebMenuLink is WhatsApp-only. The system prompt driving `answer`
// (answerOrderQuestion/answerFromKnowledgeBase) is told never to write out
// the item list itself for a broad availability question, on the promise
// that "a real menu is shown separately as an interactive button right
// after" -- a promise this function used to just silently break for
// Instagram, returning `answer` unchanged (often null, or a vague filler
// line the AI generated instead of a real list). Found live, 2026-09-03,
// Chidera's own words: "why did i ask what is available on ig and they
// said we have some tasty dis for you? where is menu?" A plain-text
// listing is the honest fallback here -- not the wall-of-text WhatsApp
// avoids by having a real button, but strictly better than nothing or a
// vague non-answer, which is the actual choice on this channel.
async function formatMenuAsText(branchId) {
  const products = await resolveMenu(branchId);
  if (!products.length) return null;
  // No dash separator and no toLocaleString comma-grouping -- reply()'s own
  // normalizeDashes turns " - " into ", " and adds a space after every
  // comma it finds, including ones already inside a formatted number, which
  // mangled "NGN 1,500" into "NGN 1, 500" the first time this ran live.
  // Plain digits match how every other bot-generated price in this file
  // (e.g. sendPaymentInstructions's `NGN ${order.total}`) already writes
  // one -- comma-grouping is a dashboard-UI-only convention (orderStages.js
  // et al), not something bot text has ever done.
  const lines = products.map((p) => `${p.name}: NGN ${Number(p.price)}`);
  return `Here's what we have:\n${lines.join('\n')}`;
}

// mid-order (answerOrderQuestion) and pre-order (answerFromKnowledgeBase)
// alike. Prefers the real, always-current interactive menu button (built
// and sent by this backend, re-sent every time it's asked, not just once)
// over the plain-text item list; falls back to the text answer whenever
// the catalogue is genuinely empty or the send itself fails, so a customer
// is never left with silence just because of a transient WhatsApp error.
export async function resolveGeneralAvailability(customer, isGeneralAvailability, answer, rawText, branchId) {
  const shouldShowMenu = isGeneralAvailability || looksLikeBrowseQuestion(rawText);
  if (!shouldShowMenu) return answer;

  if (customer.channel === 'instagram') {
    // Was a menu-photo forward (Chidera's call, 2026-09-03) -- superseded
    // 2026-09-10: "let bot no longer send menu photos itself". Straight to
    // the real text listing now, same "something beats silence" reasoning
    // as before the photo path existed.
    const menuText = await formatMenuAsText(branchId);
    if (!menuText) return answer;
    return answer ? `${answer}\n\n${menuText}` : menuText;
  }
  // The real web menu (site), not the old native List Message -- Chidera
  // 2026-09-11: "anywhere bot was meant to give that list view menu
  // remove and put the site one, the list one will only be used for
  // upsell." sendWebMenuLink already handles its own sandbox awareness
  // and logging (sendMenuList had neither), so no separate EBOS_SANDBOX
  // gate or logMessage call needed here anymore either.
  const shown = await sendWebMenuLink(customer, "Here's our menu, take a look and let me know what you'd like.").catch((err) => {
    console.error('sendWebMenuLink failed:', err.message);
    return false;
  });
  // Whether the link sent or not, `answer` is returned unchanged here --
  // it's either null (a pure browse question, nothing else to say) or a
  // short factual clause ("no, we don't have that") that's genuinely worth
  // saying on its own, alongside the link when it sent, and by itself if
  // it didn't. Never falls back to writing the full item list as text on
  // failure -- that's exactly the wall-of-text problem this link exists
  // to avoid, worse the bigger the menu. A short generic nudge instead.
  if (shown || answer) return answer;
  return 'Sorry, having a little trouble showing the menu right now. Let me know what you would like, or ask about a specific item.';
}

// Wraps answerOrderQuestion so every mid-order call site gets the above for
// free. Returns a plain string|null exactly like answerOrderQuestion used
// to, so every existing `if (answer) {...}` call site needed no other
// changes.
export async function answerOrThenShowMenu(customer, order, text, statusLine) {
  const { answer, isGeneralAvailability } = await answerOrderQuestion(order, text, statusLine);
  return resolveGeneralAvailability(customer, isGeneralAvailability, answer, text, order.branch_id);
}


// Phase 2 of the web-chat feature: on plain WhatsApp, a customer left
// sitting at confirm_payment naturally re-engages by texting something
// (even just "okay"), which is what actually triggers handleWaitingOnPayment
// above -- pure silence gets pure silence forever, nobody's ever proactively
// re-pinged. That's the one real gap the web-chat page makes worse, not
// better: a customer who taps "Ready to pay?", opens the pay page, then
// just closes the tab without ever typing anything back has no way to
// trigger a reminder at all. This is the proactive counterpart --
// PAYMENT_NUDGE_MINUTES of real silence (order.updated_at, same staleness
// signal closeStaleOrders already uses) triggers exactly ONE real WhatsApp/
// Instagram nudge, reusing sendPaymentReminder's own payment_reminder_sent_at
// guard so this and a customer's own later message can never double-send.
// Skips anyone whose web_chat_active_at is still fresh -- they're looking
// at the "Ready to pay?" bubble right now, a real WhatsApp ping on top of
// that would be the exact unwanted extra message this whole feature exists
// to avoid, not a safety net. dinein is deliberately excluded (order.channel
// in ('whatsapp','instagram') only) -- a table still physically at the
// restaurant isn't "abandoned" the same way, and dine-in's own payment flow
// is staff-mediated, not this reminder's concern.
// Chidera, 2026-09-26: moved to ./sweeps.js, re-exported here, same as
// refreshExpiringPaymentLinks/closeStaleOrders above.
export { sweepAbandonedWebChatOrders } from './sweeps.js';

// Chidera, 2026-09-25: "when a customer text and abandon a menu maybe they
// text bare chat and they dont open web menu or they open webmenu but dont
// say anything after see menu, retext them... 10 mins after abandonment."
// A DIFFERENT, earlier gap than sweepAbandonedWebChatOrders above -- that
// one only ever fires once a real order already exists and reached
// confirm_payment. This covers everything BEFORE that: a customer who got
// the greeting/first-choice/dinein bubble (or opened the web menu itself,
// which touches web_chat_active_at but never last_message_at on its own)
// and then just went quiet, possibly with no order row at all yet.
// last_message_at (touched by logMessage on both inbound and outbound)
// is the real "last activity on this thread" clock -- opening the web
// menu without saying/tapping anything after never advances it, so
// staying on "See menu" with no follow-up correctly counts as abandonment
// too, not just silence after a bare text.
// Deliberately reuses sendChatRedirectPing/chat_redirect_sent_at (the same
// "tap here to text" mechanism handlePendingBatch's own bare-WhatsApp
// redirect already uses) rather than a second, parallel ping system --
// same underlying situation (customer isn't using the web chat right now),
// just a different trigger (a silence timer instead of a fresh bare text).
// Its own guard is written directly here rather than via needsChatRedirect
// -- that helper's 30-minute "actively on page" window would silently
// delay this to ~30 minutes instead of the requested 10 for anyone in the
// 10-30 minute band, since a page LOAD alone (no message) touches
// web_chat_active_at without ever advancing last_message_at.
// Chidera, 2026-09-26: moved to ./sweeps.js, re-exported here, same as
// the other sweeps above.
export { sweepAbandonedChatCustomers } from './sweeps.js';

// Moved to ./ordering.js, 2026-10-01 (seventh and final phase of breaking
// up this file -- see that file's own header). dispatch() right below is
// the thin router the original plan called for -- it only decides WHICH
// of these runs next off order.engine_state, never duplicates their
// logic. Every name here is imported back for dispatch's own switch
// statement and the handful of other staying functions
// (handlePendingBatch, shouldSkipTypingIndicator, handleWebMenuOrder,
// handleMenuItemTap, handleOrderConfirmYesTap) that call directly into
// this file; every exported name is also re-exported so no existing
// EXTERNAL import site has to change.
import {
  handleCollectInfo,
  UPSELL_GROUPS,
  categoryMatchesGroup,
  sendUpsellList,
  finishItemsCollection,
  handlePendingUpsell,
  handleUpsellListTap,
  handleUpsellMultiTap,
  handlePendingItemQuestion,
  handleItemQuestionChoiceTap,
  handleConfirmOrder,
  markOrderConfirmed,
  handleReconfirmAfterEdit,
  sendFieldPrompt,
  handleCollectFulfilment,
  clearPendingQuestionIfOnItem,
  applyOrderModifications,
  sendTopupInvoice,
  handleOrderModification,
  handleFulfilmentChange,
  classifyPureAck,
  handleFulfilmentStageMessage,
  handlePostPaymentFulfilmentChange,
} from './ordering.js';
export {
  handleCollectInfo,
  UPSELL_GROUPS,
  categoryMatchesGroup,
  sendUpsellList,
  finishItemsCollection,
  handlePendingUpsell,
  handleUpsellListTap,
  handleUpsellMultiTap,
  handleItemQuestionChoiceTap,
  handleConfirmOrder,
  sendFieldPrompt,
  applyOrderModifications,
  handlePostPaymentFulfilmentChange,
};

async function dispatch(customer, order, text) {
  // Mid-way through asking an item's customization question(s) -- see
  // askNextItemQuestion/handlePendingItemQuestion. Checked before anything
  // else regardless of engine_state (this only ever gets set during item
  // collection, engine_state never actually changes for it), so the reply
  // is captured as the answer instead of running through the normal
  // modification/intent checks below, which could easily misread a short
  // answer like "cold" or "no pepper" as something else entirely.
  if (order.pending_question_id) {
    return handlePendingItemQuestion(customer, order, text);
  }
  // Mid-way through the drink/protein cross-sell offer -- see
  // nextUpsellGroup/handlePendingUpsell. Same reasoning as the
  // pending_question_id check above: this reply should be read as an
  // answer to that specific question, not run through the normal
  // modification/intent checks below.
  if (order.pending_upsell_category) {
    return handlePendingUpsell(customer, order, text);
  }
  if (['confirm_order', 'confirm_payment', 'fulfilment'].includes(order.engine_state)) {
    const { rows: currentItems } = await pool.query(
      `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
      [order.id]
    );
    const mods = await extractOrderModifications(text, currentItems, order.branch_id);
    if (mods) {
      await handleOrderModification(customer, order, mods);
      return;
    }
  }
  // Delivery vs pickup can change any time, even after payment -- a real
  // case, not an edge case to ignore: paid expecting to pick up, then can't
  // make it and needs it delivered instead. Only relevant once
  // fulfilment_type is actually set -- otherwise this is still the normal
  // first-time question, handled by the switch below, not a "change".
  if (['confirm_order', 'confirm_payment', 'fulfilment'].includes(order.engine_state) && order.fulfilment_type) {
    const newType = await extractFulfilmentChange(order, text);
    if (newType) {
      if (order.engine_state === 'fulfilment') {
        await handlePostPaymentFulfilmentChange(customer, order, newType);
      } else {
        await handleFulfilmentChange(customer, order, newType);
      }
      return;
    }
  }
  switch (order.engine_state) {
    case 'understand_request':
    case 'collect_info':
      return handleCollectInfo(customer, order, text);
    case 'confirm_order':
      return order.confirmed_at ? handleCollectFulfilment(customer, order, text) : handleConfirmOrder(customer, order, text);
    case 'confirm_payment':
      // confirmed_at is null here only right after an edit reset it (see
      // handleOrderModification) -- everything else about this state means
      // payment instructions already went out and confirmed_at is set.
      return order.confirmed_at ? handleWaitingOnPayment(customer, order, text) : handleReconfirmAfterEdit(customer, order, text);
    case 'fulfilment':
      return handleFulfilmentStageMessage(customer, order, text);
    default:
      return reply(customer, 'Your order is already being handled, I will update you here.');
  }
}

// The payment-received message for a pickup order deliberately says "I'll
// let you know when to pick up" rather than implying it's ready immediately
// -- this is that actual notification, triggered by staff from the
// dashboard (routes/api.js) once it really is ready, not automatically.
export async function notifyReadyForPickup(orderId) {
  const { rows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = rows[0];
  if (!order) throw new Error('Order not found.');
  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];
  if (!customer) throw new Error('Customer not found.');
  await reply(customer, `Your order is ready for pickup!`, 'ready_for_pickup');
}

// Own_riders delivery only. Called the instant a delivery order's offer
// broadcasts (engine/delivery-dispatch.js) -- a customer whose order is
// out for delivery gets a real, working tracking link from THIS moment,
// not only once a rider happens to accept (Chidera's own Chowdeck-style
// stage tracker: "waiting for rider to accept order" is itself a real,
// trackable stage, not a gap before tracking starts).
// Chidera, 2026-09-23: "usually they send 2, one with normal link and one
// to track ride... so now i need it to be 1, the code should be in the
// link" -- this is now the ONLY real WhatsApp message an own_riders
// delivery ever gets for tracking, start to finish. It used to be followed
// by a second one (notifyDeliveryAssigned, since removed) once a rider
// accepted, purely to hand over the delivery code -- that's gone now, the
// SAME link (routes/tracking.js, which already live-polls its own status)
// just shows the code itself the moment a rider's assigned.
export async function notifyDeliverySearching(orderId, trackingPath) {
  const { rows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = rows[0];
  if (!order) throw new Error('Order not found.');
  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];
  if (!customer) throw new Error('Customer not found.');
  if (!process.env.PUBLIC_URL) return; // no link worth sending without it
  await reply(
    customer,
    `Your order is ready and we're finding you a rider. Track it here: ${process.env.PUBLIC_URL}${trackingPath}`,
    'delivery_searching'
  );
}

// WhatsApp gives no typing indicator on the business side, so there is no
// way to tell "still typing the next line" from "done, waiting on a reply".
// Someone who fires off three quick messages saying the same thing should
// get ONE reply to all of it, not three separate ones talking past each
// other. So an inbound message never triggers a reply directly -- it resets
// a per-customer timer, and only once a customer goes quiet for
// DEBOUNCE_MS does everything they sent since the last reply get processed
// together, as one combined message. Lives in memory only: a container
// restart mid-window drops the pending timer, but the message itself is
// already saved (see logMessage below), so the next inbound message (or a
// manual nudge) still picks it up in the next batch.
// Exported so sandbox/test-conversation.mjs can wait the real amount
// instead of a hardcoded guess that could silently drift out of sync.
// 15s -> 6s -> 2s, each Chidera's own call for a faster reply. At 2s, two
// messages sent more than 2 seconds apart will genuinely get answered
// separately rather than combined -- worth knowing if replies start
// feeling split up, but that's the direct tradeoff of "fast", not a bug.
export const DEBOUNCE_MS = 2_000;
const pendingTimers = new Map();

// A single one-shot typing indicator at the start of a debounce cycle used
// to be the whole story -- fine when Meta's own indicator outlives the
// debounce+processing wait, not fine when it doesn't. Found live,
// 2026-09-03, Chidera's own words: "why does instagram not show that
// typing thing again? even whatsapp doesnt sometimes" -- Instagram's
// sender_action typing_on visibly expires well inside 15s, and WhatsApp's
// own ~25s window can still run out if a real AI call inside
// handlePendingBatch takes a while after the debounce fires. This keeps
// re-sending on an interval (under each platform's own known lifetime)
// for as long as this customer has a message genuinely being worked on,
// and stops the moment processPendingMessages actually finishes -- see
// startTypingKeepAlive/stopTypingKeepAlive below and their two call sites.
const typingIntervals = new Map();

function startTypingKeepAlive(customer, channel, messageId, channelId) {
  if (typingIntervals.has(customer.id)) return; // already running for this burst
  const tick = () => {
    if (channel === 'whatsapp') {
      markTypingIndicator(messageId).catch((err) => console.error('Typing indicator failed:', err));
    } else if (channel === 'instagram') {
      markInstagramTypingIndicator(channelId).catch((err) => console.error('Instagram typing indicator failed:', err));
    }
  };
  tick();
  const intervalMs = channel === 'whatsapp' ? 20_000 : 15_000;
  typingIntervals.set(customer.id, setInterval(tick, intervalMs));
}

function stopTypingKeepAlive(customerId) {
  const id = typingIntervals.get(customerId);
  if (id) {
    clearInterval(id);
    typingIntervals.delete(customerId);
  }
}

// Whatever broke (a payment provider down, an unexpected bug, a dependency
// error, the AI provider itself failing/rate-limited), the customer must
// never be left with pure silence -- found live: a Paystack failure
// mid-flow left a WhatsApp customer hanging after "switching to pickup"
// with nothing further, ever, until they happened to message again. Best-
// effort and deliberately swallows its own failure, so a second error here
// can't cascade. Shared by scheduleDebouncedProcessing (the real WhatsApp
// path) and handleWebChatMessage (the web-chat path, added 2026-09-23 --
// found live, Chidera: "i sent a text, bot didnt reply me", on the /wa
// chat page, which had NO equivalent safety net at all until this) -- one
// place decides what a broken processing turn looks like to the customer,
// not two copies that could quietly drift apart.
async function recoverFromProcessingError(customer) {
  try {
    // Still lets the bot retry normally on every later message (the usual
    // handled_by='staff'-but-no-real-human-yet gate in handlePendingBatch
    // already does that) -- this only decides what the CUSTOMER sees when
    // a retry fails again. First failure: the one-time ack below. Every
    // failure after that, while still the same unresolved outage and no
    // staff reply yet: stay silent to the customer (no repeat "someone
    // will be with you shortly" spam) but still relay to staff, so a
    // message sent during a still-broken retry isn't lost. The moment a
    // retry actually succeeds, this never runs and the customer gets a
    // normal reply again.
    const { rows: freshRows } = await pool.query(
      'select handled_by, handover_reason, handled_by_staff_id, app_handled_at from customers where id = $1',
      [customer.id]
    );
    const fresh = freshRows[0];
    const alreadyInErrorHandover =
      fresh?.handled_by === 'staff' &&
      fresh.handover_reason === SYSTEM_ERROR_HANDOVER_REASON &&
      !(fresh.handled_by_staff_id || fresh.app_handled_at);

    if (alreadyInErrorHandover) {
      const { rows: lastMsg } = await pool.query(
        `select body from message where customer_id = $1 and direction = 'inbound' order by created_at desc limit 1`,
        [customer.id]
      );
      const recipients = await handoverRecipients();
      for (const { phoneNumber: to, staffId } of recipients) {
        await notifyStaff({ staffId, phoneNumber: to, title: 'Still erroring', body: `${displayNameFor(customer)} sent another message while still erroring: ${lastMsg[0]?.body || '(no text)'}` });
      }
    } else {
      // First failure -- one plain message, not two -- this used to send
      // its own "having trouble" line here and then handover()'s default
      // "let me confirm this properly" right after, which read as a
      // stitched-together non-sequitur to the customer (found live,
      // 2026-09-02: "let me confirm this properly" makes no sense right
      // after being told something broke).
      await handover(customer, SYSTEM_ERROR_HANDOVER_REASON, null, 'Hello, please someone will be with you shortly.');
    }
  } catch (innerErr) {
    console.error('Failed to notify customer after a processing error:', innerErr);
  }
}

function scheduleDebouncedProcessing(customer) {
  const existing = pendingTimers.get(customer.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(customer.id);
    processPendingMessages(customer.id).catch((err) => {
      console.error('Debounced message processing failed:', err);
      return recoverFromProcessingError(customer);
    });
  }, DEBOUNCE_MS);
  pendingTimers.set(customer.id, timer);
}

// A crash or redeploy wipes pendingTimers (in-memory only) -- the message
// itself was already saved before the timer was ever set, so nothing is
// lost, but without this, a customer whose reply was still pending at the
// exact moment of a restart would sit unanswered forever, silently, until
// they happened to message again or staff noticed by chance. Called once
// at server startup (see server.js): finds every bot-handled customer
// whose most recent message is inbound with nothing answering it yet, and
// re-schedules them the same as if they'd just texted in -- the customer
// never has to do anything or notice a gap.
export async function recoverPendingMessages() {
  const { rows } = await pool.query(`
    select c.* from customers c
    where c.handled_by = 'bot'
      and exists (select 1 from message m where m.customer_id = c.id)
      and (select m2.direction from message m2 where m2.customer_id = c.id order by m2.created_at desc limit 1) = 'inbound'
  `);
  for (const customer of rows) {
    scheduleDebouncedProcessing(customer);
  }
  if (rows.length) console.log(`Recovered ${rows.length} pending conversation(s) after restart.`);
}

// Which inbound messages are still unanswered used to be inferred from
// timestamps ("anything after my last reply") -- that broke for real: a
// message landing in the brief window between an earlier debounce timer
// firing and that reply actually being saved got a created_at EARLIER than
// the reply about to be logged, so it looked already-answered forever and
// was silently dropped, never processed, customer never told anything was
// wrong. Reproduced live on era-demo (a multi-item order where one message
// vanished this exact way). Fixed by marking each inbound message
// processed explicitly, once it's actually been handled -- no timestamp
// comparison, no race window regardless of how messages and replies
// interleave.
async function processPendingMessages(customerId) {
  const { rows: custRows } = await pool.query('select * from customers where id = $1', [customerId]);
  const customer = custRows[0];
  if (!customer) return; // deleted between scheduling and firing -- nothing to reply to

  const { rows: pending } = await pool.query(
    `select id, body from message where customer_id = $1 and direction = 'inbound' and processed_at is null order by created_at`,
    [customerId]
  );
  if (!pending.length) {
    stopTypingKeepAlive(customerId); // already answered by the time this fired
    return;
  }
  const text = pending.map((m) => m.body).join('\n');

  try {
    // Captured before processing -- found live, 2026-09-02: a customer stuck
    // in this exact handover from an earlier outage, bot replying to them
    // completely normally since (a real, successful reply logged), but still
    // sitting in Needs Attention forever because nothing ever cleared it.
    // "Waiting on the customer to reply" isn't "needs a person" -- the fix is
    // below, right after a successful reply proves the bot actually recovered.
    const wasStuckOnSystemError =
      customer.handled_by === 'staff' &&
      customer.handover_reason === SYSTEM_ERROR_HANDOVER_REASON &&
      !(customer.handled_by_staff_id || customer.app_handled_at);

    await handlePendingBatch(customer, text);

    if (wasStuckOnSystemError) {
      // Only clear if the reason is STILL the system-error one -- if this
      // same pass raised a fresh, different, real handover (a complaint
      // buried in this batch, say), that one deserves to stay flagged, not
      // get silently wiped out just because it happened to follow an outage.
      const { rows: freshRows } = await pool.query('select handover_reason from customers where id = $1', [customerId]);
      if (freshRows[0]?.handover_reason === SYSTEM_ERROR_HANDOVER_REASON) {
        await pool.query(`update customers set handled_by = 'bot', handover_reason = null, handover_at = null where id = $1`, [customerId]);
      }
    }

    // Only marked once actually handled -- if handlePendingBatch throws, these
    // stay unprocessed and get picked up (and re-included) the next time
    // anything schedules processing for this customer, instead of being
    // written off by a batch that never actually replied to them.
    await pool.query(
      `update message set processed_at = now() where id = any($1)`,
      [pending.map((m) => m.id)]
    );
  } finally {
    // Stops the moment this batch is done, success or failure -- the
    // customer either has their real reply now, or (on failure) got
    // scheduleDebouncedProcessing's own error-recovery ack instead, and
    // either way "typing..." forever after that would be a lie.
    stopTypingKeepAlive(customerId);
  }
}


// Moved to ./dinein.js, 2026-10-01 (third phase of breaking up this file --
// see that file's own header). handleDineinScan/currentDineinSession/
// confirmOrderPayment/resetServedForAddOn are imported back below since
// other code in THIS file (handlePendingBatch's own dispatch,
// matchPosTransactionToPayment's own webhook caller, markOrderConfirmed,
// applyOrderModifications) calls them directly; every exported name here
// is also re-exported so no existing EXTERNAL import site has to change.
import { handleDineinScan, currentDineinSession, confirmOrderPayment, resetServedForAddOn } from './dinein.js';
export {
  upsertTableGuest,
  getOrCreateTableOrder,
  buildDineinGreetingContent,
  currentDineinSession,
  handleDineinButtonTap,
  closeTableSessionIfSettled,
  createOrderPayment,
  confirmOrderPayment,
  matchPosTransactionToPayment,
  notifyGuestsReadyToPay,
  resetServedForAddOn,
} from './dinein.js';


// Joint dine-in, Stage 2: getOrCreateTableOrder can now reopen an order
// that's already walked all the way through to 'fulfilment' (confirmed,
// being prepared, or even already served) -- finishItemsCollection
// unconditionally calls transitionOrder(order, 'check_availability'),
// which the state machine only allows FROM 'collect_info'
// (schema.sql's bot_state seed), so re-running it on a further-along order
// threw "confirm_order -> check_availability is not an allowed move"
// (found via the sandbox test's post-serve add-on case, not assumed).
// This is a deliberate restart of the collection sub-cycle for the new
// round of items, not a normal forward move the state machine's own
// transition table should have to model -- same reasoning a brand-new
// order already gets away with (INSERT sets engine_state = 'collect_info'
// directly, no transitionOrder call at all). No-op when the order's
// already there (the ordinary still-deciding-the-first-round case).
export async function restartItemsCollection(order) {
  if (order.engine_state === 'collect_info') return;
  await pool.query(`update "order" set engine_state = 'collect_info' where id = $1`, [order.id]);
  order.engine_state = 'collect_info';
}

// resetServedForAddOn moved to ./dinein.js, 2026-10-01 (re-exported above
// with the rest of that file's exports) -- "Joint dine-in, Stage 2: even
// if staff marks served and it goes to the next pipeline and they still
// add it should go back to first pipeline" (the original chat-only
// version of this rule, applyOrderModifications below) also alerts staff
// -- "Table X added more after being served" -- reusing
// orderAlertRecipients/sendStaffAlert exactly as completePayment's own
// ready-to-prepare ping already does, not new plumbing. Exported and
// shared between applyOrderModifications (typed-chat adds) and
// routes/dinein-menu.js's web review route (which replaces the whole
// basket rather than diffing adds/removes, so it can't reuse
// applyOrderModifications itself) -- one place decides what "served, then
// added to" means and what it does about it.

// Unified feedback -- replaces the old dine-in-only, table-close-delayed,
// 3-button Good/Alright/Not-good system entirely. Chidera 2026-09-11: "the
// questions will be how was your experience? how was the food? and how
// was the service? 5 starts to rate" -- sent for EVERY order (delivery,
// pickup, or dine-in) the moment it actually reaches status = 'completed'
// (see the shared hook this function is called from at each of the three
// real completion sites: routes/api.js's /orders/:id/status,
// routes/rider.js's delivery-code entry, routes/delivery.js's release),
// not hours later.
//
// A real rating FORM (routes/feedback-form.js, opened via this cta_url
// link), not a chat exchange -- Chidera 2026-09-11 corrected an earlier
// pass here twice: first asked "cant they all be collected in one chat or
// form?", which became a single free-text message parsed by AI; then "i
// told you to make your own rating form not your own text" -- a real
// WhatsApp Flow (Meta's own native form) needs authoring and registering
// with Meta first ("no i dont know how but cant you set it up yourself
// and push without meta"), so this is our OWN web form instead, same
// pattern already proven for the web menu and tracking pages, no Meta
// approval needed for any of it.
export async function sendFeedbackRequest(orderId) {
  if (!process.env.PUBLIC_URL) return;
  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = orderRows[0];
  if (!order) return;
  const { rows: customerRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = customerRows[0];
  // Same no-live-request gap as completePayment above -- this fires from
  // dine-in's own payment completion, a rider's delivery release, or a
  // pickup release, none of which have a live customer object to flip.
  // web_chat_active_at fresh (customer was on the chat page recently, e.g.
  // dine-in feedback fires the instant payment confirms, or an online
  // customer still tracking delivery) means the request becomes a bubble
  // instead of a real send; stale or never-set falls through to the real
  // WhatsApp/Instagram channel below exactly as before -- a customer whose
  // order was delivered hours ago has long since left the page, and real
  // WhatsApp is the right way to reach them for this, not a dead tab.
  if (customer && customer.web_chat_active_at && new Date(customer.web_chat_active_at) > new Date(Date.now() - 30 * 60 * 1000)) {
    customer.channel = 'website';
  }
  // Chidera, 2026-09-23: "i only want customer getting 2 messages- 1.
  // greetings message and 2. you order is ready for pick up or the
  // delivery message with delivery link" -- a web-chat customer who's
  // gone stale (closed the tab) used to still get this as a real 3rd
  // WhatsApp/Instagram message, the one gap left in the near-zero-message
  // promise: by the time an order's actually fulfilled, they've almost
  // always left the page. That's a real, deliberate trade-off (feedback
  // is genuinely never collected from someone who doesn't reopen the
  // chat), not a bug -- she chose the message cap over completeness here.
  // A customer who never touched web-chat at all (web_chat_active_at is
  // still null -- a classic WhatsApp/Instagram-only order) is unaffected:
  // this promise was only ever about the new web-chat flow.
  if (customer && customer.channel !== 'website' && customer.web_chat_active_at) return;
  // Chidera, 2026-09-21: "look at my instagram flow... how does instagram
  // catch up to our current state" -- this used to flatly skip Instagram
  // (no feedback request ever sent), the one deliberate WhatsApp-only
  // gate left after fixing the actual ordering-flow gaps (menu link,
  // POS payment) -- same plain-text-link fallback as everywhere else now.
  if (!customer || !['whatsapp', 'instagram', 'website'].includes(customer.channel)) return;
  const { rows: inserted } = await pool.query(
    `insert into order_feedback (order_id, branch_id, customer_id, channel)
     values ($1, $2, $3, $4) on conflict (order_id) do nothing returning id`,
    [order.id, order.branch_id, order.customer_id, order.channel]
  );
  if (!inserted.length) return; // already sent for this order
  const url = `${process.env.PUBLIC_URL}/f/${inserted[0].id}`;
  if (customer.channel === 'website') {
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `How was your order? Tap below to rate it, takes 10 seconds.\n[feedback form sent: ${url}]`, trigger: 'feedback_form_sent', interactive: { type: 'cta_url', buttonText: 'Rate your order', url } });
    return;
  }
  if (customer.channel === 'instagram') {
    await reply(customer, `How was your order? Tap below to rate it, takes 10 seconds.\n\n${url}`, 'feedback_form_sent');
    return;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), 'How was your order? Tap below to rate it -- takes 10 seconds.', 'Rate your order', url, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[feedback form sent: ${url}]`, trigger: 'feedback_form_sent' });
}

export async function handlePendingBatch(customer, text) {
  if (await handleDineinScan(customer, text)) return;
  // Checked first, before ANY other routing -- deterministic and free.
  // Applies everywhere EXCEPT while an order is still actively being
  // processed (Chidera's call, 2026-09-02: a staff member had just quoted
  // the delivery fee -- payment still outstanding -- and a plain "okay"
  // got pure silence instead of the payment nudge handleWaitingOnPayment
  // already exists specifically to give; silence is only right once
  // there's genuinely nothing left pending, not mid-order). getOpenOrder
  // already excludes 'completed'/'cancelled', so reusing it here is the
  // exact same "is this actually done" boundary the rest of the engine
  // uses, not a new one invented just for this check. When there IS an
  // open order, this falls through to the real per-state dispatch below,
  // which already knows how to answer a plain "ok" gracefully at each
  // stage (see handleWaitingOnPayment's own anti-repeat guard, and
  // handleFulfilmentStageMessage's comment on why paid-and-preparing stays
  // quiet) -- this isn't bypassing that judgment, just no longer skipping
  // it universally before it gets a chance to run.
  const ackType = classifyPureAck(text);
  if (ackType === 'ack') {
    const openOrder = await resolveCustomerOrder(customer);
    if (!openOrder) return;
  } else if (ackType === 'thanks' || ackType === 'decline') {
    // Chidera, 2026-09-24: "any outbound text should redirect customer to
    // the web chat" -- even a plain "You're welcome!"/"Okay!" counts.
    // Website customers (already free, already on the page) keep the
    // instant real reply; a real WhatsApp customer gets the same
    // redirect-once-then-silent gate as everything else below.
    if (customer.channel === 'whatsapp') {
      if (await needsChatRedirect(customer)) {
        // Chidera, 2026-09-25: "dine in can only ever be triggered with a
        // qr code and all its greeting or redirect text to webchat must
        // state the 'started on your dine in session'." This redirect used
        // to always point at the generic bare /wa/:token, even for a
        // customer sitting mid a real dine-in table session -- wrong
        // thread entirely, not just wrong wording.
        const dineinSession = await currentDineinSession(customer);
        await sendStartOrderLink(customer, dineinSession ? { dineinTableLabel: dineinSession.table_label, dineinQrToken: dineinSession.qr_token } : {});
        await markChatRedirectSent(customer);
      }
      return;
    }
    await reply(customer, ackType === 'thanks' ? `You're welcome!` : `Okay!`, `${ackType}_ack`);
    return;
  }

  // handled_by='staff' just means a handover was raised (payment proof
  // submitted, a complaint, someone asked for a person) -- it does NOT mean
  // a human is actually on this thread yet. handled_by_staff_id (a
  // dashboard reply) or app_handled_at (a reply from the business's own
  // WhatsApp app, coexistence mode -- see recordAppReply) is the real
  // signal: only ever set once an actual human sends something. Until
  // then, the bot keeps attending to the customer normally -- a pending
  // handover alert shouldn't mean the customer can't get help with
  // anything else in the meantime, only an actual person replying should
  // go quiet.
  if (customer.handled_by === 'staff' && (customer.handled_by_staff_id || customer.app_handled_at)) {
    // 30 minutes with no further staff reply -- same catch-up as the
    // explicit "Return to bot" button, just triggered automatically so a
    // business that mostly replies from their own phone (see Settings'
    // WhatsApp connection) is never stuck waiting on someone to remember
    // to open the dashboard.
    const { rows: idle } = await pool.query(
      `select (now() - coalesce(max(created_at), '-infinity')) > interval '30 minutes' as idle
       from message where customer_id = $1 and sender = 'staff'`,
      [customer.id]
    );
    if (idle[0]?.idle) {
      await resumeBotControl(customer.id);
      return;
    }
    // Pure silence while staff actually has it -- no filler ack either.
    // The message is already logged (above) so staff see it in the
    // dashboard and can answer themselves; the bot just isn't the one
    // talking right now. It picks back up the moment "Return to bot" is
    // pressed or the 30-minute idle window above trips.
    return;
  }

  const order = await resolveCustomerOrder(customer);

  // Chidera, 2026-09-24: "in general, any outbound text should redirect
  // customer to the web chat and if customer text on bare again only 1 re
  // ping after that bot only responds in web chat not bare chat" -- then,
  // separately: "now we need dine in to go through web chat too... study
  // how it works and the best way it can go through web chat and bare
  // chat to reduce my cost." Dine-in's own carve-out here is now removed
  // -- a dine-in guest (order or not, session or not) gets the exact same
  // treatment as every other whatsapp customer: sendStartOrderLink points
  // at /wa/:token, and their own first bubble there (routes/web-chat.js)
  // is dine-in-aware (table label, menu link to /t/:token, "joining an
  // active order" wording) instead of the generic choice. Two carve-outs
  // remain, both pre-existing and unchanged: text relayed FROM the chat
  // page itself (handleWebChatMessage sets customer.channel = 'website'
  // before calling in here) and a genuine "I need a person" typed on the
  // free chat page, which still reaches detectWantsHuman/handover below
  // exactly as before -- nothing is lost, just deferred to the free
  // surface. classifyIntent/dispatch/handleGreeting/handleEnquiry never
  // even run for a whatsapp customer anymore, dine-in or online; the
  // entire rest of this engine (everything below this point) is
  // website-only now, reached exclusively through handleWebChatMessage.
  if (customer.channel === 'whatsapp') {
    if (await needsChatRedirect(customer)) {
      // Chidera, 2026-09-25: same dine-in-thread fix as the ack/thanks/
      // decline branch above -- a dine-in customer texting bare must be
      // redirected to THEIR table's own thread, not the generic online one.
      const dineinSession = await currentDineinSession(customer);
      await sendStartOrderLink(customer, dineinSession ? { dineinTableLabel: dineinSession.table_label, dineinQrToken: dineinSession.qr_token } : {});
      await markChatRedirectSent(customer);
    }
    return;
  }

  if (order) {
    if (await detectWantsHuman(text)) {
      await handover(customer, 'Customer asked for a person');
      return;
    }
    await dispatch(customer, order, text);
    return;
  }

  const { intent, wantsHuman } = isPureGreeting(text) ? { intent: 'greeting', wantsHuman: false } : await classifyIntent(text);
  if (wantsHuman || intent === 'complaint') {
    // Chidera, 2026-09-25: "make sure complaint and abandonment are
    // functioning" -- real bug found: this used to log the 'complaint'
    // metric right here, the moment AI classified the message as a
    // complaint -- but that's only ever an intent, not a real complaint.
    // sendComplaintLink below just sends the customer a link to the real
    // complaint FORM (routes/complaint.js); they might never actually
    // fill it out. Logging here counted intent, not the thing the
    // dashboard's own Complaints tab actually lists -- a real row in the
    // `complaint` table, which routes/complaint.js's own submit handler
    // now logs instead, at the one moment that's actually true.
    await sendComplaintLink(customer);
    return;
  }
  if (intent === 'greeting') {
    // Chidera's call, 2026-09-03: a customer messaging back in within 24h
    // of an order actually finishing (picked up/delivered) isn't a brand
    // new inquiry -- greeting them with the cold first-contact line reads
    // like the bot forgot they were just here. Not the normal AI-driven
    // handleGreeting on purpose: this is a specific, deterministic offer,
    // not something worth letting an AI call improvise differently each
    // time. Only overrides a bare greeting -- a real question or a direct
    // "I want jollof rice" still gets handled normally below/by enquiry,
    // no need to ask first when they've already said what they want.
    const completedOrder = await recentlyCompletedOrder(customer.id);
    if (completedOrder && !(await wasSentFeedbackRequestFor(completedOrder.id))) {
      await reply(customer, `Hello! Would you like to place another order, or is there anything else I can help you with?`, 'post_completion_greeting');
      return;
    }
    await handleGreeting(customer, text);
    return;
  }
  if (intent === 'enquiry') {
    await handleEnquiry(customer, text);
    return;
  }

  // classifyIntent picks exactly one label, so a first message that both
  // greets AND states an order ("How far? I wan order food") correctly
  // comes back "order" per its own instructions -- but that used to
  // silently drop the greeting entirely, reading as cold/rude. Fixed once
  // as a separate handleGreeting() reply, but that call has no menu/KB data
  // at all, and when the SAME message also asked something real ("is there
  // white rice?"), it just guessed an answer with nothing to ground it --
  // confirmed live, it confidently said yes to an item that isn't on the
  // menu, then had to immediately correct itself in a second message. A
  // deterministic prefix instead: no AI call, no chance of it inventing an
  // answer, and folded into the SAME reply handleCollectInfo sends below
  // (which does have real data) rather than a separate message.
  const newOrder = await createDraftOrder(customer.id, customer.branch_id);
  await transitionOrder(newOrder, 'understand_request');
  await transitionOrder(newOrder, 'collect_info');
  await handleCollectInfo(customer, newOrder, text, greetingAckFor(text));
}

// A tap on the "View menu" list (engine/menu-message.js) is browsing, not
// ordering. WhatsApp only lets a customer select one row at a time with no
// real multi-pick UI on their side, so treating a tap as "add exactly this
// item" would quietly cap them at one item per tap and blur the line
// between looking and ordering. Instead: acknowledge what they looked at
// by name, and let them order in their own words, exactly like every order
// in this system already works (typed, any number of items in one go).
// A tap on a real menu item now really orders it -- Chidera's call,
// 2026-09-10: picking from the list should work the same everywhere,
// reconfirm, then carry on into the normal flow (missing fields, item
// questions, upsell, payment), same as typing the item's name would, and
// with no AI call needed at all to know what was picked (the tap itself is
// unambiguous) -- real API cost saved on the single most common message a
// customer sends. Quantity is always 1 per tap (WhatsApp's list message has
// no quantity picker); tapping the same item again, or typing "make it 3",
// both already work as real modifications once it's in the order.
// The "Place an order" button tapped (see handleGreeting above) -- shows
// the real menu list directly, the same button sendMenuList already sends
// for a typed "what do you have", but with zero AI calls: the button tap
// alone is enough to know what was meant, unlike a typed message which
// still needs classifyIntent to tell an order-browse from anything else.
// The real web menu link -- one per customer (customers.menu_token,
// reused rather than regenerated every time so an old link a customer
// still has open in their browser keeps working). Sent as a WhatsApp
// CTA-URL button (opens right inside WhatsApp's in-app browser, same as
// dine-in's table-scoped version, just keyed by customer instead of
// table). Returns false (no real send) when PUBLIC_URL isn't configured,
// same "genuinely inert without it" gate every other PUBLIC_URL-dependent
// send in this file already follows.
export async function ensureMenuToken(customer) {
  if (customer.menu_token) return customer.menu_token;
  const token = randomBytes(12).toString('hex');
  await pool.query('update customers set menu_token = $1 where id = $2', [token, customer.id]);
  customer.menu_token = token;
  return token;
}

// business.cover_photo_data_url is a data: URI (Settings > Branding) --
// Meta has to fetch a header image itself from a real URL, so
// routes/product-photo.js's /photo/cover (not the data: URI directly) is
// what actually makes a header image possible here. Chidera 2026-09-10,
// after "why is there no cover photo" turned out to mean the photo
// attached directly to the button message in the chat itself, not the web
// menu page's own header: "the place where there is the button its
// attached to a photo or image... just make it happen."
async function businessCoverPhotoUrl() {
  if (!process.env.PUBLIC_URL) return null;
  // ?v= -- Chidera 2026-09-11: "when i changed cover photo why didnt it
  // reflect?" WhatsApp caches a header image by its URL (sometimes for a
  // while), so a re-uploaded photo needs a genuinely different URL to
  // ever actually show, not just new bytes behind the same one. Computed
  // in Postgres (md5) so the real data: URI never has to load into Node
  // just for this.
  const { rows } = await pool.query('select md5(cover_photo_data_url) as v from business limit 1');
  return rows[0]?.v ? `${process.env.PUBLIC_URL}/photo/cover?v=${rows[0].v}` : null;
}

// Chidera, 2026-09-16: "the photo text should have a greeting na. dont
// era demo have gretig? add Hello! welcome to Pomodoro food truck, then
// one line space before here is our menu, take a look and pick what you
// like" -- handleGreeting (this file, ~line 830) already says "Hello!
// Welcome to X" but ONLY for a plain "hi" with nothing else in it; a
// message that already expresses order intent (her own test: "I would
// like to place an order") skips straight past it, so its greeting
// mirrors the exact same business-name lookup for that other case.
export async function menuGreetingBody() {
  const { rows } = await pool.query('select name from business limit 1');
  const businessName = rows[0]?.name || 'us';
  return `Hello! Welcome to ${businessName},\n\nHere's our menu, take a look and pick what you like.`;
}

// order -- optional, and the fix for a real gap found live, 2026-09-20,
// Chidera: "i tapped the finish my order to add, i saw an empty cart."
// Every caller here used to build /m/<this customer's own token> no
// matter what order it was actually about -- fine for a normal order
// (order.customer_id IS this customer), but wrong for a joint dine-in
// order (Stage 1): order.customer_id is always the table's ORIGINAL
// scanner, never whichever guest is currently mid-conversation, so
// routes/menu-page.js's pendingOrderPayload(customer.id) found nothing
// for any other guest -- a real, correctly-answered item question landed
// on a page showing an empty basket. Passing the order here (when the
// caller has one) routes a dine-in order to its own /t/:qrToken page
// instead, with THIS guest's own ?g= token -- the one page that already
// resolves the shared order by session, not by whose customer_id happens
// to be on it (see routes/dinein-menu.js's resolveActingCustomer).
export async function sendWebMenuLink(customer, bodyText, buttonTitle = 'View menu', category = null, headerImageUrl = null, order = null) {
  if (!process.env.PUBLIC_URL) return false;
  if (order?.channel === 'dinein' && order.table_id) {
    const { rows } = await pool.query('select qr_token from restaurant_table where id = $1', [order.table_id]);
    const qrToken = rows[0]?.qr_token;
    if (qrToken) {
      const guestToken = await ensureMenuToken(customer);
      const params = new URLSearchParams({ g: guestToken });
      if (category) params.set('cat', category);
      const dineinUrl = `${process.env.PUBLIC_URL}/t/${qrToken}?${params.toString()}`;
      // Chidera, 2026-09-21: "look at my instagram flow... how does
      // instagram catch up" -- this unconditionally called the WhatsApp-
      // only CTA-URL button before, no Instagram branch at all -- same
      // plain-text-link fallback as every other place in this file now
      // handles it (sendPaymentLinkButton/sendPosPaymentChoice/
      // handleGreeting).
      if (customer.channel === 'instagram') {
        await reply(customer, `${bodyText}\n\n${dineinUrl}`, 'menu_shown');
        return true;
      }
      // Chidera, 2026-09-25: real report -- "No, change it" was sending 2
      // responses. Root cause: this dine-in branch only special-cased
      // Instagram, so a website customer fell straight through to the real
      // sendWhatsAppCtaUrl below (a genuine WhatsApp push) AND THEN the
      // logMessage marker row right after it got picked up by the web
      // chat page's own polling and rendered as a second, separate bubble
      // -- one real WhatsApp message plus one web-chat bubble for the same
      // tap. Same fix shape as the online branch below.
      if (customer.channel === 'website') {
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: bodyText, trigger: 'menu_shown', processed: true, interactive: { type: 'cta_url', buttonText: buttonTitle, url: dineinUrl } });
        return true;
      }
      const dineinCredentials = await getWhatsAppCredentials(customer.branch_id);
      try {
        await sendWhatsAppCtaUrl(recipientFor(customer), bodyText, buttonTitle, dineinUrl, dineinCredentials, headerImageUrl || (await businessCoverPhotoUrl()));
      } catch (err) {
        console.error(`sendWebMenuLink (dinein) failed, falling back to text: ${err.message}`);
        return false;
      }
      await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[menu link sent: ${dineinUrl}]`, trigger: 'menu_shown', processed: true });
      return true;
    }
  }
  const token = await ensureMenuToken(customer);
  const url = `${process.env.PUBLIC_URL}/m/${token}${category ? `?cat=${encodeURIComponent(category)}` : ''}`;
  // Chidera, 2026-09-21: "look at my instagram flow... how does instagram
  // catch up" -- same fix as the dine-in branch above, this is the main
  // call site every OTHER menu-link moment in the conversation actually
  // routes through -- was the real reason an Instagram customer never
  // saw a menu link anywhere in the whole flow.
  if (customer.channel === 'instagram') {
    await reply(customer, `${bodyText}\n\n${url}`, 'menu_shown');
    return true;
  }
  // website: a "See menu"/"Finish my order" bubble that navigates OUT to
  // /m/:token (the existing shop page, unchanged) -- the same hand-off
  // shape as today's real WhatsApp CTA-URL button, just rendered as a
  // bubble on the chat page instead of a real Meta send. This is the
  // single highest-traffic call site in the whole engine (every "show me
  // the menu" moment funnels through here).
  if (customer.channel === 'website') {
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: bodyText, trigger: 'menu_shown', processed: true, interactive: { type: 'cta_url', buttonText: buttonTitle, url } });
    return true;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  // Chidera, 2026-09-16: "ensure image appear on chat cause its not still
  // appearing" -- handleGreeting (this file, ~line 839) already resolved
  // and passed businessCoverPhotoUrl() correctly, but every OTHER call
  // site of this function (four of them) left headerImageUrl at its
  // default of null, so a conversation that skips straight past the plain
  // greeting -- e.g. the customer's first message already says "I want to
  // order" -- never saw the cover photo at all. Resolving it here, once,
  // as the fallback means every caller gets the photo without having to
  // remember to ask for it.
  const resolvedHeaderImageUrl = headerImageUrl || (await businessCoverPhotoUrl());
  // Chidera, 2026-09-20: real gap found testing the new item-question/
  // fulfilment links below -- a genuine send failure here (not just
  // PUBLIC_URL being unset) used to throw straight out of this function,
  // which a caller like handleOrderConfirmNoTap/handleStartOrderTap never
  // caught -- a transient Meta hiccup would have silently dropped the
  // whole reply instead of falling back to plain text. Some callers
  // already wrapped this in their own `.catch(() => false)`; consolidated
  // here instead so every caller, old and new, gets the same "never worse
  // than a text prompt" guarantee for free.
  try {
    await sendWhatsAppCtaUrl(recipientFor(customer), bodyText, buttonTitle, url, credentials, resolvedHeaderImageUrl);
  } catch (err) {
    console.error(`sendWebMenuLink failed, falling back to text: ${err.message}`);
    return false;
  }
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[menu link sent: ${url}]`, trigger: 'menu_shown', processed: true });
  return true;
}

// The "No, change it" half of sendConfirmButtons' read-back prompt --
// matches the reference demo exactly (EBOS-Web-Menu-Demo.html: "No
// problem. Open the menu again and change whatever you like." + a "See
// the menu" button), sent directly rather than through the normal AI
// confirm-detection pipeline (handleConfirmOrder's own "no" branch asks a
// vaguer "what would you like to change" with no button at all) -- the
// tap itself is already unambiguous, same reasoning as every other
// instant button handler in this file. Chidera 2026-09-10.
export async function handleOrderConfirmNoTap({ phoneNumber, channelId, channel = 'whatsapp', branchId, customer: presetCustomer }) {
  const customer = presetCustomer || (await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId }));
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: '[tapped: No, change it]', processed: true });

  // The reference demo's exact wording (Chidera 2026-09-10) plus one
  // added clause -- without it, a customer who opens the menu, decides
  // not to change anything after all, and doesn't know they can just
  // reply yes was left with no obvious way back to confirming as-is.
  // Chidera 2026-09-10 (separately): "if a customer say yes they want to
  // change order and they dont end up changing anything it[']s confusing
  // on what they should do next."
  const message = "No problem. Open the menu again and change whatever you like, or just reply yes if you'd like to keep it as it is.";
  // Chidera, 2026-09-20: real bug, found from a real report -- this used to
  // call currentDineinSession(customer), which answers "does this customer
  // have ANY open dine-in table session at all, ever," not "is the order
  // actually being reconsidered right now a dine-in order." A customer
  // whose table session from days earlier was never explicitly closed got
  // sent that stale table's own /t/ menu link for a completely unrelated,
  // normal WhatsApp order -- silently diverting her into a dine-in re-order
  // (no payment step) while the real order she was actually confirming sat
  // abandoned mid-flow. Resolved directly off THIS order's own table_id
  // now, never a customer-wide session lookup. resolveCustomerOrder (not
  // getOpenOrder) so a non-owner dine-in guest's own "No, change it" tap
  // still resolves to their real shared table order, same JV-report fix.
  const order = await resolveCustomerOrder(customer);
  // Chidera, 2026-09-25: this used to hand-roll its own dine-in real-
  // WhatsApp-CTA send here (duplicating sendWebMenuLink's own dine-in
  // branch, ?g=guestToken and all) instead of just calling it -- which is
  // exactly how it ended up with the SAME channel-unaware bug
  // (sendWebMenuLink's dine-in branch, fixed above) separately: a website
  // customer's "No, change it" leaked a real WhatsApp push. Passing
  // `order` through lets sendWebMenuLink resolve the dine-in URL itself
  // (it already does this, guestToken and all), one implementation, one
  // fix covers both.
  const shown = await sendWebMenuLink(customer, message, 'Tap here to see menu', null, null, order);
  if (!shown) await reply(customer, message, 'order_confirm_no');
}

// Chidera, 2026-09-24: "after taping yes confirm the reply after that is
// too slow." Root cause, confirmed reading the actual path: a tap on
// "Yes, confirm" used to go through the normal text pipeline
// (handleWebChatMessage/dispatch), same as a genuinely typed reply --
// which meant TWO real Anthropic calls back to back before anything
// happened (dispatch()'s own extractOrderModifications check, then
// handleConfirmOrder's own extractField to work out the tap's title
// meant yes) for something the tap itself already answers with zero
// ambiguity. A dedicated handler, same zero-AI-cost shape as
// handleOrderConfirmNoTap right above and handleUpsellListTap -- the tap
// IS the confirmation, no AI needed to confirm what it already is.
export async function handleOrderConfirmYesTap({ phoneNumber, channelId, channel = 'whatsapp', branchId, customer: presetCustomer }) {
  const customer = presetCustomer || (await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId }));
  const order = await resolveCustomerOrder(customer);
  // A stale tap (already confirmed another way, or the order's moved on)
  // -- nothing to do, same "stale tap = no-op" reasoning as
  // handleUpsellListTap's own guard.
  if (!order || order.confirmed_at || order.engine_state !== 'confirm_order') return;
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: '[tapped: Yes, confirm]', processed: true });
  await markOrderConfirmed(customer, order);
}

export async function handleStartOrderTap({ phoneNumber, channelId, channel = 'whatsapp', branchId, customer: presetCustomer }) {
  const customer = presetCustomer || (await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId }));
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: '[tapped: Place an order]' , processed: true });
  // Same minimal-CTA-to-/wa/:token send as a plain "hi" now gets
  // (sendStartOrderLink) -- a "Place an order" button tap and a fresh
  // greeting converge on the same outcome, 2026-09-22.
  await sendStartOrderLink(customer);
}

// The real order behind "Review order" on the web menu page (routes/
// menu-page.js) -- multiple items at once, same as handleMenuItemTap
// below but for a whole basket instead of one tap. Reuses the exact same
// tail (finishItemsCollection: missing fields, item-customization
// questions, upsell, the confirm read-back) so a basket ordered from the
// page and an item ordered by typing or tapping all converge on one
// identical experience from here on.
// `items` is the FULL desired basket, not just what's new -- the menu page
// pre-populates its basket from any pending order (routes/menu-page.js's
// /menu.json now returns it), so a customer who reopens the link sees and
// can edit what's already there (Chidera 2026-09-10: "how are they aware
// that the first one is still pending... how can they remove as well?").
// That means a second submission has to be diffed against what's already
// on the order -- an untouched quantity is a no-op, a lowered one is a
// real reduction/removal, and only a genuinely new product is an add.
// Chidera, 2026-09-17: "so if a person is pick 2 pasta itll have to ask
// for each + and if they picked 2 different a - will have to know for
// which" -- a web order_item is identified by product+answers together,
// not product alone, so two lines of the same product with different
// answers (or no answers at all) never collide or get merged into one
// row by mistake. Keys sort their own entries first so the same answers
// submitted in a different object-key order (client) still match what
// the DB's own json_object_agg happens to return (server) -- see
// webLineKey below.
function answersKey(answers) {
  const a = answers || {};
  return JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]]));
}
function webLineKey(productId, answers) {
  return `${productId}::${answersKey(answers)}`;
}
async function insertWebOrderItem(orderId, item) {
  const { rows } = await pool.query(
    'insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4) returning id',
    [orderId, item.productId, item.quantity, item.price]
  );
  const answers = item.answers || {};
  for (const questionId of Object.keys(answers)) {
    await pool.query(
      'insert into order_item_answer (order_item_id, question_id, answer) values ($1, $2, $3)',
      [rows[0].id, questionId, answers[questionId]]
    );
  }
}

// Chidera, 2026-09-17: "lets think, the extra penne or spagetti and room
// temp or what ever message could be on the site right?" -- same idea
// extended to delivery/pickup and the address: writing them directly onto
// the order/customer here (not waiting for the WhatsApp confirm step to
// ask) is what makes missingFulfilmentFields (fields.js) find nothing
// missing later, so handleCollectFulfilment sails straight through to
// payment instead of re-asking something already answered on the site.
// delivery_zone_id is set here too (own_riders only) rather than left for
// handleCollectFulfilment's own guess-and-confirm text matching -- the web
// page shows the customer a real dropdown of actual zone names, so there's
// nothing left to guess. Never trusts the client's own fee claim, same
// principle as never trusting its price/availability claims elsewhere in
// this file -- the fee always comes from re-reading the real zone row.
async function applyWebFulfilment(order, customer, fulfilment) {
  if (!fulfilment || !fulfilment.type) return;
  await pool.query('update "order" set fulfilment_type = $1 where id = $2', [fulfilment.type, order.id]);
  order.fulfilment_type = fulfilment.type;
  if (fulfilment.type !== 'delivery') return;

  if (fulfilment.address) {
    await pool.query('update customers set address = $1 where id = $2', [fulfilment.address, customer.id]);
    customer.address = fulfilment.address;
  }
  if (fulfilment.zoneId) {
    const { rows } = await pool.query(
      `select * from delivery_zone where id = $1 and active = true and ($2::uuid is null or branch_id = $2 or branch_id is null)`,
      [fulfilment.zoneId, order.branch_id]
    );
    const zone = rows[0];
    if (zone) {
      await pool.query('update "order" set delivery_zone_id = $1, delivery_fee = $2 where id = $3', [zone.id, zone.customer_fee, order.id]);
      order.delivery_zone_id = zone.id;
      order.delivery_fee = Number(zone.customer_fee);
    }
  }
}

export async function handleWebMenuOrder(customer, items, fulfilment) {
  let order = await getOpenOrder(customer.id);
  const isNewOrder = !order;

  if (isNewOrder) {
    order = await createDraftOrder(customer.id, customer.branch_id);
    await transitionOrder(order, 'understand_request');
    await transitionOrder(order, 'collect_info');
  }
  await applyWebFulfilment(order, customer, fulfilment);

  if (isNewOrder) {
    for (const item of items) await insertWebOrderItem(order.id, item);
    await finishItemsCollection(customer, order, 'Got it. ', { autoConfirm: Boolean(fulfilment) });
    return;
  }

  // answers, one row per existing order_item -- json_object_agg returns
  // NULL (not an empty object) when a product has no order_item_answer
  // rows at all, same reason menuForBranch's own questions coalesce
  // exists, so every no-question item still lands on the SAME key
  // (webLineKey({})) the client uses for it, not a stray NULL-keyed one.
  const { rows: existingItems } = await pool.query(
    `select oi.id, oi.product_id, oi.quantity,
       coalesce(
         (select json_object_agg(oa.question_id, oa.answer) from order_item_answer oa where oa.order_item_id = oi.id),
         '{}'
       ) as answers
     from order_item oi where oi.order_id = $1`,
    [order.id]
  );
  const existingByKey = new Map(existingItems.map((r) => [webLineKey(r.product_id, r.answers), r]));
  const submittedKeys = new Set(items.map((i) => webLineKey(i.productId, i.answers)));

  const adds = [];
  const sets = [];
  const removes = [];
  for (const item of items) {
    const existing = existingByKey.get(webLineKey(item.productId, item.answers));
    if (existing) {
      if (existing.quantity !== item.quantity) sets.push({ itemId: existing.id, quantity: item.quantity });
    } else {
      adds.push(item);
    }
  }
  for (const [key, row] of existingByKey) {
    if (!submittedKeys.has(key)) removes.push({ itemId: row.id });
  }
  if (!adds.length && !sets.length && !removes.length) {
    // Was a silent return -- a real dead end. Chidera 2026-09-10: "if a
    // customer say yes they want to change order and they dont end up
    // changing anything it[']s confusing on what they should do next."
    // Tapping "No, change it" -> reopening the menu -> not actually
    // changing anything -> "Review order" anyway used to produce total
    // silence: the web page still said "Order sent!" and redirected back
    // to a chat with no new message in it at all. Confirm_order-or-later
    // just re-shows the same read-back and yes/no buttons they'd already
    // seen; still mid-collection (an item question or upsell still
    // outstanding) routes back through finishItemsCollection so it asks
    // whatever's genuinely still needed instead of jumping straight to a
    // premature "to confirm".
    if (['confirm_order', 'confirm_payment', 'fulfilment'].includes(order.engine_state)) {
      const { itemLines, total } = await summariseOrder(order);
      const summary = [...itemLines, `Total: NGN ${total}`].join('\n');
      await sendConfirmButtons(customer, `Your order:\n${summary}`, 'order_confirm_asked');
    } else {
      await finishItemsCollection(customer, order, '', { autoConfirm: Boolean(fulfilment) });
    }
    return;
  }

  // Not routed through handleOrderModification/applyOrderModifications --
  // both match an existing order_item by product_id alone, which can't
  // tell apart two lines of the same product with different answers.
  // Mirrors their exact behavior (paid-order gate, top-up invoicing,
  // re-confirm read-back) with a composite-key-aware apply instead, so
  // the typed-WhatsApp path those two functions still serve stays
  // completely untouched.
  if (['confirm_order', 'confirm_payment', 'fulfilment'].includes(order.engine_state)) {
    const paid = order.payment_status === 'confirmed' || order.payment_status === 'accepted';
    // Chidera, 2026-09-25: same dine-in kitchen-protection gap as
    // handleOrderModification's own fix (its own comment has the full
    // reasoning) -- this is the web-menu-page basket-resubmit path
    // (tapping through the menu and hitting "Review order" again, not
    // typing), the one dine-in tables actually use to change an order.
    // Captured before anything below mutates confirmed_at.
    const alreadySentToKitchen = order.payment_mode === 'at_table' && Boolean(order.confirmed_at);
    if ((paid || alreadySentToKitchen) && (sets.length || removes.length)) {
      await reply(
        customer,
        paid
          ? `Your order's already paid for, so I can't remove or change what's in it myself -- let me get someone to help with that.`
          : `That order is already gone to the kitchen, so I can't remove or change what's in it myself -- let me get someone to help with that.`
      );
      await handover(
        customer,
        paid ? 'Customer wants to remove or change items on an already-paid order' : 'Customer wants to remove or change items already sent to the kitchen',
        null,
        false
      );
      if (!adds.length) return;
    }

    let addedValue = 0;
    for (const item of adds) {
      await insertWebOrderItem(order.id, item);
      addedValue += item.quantity * Number(item.price);
    }
    if (!paid && !alreadySentToKitchen) {
      for (const item of sets) {
        await pool.query('update order_item set quantity = $1 where id = $2', [item.quantity, item.itemId]);
      }
      for (const item of removes) {
        await clearPendingQuestionIfOnItem(order, item.itemId);
        await pool.query('delete from order_item where id = $1', [item.itemId]);
      }
    }

    const { itemLines, total, deliveryFee } = await summariseOrder(order);
    await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
    // Chidera, 2026-09-20: "when an item is added, why is stale amount on
    // ready to pay still there" -- same fix as applyOrderModifications'
    // own insert, this time for the general web-menu resubmit path (an
    // online order with a POS payment already pending, e.g. mid confirm_
    // payment, getting more added before it's paid). Any PENDING
    // order_payment is now stale the moment a real item change happens.
    await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
    if (adds.length) await resetServedForAddOn(order);

    if (paid) {
      await sendTopupInvoice(customer, order, adds, addedValue);
      return;
    }
    await pool.query(`update "order" set confirmed_at = null where id = $1`, [order.id]);
    order.confirmed_at = null;
    // Chidera, 2026-09-23, live report on era-demo: "it gave me a bill of
    // food with total of 4700 my food way 1700 but it didnt state the
    // delivery there, one could easily misunderstand" -- summariseOrder's
    // own `total` has always silently included delivery_fee (itemsTotal +
    // deliveryFee), but this message only ever listed the items, never the
    // fee itself, so a real delivery order's total looked unexplained --
    // items summed to less than what's actually being charged. Same
    // structured-line convention this file already uses everywhere else
    // (documents.js's own invoice deliveryFeeRow, completePayment's staff
    // alert) -- only added when there actually is one, a pickup order's
    // message is completely unaffected.
    const deliveryFeeLine = deliveryFee > 0 ? `\nDelivery fee: NGN ${deliveryFee}` : '';
    await sendConfirmButtons(customer, `Got it, your order:\n${itemLines.join('\n')}${deliveryFeeLine}\nNew total: NGN ${total}.`, 'order_confirm_asked');
    return;
  }

  // Still collecting items (collect_info) -- apply the diff directly, then
  // let finishItemsCollection carry on exactly as a fresh order would
  // (upsell prompts, item questions, moving on to confirm_order).
  // Same stray-offer cleanup as handleMenuItemTap above -- this edit is
  // what answers any upsell that was left pending, whether or not it
  // actually touched that category.
  if (order.pending_upsell_category) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
  }
  for (const item of adds) await insertWebOrderItem(order.id, item);
  for (const item of sets) {
    await pool.query('update order_item set quantity = $1 where id = $2', [item.quantity, item.itemId]);
  }
  for (const item of removes) {
    await clearPendingQuestionIfOnItem(order, item.itemId);
    await pool.query('delete from order_item where id = $1', [item.itemId]);
  }
  await finishItemsCollection(customer, order, 'Got it. ', { autoConfirm: Boolean(fulfilment) });
}

// customer: an already-resolved customer object, passed by routes/web-chat.js
// for a tap on the website channel -- findOrCreateCustomer ignores the
// `channel` argument for an existing row (returns it exactly as stored), so
// that alone can't carry the website-channel override for a returning
// customer. Same passthrough shape handleWebMenuOrder already uses.
export async function handleMenuItemTap({ phoneNumber, channelId, product, channel = 'whatsapp', branchId, customer: presetCustomer }) {
  const customer = presetCustomer || (await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId }));
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: `[tapped menu: ${product.name}]` , processed: true });

  let order = await resolveCustomerOrder(customer);
  const item = { productId: product.id, name: product.name, price: product.price, quantity: 1 };

  if (order && ['confirm_order', 'confirm_payment', 'fulfilment'].includes(order.engine_state)) {
    // Already past initial item collection -- this is a real modification
    // (an add), not a first pick, so it gets the same "added that on, your
    // order's now..." treatment any other mid-confirm add already does.
    await handleOrderModification(customer, order, { adds: [item], removes: [], sets: [] });
    return;
  }

  if (!order) {
    order = await createDraftOrder(customer.id, customer.branch_id);
    // Same two transitions handleInboundMessage's own new-order path
    // always does immediately after createDraftOrder -- skipping them
    // left the order stuck at its default 'new_inquiry' state, which
    // dispatch()'s switch doesn't handle at all (falls to the generic
    // "already being handled" filler on the very next message). Found
    // live, 2026-09-10, testing this exact path.
    await transitionOrder(order, 'understand_request');
    await transitionOrder(order, 'collect_info');
  }
  // A stray upsell offer left pending would otherwise hijack this
  // customer's NEXT typed message (dispatch() checks pending_upsell_
  // category before anything else) -- this add itself is what answers it,
  // one way or another, same as handleUpsellListTap/handlePendingUpsell
  // clearing it on their own paths.
  if (order.pending_upsell_category) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
  }
  // added_by_customer_id -- same class of gap as handleUpsellListTap's own
  // insert (Chidera, 2026-09-20: "water is still categorized as guest"),
  // this time for a WhatsApp catalog product tap rather than an upsell tap.
  await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, item.productId, item.quantity, item.price, customer.id]);
  await finishItemsCollection(customer, order, `Added ${product.name}. `);
}

// The branch whose opening_hours actually govern this customer -- their
// own branch if one's resolved (multi-branch, independent sharing), else
// the primary branch, same "zero/one/many" fallback every other
// branch-scoped fact in this file already uses rather than assuming a
// business has exactly one.
async function branchHoursFor(customer) {
  const { rows } = await pool.query(
    customer.branch_id ? `select id, opening_hours from branch where id = $1` : `select id, opening_hours from branch where is_primary = true limit 1`,
    customer.branch_id ? [customer.branch_id] : []
  );
  return { branchId: rows[0]?.id || null, openingHours: rows[0]?.opening_hours || null };
}

// Chidera, 2026-09-16: "when its not in that time it can tell client that
// they are not currently open and the time they open and say itll let them
// know immediately they open." A hard early return, not a prefix folded
// into the normal flow -- closed means closed, no menu, no order-taking,
// same shape as handleClosedHoursCall's voice equivalent. Upserting into
// hours_notify_request is what sweepOpeningNotifications (below) later
// finds to actually send that promised message; ON CONFLICT DO NOTHING
// means messaging again while still closed doesn't queue a second one.
async function handleClosedHoursMessage(customer, opensAt, branchId) {
  const message = opensAt
    ? `We're closed right now, we open again at ${opensAt}. I'll message you the moment we're open.`
    : `We're closed right now.`;
  await reply(customer, message, 'closed_hours');
  await pool.query(
    `insert into hours_notify_request (customer_id, branch_id) values ($1, $2) on conflict (customer_id) where notified_at is null do nothing`,
    [customer.id, branchId]
  );
}

// Chidera, 2026-09-26: moved to ./sweeps.js, re-exported here, same as
// the other sweeps above.
export { sweepOpeningNotifications } from './sweeps.js';

// Chidera, 2026-09-24, real report: "if on bare chat we already set that
// bot wont respond, why is it still showing the typing sign like it
// wants to respond? ... went quiet with fake false hope of typing." The
// debounce handleInboundMessage's own typing keep-alive spans
// (DEBOUNCE_MS below) runs entirely BEFORE handlePendingBatch's real
// decision -- by the time that decision is silence, the customer already
// watched "typing..." for the whole wait, with nothing ever arriving.
// Reuses the exact same checks handlePendingBatch itself makes for a
// plain bare-WhatsApp text with the bot still in control (not a
// simplified guess at them, so this can never promise a reply the real
// gate has already decided not to send): a pure "ok"-type ack against a
// genuinely open order is the one case that skips the redirect gate
// entirely and always gets a real dispatch reply (see handlePendingBatch's
// own ackType==='ack' branch) -- every other whatsapp/bot-controlled case
// funnels through needsChatRedirect, same as the gate itself. Exported
// (own named function, not inlined) so this specific decision can be
// tested directly -- markTypingIndicator itself is a real-credentials-only
// send with no sandbox hook to observe.
export async function shouldSkipTypingIndicator(customer, channel, text) {
  if (channel !== 'whatsapp' || customer.handled_by === 'staff') return false;
  const bypassesRedirectGate = classifyPureAck(text) === 'ack' && Boolean(await resolveCustomerOrder(customer));
  if (bypassesRedirectGate) return false;
  return !(await needsChatRedirect(customer));
}

export async function handleInboundMessage({ phoneNumber, channelId, text, channel = 'whatsapp', messageId, branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: text });

  // Voice has its own separate closed-hours path (voice_config.operating_hours,
  // checked in engine/voice.js before this function is ever reached) -- this
  // is the text-channel (WhatsApp/Instagram) equivalent, using the branch's
  // own opening_hours instead.
  const { branchId: hoursBranchId, openingHours } = await branchHoursFor(customer);
  const hours = checkOperatingHours(openingHours);
  if (!hours.open) {
    await handleClosedHoursMessage(customer, hours.opensAt, hoursBranchId);
    return;
  }

  // Best-effort -- shows "typing..." for the whole debounce+processing
  // wait so the customer sees something happening instead of silence.
  // Never let this delay or break the actual reply. Only started for the
  // message that STARTS a debounce cycle, not every message in a burst --
  // Meta's API rejects (#131009) a typing indicator sent while one from an
  // earlier message in the same still-open cycle is already active. See
  // startTypingKeepAlive's own comment for why this is now a repeating
  // keep-alive, not a single call. WhatsApp's call needs the inbound
  // messageId (its typing indicator is a mark-as-read+typing combo tied to
  // that specific message); Instagram's sender_action just needs who to
  // show it to.
  const skipsTyping = await shouldSkipTypingIndicator(customer, channel, text);
  if (!skipsTyping && !pendingTimers.has(customer.id)) {
    startTypingKeepAlive(customer, channel, messageId, channelId);
  }
  scheduleDebouncedProcessing(customer);
}

// The web-chat page's (routes/web-chat.js) own front door for typed free
// text -- Chidera, 2026-09-22: "meta will start charging 14 naira per
// message... the whole flow duplicated in a site." Deliberately does NOT
// go through handleInboundMessage/scheduleDebouncedProcessing: that 2s
// debounce (see DEBOUNCE_MS below) reloads the customer FRESH from the DB
// once it fires (processPendingMessages), which would silently discard the
// in-memory `customer.channel = 'website'` override routes/web-chat.js set
// before calling this -- every reply from that point on would go out as a
// REAL WhatsApp send instead of a bubble, defeating the entire point. Same
// fix shape as handleVoiceTurn just below (calls handlePendingBatch
// directly, for a different but related reason -- a live call can't
// tolerate the debounce delay either) -- there's no batching need here
// anyway, since each POST from the page is already one deliberate submit
// (a Send-button tap), not WhatsApp's SMS-style rapid-fire bursts.
export async function handleWebChatMessage({ customer, text }) {
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel: 'website', sender: 'customer', body: text });
  const { branchId: hoursBranchId, openingHours } = await branchHoursFor(customer);
  const hours = checkOperatingHours(openingHours);
  if (!hours.open) {
    await handleClosedHoursMessage(customer, hours.opensAt, hoursBranchId);
    return;
  }
  // Chidera, 2026-09-23, live report: "i sent a text, bot didnt reply me"
  // -- unlike the real WhatsApp path (scheduleDebouncedProcessing's own
  // catch, above), this had no error-recovery net at all: a free-text turn
  // on the /wa chat page failing for ANY reason (the AI provider down/
  // rate-limited, any dependency error) threw straight out of this
  // function with nothing caught anywhere -- the client's own fetch is a
  // silent try/catch (web-chat-page-template.js's sendText), so the
  // customer got absolute silence, not even an error toast. Same recovery
  // now, reused: an apologetic ack + staff handover on first failure, a
  // repeat one just re-alerts staff without re-spamming the customer.
  try {
    await handlePendingBatch(customer, text);
  } catch (err) {
    console.error('Web-chat message processing failed:', err);
    await recoverFromProcessingError(customer);
  }
}

// Moved to ./voice-turn.js, 2026-10-01 (second phase of breaking up this
// file -- see that file's own header). Re-exported here so no existing
// import site has to change.
export { handleVoiceTurn, escalateVoiceCall, handleClosedHoursCall } from './voice-turn.js';

// An image was being silently dropped entirely before this -- no reply, no
// record, nothing -- which is exactly how a customer's actual payment proof
// went unacknowledged. Handled outside the debounce/text pipeline (an image
// isn't text to combine with other messages) and immediately, not queued:
// proof of payment is time-sensitive, and "got it, confirming" beats
// waiting out a debounce window for an ack that was always going to be the
// same regardless of what else they type.
// Same handling for a photo or a PDF of a receipt -- customers use
// whichever their bank app happens to export, and neither used to be
// acknowledged at all (only text was processed).
// `mediaId` means different things per channel -- WhatsApp gives an opaque
// ID needing a lookup (downloadWhatsAppMedia's two-step), Instagram's
// webhook already hands over a direct, pre-signed CDN URL (no lookup step
// at all, see instagram-send.js) -- same parameter slot, resolved by
// channel below rather than two separate function signatures.
export async function handleInboundMedia({ phoneNumber, channelId, mediaId, kind, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: `[${kind}]` , processed: true });

  // Same principle as handlePendingBatch -- a pending handover alone
  // doesn't mean a human is actually on this thread yet, only a real
  // human reply (dashboard or the WhatsApp app) does. Same 30-minute
  // auto-resume too -- an image/PDF shouldn't stay stuck behind a stale
  // handover any more than a text message should.
  if (customer.handled_by === 'staff' && (customer.handled_by_staff_id || customer.app_handled_at)) {
    const { rows: idle } = await pool.query(
      `select (now() - coalesce(max(created_at), '-infinity')) > interval '30 minutes' as idle
       from message where customer_id = $1 and sender = 'staff'`,
      [customer.id]
    );
    if (idle[0]?.idle) {
      await resumeBotControl(customer.id);
      const { rows: reloaded } = await pool.query('select * from customers where id = $1', [customer.id]);
      Object.assign(customer, reloaded[0]);
    } else {
      // Pure silence, same reasoning as handlePendingBatch's staff gate.
      return;
    }
  }

  const order = await resolveCustomerOrder(customer);
  const awaitingPayment = order && order.engine_state === 'confirm_payment' && order.payment_status !== 'confirmed' && order.payment_status !== 'accepted';
  // A top-up (sendTopupInvoice, for items added after the original payment)
  // leaves the order itself alone (engine_state/payment_status don't change
  // for it), so its own "still waiting on a proof image" state lives on
  // order_topup instead -- this is what lets a proof image sent after the
  // order's already paid and moving through fulfilment still be recognised
  // as belonging to the top-up rather than falling into "no order awaiting
  // payment" below.
  const { rows: pendingTopupRows } = order
    ? await pool.query(`select id, amount from order_topup where order_id = $1 and payment_status = 'pending' order by created_at desc limit 1`, [order.id])
    : { rows: [] };
  const pendingTopup = pendingTopupRows[0];

  if (!awaitingPayment && !pendingTopup) {
    await reply(customer, `Got your ${kind}, let me get someone to take a look.`, 'media_received');
    await handover(customer, `Customer sent a ${kind} with no order currently awaiting payment`, null, false);
    return;
  }

  try {
    const dataUrl = channel === 'instagram' ? await downloadInstagramMedia(mediaId) : await downloadWhatsAppMedia(mediaId);
    // Every proof image is kept, not overwritten -- Chidera 2026-09-11:
    // "let the place in the dashboard that shows receipt be able to store
    // multiple receipts image" (a top-up needs its own proof without
    // losing the original one).
    await pool.query(`insert into order_payment_proof (order_id, data_url) values ($1, $2)`, [order.id, dataUrl]);

    if (pendingTopup) {
      // No handover here either, same "take it normally" reasoning as
      // sendTopupInvoice -- staff see it via the order's own Top-ups card
      // (OrderDetail.jsx) and the payment-proof gallery, not a ping.
      await pool.query(`update order_topup set payment_status = 'proof_submitted' where id = $1`, [pendingTopup.id]);
      await reply(customer, `Noted, I will confirm the top-up payment and get back to you shortly.`, 'payment_proof_received');
      return;
    }

    // 'confirmation' means exactly this moment -- proof is in, pending a
    // real person's sign-off (Chidera's own words: "customer has sent
    // proof of payment and is pending confirmation") -- not "already
    // confirmed." completePayment() is what moves it past this, straight
    // to 'preparation', the instant a person (or Paystack's own webhook)
    // actually confirms it.
    await pool.query(`update "order" set payment_status = 'proof_submitted', status = 'confirmation' where id = $1`, [order.id]);
    await reply(customer, `Noted, I will confirm the payment and get back to you shortly.`, 'payment_proof_received');
    // Chidera, 2026-09-21: "WHY IS DINE IN HANDOVER TAKING ME OUT OF
    // WHATSAPP TO SHOW ME INVOICE?" -- these used to be plain-text URLs
    // inside the alert body, which WhatsApp auto-linkifies to open the
    // device's own external browser -- exactly the same bug the "confirm"
    // button below was already fixed for once (2026-09-03 comment,
    // preserved), just never applied to these two. Dropped entirely, not
    // converted to more CTA buttons (WhatsApp only allows one per
    // message) -- the "Confirm payment" button already lands staff on the
    // order page, which shows the same invoice/items AND the payment-
    // proof image inline (OrderDetail.jsx's own paymentProofs), so
    // nothing is actually lost.
    await handover(
      customer,
      `Customer submitted payment proof, needs manual confirmation`,
      null,
      false, // already sent its own ack ("Noted, I will confirm...") above
      // found live, 2026-09-03: staff had the invoice and the proof but
      // nothing to actually click to confirm it, just handover()'s own
      // generic conversation link. Straight into the order itself
      // (OrderDetail.jsx has the same "Confirm payment received" button
      // the kanban card does) -- Chidera's call: land inside the card,
      // not on the board having to find it first.
      { path: `/orders/${order.id}`, title: 'Confirm payment' }
    );
  } catch (err) {
    console.error(`Failed to download payment proof ${kind}:`, err);
    await reply(customer, `Got your ${kind} but had trouble saving it. Let me get someone to help confirm your payment.`, 'payment_proof_received');
    await handover(customer, `Customer submitted payment proof but the ${kind} failed to save`, null, false);
  }
}

// Chidera, 2026-09-23: "actually enable them to upload photo of file or
// camera." The chat page's own equivalent of handleInboundMedia, for a
// customer who uploads a payment-proof photo straight from the browser
// instead of real WhatsApp -- dataUrl arrives already resolved (the
// browser reads the file itself, no WhatsApp/Instagram media-ID lookup
// step exists here), and customer.channel is already 'website' by the
// time routes/web-chat.js calls this, same override pattern as
// handleWebChatMessage. Kept as its own function rather than sharing logic
// with handleInboundMedia so a future change to the real WhatsApp media
// pipeline (customer resolution, staff-handover idle check, channel
// download) can never accidentally touch this one.
export async function handleWebChatMedia(customer, dataUrl, kind = 'photo') {
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel: 'website', sender: 'customer', body: `[${kind}]`, processed: true });

  const order = await resolveCustomerOrder(customer);
  const awaitingPayment = order && order.engine_state === 'confirm_payment' && order.payment_status !== 'confirmed' && order.payment_status !== 'accepted';
  const { rows: pendingTopupRows } = order
    ? await pool.query(`select id, amount from order_topup where order_id = $1 and payment_status = 'pending' order by created_at desc limit 1`, [order.id])
    : { rows: [] };
  const pendingTopup = pendingTopupRows[0];

  if (!awaitingPayment && !pendingTopup) {
    await reply(customer, `Got your ${kind}, let me get someone to take a look.`, 'media_received');
    await handover(customer, `Customer sent a ${kind} with no order currently awaiting payment`, null, false);
    return;
  }

  try {
    // Same "every proof kept, not overwritten" reasoning as
    // handleInboundMedia -- a top-up needs its own proof without losing
    // the original.
    await pool.query(`insert into order_payment_proof (order_id, data_url) values ($1, $2)`, [order.id, dataUrl]);

    if (pendingTopup) {
      await pool.query(`update order_topup set payment_status = 'proof_submitted' where id = $1`, [pendingTopup.id]);
      await reply(customer, `Noted, I will confirm the top-up payment and get back to you shortly.`, 'payment_proof_received');
      return;
    }

    await pool.query(`update "order" set payment_status = 'proof_submitted', status = 'confirmation' where id = $1`, [order.id]);
    await reply(customer, `Noted, I will confirm the payment and get back to you shortly.`, 'payment_proof_received');
    await handover(
      customer,
      `Customer submitted payment proof, needs manual confirmation`,
      null,
      false, // already sent its own ack above
      { path: `/orders/${order.id}`, title: 'Confirm payment' }
    );
  } catch (err) {
    console.error(`Failed to save web-chat payment proof ${kind}:`, err);
    await reply(customer, `Got your ${kind} but had trouble saving it. Let me get someone to help confirm your payment.`, 'payment_proof_received');
    await handover(customer, `Customer submitted payment proof but the ${kind} failed to save`, null, false);
  }
}
