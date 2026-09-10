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
import { sendWhatsApp, sendWhatsAppDocument, sendWhatsAppImage, sendWhatsAppButtons, sendWhatsAppCtaUrl, sendWhatsAppTemplate, markTypingIndicator, downloadWhatsAppMedia } from './whatsapp-send.js';
import { sendMenuList, sendListMessage, productForRowId } from './menu-message.js';
import { sendInstagram, sendInstagramDocument, markInstagramTypingIndicator, downloadInstagramMedia } from './instagram-send.js';
import { createInvoice, createReceipt } from './documents.js';
import { createDelivery, estimateDeliveryFee } from './delivery.js';
import { getWhatsAppCredentials } from './branch-channel.js';
import { getDeliveryConfig, resolveZoneForAddress } from './delivery-zones.js';

// The one place that decides "who is this customer and how do we reach
// them" by channel -- WhatsApp uses their phone number, Instagram uses
// their channel-scoped id (Instagram DMs never expose a phone number at
// all). Every send call site below goes through these two instead of
// hardcoding WhatsApp, so adding a channel means adding a case here, not
// hunting down every place a message goes out.
function recipientFor(customer) {
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
// WhatsApp/Instagram today.
const voiceReplyBuffers = new Map();

async function senderFor(customer) {
  if (customer.channel === 'instagram') return sendInstagram;
  if (customer.channel === 'voice') {
    return (to, text) => {
      const buffered = voiceReplyBuffers.get(customer.id) || [];
      buffered.push(text);
      voiceReplyBuffers.set(customer.id, buffered);
      return {};
    };
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  return (to, text) => sendWhatsApp(to, text, credentials);
}
// sendInstagramDocument's attachment type ('file') already fetches by URL
// generically, so it doubles as the image sender there -- only WhatsApp
// distinguishes an 'image' message type from a 'document' one.
async function imageSenderFor(customer) {
  if (customer.channel === 'instagram') return sendInstagramDocument;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  return (to, link, caption) => sendWhatsAppImage(to, link, caption, credentials);
}
// Pure display text for staff-facing alerts -- customer.phone_number is
// always null for an Instagram customer (DMs never expose one), so that
// fallback alone would just show nothing useful there.
function displayNameFor(customer) {
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
async function logMessage({ customerId, direction, channel, sender, body, trigger, platformMessageId, processed }) {
  await pool.query(
    `insert into message (customer_id, direction, channel, sender, body, trigger, platform_message_id, processed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [customerId, direction, channel, sender, body, trigger || null, platformMessageId || null, processed ? new Date() : null]
  );
  await pool.query(`update customers set last_message = $1, last_message_at = now() where id = $2`, [body, customerId]);
}

// Instagram's send response carries the new message's own id (message_id).
// WhatsApp's carries its own wamid too (sendResult.messages[0].id) -- kept
// unused here until 2026-09-02, when a real live bug (a plain-text send
// outside the 24h window, accepted synchronously then failed later via a
// status webhook, with no way to know which conversation row it belonged
// to) made it clear webhook-whatsapp.js's status handler needs this to
// correlate a failure back to the message that produced it. See message.
// platform_message_id's schema comment for the full story.
function platformMessageIdFrom(customer, sendResult) {
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
async function reply(customer, text, logTag = 'bot_flow_step') {
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
  if (customer.channel !== 'whatsapp') {
    await reply(customer, `${bodyText} Reply yes to confirm, or let me know what you'd like to change.`, trigger);
    return;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  const buttons = [
    { id: 'order_confirm_yes', title: 'Yes, confirm' },
    { id: 'order_confirm_no', title: 'No, change it' },
  ];
  await sendWhatsAppButtons(recipientFor(customer), bodyText, buttons, credentials);
  await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body: bodyText, trigger });
}

// A real staff member, typing their own words from the dashboard's
// conversation view -- not the bot. Same WhatsApp send path (still runs
// through sanitizeText, so no markdown-style bullets), but logged as
// sender 'staff' rather than 'bot', and it counts as taking the thread:
// the customer already can't tell bot from staff apart by design, and a
// human replying without explicitly claiming the thread first is exactly
// how the bot would also try to answer the same message a moment later.
export async function sendStaffReply(customerId, text, staffId) {
  const { rows } = await pool.query('select * from customers where id = $1', [customerId]);
  const customer = rows[0];
  if (!customer) throw new Error('Customer not found.');

  let sendResult;
  try {
    sendResult = await botEngine.sendMessage({ trigger: 'explicit_type_command', to: recipientFor(customer), text, whatsappSend: await senderFor(customer) });
  } catch (err) {
    // Error 131047 is WhatsApp refusing a plain text send outside the 24h
    // session window -- a stale conversation, or one that never started
    // (Chidera's call, 2026-09-02: "normal messaging on normal chat", no
    // separate "message a customer first" flow, and it must not just fail
    // silently). Same reply box, same endpoint -- falls back to the
    // approved business_outreach template with the exact text staff typed,
    // automatically, instead of surfacing this as a dead end.
    if (customer.channel === 'whatsapp' && /131047/.test(err.message)) {
      const credentials = await getWhatsAppCredentials(customer.branch_id);
      const components = [{ type: 'body', parameters: [{ type: 'text', text }] }];
      sendResult = await sendWhatsAppTemplate(customer.phone_number, 'business_outreach', 'en_US', components, credentials);
    } else {
      throw err;
    }
  }
  await logMessage({
    customerId: customer.id,
    direction: 'outbound',
    channel: customer.channel,
    sender: 'staff',
    body: text,
    trigger: 'staff_reply',
    platformMessageId: platformMessageIdFrom(customer, sendResult),
  });
  // handover_at matters even when staff proactively jumps into a still
  // bot-handled conversation (no formal handover() call first) -- it's the
  // boundary resumeBotControl uses to know which customer messages are
  // genuinely unanswered. Missing this was a real bug: without it, "Return
  // to bot" fell back to customer.created_at as the boundary, so it
  // replayed EVERY message the customer had ever sent, including old
  // already-handled ones, and the bot wrongly replied even when staff's own
  // reply was the last word and the customer hadn't said anything since.
  await pool.query(
    `update customers set handled_by = 'staff', handled_by_staff_id = coalesce($1, handled_by_staff_id), handover_at = coalesce(handover_at, now()) where id = $2`,
    [staffId || null, customer.id]
  );
}

// Staff reaching a phone number with no existing thread -- just resolves
// (or creates) the customer row so there's a conversation to open. No send
// here, no separate "outreach" ceremony: sendStaffReply's own fallback
// (business_outreach template when a plain send hits error 131047) is what
// actually gets the first message out, from the exact same reply box as
// any other conversation.
export async function startConversation({ phoneNumber, branchId }) {
  return findOrCreateCustomer({ phoneNumber, channel: 'whatsapp', branchId });
}

// Called from webhook-whatsapp.js's status handler when Meta reports a send
// failed with error 131047 -- the window-closed case sendStaffReply's own
// try/catch fallback can't catch, because Meta accepted the request
// synchronously (a real wamid came back, no error) and only failed it
// afterward, async, via this same webhook. Real bug, found live
// 2026-09-02: two staff replies to real customers went out this way,
// Meta accepted both, neither customer ever got anything, and nothing in
// this app knew, because this webhook event was never even listened for.
// Retries the exact text that failed, via the same business_outreach
// template sendStaffReply's synchronous fallback already uses, so this is
// the second half of the same fix, not a separate mechanism.
export async function retryFailedSendAsTemplate(failedPlatformMessageId) {
  const { rows: msgRows } = await pool.query(
    `select * from message where platform_message_id = $1 and direction = 'outbound'`,
    [failedPlatformMessageId]
  );
  const original = msgRows[0];
  if (!original) return; // nothing to correlate -- can't safely retry blind

  await pool.query(`update message set delivery_status = 'failed' where id = $1`, [original.id]);

  const { rows: custRows } = await pool.query('select * from customers where id = $1', [original.customer_id]);
  const customer = custRows[0];
  if (!customer || customer.channel !== 'whatsapp') return; // template mechanism is WhatsApp-only

  const credentials = await getWhatsAppCredentials(customer.branch_id);
  const components = [{ type: 'body', parameters: [{ type: 'text', text: original.body }] }];
  const sendResult = await sendWhatsAppTemplate(customer.phone_number, 'business_outreach', 'en_US', components, credentials);

  await pool.query(`update message set delivery_status = 'retried' where id = $1`, [original.id]);
  await logMessage({
    customerId: customer.id,
    direction: 'outbound',
    channel: 'whatsapp',
    sender: original.sender,
    body: original.body,
    trigger: 'window_closed_retry',
    platformMessageId: sendResult?.messages?.[0]?.id,
  });
}

// Claims a conversation for staff WITHOUT sending anything -- the
// dashboard's "Take over from bot" button, clicked before staff has typed a
// word. Exists specifically to close a real race: sendStaffReply only
// marks handled_by='staff' once a reply actually goes out, but a human
// typing a reply can easily take longer than the bot's own debounce
// window, so the bot would still answer the customer in the meantime, both
// of them replying at once. Clicking this first closes that window
// immediately, before typing even starts.
// Who took over what, and when, lives in the Activity Log now (routes/
// api.js's take-over route already calls logActivity for this) -- staff
// used to also get it pushed as a WhatsApp text ("X has taken over the chat
// with Y"), which Chidera flagged as the wrong channel for it, 2026-09-02:
// that's dashboard information, not something that should land on a phone.
export async function takeOverConversation(customerId, staffId) {
  const { rows } = await pool.query('select * from customers where id = $1', [customerId]);
  const customer = rows[0];
  if (!customer) throw new Error('Customer not found.');

  await pool.query(
    `update customers set handled_by = 'staff', handled_by_staff_id = coalesce($1, handled_by_staff_id), handover_at = coalesce(handover_at, now()) where id = $2`,
    [staffId || null, customer.id]
  );
}

// A real human reply sent from the business's OWN WhatsApp app --
// coexistence mode (Settings' "WhatsApp connection"), not this dashboard.
// Meta mirrors these back through the same webhook as an smb_message_echoes
// event (see webhook-whatsapp.js), which is how this gets called. No staff
// login is involved here (it's just whoever has the phone), so there's no
// staffId the way sendStaffReply has -- app_handled_at is the equivalent
// "a real human is here" signal instead (see the gate checks in
// handlePendingBatch/handleInboundMedia). Logged into the same message
// history as everything else, so resumeBotControl's catch-up sees the full
// conversation regardless of which side of coexistence it happened on. Used
// to also WhatsApp-broadcast "Someone has taken over the chat with X" to
// every other handover-alert number -- removed, same call as the dashboard
// takeover broadcasts (Chidera's call, 2026-09-02/03): who took over what
// belongs in the dashboard/Activity Log, not pushed to a phone.
export async function recordAppReply({ phoneNumber, text }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channel: 'whatsapp' });
  await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'staff', body: text, trigger: 'app_reply' });
  await pool.query(
    `update customers set handled_by = 'staff', app_handled_at = coalesce(app_handled_at, now()), handover_at = coalesce(handover_at, now()) where id = $1`,
    [customer.id]
  );
}

// Instagram's version of recordAppReply above -- a real human reply typed
// directly in the business's own Instagram app, not this dashboard. Unlike
// WhatsApp, Meta gives no separate field for this (see message.platform_
// message_id's schema comment) -- webhook-instagram.js is the one that
// tells "our own echo" apart from "a genuine human reply" before ever
// calling this, so by the time this runs, that check has already happened.
export async function recordAppReplyInstagram({ channelId, text }) {
  const customer = await findOrCreateCustomer({ channelId, channel: 'instagram' });
  await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'staff', body: text, trigger: 'app_reply' });
  await pool.query(
    `update customers set handled_by = 'staff', app_handled_at = coalesce(app_handled_at, now()), handover_at = coalesce(handover_at, now()) where id = $1`,
    [customer.id]
  );
}

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
export async function getOpenOrder(customerId) {
  const { rows } = await pool.query(
    `select * from "order" where customer_id = $1 and engine_state not in ('completed', 'cancelled')
       and updated_at > now() - interval '3 hours'
     order by created_at desc limit 1`,
    [customerId]
  );
  const order = rows[0] || null;
  if (order) await pool.query(`update "order" set updated_at = now() where id = $1`, [order.id]);
  return order;
}

// Drives the 24h "want to order again?" window (Chidera's call,
// 2026-09-03): once completed_at is more than 24h old, this returns null
// and a bare greeting goes back to the normal cold-open flow -- exactly
// "back to root" after 24h, no separate cleanup job needed, the interval
// check alone does it.
async function recentlyCompletedOrder(customerId) {
  const { rows } = await pool.query(
    `select id from "order" where customer_id = $1 and status = 'completed' and completed_at > now() - interval '24 hours'
     order by completed_at desc limit 1`,
    [customerId]
  );
  return rows[0] || null;
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
const STALE_ORDER_HOURS = 24;
export async function closeStaleOrders() {
  const { rowCount } = await pool.query(
    `update "order" set status = 'cancelled', engine_state = 'cancelled'
     where engine_state not in ('completed', 'cancelled') and updated_at < now() - make_interval(hours => $1)`,
    [STALE_ORDER_HOURS]
  );
  if (rowCount) console.log(`Closed ${rowCount} order(s) abandoned for over ${STALE_ORDER_HOURS}h.`);
}

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

async function transitionOrder(order, toState) {
  const sm = await loadStateMachine();
  sm.assertTransition(order.engine_state, toState);
  await pool.query(`update "order" set engine_state = $1, updated_at = now() where id = $2`, [toState, order.id]);
  order.engine_state = toState;
}

// Any staff can opt into handover alerts (staff.handover_alerts), not just
// a single business.handover_number -- that field is kept only as a
// fallback for a business that hasn't set any staff-level alerts up yet, so
// nothing that already worked stops working. Exported for engine/delivery-
// dispatch.js's own escalation alert (an unaccepted delivery offer) -- same
// "who to tell" list as a customer handover, without needing the full
// customer-conversation handover() machinery around it.
export async function handoverRecipients() {
  const { rows: staffRows } = await pool.query(`select phone_number from staff where handover_alerts = true and phone_number is not null`);
  if (staffRows.length) return staffRows.map((s) => s.phone_number);
  const { rows: biz } = await pool.query('select handover_number from business limit 1');
  return biz[0]?.handover_number ? [biz[0].handover_number] : [];
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
async function handover(customer, reason, extra, ackText) {
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
      const alert = `A caller needs a person: ${displayNameFor(customer)}.\nReason: ${reason}\nThey were told someone will call them back on this number.`;
      for (const to of voiceRecipients) {
        await botEngine.sendMessage({ trigger: 'staff_handoff_intro', to, text: alert, whatsappSend: sendWhatsApp });
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
  const extraLines = extra ? `\n${Object.values(extra).filter(Boolean).join('\n')}` : '';
  // A straight link to this exact conversation, not just a text summary --
  // whoever gets this alert can open the real thread and reply from there
  // in one tap instead of hunting for this customer in the dashboard.
  const link = process.env.PUBLIC_URL ? `\n${process.env.PUBLIC_URL}/conversations/${customer.id}` : '';
  const alert = `Handing over a chat from ${displayNameFor(customer)} to you.\nReason: ${reason}\n${summary}${extraLines}${link}`;
  // Known gap: unlike every other reply in this file, this message can go
  // to a staff number that hasn't messaged the bot in the last 24 hours,
  // which WhatsApp requires a template for (bot-engine/wake-template.js) --
  // not wired yet, so a stale/never-messaged number can silently fail to
  // receive this alert until they message the bot number first.
  for (const to of recipients) {
    await botEngine.sendMessage({ trigger: 'staff_handoff_intro', to, text: alert, whatsappSend: sendWhatsApp });
  }
}

async function countConsecutiveKbMisses(customerId) {
  const { rows } = await pool.query(
    `select trigger from message where customer_id = $1 and direction = 'outbound' order by created_at desc limit 1`,
    [customerId]
  );
  return rows[0]?.trigger === 'kb_miss' ? 1 : 0;
}

const NO_KB_MATCH = 'NO_KB_MATCH';

// Shared by every place that needs to answer a real question from real
// data -- the knowledge base, the menu, and business/branch facts. One
// source of truth for this context, not a separate hand-copied version per
// caller (answerOrderQuestion used to have its own smaller copy with just
// the menu, missing the knowledge base and business facts entirely -- which
// is exactly why "when do you close?" got "let me check with the team"
// instead of the real "24/7" answer already sitting in the knowledge base).
async function buildBusinessKnowledgeContext(branchId) {
  const { rows: kb } = await pool.query('select question, answer from knowledge_base order by position');
  const products = await resolveMenu(branchId);
  const { rows: bizRows } = await pool.query('select address, operating_hours from business limit 1');
  const business = bizRows[0] || {};
  const branches = await branchOptions();

  const menuContext = products.length
    ? `Current menu/catalogue (only these items are available right now):\n${products.map((p) => `${p.name}${p.description ? ` (${p.description})` : ''} -- NGN ${p.price}`).join('\n')}`
    : 'The menu/catalogue is currently empty.';
  const kbContext = kb.length ? kb.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join('\n\n') : '';
  // Giving the model the real location fact(s) (and stating plainly how
  // many there are) closes the exact gap that was causing it to invent
  // branches out of nowhere when asked "how many locations" -- an empty
  // context left a vacuum for it to fill with a plausible-sounding guess;
  // a concrete fact leaves nothing to guess.
  const businessContext =
    branches.length > 1
      ? `This business has ${branches.length} branches, no others:\n${branches.map((b) => `${b.name}: ${b.address}`).join('\n')}`
      : `This business has exactly one location, no other branches:\nAddress: ${branches[0]?.address || business.address || 'not on file'}\nOperating hours: ${business.operating_hours || 'not on file'}`;

  return { businessContext, menuContext, kbContext };
}

async function answerFromKnowledgeBase(message) {
  const { businessContext, menuContext, kbContext } = await buildBusinessKnowledgeContext();

  const system = `You are a strict lookup, not a conversationalist. Your only source of truth is the DATA block at the end of this prompt. You have no other knowledge about this business, its history, its facilities, or anything about it beyond what's printed in DATA -- treat yourself as knowing literally nothing else, the way a brand-new hire reading only this sheet would. Do not use general assumptions about what a typical business like this "usually" has (multiple locations, certain hours, certain policies) -- assume nothing beyond DATA.\n\nRule: if the customer's question is about a fact that is not written in DATA word-for-word or as a clear paraphrase of it, that is a miss. A miss means: reply with exactly this one word and nothing else: ${NO_KB_MATCH}. Silence on a topic in DATA always means "not covered", never "safe to guess." This applies to every kind of fact equally -- physical addresses, number of locations, opening hours, delivery areas, policies -- there is no topic where guessing a plausible-sounding answer is acceptable.\n\nException: a direct, unambiguous logical consequence of a stated fact is not a guess, and IS answerable -- e.g. "open 24/7" directly means "never closes", so "when do you close?" has a real answer (we don't close) even though the word "close" isn't in DATA. The menu/catalogue listed is stated as the FULL, exhaustive list of what's available right now -- so asked about any item NOT on it ("is there white rice?", "do you have suya sauce?"), the direct answer is a short "no, we don't have that" (that clause only -- do NOT also name what's actually available, a real, always-current menu with photos and prices is shown separately as a button right after, that's what covers "here's what we do have," never write that part out yourself), not a miss -- absence from an exhaustive list is itself the answer, not an unknown. Only treat something as a genuine miss if DATA doesn't address the topic at all, not merely because the question is phrased differently from how DATA states it.\n\nSame rule for an unclear question: do not write your own clarifying question, and never describe what topics you're able to help with or list examples of what you can answer -- that is not this business's voice, a staff member doesn't announce their own job description. Just output ${NO_KB_MATCH}.\n\nNever write out more than one or two item names in a row yourself, for any reason -- a menu can be large, and a real always-current menu with photos and prices is always shown separately as a button (see ISGENERALAVAILABILITY below) whenever the full list matters. If they ask specifically about the price of a particular item ("how much is X", "is it 1500?"), answer that directly with the real number instead.\n\nSeparately from the text you reply with, also decide: does answering this properly involve the full list of what's available -- either a BROAD browse question naming no specific item ("what do you have", "what's on the menu", "what's available", "can I see the menu/catalogue"), OR a specific item that's NOT available (where "here's what we do have" would be the natural next thing to say)? If either, end your reply on its own new line with exactly: ISGENERALAVAILABILITY -- for the broad case leave the rest of your reply empty, for the not-available case keep only the short "no" clause before it. Do not add this line for a question about a specific item that IS available (name it and its price, if asked, as normal), or for anything else.\n\nDATA:\n${businessContext}\n\n${menuContext}\n\n${kbContext}`;
  const raw = await askText(system, message);
  const isGeneralAvailability = /ISGENERALAVAILABILITY\s*$/i.test(raw.trim());
  const cleaned = raw.replace(/ISGENERALAVAILABILITY\s*$/i, '').trim();
  // Matched loosely (contains, case-insensitive) rather than an exact
  // string match -- a model asked for an exact phrase like "I don't know"
  // will sometimes still rephrase it, so a distinctive all-caps token
  // checked this way is the more reliable version of the same idea.
  const answer = cleaned.toUpperCase().includes(NO_KB_MATCH) ? null : cleaned;
  return { answer, isGeneralAvailability };
}

// This has NO menu/business data at all, deliberately -- it exists only to
// greet, never to answer anything. Found live: without the explicit ban
// below, given a message that both greeted AND asked a real question ("is
// there white rice and stew?"), it just guessed -- confidently said yes to
// something not on the menu, with nothing to ground the answer, then had to
// be corrected by the real (grounded) reply a moment later.
const GREETING_SYSTEM = `You open a WhatsApp conversation for a business, replying to a customer's first message. Match what they actually said -- if they said "good evening", greet them back for the evening; if they used no greeting at all, don't force one. Warm and professional customer service, not a casual friend: no slang, keep emoji minimal or none. Use commas or periods for pauses, never a dash of any kind (no em dash, en dash, or hyphen used as punctuation). End by inviting them to share what they'd like to order. Do not list examples of what you can help with or describe your own capabilities -- a staff member doesn't announce their job description, just ask plainly. One or two short sentences, plain text, no markdown.\n\nIf the message also asks a real question (menu, prices, hours, anything factual) alongside the greeting, do NOT answer it here -- you have no real data to answer from, and guessing is never acceptable. Just greet and invite them to order; the real question gets answered separately, for real, right after.`;

// Special offers/combo deals are just an ordinary category, same as
// "Drinks" or "Mains" -- Catalogue.jsx already groups by whatever's typed
// in, and the web menu already tabs by it too, so nothing about storage
// or display needed inventing. What's new is noticing one exists at all
// (so the greeting knows to offer it) and finding it by MEANING rather
// than an exact string, since one business might type "Special Offers",
// another "Combo Deals" -- same keyword-matching idiom as UPSELL_GROUPS.
// Chidera 2026-09-10: "restaurants have combo deals or special offers,
// they should be able to write it in catalogue in a different section."
const SPECIALS_KEYWORDS = ['special', 'offer', 'combo', 'deal'];
function isSpecialsCategory(category) {
  if (!category) return false;
  const lower = category.toLowerCase();
  return SPECIALS_KEYWORDS.some((k) => lower.includes(k));
}
async function findSpecialsCategory(branchId) {
  const menu = await resolveMenu(branchId);
  return menu.find((p) => isSpecialsCategory(p.category))?.category || null;
}

// A "Place an order" button on the very first greeting -- Chidera's call,
// 2026-09-10: a customer who taps this skips straight to the real menu
// list (see the button_reply handling in webhook-whatsapp.js), the same
// way a table's QR code does for dine-in, with no AI classifyIntent call
// needed to work out they wanted to order. WhatsApp only -- Instagram/voice
// have no reply-button equivalent, so they keep the plain-text greeting.
async function handleGreeting(customer, text) {
  const message = await askText(GREETING_SYSTEM, text);
  if (customer.channel !== 'whatsapp') {
    await reply(customer, message, 'greeting');
    return;
  }
  // Two buttons only when there's a real second thing to offer -- a
  // business with nothing in a specials-ish category gets exactly the
  // same single "View menu" button as before, not an empty second option.
  // Chidera 2026-09-10: "that first message... will have two buttons, the
  // see menu and special offers[,] but see menu should still have a
  // special offer category" -- the general menu link always shows every
  // category including this one; the second button just jumps straight to
  // it for someone who came here specifically for the deal.
  const specialsCategory = await findSpecialsCategory(customer.branch_id);
  if (specialsCategory) {
    const credentials = await getWhatsAppCredentials(customer.branch_id);
    const buttons = [
      { id: 'menu_see', title: 'See menu' },
      { id: 'menu_specials', title: 'Special offers' },
    ];
    await sendWhatsAppButtons(recipientFor(customer), message, buttons, credentials);
    await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body: message, trigger: 'greeting' });
    return;
  }
  // Straight to the real web menu -- Chidera's call, 2026-09-10: "no need
  // for place an order just put view menu button straight". One tap
  // (View menu) instead of two (Place an order, then a second message
  // with the actual link) -- sendWebMenuLink handles PUBLIC_URL not being
  // set by falling back to plain text on its own.
  const shown = await sendWebMenuLink(customer, message);
  if (!shown) await reply(customer, message, 'greeting');
}

// The two greeting buttons above, tapped -- each just opens the same web
// menu page, "Special offers" pre-scrolled to that category via ?cat=
// (menu-page-template.js reads it as the starting tab instead of always
// defaulting to the first one) rather than a separate page or a second
// concept to keep in sync with the real catalogue.
export async function handleMenuChoiceTap({ phoneNumber, channelId, buttonId, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  const label = buttonId === 'menu_specials' ? 'Special offers' : 'See menu';
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: `[tapped: ${label}]`, processed: true });

  if (buttonId === 'menu_specials') {
    const specialsCategory = await findSpecialsCategory(customer.branch_id);
    const shown = await sendWebMenuLink(customer, "Here's today's specials.", 'See specials', specialsCategory);
    if (!shown) await reply(customer, "Here's today's specials.", 'menu_shown');
    return;
  }
  const shown = await sendWebMenuLink(customer, "Here's our menu, take a look and let me know what you'd like.");
  if (!shown) await reply(customer, 'What would you like to order?', 'items_menu_shown');
}

// Deterministic, not AI-driven -- this can never guess or invent an answer,
// which matters here specifically: it runs alongside real content in the
// SAME reply (handleCollectInfo, handleEnquiry), so there's no room for it
// to improvise past a plain courtesy phrase. Covers the greetings actually
// seen in real conversations; anything not matched just means no prefix,
// never a forced or wrong one.
//
// Composes rather than short-circuits: found live, a message with BOTH a
// time-of-day greeting and a wellbeing question ("good afternoon, how are
// you doing?") only got the time-of-day half acknowledged -- the "how are
// you" was answered with silence, technically "not ignored" (something
// still went out) but not actually a real answer to what was asked either.
// Every branch below can fire independently and all their text concatenates
// into one reply, matching how a real person would answer both parts of
// "good afternoon, how are you" in one breath.
function greetingAckFor(text) {
  let ack = '';
  if (/good\s*morning/i.test(text)) ack += 'Good morning! ';
  else if (/good\s*afternoon/i.test(text)) ack += 'Good afternoon! ';
  else if (/good\s*evening/i.test(text)) ack += 'Good evening! ';
  else if (/\b(hi|hello|hey+)\b/i.test(text)) ack += 'Hey there! ';
  if (/how\s*(far|you\s*(dey|de)|are\s*you|is\s*(your\s*day|it\s*going))\b/i.test(text)) {
    ack += "I'm doing well, thank you for asking. ";
  }
  return ack;
}

async function handleEnquiry(customer, text) {
  const { answer: rawAnswer, isGeneralAvailability } = await answerFromKnowledgeBase(text);
  const answer = await resolveGeneralAvailability(customer, isGeneralAvailability, rawAnswer, text);
  // Same idiom as handleCollectInfo's greetingPrefix -- a batched message can
  // both greet AND ask a browse question ("good afternoon, what do you
  // have?"), and the greeting was being silently dropped whenever the
  // question half resolved to an empty answer (a pure browse question is
  // BY DESIGN answered with just the menu button, so `answer` alone was
  // often falsy and this whole function returned without sending anything).
  // handleCollectInfo already folds a greeting into its reply this same
  // way; this path never did, which is exactly the gap that made a
  // multi-part message with a greeting in it look ignored.
  const greeting = greetingAckFor(text);
  if (answer || greeting) {
    await reply(customer, `${greeting}${answer || ''}`.trim(), 'kb_answer');
    return;
  }
  // Covers both how the menu could have just been sent instead of text --
  // the AI's own classification, or the deterministic phrasing check inside
  // resolveGeneralAvailability -- either way, nothing more is needed here.
  if (isGeneralAvailability || looksLikeBrowseQuestion(text)) return;
  const priorMisses = await countConsecutiveKbMisses(customer.id);
  if (priorMisses >= 1) {
    await handover(customer, "Customer asked something twice that isn't in the knowledge base");
    return;
  }
  await reply(customer, "Let me check on that for you, one moment.", 'kb_miss');
}

async function summariseOrder(order) {
  const { rows } = await pool.query(
    `select p.name, oi.quantity, oi.price from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
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
  const itemLines = rows.map((r) => `${r.quantity}x ${r.name}: NGN ${r.price}`);
  const itemsTotal = rows.reduce((sum, r) => sum + Number(r.price) * r.quantity, 0);
  // delivery_fee is 0 until handleCollectFulfilment sets it (only known once
  // fulfilment_type/address are collected, and only for real Chowdeck
  // delivery) -- reading it straight off the order row here means callers
  // before and after that point both get the right total automatically.
  const deliveryFee = Number(order.delivery_fee || 0);
  return { lines, itemLines, itemsTotal, deliveryFee, total: itemsTotal + deliveryFee };
}

// A bare re-ask ("What would you like to order today?") on a second try
// isn't actually helpful -- the customer already tried to answer that and
// it didn't match. For the two fields with a real, short options list
// (item, branch), naming the actual choices turns a repeated question into
// something they can act on ("we didn't have a match, here's what we do
// have" instead of the same sentence verbatim).
async function fieldPrompt(fieldKey, fallbackQuestion, branchId) {
  if (fieldKey === 'items') {
    // A business with a menu photo on file gets it forwarded instead (see
    // the items_menu_shown call site below) -- naming every item as text
    // here too would defeat the point (that's exactly the "300 items is
    // unreadable as text" problem the photo forward exists to avoid).
    const { rows: photos } = await pool.query('select 1 from menu_photo limit 1');
    if (photos.length) return fallbackQuestion || 'What would you like to order?';
    const products = await resolveMenu(branchId);
    if (products.length) return `${fallbackQuestion || 'What would you like to order?'} We have: ${products.map((p) => p.name).join(', ')}.`;
  }
  if (fieldKey === 'branch') {
    const branches = await branchOptions();
    if (branches.length) return `${fallbackQuestion || 'Which branch?'} We have: ${branches.map((b) => b.name).join(', ')}.`;
  }
  return fallbackQuestion || `Sorry, can you tell me the ${fieldKey}?`;
}

async function handleCollectInfo(customer, order, text, greetingPrefix = '') {
  // Computed once, reused for whatever reply actually ends up going out
  // below -- a message can both state an order AND ask something ("can I
  // have fried rice, how much is suya wrap"), and the question was
  // silently getting dropped whenever the order half also matched
  // successfully (only the no-match path used to check for a question at
  // all). One combined reply, not the question ignored or a second message
  // sent separately -- also folds in the greeting acknowledgment for a
  // brand-new conversation, so that's one reply too, not two.
  const questionAnswer = await answerOrThenShowMenu(customer, order, text, `Taking their order.`);
  // Mutable -- a vague item mention found further down ("1 chapman and some
  // rice") gets appended here too, so it rides along on whatever reply ends
  // up going out next instead of being silently dropped just because OTHER
  // items in the same message matched cleanly.
  let prefix = `${greetingPrefix}${questionAnswer ? `${questionAnswer} ` : ''}`;
  const send = (msg, trigger) => reply(customer, `${prefix}${msg}`.trim(), trigger || (prefix ? 'order_question_answer' : undefined));

  const { rows: items } = await pool.query('select * from order_item where order_id = $1', [order.id]);
  const outstanding = await missingFieldsForOrder(order, items);

  if (outstanding.length) {
    if (outstanding[0] === 'items') {
      // One extraction pass over the whole message pulls out every
      // item+quantity it can match, not just the first one -- a customer
      // who writes their whole order in one go should never have to repeat
      // it back one item at a time.
      const { matched, ambiguous } = await extractOrderItems(text, order.branch_id);
      if (!matched.length) {
        // A vague mention that could genuinely mean more than one real item
        // ("rice" when both jollof and fried rice exist) -- ask which one,
        // always naming the actual matching options, never a guess and
        // never a generic "what would you like" that ignores what they
        // already said.
        if (ambiguous.length) {
          const lines = ambiguous.map((a) => `We have ${a.options.join(' and ')}, which do you mean?`).join(' ');
          await send(lines, 'items_clarify');
          return;
        }
        // "How much is X" isn't an order for X -- extractOrderItems
        // correctly finds nothing to add, but that's not the same as the
        // message being unclear. A real price question gets a real price
        // answer (already in `prefix` above), not the generic re-ask below.
        if (questionAnswer) {
          await send('', 'order_question_answer');
          return;
        }
        // The full "We have: ..." list is only useful the first time --
        // repeating the whole menu on every failed attempt gets tedious
        // fast. After that, a short nudge instead: they can already see
        // what's on offer, no need to recite it back every time nothing
        // matches.
        const { rows: shown } = await pool.query(
          `select 1 from message where customer_id = $1 and trigger = 'items_menu_shown' and created_at >= $2 limit 1`,
          [customer.id, order.created_at]
        );
        if (shown.length) {
          await send(`You can check what we have and let me know what you'd like.`, 'items_reask');
        } else {
          // The real web menu page (engine/menu-page-template.js) beats
          // even a photo once it's available -- every dish, a real photo,
          // categories, a basket, built and served entirely by this
          // backend, not dependent on Meta's own catalogue indexing or the
          // old WhatsApp List Message's 10-row/no-photo limits. Chidera's
          // call, 2026-09-10: "the menu is meant to be like a site now...
          // not just in dine in[,] the normal conversation flow". WhatsApp
          // only (Instagram has no CTA-URL button type) -- Instagram keeps
          // the photo/text fallback below unchanged. Returns false only
          // when PUBLIC_URL isn't set, so the photo/text fallback below
          // still covers that real gap.
          let catalogShown = false;
          if (customer.channel !== 'instagram') {
            catalogShown = await sendWebMenuLink(customer, "Here's our menu, take a look and let me know what you'd like.").catch((err) => {
              console.error('sendWebMenuLink failed:', err.message);
              return false;
            });
          }
          // A real menu photo beats a text list once a catalogue is more
          // than a handful of items -- "We have: X, Y, Z... [300 names]" is
          // unreadable, but the actual printed menu is exactly what a
          // customer would be handed in person. PUBLIC_URL-gated same as
          // every other outbound file link here (invoice, receipt): no
          // photo forward without a real public URL to serve it from.
          if (!catalogShown && process.env.PUBLIC_URL) {
            const { rows: photos } = await pool.query('select id from menu_photo order by position');
            if (photos.length) {
              const sendImage = await imageSenderFor(customer);
              for (const photo of photos) {
                await sendImage(recipientFor(customer), `${process.env.PUBLIC_URL}/documents/menu-photo/${photo.id}`);
              }
            }
          }
          // Found live: this used to call fieldPrompt('items', ...)
          // unconditionally, which -- whenever there's no menu photo either
          // -- falls back to naming every item as text. That ran even when
          // the button above had just succeeded, so a customer got the
          // button AND a full text list of the same items in the same
          // turn. The button already covers "here's what's available"
          // once it's actually sent; only fall back to fieldPrompt's own
          // (photo, or as a last resort, text-list) behaviour when it
          // didn't.
          await send(catalogShown ? 'What would you like to order?' : await fieldPrompt('items', 'What would you like to order?', order.branch_id), 'items_menu_shown');
        }
        return;
      }
      for (const m of matched) {
        await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4)', [order.id, m.productId, m.quantity, m.price]);
      }
      // The clear items above still get added -- the ambiguous part just
      // rides along on whatever reply comes next (branch, confirm, etc.)
      // instead of being silently dropped.
      if (ambiguous.length) {
        prefix = `${prefix}${ambiguous.map((a) => `We have ${a.options.join(' and ')}, which do you mean? `).join('')}`;
      }
    } else {
      // Before assuming this message answers the CURRENT outstanding field
      // (branch, delivery address, whatever's next), check whether it's
      // actually asking to add/change items instead -- found live: "I also
      // want suya and rice" while still being asked for a branch was
      // silently dropped, since this branch only ever looked for the one
      // specific field it expected next, never for a new item mention.
      const { rows: currentItemsForMod } = await pool.query(
        `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
        [order.id]
      );
      const mods = await extractOrderModifications(text, currentItemsForMod, order.branch_id);
      if (mods) {
        // Not "your order's now X" here -- found live, 2026-09-10: this
        // used to restate the whole order, then finishItemsCollection's
        // own confirm message restated it again right after, listing
        // everything twice in one reply. finishItemsCollection is always
        // the very next thing that runs from here (nothing else follows
        // this branch), so a bare acknowledgment is enough -- the real
        // breakdown shows up once, in that message.
        await applyOrderModifications(order, mods, { allowRemovals: true });
        prefix = `${prefix}Got it. `;
      } else {
        const fields = await loadBotFields();
        const field = fields.find((f) => f.key === outstanding[0]);
        const extracted = await extractAndApply({ fieldKey: outstanding[0], message: text, contextQuestion: field?.question, order });
        if (extracted === null) {
          await send(await fieldPrompt(outstanding[0], field?.question, order.branch_id));
          return;
        }
      }
    }
    // extractAndApply/the items insert above just wrote straight to the
    // database -- reload so the missing-fields check right below sees it,
    // instead of judging against this now-stale in-memory copy.
    const { rows: reloaded } = await pool.query('select * from "order" where id = $1', [order.id]);
    Object.assign(order, reloaded[0]);
  }

  return finishItemsCollection(customer, order, prefix);
}

// Finds the earliest catalogue-question still unanswered across every item
// on this order, in item-then-question order -- null once every item's
// questions (if it has any at all) are all answered. Kept as its own query
// (not parsed out of order_item.modification's free text) so "has this
// specific question been asked yet" is a real fact, not a guess.
async function askNextItemQuestion(orderId) {
  const { rows } = await pool.query(
    `select oi.id as order_item_id, pq.id as question_id, pq.question, p.name as product_name
     from order_item oi
     join product p on p.id = oi.product_id
     join product_question pq on pq.product_id = p.id
     where oi.order_id = $1
       and not exists (
         select 1 from order_item_answer oa where oa.order_item_id = oi.id and oa.question_id = pq.id
       )
     order by oi.id, pq.position
     limit 1`,
    [orderId]
  );
  return rows[0] || null;
}

// Cross-sell, per Chidera 2026-09-10: a real question with the actual
// options named ("Would you like to add a drink? We have: Coke, Fanta,
// Chapman.") asked and answered as its own exchange BEFORE the final "to
// confirm" summary, not decoration folded into it or sent after -- "you
// must be clear on what customer wants before asking that total yes to
// confirm thing". Only ever for a category this business actually sells
// (never invented, same rule as everywhere else the menu gets named), and
// each category is offered at most once per order (order.upsell_offered)
// so declining it doesn't get asked again on every turn. Keyed off
// product.category, the same field the Catalogue page already groups by --
// no new setup for a restaurant that's already categorized its menu, and
// it simply never fires for one that hasn't.
// Chidera 2026-09-10: "the bott should know when to recommend a protein or
// when to recommend a drink... or when to recommend a snack... or even
// when to recommend water." nextUpsellGroup below already asks one group
// at a time, skips anything the order already has, and never repeats a
// group already offered this order -- so which of these actually gets
// offered, and in what order, already follows what's really being
// ordered without any extra logic; adding a real category here is what
// makes it apply to more than drink/protein. Water deliberately isn't its
// own group -- most catalogues list a water bottle under Drinks like any
// other beverage (era-demo's own category list confirms this: DRINKS,
// MAINS, nothing separate), so a rigid "category = water" group would
// just never fire for almost anyone. Folded into 'drink's own keywords
// instead, so a business that DOES give it a distinct category still
// gets it offered, under the same "would you like a drink" ask.
const UPSELL_GROUPS = [
  { key: 'drink', keywords: ['drink', 'beverage', 'juice', 'water'], label: 'a drink' },
  { key: 'protein', keywords: ['protein', 'meat'], label: 'a protein' },
  { key: 'snack', keywords: ['snack', 'small chop', 'appetiser', 'appetizer', 'starter'], label: 'a snack' },
];

function categoryMatchesGroup(category, keywords) {
  if (!category) return false;
  const lower = category.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

// Full product rows, not just names -- Chidera 2026-09-10: "an upsell
// should bring up that view drinks thats like a list and click button...
// if i want to reduce api cost what will be the best option?" A tap needs
// a real product id to route the same zero-AI-cost way any other menu-list
// tap already does (see sendUpsellList/handleUpsellListTap below); the
// text fallback (sendUpsellList returning false, or a typed reply --
// handlePendingUpsell) just reads .name off these instead.
function catalogueOptions(menu, keywords) {
  return menu.filter((p) => categoryMatchesGroup(p.category, keywords));
}

// Next upsell group worth asking about, if any -- already-ordered
// categories and already-offered-this-order categories are both excluded,
// so this naturally returns null once every real cross-sell opportunity is
// either satisfied or already declined.
async function nextUpsellGroup(order, orderItems) {
  if (!orderItems.length) return null;
  const menu = await resolveMenu(order.branch_id);
  const orderedCategories = orderItems.map((oi) => menu.find((p) => p.id === oi.product_id)?.category).filter(Boolean);
  const offered = order.upsell_offered || [];
  for (const group of UPSELL_GROUPS) {
    if (offered.includes(group.key)) continue;
    const options = catalogueOptions(menu, group.keywords);
    if (!options.length) continue;
    const orderHasIt = orderedCategories.some((c) => categoryMatchesGroup(c, group.keywords));
    if (!orderHasIt) return { ...group, options };
  }
  return null;
}

// The upsell offer as a real WhatsApp List Message (tap to add) instead of
// free text an AI call has to parse -- Chidera 2026-09-10: "an upsell
// should bring up that view drinks thats like a list and click button...
// if i want to reduce api cost what will be the best option?" A tap costs
// zero AI calls (handleUpsellListTap below just reads the row id straight
// back to a real product, same as any other menu-list tap), where the old
// free-text version could burn up to three separate AI calls just parsing
// one reply ("is this a change?", "does this name an item?", "are they
// saying yes without naming one?" -- the last of those existed specifically
// to patch the ambiguity a list tap makes impossible by construction).
// Capped at 8 options + a "No thanks" row (9 total, under WhatsApp's
// 10-row hard limit) -- an upsell nudge doesn't need the main menu's own
// pagination, it's a short nudge, not a browse.
// Row ids are prefixed (upsell::<productId>, upsell::skip) rather than a
// bare product id -- keeps this completely separate from the general
// "View menu" list's own row-id space (menu-message.js), which a bare id
// would otherwise collide with.
async function sendUpsellList(customer, upsell, prefix = '') {
  if (customer.channel !== 'whatsapp') return false;
  if (!process.env.META_PHONE_NUMBER_ID || !process.env.META_ACCESS_TOKEN) return false;
  const rows = upsell.options.slice(0, 8).map((p) => ({
    id: `upsell::${p.id}`,
    title: p.name.slice(0, 24),
    description: `NGN ${Number(p.price).toLocaleString()}`,
  }));
  rows.push({ id: 'upsell::skip', title: 'No thanks', description: `Skip ${upsell.label}` });
  await sendListMessage(recipientFor(customer), {
    bodyText: `${prefix}Would you like to add ${upsell.label}?`.trim(),
    buttonText: 'Choose',
    sectionTitle: upsell.label.charAt(0).toUpperCase() + upsell.label.slice(1),
    rows,
  });
  await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `Would you like to add ${upsell.label}? We have: ${upsell.options.map((o) => o.name).join(', ')}.`, trigger: 'upsell_offered' });
  return true;
}

// The tail end of item collection -- shared between the normal path
// (handleCollectInfo above), handlePendingItemQuestion, and
// handlePendingUpsell below, so all three end up asking for the next
// item-question, the next missing field, the next upsell, or moving to
// confirmation the same way, instead of multiple versions drifting apart.
// The item-question check runs first and unconditionally, every time this
// is reached -- including right after handlePendingUpsell adds a drink,
// so a drink that itself has a product_question ("hot or cold?") still
// gets asked, the same as if it had been the very first item ordered.
async function finishItemsCollection(customer, order, prefix = '') {
  const nextQuestion = await askNextItemQuestion(order.id);
  if (nextQuestion) {
    await pool.query('update "order" set pending_question_order_item_id = $1, pending_question_id = $2 where id = $3', [
      nextQuestion.order_item_id,
      nextQuestion.question_id,
      order.id,
    ]);
    await reply(customer, `${prefix}For your ${nextQuestion.product_name}, ${nextQuestion.question}`.trim(), 'item_question_asked');
    return;
  }

  const { rows: itemsAfter } = await pool.query('select * from order_item where order_id = $1', [order.id]);
  const stillOutstanding = await missingFieldsForOrder(order, itemsAfter);
  if (stillOutstanding.length) {
    const fields = await loadBotFields();
    const nextField = fields.find((f) => f.key === stillOutstanding[0]);
    await reply(customer, `${prefix}${await fieldPrompt(stillOutstanding[0], nextField?.question, order.branch_id)}`.trim());
    return;
  }

  const upsell = await nextUpsellGroup(order, itemsAfter);
  if (upsell) {
    await pool.query('update "order" set pending_upsell_category = $1, upsell_offered = array_append(upsell_offered, $1) where id = $2', [
      upsell.key,
      order.id,
    ]);
    const sent = await sendUpsellList(customer, upsell, prefix);
    if (!sent) {
      await reply(customer, `${prefix}Would you like to add ${upsell.label}? We have: ${upsell.options.map((o) => o.name).join(', ')}.`.trim(), 'upsell_offered');
    }
    return;
  }

  await transitionOrder(order, 'check_availability');
  await transitionOrder(order, 'calculate_price');
  const { itemLines, total } = await summariseOrder(order);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
  await transitionOrder(order, 'confirm_order');
  const summary = [...itemLines, `Total: NGN ${total}`].join('\n');
  await sendConfirmButtons(customer, `${prefix}To confirm:\n${summary}`.trim(), 'order_confirm_asked');
}

// The reply to the upsell question above. Checked in order:
// 1) a real change to what's already in the order ("change it to jollof",
//    "remove the fried rice") -- found live, 2026-09-10: without this
//    check, a "change it to X" arriving right while a drink was being
//    offered got read as "add X" through the item-matcher below instead
//    of the swap it obviously meant, leaving both the old and new item on
//    the order at once.
// 2) failing that, the same real item-matcher the main order uses
//    (extractOrderItems), so "yes, a coke" or just "coke" both work the
//    same way an item mention always does elsewhere, not a bespoke
//    yes/no parser.
// 3) failing THAT, whether they said yes at all without naming one --
//    found live, 2026-09-10: "yes" to "Would you like to add a drink? We
//    have: Coke, Chapman, Zobo" matched no product name, so it silently
//    fell through as if they'd said no -- nothing added, nothing asked,
//    straight to confirming the order with no drink on it. A plain
//    decline still moves on exactly as before; only a real yes-but-which
//    re-asks, and only once (the offer's already marked offered, so it
//    can't loop forever even if they keep answering vaguely).
async function handlePendingUpsell(customer, order, text) {
  const { rows: currentItems } = await pool.query(
    `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
    [order.id]
  );
  const mods = await extractOrderModifications(text, currentItems, order.branch_id);
  if (mods) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
    // Same reasoning as handleCollectInfo's own mods branch -- no "your
    // order's now X" here, finishItemsCollection's own confirm message is
    // the one place that lists it.
    await applyOrderModifications(order, mods, { allowRemovals: true });
    return finishItemsCollection(customer, order, 'Got it. ');
  }

  const { matched } = await extractOrderItems(text, order.branch_id);
  if (matched.length) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
    for (const m of matched) {
      await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4)', [order.id, m.productId, m.quantity, m.price]);
    }
    return finishItemsCollection(customer, order, `Added ${matched.map((m) => `${m.quantity}x ${m.name}`).join(', ')}. `);
  }

  const wantsQuestion = 'Are they saying yes, they would like to add one, without yet naming which specific option?';
  const wantsOneField = botEngine.defineField({
    key: 'wantsOne',
    label: 'wants one',
    type: 'boolean',
    description: describeForExtraction(wantsQuestion, { type: 'boolean' }),
  });
  const wantsOne = await botEngine.extractField(wantsOneField, text, { askJson });
  if (wantsOne === true) {
    const group = UPSELL_GROUPS.find((g) => g.key === order.pending_upsell_category);
    const menu = await resolveMenu(order.branch_id);
    const options = group ? catalogueOptions(menu, group.keywords) : [];
    // pending_upsell_category deliberately left set -- their next message
    // is still the answer to this same offer, not a fresh one.
    await reply(customer, `Great, which one would you like? We have: ${options.map((o) => o.name).join(', ')}.`, 'upsell_clarify');
    return;
  }

  order.pending_upsell_category = null;
  await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
  return finishItemsCollection(customer, order, '');
}

// A tap on sendUpsellList's List Message above -- the zero-AI-cost path,
// handled entirely separately from handlePendingUpsell (which only ever
// sees a TYPED reply now, since a list tap arrives as its own webhook
// event and never reaches dispatch()/the pending_upsell_category text
// check at all). Row ids are 'upsell::<productId>' or 'upsell::skip', set
// by sendUpsellList -- webhook-whatsapp.js routes here before its normal
// menu-list row handling, since this id space is deliberately separate
// from that one.
export async function handleUpsellListTap({ phoneNumber, channelId, rowId, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  const order = await getOpenOrder(customer.id);
  // A stale tap on an old list (the offer's already been answered another
  // way, or the order's moved on/gone) -- nothing to do, and nothing to
  // clear that isn't already cleared.
  if (!order || !order.pending_upsell_category) return;

  order.pending_upsell_category = null;
  await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);

  const picked = rowId.slice('upsell::'.length);
  if (picked === 'skip') {
    await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: '[tapped: No thanks]', processed: true });
    return finishItemsCollection(customer, order, '');
  }

  const product = await productForRowId(picked);
  if (!product) return finishItemsCollection(customer, order, '');
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: `[tapped: ${product.name}]`, processed: true });
  await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, 1, $3)', [order.id, product.id, product.price]);
  return finishItemsCollection(customer, order, `Added ${product.name}. `);
}

// The reply to a question just asked by askNextItemQuestion above -- taken
// literally as the answer (no yes/no or item-change classification here on
// purpose, this is a short, deliberately simple exchange), recorded both
// as a real (order_item, question) fact and folded into order_item.modification
// for anywhere that already displays that column (Kanban card, order
// detail). Then either the next unanswered question, or back into the
// normal flow via finishItemsCollection once every item's questions are done.
async function handlePendingItemQuestion(customer, order, text) {
  const answer = text.trim();
  const { rows: qRows } = await pool.query('select question from product_question where id = $1', [order.pending_question_id]);
  const questionText = qRows[0]?.question || '';

  await pool.query(
    `insert into order_item_answer (order_item_id, question_id, answer) values ($1, $2, $3)
     on conflict (order_item_id, question_id) do update set answer = excluded.answer`,
    [order.pending_question_order_item_id, order.pending_question_id, answer]
  );
  const { rows: itemRows } = await pool.query('select modification from order_item where id = $1', [order.pending_question_order_item_id]);
  const existingMod = itemRows[0]?.modification;
  const newMod = existingMod ? `${existingMod}; ${questionText}: ${answer}` : `${questionText}: ${answer}`;
  await pool.query('update order_item set modification = $1 where id = $2', [newMod, order.pending_question_order_item_id]);

  order.pending_question_order_item_id = null;
  order.pending_question_id = null;
  await pool.query('update "order" set pending_question_order_item_id = null, pending_question_id = null where id = $1', [order.id]);

  // finishItemsCollection's own item-question check (its very first thing)
  // picks up the next unanswered question itself if there is one -- no
  // need to duplicate that lookup here too.
  return finishItemsCollection(customer, order, 'Got it. ');
}

// "Confirmed" (order.status) and "engine_state = confirm_order" are not the
// same fact -- engine_state stays confirm_order for both the yes/no ask AND
// the fulfilment questions that follow a yes, since delivery-vs-pickup
// still isn't decided yet either way. status flips to 'confirmed' the
// moment they say yes, which is what dispatch() below uses to tell "still
// deciding whether to order this" from "ordering it, now working out how it
// gets to them" -- asking for an address is not the same step as agreeing
// to buy.
async function handleConfirmOrder(customer, order, text) {
  // A plain "no" doesn't reliably mean "cancel this entirely" -- they may
  // just want to change something, or hesitate for a reason unrelated to
  // wanting out. So "no" never cancels here: it just asks what to change,
  // and leaves the order exactly as it is (still open, nothing lost). A
  // real modification ("remove the suya wrap") is already caught earlier
  // in dispatch(), before this function is even reached. There's no
  // customer-facing way to actively cancel anymore -- an order that's
  // genuinely abandoned just ages out on its own (see closeStaleOrders).
  const confirmQuestion = 'Are they confirming yes, ready to go ahead with this order as it is?';
  const confirmedField = botEngine.defineField({
    key: 'confirmed',
    label: 'confirmation',
    type: 'boolean',
    description: describeForExtraction(confirmQuestion, { type: 'boolean' }),
  });
  const value = await botEngine.extractField(confirmedField, text, { askJson });
  if (value === null || value === false) {
    // Not a plain yes doesn't mean nothing was actually said -- a real
    // question ("does that include delivery?") deserves a real answer, not
    // a rigid repeat of the same prompt regardless of what they asked.
    const answer = await answerOrThenShowMenu(customer, order, text, `Waiting on them to confirm yes, or say what they would like to change.`);
    if (answer) {
      await reply(customer, `${answer} Just let me know, yes to confirm, or what you would like to change.`);
      return;
    }
    // dispatch() already ran extractOrderModifications on this exact text
    // before handleConfirmOrder was ever reached, and it found nothing --
    // but that's a stricter AI call, reasoning about whether this is a
    // CHANGE to the current order. Found live, 2026-09-10: "I'll have
    // chapman" failed that stricter check and fell all the way through to
    // a canned non-answer, even though the plainer item-matcher
    // (extractOrderItems, same one used for a fresh order) reads it
    // correctly every time. One more, more lenient try before giving up --
    // a name-only, deterministic reply, not the vague generic one.
    const { matched } = await extractOrderItems(text, order.branch_id);
    if (matched.length) {
      await handleOrderModification(customer, order, { adds: matched, removes: [], sets: [] });
      return;
    }
    await reply(customer, 'No problem, just let me know what you would like to change, or reply yes to confirm as is.');
    return;
  }

  await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);
  order.confirmed_at = new Date();
  await handleCollectFulfilment(customer, order, null);
}

// Same yes/no gate as handleConfirmOrder, but for the case where an edit
// landed AFTER fulfilment was already resolved and payment instructions
// already sent once (engine_state is already 'confirm_payment' -- see
// handleOrderModification). Deliberately does NOT call
// handleCollectFulfilment: fulfilment_type/address are already known and
// re-running that would both re-ask something already answered and, since
// engine_state never left 'confirm_payment', hit an illegal
// confirm_payment -> confirm_payment transition in transitionOrder. A plain
// yes here just re-sends payment instructions for the new total.
async function handleReconfirmAfterEdit(customer, order, text) {
  // Same reasoning as handleConfirmOrder above -- "no" never cancels, it
  // just asks what to change and leaves the order (and the edit already
  // made) exactly as it is.
  const confirmQuestion = 'Are they confirming yes, ready to go ahead with the updated order as it is?';
  const confirmedField = botEngine.defineField({
    key: 'confirmed',
    label: 'confirmation',
    type: 'boolean',
    description: describeForExtraction(confirmQuestion, { type: 'boolean' }),
  });
  const value = await botEngine.extractField(confirmedField, text, { askJson });
  if (value === null || value === false) {
    const answer = await answerOrThenShowMenu(customer, order, text, `Waiting on them to confirm yes, or say what they would like to change, on the updated order.`);
    await reply(customer, answer ? `${answer} Just let me know, yes to confirm, or what you would like to change.` : 'No problem, just let me know what you would like to change, or reply yes to confirm as is.');
    return;
  }

  await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);
  order.confirmed_at = new Date();
  await sendPaymentInstructions(customer, order);
}

async function handleCollectFulfilment(customer, order, text) {
  // Dine-in (payment_mode = 'at_table') never asks for delivery/pickup or
  // takes payment through the bot -- spec 5.4: "settled at the table...
  // the order completes without a payment confirmation step." Still walks
  // the real state machine (confirm_payment -> payment_acceptance ->
  // fulfilment are the only legal next steps from confirm_order, see
  // bot_state's seed data), just with no message or wait at any of them --
  // same status/receipt handling completePayment gives every other order,
  // minus the delivery/pickup-specific messaging that makes no sense for
  // someone already sitting at the table.
  if (order.payment_mode === 'at_table') {
    await transitionOrder(order, 'confirm_payment');
    await transitionOrder(order, 'payment_acceptance');
    await pool.query(`update "order" set status = 'preparation' where id = $1`, [order.id]);
    await createReceipt(order);
    await transitionOrder(order, 'fulfilment');
    await reply(customer, 'Your order has been placed. Thank you!', 'dinein_order_placed');
    return;
  }

  const outstanding = await missingFulfilmentFields(order);
  if (outstanding.length && text !== null) {
    const fields = await loadBotFields();
    const field = fields.find((f) => f.key === outstanding[0]);
    const extracted = await extractAndApply({ fieldKey: outstanding[0], message: text, contextQuestion: field?.question, order });
    if (extracted === null) {
      // Same principle as everywhere else -- not a clean answer to this
      // field doesn't mean nothing was actually asked.
      const answer = await answerOrThenShowMenu(customer, order, text, `Deciding on ${outstanding[0] === 'delivery_address' ? 'the delivery address' : 'delivery or pickup'}.`);
      // Only the no-answer branch is a genuine "didn't understand" signal --
      // when `answer` is set the customer asked a real question and this is
      // just the normal follow-up prompt after answering it, not a miss.
      if (answer) {
        await reply(customer, `${answer} ${await fieldPrompt(outstanding[0], field?.question, order.branch_id)}`);
      } else {
        await reply(customer, await fieldPrompt(outstanding[0], field?.question, order.branch_id), 'field_reprompt');
      }
      return;
    }
    const { rows: reloaded } = await pool.query('select * from "order" where id = $1', [order.id]);
    Object.assign(order, reloaded[0]);
  }

  const stillOutstanding = await missingFulfilmentFields(order);
  if (stillOutstanding.length) {
    const fields = await loadBotFields();
    const nextField = fields.find((f) => f.key === stillOutstanding[0]);
    await reply(customer, await fieldPrompt(stillOutstanding[0], nextField?.question, order.branch_id));
    return;
  }

  // Only known once fulfilment_type/address are actually decided -- adding
  // this before payment means the customer pays the real delivery cost
  // instead of the business quietly absorbing it. No-op (returns 0) for
  // pickup orders and for any business not on real Chowdeck delivery.
  if (order.fulfilment_type === 'delivery') {
    const deliveryConfig = await getDeliveryConfig();
    if (deliveryConfig.mode === 'own_riders' && !order.delivery_zone_id) {
      // Three states, same null/non-null gate idiom confirm_order's own
      // confirmed_at uses (see schema.sql's comment on the two columns
      // below): a candidate zone awaiting yes/no, "already asked what area
      // this is" awaiting their answer, or neither yet (first pass).
      // Chidera's call, 2026-09-02: a matched zone is never applied
      // silently any more -- always confirmed first -- and a miss asks the
      // customer directly for the area instead of giving straight up to a
      // human. Persisted the moment it's actually confirmed (not
      // re-resolved at dispatch time) so the price the customer is about
      // to pay and the amount the rider is eventually owed both come from
      // the exact same zone row -- see schema.sql's own comment on
      // order.delivery_zone_id.
      if (order.delivery_zone_candidate_id) {
        const confirmQuestion = 'Are they confirming yes, that this is the right delivery area?';
        const confirmedField = botEngine.defineField({
          key: 'area_confirmed',
          label: 'delivery area confirmation',
          type: 'boolean',
          description: describeForExtraction(confirmQuestion, { type: 'boolean' }),
        });
        const confirmed = text === null ? null : await botEngine.extractField(confirmedField, text, { askJson });
        if (confirmed === true) {
          const { rows: zoneRows } = await pool.query('select * from delivery_zone where id = $1', [order.delivery_zone_candidate_id]);
          const zone = zoneRows[0];
          await pool.query(
            `update "order" set delivery_zone_id = $1, delivery_fee = $2, delivery_zone_candidate_id = null where id = $3`,
            [zone.id, zone.customer_fee, order.id]
          );
          order.delivery_zone_id = zone.id;
          order.delivery_fee = Number(zone.customer_fee);
          // Falls through below to total/payment -- confirmed, nothing left to ask.
        } else if (confirmed === false) {
          // Try the rejection itself before falling back to a blind
          // re-ask -- "no, it's Wuse" says both in one message, and
          // resolveZoneForAddress's plain substring match catches that.
          const retry = await resolveZoneForAddress(text, order.branch_id);
          if (retry) {
            await pool.query(`update "order" set delivery_zone_candidate_id = $1 where id = $2`, [retry.id, order.id]);
            order.delivery_zone_candidate_id = retry.id;
            await reply(customer, `Got it, just to confirm, is that delivery to ${retry.name}?`);
            return;
          }
          await pool.query(
            `update "order" set delivery_zone_candidate_id = null, delivery_area_prompted_at = now() where id = $1`,
            [order.id]
          );
          order.delivery_zone_candidate_id = null;
          order.delivery_area_prompted_at = new Date();
          await reply(customer, 'No problem -- please, what area is this delivery for?');
          return;
        } else {
          const { rows: zoneRows } = await pool.query('select name from delivery_zone where id = $1', [order.delivery_zone_candidate_id]);
          await reply(customer, `Just to confirm, is that delivery to ${zoneRows[0]?.name}?`);
          return;
        }
      } else if (!order.delivery_area_prompted_at) {
        const zone = await resolveZoneForAddress(customer.address, order.branch_id);
        if (zone) {
          await pool.query(`update "order" set delivery_zone_candidate_id = $1 where id = $2`, [zone.id, order.id]);
          order.delivery_zone_candidate_id = zone.id;
          await reply(customer, `Just to confirm, is that delivery to ${zone.name}?`);
          return;
        }
        await pool.query(`update "order" set delivery_area_prompted_at = now() where id = $1`, [order.id]);
        order.delivery_area_prompted_at = new Date();
        await reply(customer, 'Please, what area is this delivery for?');
        return;
      } else {
        const zone = text === null ? null : await resolveZoneForAddress(text, order.branch_id);
        if (zone) {
          await pool.query(`update "order" set delivery_zone_candidate_id = $1 where id = $2`, [zone.id, order.id]);
          order.delivery_zone_candidate_id = zone.id;
          await reply(customer, `Just to confirm, is that delivery to ${zone.name}?`);
          return;
        }
        // Never guess a zone (spec B5) -- a wrong one means a wrong price
        // charged to the customer and a wrong amount owed to a rider, both
        // real money. Same handover primitive sendPaymentInstructions
        // already uses when bank details aren't configured.
        await handover(customer, 'Delivery address could not be matched to a delivery zone');
        return;
      }
    } else if (deliveryConfig.mode !== 'own_riders') {
      const deliveryFee = await estimateDeliveryFee(order, customer);
      if (deliveryFee > 0) {
        await pool.query(`update "order" set delivery_fee = $1 where id = $2`, [deliveryFee, order.id]);
        order.delivery_fee = deliveryFee;
      }
    }
  }
  const { total } = await summariseOrder(order);
  await pool.query(`update "order" set total = $1 where id = $2`, [total, order.id]);
  order.total = total;

  await transitionOrder(order, 'confirm_payment');
  await sendPaymentInstructions(customer, order);
}

// Shared by the initial "here's how to pay" and by an order modification
// that lands while still awaiting payment (new total needs a fresh Paystack
// transaction and a re-sent amount, not the stale one from before the
// change).
// Real Paystack integration (payment.js) is deliberately not called here
// any more -- customers consistently preferred just being given the bank
// account number over a "Pay now" link, so payment is bank-transfer +
// manual staff confirmation only now, for every business. Not deleted
// (payment.js/webhook-paystack.js still work as before) in case that
// changes later -- this is a detach, the integration point, not a removal
// of the capability itself.
async function sendPaymentInstructions(customer, order) {
  const { total, deliveryFee } = await summariseOrder(order);
  const invoicePath = await createInvoice(order);
  // PUBLIC_URL is this deployment's own https://<subdomain> -- without it
  // there's no real public URL to send at all (a bare relative path means
  // nothing outside a browser already on this site).
  // A link to the HTML invoice page isn't "the invoice" as far as a
  // customer's concerned -- they expect an actual file. Sent as a real
  // WhatsApp document (Gotenberg renders the same page to PDF on the fly,
  // see routes/documents.js), falling back to a text link only if that
  // send fails, so the invoice info is never just lost.
  let invoiceSent = false;
  if (process.env.PUBLIC_URL) {
    try {
      const invoicePdfUrl = `${process.env.PUBLIC_URL}${invoicePath}/pdf`;
      if (customer.channel === 'instagram') {
        await sendInstagramDocument(recipientFor(customer), invoicePdfUrl);
      } else {
        await sendWhatsAppDocument(recipientFor(customer), invoicePdfUrl, `invoice-${order.reference}.pdf`, `Invoice for order ${order.reference}`);
      }
      await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[invoice PDF] ${invoicePdfUrl}`, trigger: 'invoice_pdf' });
      invoiceSent = true;
    } catch (err) {
      console.error(`Failed to send invoice PDF, falling back to a text link: ${err.message}`);
    }
  }
  // Invoice always comes first, on its own -- it's the compulsory receipt of
  // what's being bought, not a footnote on the payment line. Always followed
  // by bank details now -- see the note above the function.
  const invoiceUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${invoicePath}` : null;
  const invoiceLine = invoiceSent
    ? `Your invoice is attached above.`
    : invoiceUrl
      ? `Here's your invoice: ${invoiceUrl}`
      : `Your invoice for this order is ready.`;
  // Silent up until now -- the customer only agreed to the items total
  // earlier in "confirm order" (delivery fee wasn't known yet then). Stated
  // here so the amount they're about to pay never comes as a surprise.
  const deliveryFeeLine = deliveryFee > 0 ? ` (includes NGN ${deliveryFee} delivery fee)` : '';
  const { rows: biz } = await pool.query('select bank_name, bank_account_number, bank_account_name from business limit 1');
  const b = biz[0] || {};
  const hasBankDetails = b.bank_name && b.bank_account_number && b.bank_account_name;
  const payLine = hasBankDetails
    ? `Please pay NGN ${total}${deliveryFeeLine} to ${b.bank_name}, ${b.bank_account_number}, ${b.bank_account_name}, then send proof of payment here.`
    : `Your total is NGN ${total}${deliveryFeeLine}. Let me get someone to confirm payment details with you.`;
  await reply(customer, `${invoiceLine}\n\n${payLine}`);
  // ackText false -- payLine already told them someone will confirm payment
  // details (see above), same double-ack bug as the others fixed 2026-09-03.
  if (!hasBankDetails) await handover(customer, 'Order ready for payment but no payment method is configured for this business yet', null, false);
}

// A customer nudging the bot while still unpaid ("where's the link", "resend
// it") used to get a hardcoded "use the link I sent above" no matter what
// was actually sent, or if nothing usable ever was -- a real lie if it was
// bank details, or a handover. Re-states whatever is ACTUALLY true right
// now instead of assuming a link exists -- but only the FIRST time. After
// that, repeated nudges get a short acknowledgment, never the full reminder
// again -- five identical reminders in a row is worse than none.

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
function looksLikeBrowseQuestion(text) {
  return typeof text === 'string' && BROWSE_PATTERNS.some((re) => re.test(text.trim()));
}

// Shared by every place that can be asked a broad "what do you have" --
// Instagram has no equivalent of WhatsApp's interactive List Message --
// sendMenuList is a WhatsApp-only Graph API feature, confirmed while
// building the WhatsApp version of this. The system prompt driving `answer`
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
async function resolveGeneralAvailability(customer, isGeneralAvailability, answer, rawText, branchId) {
  const shouldShowMenu = isGeneralAvailability || looksLikeBrowseQuestion(rawText);
  if (!shouldShowMenu) return answer;

  if (customer.channel === 'instagram') {
    // Real menu photo(s), same source and ordering handleCollectInfo's own
    // items-field fallback already uses (position asc), take priority over
    // the plain-text listing -- Chidera's call, 2026-09-03: "instagram main
    // fallback should be a photo of the menus first (there could be more
    // than 1 photo)". imageSenderFor already resolves to
    // sendInstagramDocument for this channel, so no new send plumbing
    // needed, just reusing what's there.
    if (process.env.PUBLIC_URL) {
      const { rows: photos } = await pool.query('select id from menu_photo order by position');
      if (photos.length) {
        const sendImage = await imageSenderFor(customer);
        let sentAny = false;
        for (const photo of photos) {
          try {
            await sendImage(recipientFor(customer), `${process.env.PUBLIC_URL}/documents/menu-photo/${photo.id}`);
            sentAny = true;
          } catch (err) {
            console.error('Failed to forward menu photo:', err.message);
          }
        }
        if (sentAny) {
          await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[${photos.length} menu photo(s) sent]`, trigger: 'menu_shown' });
          return answer;
        }
      }
    }
    // No menu photos configured (or the send failed outright) -- fall back
    // to a real text listing rather than nothing, same "something beats
    // silence" reasoning as before this photo path existed.
    const menuText = await formatMenuAsText(branchId);
    if (!menuText) return answer;
    return answer ? `${answer}\n\n${menuText}` : menuText;
  }
  if (process.env.EBOS_SANDBOX === '1') return answer;

  const shown = await sendMenuList(recipientFor(customer), "Here's our menu, tap below to see everything we have.", branchId).catch((err) => {
    console.error('sendMenuList failed:', err.message);
    return false;
  });
  // sendMenuList sends straight via the Graph API, not through reply() --
  // logged here so it actually shows up in the conversation history.
  if (shown) await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body: '[interactive menu button sent]', trigger: 'menu_shown' });
  // Whether the button sent or not, `answer` is returned unchanged here --
  // it's either null (a pure browse question, nothing else to say) or a
  // short factual clause ("no, we don't have that") that's genuinely worth
  // saying on its own, alongside the button when it sent, and by itself if
  // it didn't. Never falls back to writing the full item list as text on
  // failure -- that's exactly the wall-of-text problem this button exists
  // to avoid, worse the bigger the menu. A short generic nudge instead.
  if (shown || answer) return answer;
  return 'Sorry, having a little trouble showing the menu right now. Let me know what you would like, or ask about a specific item.';
}

// Wraps answerOrderQuestion so every mid-order call site gets the above for
// free. Returns a plain string|null exactly like answerOrderQuestion used
// to, so every existing `if (answer) {...}` call site needed no other
// changes.
async function answerOrThenShowMenu(customer, order, text, statusLine) {
  const { answer, isGeneralAvailability } = await answerOrderQuestion(order, text, statusLine);
  return resolveGeneralAvailability(customer, isGeneralAvailability, answer, text, order.branch_id);
}

async function handleWaitingOnPayment(customer, order, text) {
  const answer = await answerOrThenShowMenu(customer, order, text, `Payment is still pending, bank transfer only.`);
  if (answer) {
    await reply(customer, answer, 'order_question_answer');
    return;
  }

  if (order.payment_reminder_sent_at) {
    await reply(customer, `Still waiting on your payment, I'll confirm as soon as it comes through.`, 'payment_wait_ack');
    return;
  }
  await pool.query(`update "order" set payment_reminder_sent_at = now() where id = $1`, [order.id]);

  const { rows: biz } = await pool.query('select bank_name, bank_account_number, bank_account_name from business limit 1');
  const b = biz[0] || {};
  if (b.bank_name && b.bank_account_number && b.bank_account_name) {
    await reply(
      customer,
      `Pay NGN ${order.total} to ${b.bank_name}, ${b.bank_account_number}, ${b.bank_account_name}, then send proof of payment here.`,
      'payment_reminder'
    );
    return;
  }
  await reply(customer, `Let me get someone to confirm payment details with you.`, 'payment_reminder');
  await handover(customer, 'Customer waiting on payment but no payment link/bank details are available', null, false);
}

// Reviewing an order isn't a one-shot thing -- "add a chapman" or "remove
// the suya wrap" can come at any point before payment, and recalculates the
// total live. Once payment_status is actually confirmed/accepted, removing
// or changing what's already paid for is refused (that money's real,
// already moving), but adding more is still fine -- it just means extra to
// collect, flagged to staff rather than assumed handled.
// The real DB mutation behind an "add X" / "remove Y" / "make it 3 Z"
// request -- shared between handleOrderModification (confirm_order onward,
// its own "reply yes to confirm" messaging) and the earlier collect_info
// stage (handleCollectInfo, a different, softer acknowledgment since the
// order hasn't reached that gate yet). Same mutation either way, just
// different words wrapped around it per stage.
async function applyOrderModifications(order, mods, { allowRemovals }) {
  const { rows: existingItems } = await pool.query('select id, product_id, quantity from order_item where order_id = $1', [order.id]);
  let addedValue = 0;

  for (const item of mods.adds) {
    const existing = existingItems.find((e) => e.product_id === item.productId);
    if (existing) {
      await pool.query('update order_item set quantity = quantity + $1 where id = $2', [item.quantity, existing.id]);
    } else {
      await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4)', [order.id, item.productId, item.quantity, item.price]);
    }
    addedValue += item.quantity * Number(item.price);
  }

  if (allowRemovals) {
    for (const item of mods.removes) {
      await pool.query('delete from order_item where order_id = $1 and product_id = $2', [order.id, item.productId]);
    }
    for (const item of mods.sets) {
      await pool.query('update order_item set quantity = $1 where order_id = $2 and product_id = $3', [item.quantity, order.id, item.productId]);
    }
  }

  const { itemLines, total } = await summariseOrder(order);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
  return { itemLines, total, addedValue };
}

async function handleOrderModification(customer, order, mods) {
  const paid = order.payment_status === 'confirmed' || order.payment_status === 'accepted';

  if (paid && (mods.removes.length || mods.sets.length)) {
    await reply(customer, `Your order's already paid for, so I can't remove or change what's in it now, but I can add more if you'd like.`);
    if (!mods.adds.length) return;
  }

  const { itemLines, total, addedValue } = await applyOrderModifications(order, mods, { allowRemovals: !paid });
  const summary = itemLines.join('\n');

  if (paid) {
    await reply(customer, `Got it, added that on. Your order:\n${summary}\nNew total: NGN ${total} (NGN ${addedValue} more than what's already paid). Our team will confirm the extra payment with you.`);
    await handover(customer, 'Customer added items to an already-paid order, extra payment needs confirming', null, false);
    return;
  }

  // Any edit before payment needs a fresh yes -- whether still picking
  // items (confirm_order) or already past that gate with payment
  // instructions already sent for the old total (confirm_payment). Only the
  // yes/no gate resets here; fulfilment (delivery vs pickup, address) is
  // never touched, so re-confirming never re-asks something already
  // answered. engine_state itself is deliberately left alone -- if it's
  // already confirm_payment, handleReconfirmAfterEdit re-sends payment
  // instructions directly on the next yes, it never routes back through
  // handleCollectFulfilment (whose own transitionOrder(..., 'confirm_payment')
  // would be an illegal confirm_payment -> confirm_payment move).
  await pool.query(`update "order" set confirmed_at = null where id = $1`, [order.id]);
  order.confirmed_at = null;
  await sendConfirmButtons(customer, `Got it, your order:\n${summary}\nNew total: NGN ${total}.`, 'order_confirm_asked');
}

// Switching delivery<->pickup after it was already set (dispatch() only
// calls this once payment isn't done yet -- see the rule at the top of
// dispatch). delivery_fee always resets to 0 first: switching to pickup
// means no fee at all, and switching to delivery means the old fee (quoted
// for a stale state) is stale and has to be re-quoted, not reused.
async function handleFulfilmentChange(customer, order, newType) {
  await pool.query(`update "order" set fulfilment_type = $1, delivery_fee = 0 where id = $2`, [newType, order.id]);
  order.fulfilment_type = newType;
  order.delivery_fee = 0;

  if (order.engine_state === 'confirm_order') {
    // Payment instructions were never sent yet -- handleCollectFulfilment
    // already does everything a fresh answer would (ask for an address if
    // one's still needed, quote the real delivery fee, transition, and send
    // payment instructions once nothing's missing), so just re-run it.
    await reply(customer, `Got it, switching to ${newType}.`);
    await handleCollectFulfilment(customer, order, null);
    return;
  }

  // confirm_payment -- payment instructions already went out once for the
  // old fulfilment/total, so this has to redo the fee estimate and re-send
  // fresh instructions, not just silently update a number nobody sees.
  if (newType === 'delivery' && !customer.address) {
    await reply(customer, `Got it, switching to delivery. What's the delivery address?`);
    await handleCollectFulfilment(customer, order, null);
    return;
  }
  if (newType === 'delivery') {
    const deliveryFee = await estimateDeliveryFee(order, customer);
    if (deliveryFee > 0) {
      await pool.query(`update "order" set delivery_fee = $1 where id = $2`, [deliveryFee, order.id]);
      order.delivery_fee = deliveryFee;
    }
  }
  const { total } = await summariseOrder(order);
  await pool.query(`update "order" set total = $1 where id = $2`, [total, order.id]);
  order.total = total;
  await reply(customer, `Got it, switched to ${newType}. New total NGN ${total}.`);
  await sendPaymentInstructions(customer, order);
}

// Deterministic (no AI call), not fuzzy -- this decides whether to say
// NOTHING at all, which is exactly the kind of decision that must never be
// a guess. Only matches if EVERY line of the message is purely one of
// these, word-for-word -- "ok but when's it coming" has a real question
// riding along and must not be silenced just because it starts with "ok".
// Deliberately just a word list, not an AI call -- this must never depend
// on Claude being reachable at all (found live: an Anthropic outage broke
// even the cheapest, simplest case when this ran through an AI check
// first). The tradeoff is real and known: it only catches phrasing
// actually in this list, so a genuinely novel way of saying "we're done
// here" can still slip through and get a reply. Grow this list as real
// cases turn up rather than reaching for an AI classifier -- a closing
// remark should never be slower or less reliable than the rest of the bot.
const PURE_ACK =
  /^(ok(ay)?|yh|yeah|yep|yup|alright|aight|sure|got ?it|noted|fine|k|cool|nice|sounds good|perfect|great|awesome|bet|gotcha|understood|will do|no problem|np|good|bye|goodbye|see you|take care|have a good (day|night|one)|all good|that works|that'?s fine)[.!]*$/i;
const PURE_THANKS = /^(thanks?( you)?|tysm|thank ?u|appreciate ?it|much appreciated)[.!]*$/i;
// A polite decline of whatever was just offered/asked ("anything else?" ->
// "no thank you") -- NOT the same as PURE_THANKS (that regex is anchored
// and requires the whole line to start with "thanks"/"thank you", so a
// leading "no" already fails it -- found live, 2026-09-03: "no thank you"
// matched neither PURE_THANKS nor PURE_ACK, so it fell all the way through
// to full AI dispatch instead of getting a simple acknowledgment). Always
// gets a short "Okay!" -- never silence (declining deserves some
// response) and never the 'thanks' branch's "You're welcome!" (nonsensical
// for a decline).
const PURE_DECLINE = /^(no,? ?thanks?( you)?|nah,? ?(i'?m good|thanks?)|i'?m good( thanks?)?|not (right )?now|no,? ?i'?m (good|fine)|no need)[.!]*$/i;

// null = not applicable (some part of the message needs a real answer),
// 'ack' = every line was a pure acknowledgment, reply with nothing,
// 'thanks' = at least one line was a thank-you (and the rest, if any, were
// pure acks too) -- a plain "you're welcome" back, not silence.
// 'decline' = a polite "no" to whatever was just offered -- a plain "Okay!"
// back, not silence, not "you're welcome".
function classifyPureAck(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  let sawThanks = false;
  let sawDecline = false;
  for (const line of lines) {
    if (PURE_THANKS.test(line)) {
      sawThanks = true;
      continue;
    }
    if (PURE_DECLINE.test(line)) {
      sawDecline = true;
      continue;
    }
    if (!PURE_ACK.test(line)) return null;
  }
  if (sawDecline) return 'decline';
  return sawThanks ? 'thanks' : 'ack';
}

// Real bug, found live 2026-09-03: this used to say "Paid and being
// prepared for delivery" no matter what order.status actually was --
// including for an order already out with a rider. A customer asking "how
// long" got told the truth from days ago, not the truth right now. Every
// stage own_riders actually moves through (orderStages.js's own pipeline
// comment): preparation -> ready -> delivery/in_transit -> completed.
function fulfilmentStatusLine(order) {
  if (order.status === 'ready') {
    return order.fulfilment_type === 'delivery' ? `Paid and ready, waiting on a rider to pick it up.` : `Paid and ready for pickup whenever you are.`;
  }
  if (order.status === 'delivery' || order.status === 'in_transit') {
    return `Paid and on its way to you with the rider now.`;
  }
  // 'preparation' (the normal case) and any other/unexpected status this
  // function still gets called for -- same honest default it always had.
  return order.fulfilment_type === 'delivery' ? `Paid and being prepared for delivery.` : `Paid and being prepared for pickup.`;
}

// Same real-question-first principle as handleWaitingOnPayment -- already
// paid and being prepared/delivered doesn't mean the customer stopped
// having things to ask ("when's it coming", "what did I order again"). But
// once the order's actually done being processed, a plain "ok"/"alright"
// needs no reply at all -- repeating "already paid and being prepared"
// after every acknowledgment reads as not listening, not as helpful.
async function handleFulfilmentStageMessage(customer, order, text) {
  // Pure ack/thanks is already handled once, universally, at the top of
  // handlePendingBatch -- text never reaches here if it was one.

  // Repeated frustration about the wait is a real complaint, not a status
  // question -- answering it with delivery/pickup facts misses that they're
  // upset, not just asking.
  if (await detectDelayComplaint(text)) {
    await reply(customer, `I'm sorry about this, let me check, I'll get back to you shortly.`, 'delay_complaint_ack');
    await handover(customer, 'Customer complained about order delay/wait time', null, false);
    return;
  }

  const statusLine = fulfilmentStatusLine(order);
  const answer = await answerOrThenShowMenu(customer, order, text, statusLine);
  if (answer) {
    await reply(customer, answer, 'order_question_answer');
    return;
  }
  await reply(customer, `${statusLine} Let me know if you'd like to add anything else.`);
}

// Switching delivery<->pickup after payment is real (paid expecting to pick
// up, then can't make it) -- but real money/logistics are already in motion
// by this point (a rider may already be dispatched for a delivery order, or
// a real delivery fee may now need collecting that was never charged for a
// pickup order). The bot records the change and acknowledges it properly --
// never silence, never pretending nothing happened -- but always hands the
// actual logistics off to a person rather than silently re-booking a rider
// or charging more on its own.
async function handlePostPaymentFulfilmentChange(customer, order, newType) {
  const previousType = order.fulfilment_type;
  await pool.query(`update "order" set fulfilment_type = $1 where id = $2`, [newType, order.id]);
  order.fulfilment_type = newType;

  // Switching TO pickup needs nothing a human has to arrange -- no rider,
  // no fee, just where to go -- so the bot answers it directly with the
  // real address instead of handing it to staff, same info/wording as the
  // pickup line completePayment already sends. Switching the other way
  // (to delivery) still genuinely needs a person (a rider to book, a real
  // delivery fee to work out), so that keeps the handover below.
  if (newType === 'pickup') {
    const { rows: bizRows } = await pool.query('select address, phone_number from business limit 1');
    const biz = bizRows[0] || {};
    const branchRows = order.branch_id ? (await pool.query('select address, phone_number from branch where id = $1', [order.branch_id])).rows : [];
    const b = branchRows[0] || {};
    await reply(
      customer,
      `Okay, this is the pickup address: ${b.address || biz.address || 'our location'}. When your order is ready I'll let you know so you can pick it up.`
    );
    return;
  }

  await reply(customer, `Got it, you'd like ${newType} instead of ${previousType}. Your order's already paid, so let me get someone to sort that out for you.`);
  await handover(customer, `Customer wants to switch an already-paid order from ${previousType} to ${newType}`, null, false);
}

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

// Own-riders delivery only -- called from routes/rider.js's own
// /offers/:id/accept, right after a rider wins the atomic claim (spec B6:
// "customer receives tracking link and a 4 digit delivery code" happens at
// that moment, not later). Same exported-notification shape as
// notifyReadyForPickup above, called from outside this file's own
// request/reply loop for the same reason: the event that triggers it
// (a rider accepting) doesn't originate from the customer's next message.
export async function notifyDeliveryAssigned(orderId, { riderName, trackingPath, deliveryCode }) {
  const { rows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = rows[0];
  if (!order) throw new Error('Order not found.');
  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];
  if (!customer) throw new Error('Customer not found.');
  // Never a bare relative path in a WhatsApp message -- there's no "current
  // page" for a chat to resolve it against, so this only goes out at all
  // once PUBLIC_URL is actually configured (same gating every other
  // outbound link in this codebase, e.g. the invoice link, already uses).
  const trackingLine = trackingPath && process.env.PUBLIC_URL ? ` Track your order here: ${process.env.PUBLIC_URL}${trackingPath}.` : '';
  await reply(
    customer,
    `Your order is on its way with ${riderName}.${trackingLine} Give them this code when they arrive: ${deliveryCode}`,
    'delivery_assigned'
  );
}

// Own_riders delivery only. Called the instant a delivery order's offer
// broadcasts (engine/delivery-dispatch.js) -- a customer whose order is
// out for delivery gets a real, working tracking link from THIS moment,
// not only once a rider happens to accept (Chidera's own Chowdeck-style
// stage tracker: "waiting for rider to accept order" is itself a real,
// trackable stage, not a gap before tracking starts).
export async function notifyDeliverySearching(orderId, trackingPath) {
  const { rows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = rows[0];
  if (!order) throw new Error('Order not found.');
  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];
  if (!customer) throw new Error('Customer not found.');
  if (!process.env.PUBLIC_URL) return; // same gating as notifyDeliveryAssigned -- no link worth sending without it
  await reply(
    customer,
    `Your order is ready and we're finding you a rider. Track it here: ${process.env.PUBLIC_URL}${trackingPath}`,
    'delivery_searching'
  );
}

// Called from the Paystack webhook once a payment is verified -- not part
// of handleInboundMessage's request/reply loop, since payment confirmation
// arrives from Paystack, not from the customer's next WhatsApp message.
export async function completePayment(orderId) {
  const { rows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = rows[0];
  if (!order || order.engine_state !== 'confirm_payment') return;

  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];

  await transitionOrder(order, 'payment_acceptance');
  // This function IS "payment confirmed" -- whether that's Paystack's own
  // webhook (cryptographically verified, nothing left for a person to
  // check) or staff's own "Confirm payment received" click after looking
  // at a submitted proof. Either way, the kanban `status` jumps straight
  // to 'preparation' here, never sitting in 'confirmation' a moment
  // longer than it takes to actually confirm it (Chidera's own words:
  // "when receipt is confirmed immediately take them to preparing").
  // Fulfilment progress past this (ready, in_transit, completed) is
  // staff's own call as they physically prepare/dispatch it, not
  // something the bot decides -- payment succeeding is not the same fact
  // as food being ready.
  await pool.query(`update "order" set status = 'preparation' where id = $1`, [order.id]);
  await createReceipt(order);
  await transitionOrder(order, 'fulfilment');

  if (order.fulfilment_type === 'delivery') {
    const delivery = await createDelivery(order, customer);
    const riderLine = delivery.riderName ? ` Your rider is ${delivery.riderName}.` : '';
    // Chowdeck doesn't name a rider at booking time (one isn't assigned
    // yet) -- riderLine above will stay empty for a real Chowdeck delivery,
    // but the tracking link is available immediately and is the thing
    // actually worth sending.
    const trackingLine = delivery.trackingUrl ? ` Track it here: ${delivery.trackingUrl}` : '';
    await reply(customer, `Payment received. Your order is being prepared for delivery.${riderLine}${trackingLine}`);
  } else {
    const { rows: bizRows } = await pool.query('select address, phone_number from business limit 1');
    const biz = bizRows[0] || {};
    const branchRows = order.branch_id ? (await pool.query('select address, phone_number from branch where id = $1', [order.branch_id])).rows : [];
    const b = branchRows[0] || {};
    await reply(
      customer,
      `Payment received, I'll let you know when to pick up your order. You'll pick up at ${b.address || biz.address || 'our location'} and call ${b.phone_number || biz.phone_number || 'us'} when you arrive.`
    );
  }

  // Deliberately NOT transitioning to 'completed' here -- payment clearing
  // is not the same fact as the order actually being done. Staying at
  // 'fulfilment' keeps the order open (see getOpenOrder) so a customer can
  // still message in to add something while it's being prepared/delivered.
  // Staff marking it completed on the dashboard (routes/api.js) is what
  // actually closes it.
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
export const DEBOUNCE_MS = 6_000;
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

function scheduleDebouncedProcessing(customer) {
  const existing = pendingTimers.get(customer.id);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(customer.id);
    processPendingMessages(customer.id).catch(async (err) => {
      console.error('Debounced message processing failed:', err);
      // Whatever broke (a payment provider down, an unexpected bug, a
      // dependency error), the customer must never be left with pure
      // silence -- found live: a Paystack failure mid-flow left a customer
      // hanging after "switching to pickup" with nothing further, ever,
      // until they happened to message again. Best-effort and deliberately
      // swallows its own failure, so a second error here can't cascade.
      try {
        // Still lets the bot retry normally on every later message (the
        // usual handled_by='staff'-but-no-real-human-yet gate in
        // handlePendingBatch already does that) -- this only decides what
        // the CUSTOMER sees when a retry fails again. First failure: the
        // one-time ack below. Every failure after that, while still the
        // same unresolved outage and no staff reply yet: stay silent to
        // the customer (no repeat "someone will be with you shortly" spam)
        // but still relay to staff, so a message sent during a still-broken
        // retry isn't lost. The moment a retry actually succeeds, this
        // catch never runs and the customer gets a normal reply again.
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
          for (const to of recipients) {
            await botEngine.sendMessage({
              trigger: 'staff_handoff_intro',
              to,
              text: `${displayNameFor(customer)} sent another message while still erroring: ${lastMsg[0]?.body || '(no text)'}`,
              whatsappSend: sendWhatsApp,
            });
          }
        } else {
          // First failure -- one plain message, not two -- this used to
          // send its own "having trouble" line here and then handover()'s
          // default "let me confirm this properly" right after, which read
          // as a stitched-together non-sequitur to the customer (found
          // live, 2026-09-02: "let me confirm this properly" makes no
          // sense right after being told something broke).
          await handover(customer, SYSTEM_ERROR_HANDOVER_REASON, null, 'Hello, please someone will be with you shortly.');
        }
      } catch (innerErr) {
        console.error('Failed to notify customer after a processing error:', innerErr);
      }
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

// Hands control back to the bot -- either a staff member explicitly clicked
// "Return to bot" (routes/api.js) or 30 minutes have passed with no further
// staff reply (handlePendingBatch below). Either way, the customer may have
// told the human real order information (what they want, delivery vs
// pickup, confirming yes) purely in conversation, with nothing reflected in
// the order record itself -- so this doesn't just flip a flag and wait for
// the NEXT message, it replays everything the customer said since the
// handover (or since staff's own last reply, if they sent more than one --
// see the boundary calculation below) through the exact same extraction
// pipeline a live message
// would use, picking up from the real state instead of re-asking from
// scratch.
//
// One replay pass only advances the state machine one step (one
// extraction stage per call) -- if the customer actually got through
// several steps while a human had the thread (item, branch, confirm,
// fulfilment), a single pass would only catch the first of them. So this
// loops, replaying the SAME combined text, until the order's engine_state
// stops moving -- each stage's extraction only pulls what that stage is
// actually asking for, so replaying the same text again is safe, not
// double-counted -- capped so a transcript that doesn't map to anything
// useful can't loop forever.
export async function resumeBotControl(customerId) {
  const { rows } = await pool.query('select * from customers where id = $1', [customerId]);
  const customer = rows[0];
  if (!customer) return;

  // handover_at is set once, at the ORIGINAL handover moment -- if staff
  // replied more than once since then, using it alone replays every
  // customer message all the way back to the first handover, including
  // ones staff already answered. Found live, 2026-09-03: staff said "let
  // me check that for you", then returning control replayed an OLDER,
  // already-addressed customer message and the bot generated its own
  // near-identical "let me check on that for you" on top of it. The real
  // boundary is whichever is later: the handover itself, or staff's own
  // most recent reply -- "only respond if the customer had the last word,
  // not staff" (Chidera's own framing).
  const { rows: lastStaffRows } = await pool.query(
    `select max(created_at) as at from message where customer_id = $1 and sender = 'staff'`,
    [customerId]
  );
  const handoverAt = customer.handover_at || customer.created_at;
  const lastStaffAt = lastStaffRows[0]?.at;
  const boundary = lastStaffAt && new Date(lastStaffAt) > new Date(handoverAt) ? lastStaffAt : handoverAt;
  await pool.query(`update customers set handled_by = 'bot', handled_by_staff_id = null, app_handled_at = null, handover_reason = null, handover_at = null where id = $1`, [customerId]);
  customer.handled_by = 'bot';
  customer.handled_by_staff_id = null;
  customer.app_handled_at = null;

  const { rows: msgs } = await pool.query(
    `select body from message where customer_id = $1 and direction = 'inbound' and created_at > $2 order by created_at`,
    [customerId, boundary]
  );
  if (!msgs.length) return; // nothing the customer said while staff had it -- nothing to catch up on
  const text = msgs.map((m) => m.body).join('\n');

  let previousMarker = null;
  for (let i = 0; i < 6; i++) {
    const order = await getOpenOrder(customer.id);
    const marker = order ? `${order.id}:${order.engine_state}` : 'no-order';
    if (marker === previousMarker) break;
    previousMarker = marker;
    await handlePendingBatch(customer, text);
    // The catch-up itself might raise a fresh handover (a real complaint
    // buried in that transcript, say) -- stop immediately rather than keep
    // talking over one it just started.
    const { rows: fresh } = await pool.query('select handled_by from customers where id = $1', [customer.id]);
    if (fresh[0]?.handled_by === 'staff') return;
  }
}

// Dine-in add-on (EBOS-Addon-Schema-Dine-In.md), Stage 2. A guest's QR scan
// always sends exactly "Menu Table {label}" (routes/dinein.js's
// qrDataUrlFor) -- deterministic, no AI call. Returns true when this
// handled the message (a real scan, or the answer to "which table"),
// false to let normal routing continue untouched. Off entirely when the
// add-on isn't enabled -- one cheap query, then nothing else runs.
async function getDineinConfig() {
  const { rows } = await pool.query('select * from dinein_config limit 1');
  return rows[0] || null;
}

async function sendDineinWelcome(customer, table) {
  const dinein = await getDineinConfig();
  const { rows: bizRows } = await pool.query('select name, logo_data_url from business limit 1');
  const biz = bizRows[0];
  const body = `Welcome to ${biz?.name || 'us'}! You're at Table ${table.label}. What would you like to do?`;
  const buttons = [
    { id: 'dinein_menu', title: 'See the menu' },
    { id: 'dinein_waiter', title: 'Call a waiter' },
    { id: 'dinein_specials', title: "Today's specials" },
  ];
  const headerImage = dinein?.welcome_image_url || biz?.logo_data_url || null;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppButtons(recipientFor(customer), body, buttons, credentials, headerImage);
  await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body, trigger: 'dinein_welcome' });
}

async function handleDineinScan(customer, text) {
  const dinein = await getDineinConfig();
  if (!dinein?.enabled) return false;

  const scanMatch = /^menu\s+table\s+(.+)$/i.exec(text.trim());
  let label = scanMatch?.[1]?.trim();

  if (!label) {
    // Not a fresh scan -- only worth a second look if the LAST thing the
    // bot said was "which table are you at" (spec 2.2: ask once, then
    // carry on). Anything else falls through to normal routing untouched.
    const { rows } = await pool.query(
      `select 1 from message where customer_id = $1 and trigger = 'dinein_ask_table' and created_at > now() - interval '10 minutes'
       order by created_at desc limit 1`,
      [customer.id]
    );
    if (!rows.length) return false;
    label = text.trim();
  }

  const { rows: tableRows } = await pool.query(
    `select * from restaurant_table where branch_id = $1 and lower(label) = lower($2) and status = 'active'`,
    [customer.branch_id, label]
  );
  const table = tableRows[0];
  if (!table) {
    await reply(customer, 'Please, what table are you at?', 'dinein_ask_table');
    return true;
  }

  // Most recent open session for this table, or a fresh one -- per spec
  // 6.4, a second party on the same table later is a new session, but
  // this guest re-scanning (or WhatsApp redelivering) mid-meal must not
  // open a duplicate (table_session_one_open_idx enforces this at the DB
  // level too, this is just avoiding hitting that constraint at all).
  const { rows: sessionRows } = await pool.query(`select * from table_session where table_id = $1 and closed_at is null`, [table.id]);
  if (!sessionRows.length) {
    await pool.query(`insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3)`, [table.id, table.branch_id, customer.id]);
  }

  await sendDineinWelcome(customer, table);
  return true;
}

// The 3 welcome-card buttons (see sendDineinWelcome) -- resolved by the
// customer's own most recent open table_session, not re-parsed from
// anything in the tap itself (a button tap carries no table info of its
// own, unlike the scan message).
async function currentDineinSession(customer) {
  const { rows } = await pool.query(
    `select ts.*, rt.label as table_label, rt.qr_token
     from table_session ts join restaurant_table rt on rt.id = ts.table_id
     where ts.customer_id = $1 and ts.closed_at is null
     order by ts.opened_at desc limit 1`,
    [customer.id]
  );
  return rows[0] || null;
}

export async function handleDineinButtonTap({ phoneNumber, channelId, buttonId, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: `[tapped: ${buttonId}]` , processed: true });

  // Feedback (Stage 7) happens on a CLOSED table_session -- checked first,
  // before the open-session lookup below (which would otherwise reject it
  // with "please scan again", the wrong message for a guest who already
  // left).
  if (buttonId.startsWith('dinein_feedback_')) {
    await handleDineinFeedbackTap(customer, buttonId);
    return;
  }

  const session = await currentDineinSession(customer);
  if (!session) {
    await reply(customer, 'Please scan your table\'s QR code to get started.', 'dinein_no_session');
    return;
  }

  if (buttonId === 'dinein_waiter') {
    await pool.query('insert into waiter_call (session_id, table_id) values ($1, $2)', [session.id, session.table_id]);
    await reply(customer, "Someone's on the way!", 'dinein_waiter_called');
    return;
  }

  // 'dinein_specials' opens the same live menu page, pre-scrolled to the
  // specials category (?cat=, same mechanism as the general greeting's
  // "Special offers" button) when the catalogue actually has one -- no
  // longer identical to 'dinein_menu' now that specials are a real,
  // findable category (findSpecialsCategory) rather than an unmodeled
  // concept.
  if (!process.env.PUBLIC_URL) {
    await reply(customer, 'Sorry, the menu link is not set up right now -- please ask a waiter.', 'dinein_menu_unavailable');
    return;
  }
  const specialsCategory = buttonId === 'dinein_specials' ? await findSpecialsCategory(customer.branch_id) : null;
  const url = `${process.env.PUBLIC_URL}/t/${session.qr_token}${specialsCategory ? `?cat=${encodeURIComponent(specialsCategory)}` : ''}`;
  const bodyText = buttonId === 'dinein_specials' ? `Here's today's specials for Table ${session.table_label}.` : `Here's our menu for Table ${session.table_label}.`;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), bodyText, buttonId === 'dinein_specials' ? 'See specials' : 'View menu', url, credentials);
  await logMessage({ customerId: customer.id, direction: 'outbound', channel, sender: 'bot', body: `[menu link sent: ${url}]`, trigger: 'dinein_menu_sent' });
}

// Dine-in add-on, Stage 7: feedback. Called on a periodic sweep
// (server.js), same shape as closeStaleOrders/sweepOfferEscalation --
// finds every closed table_session past its feedback_delay_minutes with
// nothing sent yet, and sends one simple 3-button rating request per
// session. Never fires for an auto-closed session (spec 9: "you do not
// know whether they had a good night or simply left") or when the add-on
// or feedback specifically is switched off.
export async function sweepDineinFeedback() {
  const dinein = await getDineinConfig();
  if (!dinein?.enabled || !dinein.feedback_enabled) return;
  const { rows: due } = await pool.query(
    `select ts.*, rt.label as table_label, c.name as customer_name, c.phone_number, c.channel, c.channel_id, c.branch_id as customer_branch_id
     from table_session ts
     join restaurant_table rt on rt.id = ts.table_id
     join customers c on c.id = ts.customer_id
     where ts.closed_at is not null and ts.closed_by != 'auto' and ts.feedback_state = 'none'
       and ts.closed_at <= now() - make_interval(mins => $1)`,
    [dinein.feedback_delay_minutes]
  );
  for (const session of due) {
    const { rows: bizRows } = await pool.query('select name from business limit 1');
    const name = session.customer_name ? `Hi ${session.customer_name}, ` : 'Hi, ';
    const body = `${name}thank you for coming to ${bizRows[0]?.name || 'us'} tonight. How was it?`;
    const buttons = [
      { id: 'dinein_feedback_good', title: 'Good' },
      { id: 'dinein_feedback_alright', title: 'Alright' },
      { id: 'dinein_feedback_bad', title: 'Not good' },
    ];
    const customer = { id: session.customer_id, channel: session.channel, channel_id: session.channel_id, phone_number: session.phone_number, branch_id: session.customer_branch_id };
    try {
      const credentials = await getWhatsAppCredentials(customer.branch_id);
      await sendWhatsAppButtons(recipientFor(customer), body, buttons, credentials);
      await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body, trigger: 'dinein_feedback_ask' });
      await pool.query(`update table_session set feedback_state = 'sent' where id = $1`, [session.id]);
    } catch (err) {
      console.error(`Dine-in feedback send failed for session ${session.id}:`, err.message);
    }
  }
}

async function handleDineinFeedbackTap(customer, buttonId) {
  const { rows } = await pool.query(
    `select ts.*, rt.label as table_label from table_session ts join restaurant_table rt on rt.id = ts.table_id
     where ts.customer_id = $1 and ts.feedback_state = 'sent' order by ts.closed_at desc limit 1`,
    [customer.id]
  );
  const session = rows[0];
  if (!session) return false;

  const score = buttonId === 'dinein_feedback_good' ? 'good' : buttonId === 'dinein_feedback_alright' ? 'alright' : 'bad';
  await pool.query(
    `insert into feedback (session_id, branch_id, customer_id, score) values ($1, $2, $3, $4)`,
    [session.id, session.branch_id, customer.id, score]
  );
  await pool.query(`update table_session set feedback_state = 'answered' where id = $1`, [session.id]);

  if (score === 'good') {
    const dinein = await getDineinConfig();
    const reviewLine = dinein?.review_link ? ` We'd really appreciate a review here: ${dinein.review_link}` : '';
    await reply(customer, `So glad to hear it! Thank you.${reviewLine}`, 'dinein_feedback_good_ack');
    return true;
  }
  // alright/bad both ask what could be better -- the answer is captured as
  // a free-text reply, matched the same "was the last bot message this
  // exact trigger" way handleDineinScan's own "which table" follow-up is.
  const ask = score === 'bad' ? "I'm sorry to hear that. What went wrong?" : 'Thank you for letting us know. What would have made it better?';
  await reply(customer, ask, 'dinein_feedback_followup');
  if (score === 'bad') {
    // Spec 8.3: "the entire commercial argument for this capability" --
    // into the queue immediately, not after the comment comes back, since
    // a guest who doesn't answer the follow-up must still surface.
    const { rows: orderRows } = await pool.query(
      `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id
       join "order" o on o.id = oi.order_id where o.session_id = $1`,
      [session.id]
    );
    const orderedLine = orderRows.length ? ` They ordered: ${orderRows.map((r) => `${r.quantity}x ${r.name}`).join(', ')}.` : '';
    await handover(customer, `Table ${session.table_label} left "Not good" feedback after dine-in.${orderedLine}`, null, false);
  }
  return true;
}

async function handlePendingBatch(customer, text) {
  if (await handleDineinScan(customer, text)) return;
  // The free-text answer to "what went wrong / what would have made it
  // better" (see handleDineinFeedbackTap) -- logged onto the feedback row
  // that's still open for this customer, not treated as a new order/enquiry.
  {
    const { rows } = await pool.query(
      `select 1 from message where customer_id = $1 and trigger = 'dinein_feedback_followup' and created_at > now() - interval '30 minutes'
       order by created_at desc limit 1`,
      [customer.id]
    );
    if (rows.length) {
      const { rows: fb } = await pool.query(
        `select id from feedback where customer_id = $1 and comment is null order by created_at desc limit 1`,
        [customer.id]
      );
      if (fb.length) {
        await pool.query(`update feedback set comment = $1 where id = $2`, [text.trim(), fb[0].id]);
        await reply(customer, 'Thank you, noted.', 'dinein_feedback_comment_ack');
        return;
      }
    }
  }
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
    const openOrder = await getOpenOrder(customer.id);
    if (!openOrder) return;
  } else if (ackType === 'thanks') {
    await reply(customer, `You're welcome!`, 'thanks_ack');
    return;
  } else if (ackType === 'decline') {
    await reply(customer, `Okay!`, 'decline_ack');
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

  const order = await getOpenOrder(customer.id);

  if (order) {
    if (await detectWantsHuman(text)) {
      await handover(customer, 'Customer asked for a person');
      return;
    }
    await dispatch(customer, order, text);
    return;
  }

  const { intent, wantsHuman } = await classifyIntent(text);
  if (wantsHuman) {
    await handover(customer, 'Customer asked for a person');
    return;
  }
  if (intent === 'complaint') {
    await handover(customer, 'Customer message classified as a complaint');
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
    if (await recentlyCompletedOrder(customer.id)) {
      await reply(customer, `Would you like to place another order, or is there anything else I can help you with?`, 'post_completion_greeting');
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
async function ensureMenuToken(customer) {
  if (customer.menu_token) return customer.menu_token;
  const token = randomBytes(12).toString('hex');
  await pool.query('update customers set menu_token = $1 where id = $2', [token, customer.id]);
  customer.menu_token = token;
  return token;
}

async function sendWebMenuLink(customer, bodyText, buttonTitle = 'View menu', category = null) {
  if (!process.env.PUBLIC_URL) return false;
  const token = await ensureMenuToken(customer);
  const url = `${process.env.PUBLIC_URL}/m/${token}${category ? `?cat=${encodeURIComponent(category)}` : ''}`;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), bodyText, buttonTitle, url, credentials);
  await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[menu link sent: ${url}]`, trigger: 'menu_shown', processed: true });
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
export async function handleOrderConfirmNoTap({ phoneNumber, channelId, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: '[tapped: No, change it]', processed: true });

  const message = 'No problem. Open the menu again and change whatever you like.';
  const session = await currentDineinSession(customer);
  if (session && process.env.PUBLIC_URL) {
    const url = `${process.env.PUBLIC_URL}/t/${session.qr_token}`;
    const credentials = await getWhatsAppCredentials(customer.branch_id);
    await sendWhatsAppCtaUrl(recipientFor(customer), message, 'See the menu', url, credentials);
    await logMessage({ customerId: customer.id, direction: 'outbound', channel, sender: 'bot', body: `[menu link sent: ${url}]`, trigger: 'order_confirm_no', processed: true });
    return;
  }
  const shown = await sendWebMenuLink(customer, message, 'See the menu');
  if (!shown) await reply(customer, message, 'order_confirm_no');
}

export async function handleStartOrderTap({ phoneNumber, channelId, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: '[tapped: Place an order]' , processed: true });
  const shown = await sendWebMenuLink(customer, "Here's our menu, take a look and let me know what you'd like.");
  if (shown) return;
  await reply(customer, 'What would you like to order?', 'items_menu_shown');
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
export async function handleWebMenuOrder(customer, items) {
  let order = await getOpenOrder(customer.id);

  if (!order) {
    order = await createDraftOrder(customer.id, customer.branch_id);
    await transitionOrder(order, 'understand_request');
    await transitionOrder(order, 'collect_info');
    for (const item of items) {
      await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4)', [order.id, item.productId, item.quantity, item.price]);
    }
    await finishItemsCollection(customer, order, 'Got it. ');
    return;
  }

  const { rows: existingItems } = await pool.query('select product_id, quantity from order_item where order_id = $1', [order.id]);
  const existingMap = new Map(existingItems.map((r) => [r.product_id, r.quantity]));
  const submittedIds = new Set(items.map((i) => i.productId));

  const adds = [];
  const sets = [];
  const removes = [];
  for (const item of items) {
    if (existingMap.has(item.productId)) {
      if (existingMap.get(item.productId) !== item.quantity) sets.push({ productId: item.productId, quantity: item.quantity });
    } else {
      adds.push(item);
    }
  }
  for (const productId of existingMap.keys()) {
    if (!submittedIds.has(productId)) removes.push({ productId });
  }
  if (!adds.length && !sets.length && !removes.length) return; // resubmitted with nothing actually changed

  if (['confirm_order', 'confirm_payment', 'fulfilment'].includes(order.engine_state)) {
    await handleOrderModification(customer, order, { adds, removes, sets });
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
  for (const item of adds) {
    await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4)', [order.id, item.productId, item.quantity, item.price]);
  }
  for (const item of sets) {
    await pool.query('update order_item set quantity = $1 where order_id = $2 and product_id = $3', [item.quantity, order.id, item.productId]);
  }
  for (const item of removes) {
    await pool.query('delete from order_item where order_id = $1 and product_id = $2', [order.id, item.productId]);
  }
  await finishItemsCollection(customer, order, 'Got it. ');
}

export async function handleMenuItemTap({ phoneNumber, channelId, product, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: `[tapped menu: ${product.name}]` , processed: true });

  let order = await getOpenOrder(customer.id);
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
  await pool.query('insert into order_item (order_id, product_id, quantity, price) values ($1, $2, $3, $4)', [order.id, item.productId, item.quantity, item.price]);
  await finishItemsCollection(customer, order, `Added ${product.name}. `);
}

export async function handleInboundMessage({ phoneNumber, channelId, text, channel = 'whatsapp', messageId, branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: text });
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
  if (!pendingTimers.has(customer.id)) {
    startTypingKeepAlive(customer, channel, messageId, channelId);
  }
  scheduleDebouncedProcessing(customer);
}

// Voice add-on's own front door onto this SAME engine (spec 0.6: "voice is
// a new way of talking to the same engine, not a second engine"). Deliberately
// does NOT go through handleInboundMessage/scheduleDebouncedProcessing --
// that 15-second debounce exists to batch a WhatsApp customer's rapid-fire
// messages into one reply, which is the wrong shape for a live call that
// must answer every utterance immediately. This calls straight into
// handlePendingBatch, the exact same routing handleInboundMessage's timer
// eventually reaches -- pure ack detection, existing-order dispatch,
// intent classification, handover, everything -- completely unchanged.
//
// The mandatory, not-configurable-off order read-back (spec A5) needs no
// extra code here: handleCollectInfo already can't reach payment without
// passing through its own `to confirm: ${lines}, total NGN ${total}...`
// step and waiting for a yes, for every channel, because that's baked into
// the order engine's state machine itself, not a per-channel branch.
//
// `isFirstTurn` (supplied by engine/voice.js, which is the one thing that
// actually knows where a call is in its own lifecycle) drives customer
// recognition (spec A6): a returning caller gets greeted by name,
// deterministically, so it can never say the wrong name or invent one. This
// is deliberately the ONLY half of A6 built right now -- asking for a name
// *naturally mid-order* on a first call needs a real call to test the
// timing against, not a guess (0.4: never guess), and stays open for the
// stage that wires up a real phone line.
export async function handleVoiceTurn({ callerNumber, branchId, spokenText, isFirstTurn = false }) {
  const customer = await findOrCreateCustomer({ phoneNumber: callerNumber, channel: 'voice', branchId });
  const hasCalledBefore = Boolean(customer.last_voice_call_at);
  if (isFirstTurn) {
    await pool.query('update customers set last_voice_call_at = now() where id = $1', [customer.id]);
  }
  await logMessage({ customerId: customer.id, direction: 'inbound', channel: 'voice', sender: 'customer', body: spokenText , processed: true });

  voiceReplyBuffers.set(customer.id, []);
  await handlePendingBatch(customer, spokenText);
  const buffered = voiceReplyBuffers.get(customer.id) || [];
  voiceReplyBuffers.delete(customer.id);
  let replyText = buffered.join(' ').trim();

  if (isFirstTurn && hasCalledBefore && customer.preferred_name) {
    const greeting = `Welcome back, ${customer.preferred_name}!`;
    await logMessage({ customerId: customer.id, direction: 'outbound', channel: 'voice', sender: 'bot', body: greeting, trigger: 'voice_welcome_back' });
    replyText = `${greeting} ${replyText}`.trim();
  }

  return { customer, replyText };
}

// Voice add-on only. Used by engine/voice.js for A8's trigger 3 (two
// consecutive low-confidence recognition turns) -- called INSTEAD of
// handleVoiceTurn, deliberately never routing a possibly-garbled transcript
// into the shared order engine at all. Reuses handover() exactly as every
// other trigger does, just from a different entry point than
// handlePendingBatch (nothing in handlePendingBatch can see recognizer
// confidence -- that number never reaches this file for any other channel).
export async function escalateVoiceCall({ callerNumber, branchId, reason }) {
  const customer = await findOrCreateCustomer({ phoneNumber: callerNumber, channel: 'voice', branchId });
  voiceReplyBuffers.set(customer.id, []);
  await handover(customer, reason);
  const buffered = voiceReplyBuffers.get(customer.id) || [];
  voiceReplyBuffers.delete(customer.id);
  return { customer, replyText: buffered.join(' ').trim() };
}

// Voice add-on only (spec A9). Deliberately its own function, not a branch
// inside handover() -- unlike a real handover, this doesn't mean the bot
// failed at something or that a human needs to intervene right now, so it
// never flips customers.handled_by (a caller phoning back once the
// restaurant is actually open must get the normal bot again, not be stuck
// staff-handled forever because they once called at 2am). It does still
// create a callback_task, exactly per spec A9 ("otherwise creates a
// callback_task") -- a person should still know a call came in while
// closed, just without it blocking this customer's next, in-hours call.
export async function handleClosedHoursCall({ callerNumber, branchId, opensAt }) {
  const customer = await findOrCreateCustomer({ phoneNumber: callerNumber, channel: 'voice', branchId });
  const message = opensAt
    ? `We're closed right now, we open again at ${opensAt}. I'll have someone follow up with you about this call.`
    : `We're closed right now. I'll have someone follow up with you about this call.`;

  voiceReplyBuffers.set(customer.id, []);
  await reply(customer, message, 'voice_closed_hours');
  const buffered = voiceReplyBuffers.get(customer.id) || [];
  voiceReplyBuffers.delete(customer.id);

  // Matched by caller_number, same reasoning as handover()'s voice branch
  // above -- customer.id can't have reached voice_call.customer_id yet on a
  // first-ever call.
  const { rows: callRows } = await pool.query(
    `select id, branch_id from voice_call where caller_number = $1 and ended_at is null order by started_at desc limit 1`,
    [customer.phone_number]
  );
  const call = callRows[0];
  if (call) {
    // One callback_task per call, not one per turn -- a caller who keeps
    // talking after being told "we're closed" shouldn't flood the queue
    // with duplicates of the same fact.
    const { rows: existing } = await pool.query(
      `select 1 from callback_task where call_id = $1 and reason = 'Called outside operating hours'`,
      [call.id]
    );
    if (!existing.length) {
      await pool.query(
        `insert into callback_task (branch_id, call_id, customer_id, reason, context_summary) values ($1, $2, $3, $4, $5)`,
        [
          call.branch_id,
          call.id,
          customer.id,
          'Called outside operating hours',
          opensAt ? `Caller reached us while closed. We open again at ${opensAt}.` : 'Caller reached us while closed.',
        ]
      );
    }
  }

  return { customer, replyText: buffered.join(' ').trim() };
}

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
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: `[${kind}]` , processed: true });

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

  const order = await getOpenOrder(customer.id);
  const awaitingPayment = order && order.engine_state === 'confirm_payment' && order.payment_status !== 'confirmed' && order.payment_status !== 'accepted';

  if (!awaitingPayment) {
    await reply(customer, `Got your ${kind}, let me get someone to take a look.`, 'media_received');
    await handover(customer, `Customer sent a ${kind} with no order currently awaiting payment`, null, false);
    return;
  }

  try {
    const dataUrl = channel === 'instagram' ? await downloadInstagramMedia(mediaId) : await downloadWhatsAppMedia(mediaId);
    // 'confirmation' means exactly this moment -- proof is in, pending a
    // real person's sign-off (Chidera's own words: "customer has sent
    // proof of payment and is pending confirmation") -- not "already
    // confirmed." completePayment() is what moves it past this, straight
    // to 'preparation', the instant a person (or Paystack's own webhook)
    // actually confirms it.
    await pool.query(`update "order" set payment_proof_url = $1, payment_status = 'proof_submitted', status = 'confirmation' where id = $2`, [dataUrl, order.id]);
    await reply(customer, `Noted, I will confirm the payment and get back to you shortly.`, 'payment_proof_received');
    // Staff confirming payment needs both documents in front of them at
    // once -- the invoice (what was ordered/owed) and the receipt they just
    // sent (proof it was paid) -- not a bare "check the dashboard" alert.
    const { rows: docs } = await pool.query(`select url from generated_document where order_id = $1 and type = 'invoice' order by created_at desc limit 1`, [order.id]);
    const invoicePath = docs[0]?.url;
    const invoiceUrl = invoicePath && process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${invoicePath}` : null;
    await handover(
      customer,
      `Customer submitted payment proof, needs manual confirmation`,
      {
        invoice: invoiceUrl ? `Invoice: ${invoiceUrl}` : null,
        receipt: process.env.PUBLIC_URL ? `Payment proof: ${process.env.PUBLIC_URL}/documents/payment-proof/${order.id}` : null,
        // Neither of the two links above is where the actual "Confirm
        // payment received" button lives -- found live, 2026-09-03: staff
        // had the invoice and the proof but nothing to actually click to
        // confirm it, just handover()'s own generic conversation link.
        // Straight into the order itself (OrderDetail.jsx has the same
        // "Confirm payment received" button the kanban card does) --
        // Chidera's call: land inside the card, not on the board having to
        // find it first.
        confirm: process.env.PUBLIC_URL ? `Confirm payment: ${process.env.PUBLIC_URL}/orders/${order.id}` : null,
      },
      false // already sent its own ack ("Noted, I will confirm...") above
    );
  } catch (err) {
    console.error(`Failed to download payment proof ${kind}:`, err);
    await reply(customer, `Got your ${kind} but had trouble saving it. Let me get someone to help confirm your payment.`, 'payment_proof_received');
    await handover(customer, `Customer submitted payment proof but the ${kind} failed to save`, null, false);
  }
}
