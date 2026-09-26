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
async function logMessage({ customerId, direction, channel, sender, body, trigger, platformMessageId, processed, interactive, tableSessionId }) {
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

// A real staff member, typing their own words from the dashboard's
// conversation view -- not the bot. Same WhatsApp send path (still runs
// through sanitizeText, so no markdown-style bullets), but logged as
// sender 'staff' rather than 'bot', and it counts as taking the thread:
// the customer already can't tell bot from staff apart by design, and a
// human replying without explicitly claiming the thread first is exactly
// how the bot would also try to answer the same message a moment later.
// Chidera, 2026-09-24: "even any text going out to the customer, the
// customer should get a one time we are trying to reach out to you tap
// here to text, so they can enter the webchat or have the free
// conversation not on bare chat that will be costing me, this also
// reduce the amount of conversation they can hold at a cost." Scoped to
// whatsapp specifically -- same "this is about WhatsApp's own
// per-message cost" reasoning every other redirect in this file already
// uses; Instagram/voice/an already-website customer keep the original
// direct send below, unchanged.
async function sendStaffReplyRedirect(customer, text, staffId) {
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: 'website', sender: 'staff', body: text, trigger: 'staff_reply' });

  if (await needsStaffChatRedirect(customer)) {
    await sendChatRedirectPing(customer, `We're trying to reach out to you.`, { trigger: 'staff_reply_ping', sender: 'staff' });
  }
  await pool.query(
    `update customers set handled_by = 'staff', handled_by_staff_id = coalesce($1, handled_by_staff_id), handover_at = coalesce(handover_at, now()) where id = $2`,
    [staffId || null, customer.id]
  );
}

export async function sendStaffReply(customerId, text, staffId) {
  const { rows } = await pool.query('select * from customers where id = $1', [customerId]);
  const customer = rows[0];
  if (!customer) throw new Error('Customer not found.');

  if (customer.channel === 'whatsapp') return sendStaffReplyRedirect(customer, text, staffId);

  const sendResult = await botEngine.sendMessage({ trigger: 'explicit_type_command', to: recipientFor(customer), text, whatsappSend: await senderFor(customer) });
  await logMessage({
    customerId: customer.id, tableSessionId: customer.tableSessionId,
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
    customerId: customer.id, tableSessionId: customer.tableSessionId,
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
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'staff', body: text, trigger: 'app_reply' });
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
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'staff', body: text, trigger: 'app_reply' });
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
const MONNIFY_LINK_REFRESH_LEAD_MINUTES = 5;
export async function refreshExpiringPaymentLinks() {
  const { rows: orders } = await pool.query(
    `select * from "order"
     where engine_state = 'confirm_payment'
       and payment_status not in ('confirmed', 'accepted')
       and monnify_account_expires_at is not null
       and monnify_account_expires_at < now() + make_interval(mins => $1)`,
    [MONNIFY_LINK_REFRESH_LEAD_MINUTES]
  );
  for (const order of orders) {
    try {
      const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
      const customer = custRows[0];
      if (customer) await sendPaymentInstructions(customer, order);
    } catch (err) {
      console.error(`Failed to refresh expiring Monnify link for order ${order.id}:`, err.message);
    }
  }
  if (orders.length) console.log(`Refreshed ${orders.length} expiring Monnify payment link(s).`);
}

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
// staffId is null for the business.handover_number fallback -- that number
// isn't tied to any real staff account, so the main handover() alert below
// can't bind a magic-link session to it and falls back to a bare
// (login-required) link for that one case.
// phoneNumber is run through toWhatsAppDigits before being returned --
// both staff.phone_number and business.handover_number are human-typed
// fields, commonly entered in local Nigerian format, which Meta's send API
// rejects outright (see toWhatsAppDigits' own comment, lib/auth.js).
export async function handoverRecipients() {
  const { rows: staffRows } = await pool.query(`select id, phone_number from staff where handover_alerts = true and phone_number is not null`);
  if (staffRows.length) return staffRows.map((s) => ({ phoneNumber: toWhatsAppDigits(s.phone_number), staffId: s.id }));
  const { rows: biz } = await pool.query('select handover_number from business limit 1');
  return biz[0]?.handover_number ? [{ phoneNumber: toWhatsAppDigits(biz[0].handover_number), staffId: null }] : [];
}

// A separate list from handoverRecipients -- Chidera, 2026-09-16: "a staff
// number should be able to get a confirmed order after paystack has
// automatically confirmed payment on their whatsapp without accessing the
// back end... i think an owner doesnt want staff to get the whole back
// end." handover_alerts is who deals with a customer escalation
// (owner/manager, usually); order_alerts is who needs to know the moment a
// payment clears and an order is ready to prep (kitchen/ops staff) --
// deliberately no fallback to business.handover_number here: an unset
// order_alerts list just means nobody gets pinged, not "guess who to tell."
export async function orderAlertRecipients() {
  const { rows } = await pool.query(`select id, phone_number from staff where order_alerts = true and phone_number is not null`);
  return rows.map((s) => ({ phoneNumber: toWhatsAppDigits(s.phone_number), staffId: s.id }));
}

// Every staff alert below (a handover, a voice callback, a delivery
// escalation) shares the same real failure mode sendStaffReply's own
// synchronous fallback already handles for CUSTOMER messages: WhatsApp
// refuses a plain send to a number outside its 24h session window (error
// 131047). Chidera 2026-09-11: "the handover needs template incase."
// Retries with the exact same text via the same approved business_outreach
// template, so the staff member still gets the real alert content, not a
// generic placeholder. Deliberately does NOT also add the async retry path
// retryFailedSendAsTemplate covers for customer messages (a DELAYED
// failure Meta reports after first accepting the send) -- that path
// correlates by looking up a `message` row's platform_message_id, and a
// staff phone number is never logged as one (staff aren't `customers`
// rows); covering the synchronous case, the common one, is the
// proportionate fix for what was actually asked.
export async function sendStaffAlert(to, text) {
  try {
    await botEngine.sendMessage({ trigger: 'staff_handoff_intro', to, text, whatsappSend: sendWhatsApp });
  } catch (err) {
    if (!/131047/.test(err.message)) throw err;
    const components = [{ type: 'body', parameters: [{ type: 'text', text }] }];
    await sendWhatsAppTemplate(to, 'business_outreach', 'en_US', components);
  }
}

// Chidera, 2026-09-23: "make the dashboard pwa so staff can get push
// notification or something... i need to reduce billable text all round
// to highest 1-5." Tries a free push first (engine/push-notify.js's
// pushToStaff) -- the SAME content a real WhatsApp alert would carry,
// plus an optional deep link (linkUrl) the dashboard's own service worker
// opens directly when tapped.
//
// Chidera, 2026-09-23 (same day, second pass): "merge handover message to
// be 1 the full message and the dashboard button on the same message" --
// the WhatsApp fallback below used to be TWO separate real sends when a
// link was involved (a plain-text alert, then a second message carrying
// just the button) -- exactly the same redundant-2-messages-for-one-link
// shape already fixed for delivery tracking. sendWhatsAppCtaUrl's own
// body text IS the alert -- there was never a reason this needed two
// sends. Falls back to the plain alert alone (sendStaffAlert, which has
// its own 24h-window template retry) if the combined send fails for any
// reason -- the alert text must never be lost, even without its button.
export async function notifyStaff({ staffId, phoneNumber, title, body, linkUrl, linkButtonText, credentials }) {
  if (await pushToStaff(staffId, { title, body, url: linkUrl })) return;
  if (linkUrl) {
    try {
      await sendWhatsAppCtaUrl(phoneNumber, body, linkButtonText || 'Open', linkUrl, credentials);
      return;
    } catch (err) {
      console.error(`Failed to send merged staff alert+link to ${phoneNumber}, falling back to plain text:`, err.message);
    }
  }
  await sendStaffAlert(phoneNumber, body);
}

// A second, WhatsApp-native way into the same dashboard the browser already
// gives owner/manager/staff logins -- not a replacement for it. Chidera
// 2026-09-11: "not whatsapp only o, itll live on site and whatsapp." Any
// staff member can text the bot's own number one of these trigger words at
// any time (not just when a handover alert fires) and get a one-tap magic
// link straight into the dashboard, opened inside WhatsApp's own in-app
// browser exactly like the handover alert's conversation link.
// Checked in webhook-whatsapp.js BEFORE the normal customer pipeline, so a
// staff member's own number never gets a `customers` row created for it or
// gets mistaken for someone trying to place an order -- only exact matches
// on both "this text is one of these words" and "this sender is a real,
// active staff row" are intercepted; anything else from that same number
// (an owner testing the ordering flow, say) falls straight through to
// dispatch() completely unaffected, same as before this existed.
const STAFF_DASHBOARD_TRIGGERS = ['dashboard', 'panel', 'control panel'];

export async function handleStaffCommand({ phoneNumber, text }) {
  if (!STAFF_DASHBOARD_TRIGGERS.includes((text || '').trim().toLowerCase())) return false;
  const staff = await findStaffByPhoneNumber(phoneNumber);
  if (!staff) return false;
  // Nothing sensible to send without a real public URL to build the link
  // from -- but this WAS a staff dashboard request, so still report
  // "handled" rather than letting it fall through and get treated as a
  // customer message. Same reasoning for the try/catch below: a failed
  // send (a stale number, the 24h template-window gap noted on handover()'s
  // own alert) must not throw out of here -- this runs inline in
  // webhook-whatsapp.js's per-event loop, uncaught it would abort
  // processing of every OTHER message in the same webhook batch, not just
  // this one.
  if (process.env.PUBLIC_URL) {
    try {
      const credentials = await getWhatsAppCredentials(staff.branch_id);
      const token = await createMagicLink(staff.id, '/');
      await sendWhatsAppCtaUrl(
        phoneNumber,
        `Hi ${staff.name.split(' ')[0]}, tap below to open your dashboard.`,
        'Open Dashboard',
        `${process.env.PUBLIC_URL}/api/auth/magic/${token}`,
        credentials
      );
    } catch (err) {
      console.error(`Failed to send dashboard link to staff ${staff.id}:`, err.message);
    }
  }
  return true;
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
  const extraLines = extra ? `\n${Object.values(extra).filter(Boolean).join('\n')}` : '';
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  for (const { phoneNumber: to, staffId } of recipients) {
    // Chidera, 2026-09-23: "handover be structured not a paragraph" --
    // same one-fact-per-line convention every other staff alert in this
    // file already follows (completePayment's "ready to prepare" ping,
    // notifyCustomerClaimedPosPayment's claim alert). "Handing over a
    // chat from X to you." read as a sentence to parse, not a field to
    // scan -- "Customer:" is the same label shape as "Reason:" right
    // below it.
    const alert = `Customer: ${displayNameFor(customer)}\nReason: ${reason}\n${summary}${extraLines}`;

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
async function findSpecialsCategory(branchId) {
  const menu = await resolveMenu(branchId);
  return menu.some((p) => p.is_combo) ? SPECIALS_CATEGORY : null;
}

// A "Place an order" button on the very first greeting -- Chidera's call,
// 2026-09-10: a customer who taps this skips straight to the real menu
// list (see the button_reply handling in webhook-whatsapp.js), the same
// way a table's QR code does for dine-in, with no AI classifyIntent call
// needed to work out they wanted to order. WhatsApp only -- Instagram/voice
// have no reply-button equivalent, so they keep the plain-text greeting.
//
// One tap, one message -- Chidera 2026-09-10: "i want straight to the see
// menu button no two step" (fixed by switching to a direct-open cta_url
// button), then "menu and todays specials should not be 2 differnt
// texts" (a second "Special offers" MESSAGE, sent right after the first),
// then, after that got read as "drop specials from the greeting
// entirely": "i said specials and menu buttons should be in same chat i
// didnt say remove specialsss". Both stay, in the one message: "See menu"
// is the real button (opens the general menu on one tap, same as
// before); the specials link rides along as a second URL inside that
// same message's own body text, which WhatsApp auto-links and makes
// tappable on its own -- no second bubble, no second bot round-trip, and
// still one tap either way.
// No AI call here anymore -- Chidera 2026-09-11: "i need that first what
// would you like to order with menu to go out instantly no typing again."
// classifyIntent only ever routes here for a PURE greeting with nothing
// else in it (a real question or an order in the same message goes to
// 'enquiry'/'order' instead, never here), so there's nothing substantive
// left for an AI call to react to -- greetingAckFor already does the same
// tone-matching deterministically (used the same way in handleEnquiry/
// handleCollectInfo already), just without the network round trip.
// Split out from handleGreeting, 2026-09-22, so this FULL welcome text
// (menu framing + specials) can be reused as the web-chat page's own first
// bubble (routes/web-chat.js) instead of only ever being a real WhatsApp
// send -- see sendStartOrderLink below for what the real WhatsApp message
// shrinks to.
// Exported for routes/web-chat.js's own first-load render -- see that
// route's GET /:token.
export async function buildGreetingContent(customer) {
  // Chidera 2026-09-11: "welcome to <restaurant name>, what would you
  // like to order" -- then, after an initial pass kept greetingAckFor's
  // tone-matched prefix (Good morning!/Hey there!) alongside it: "not
  // that hey there" -- and then: "add hello before the welcome". Plain
  // "Hello!", not greetingAckFor's tone-matching (that's the "hey there"
  // that was already turned down).
  //
  // Chidera, 2026-09-20: "we agreed a name so bot can refer to customer"
  // -- customer.name is only ever set via the web menu's own name popup
  // (routes/menu-page.js's POST /:token/name), never invented or guessed;
  // this is the first place it's actually read back. Falls back to the
  // exact same plain wording as before when it isn't set, which is still
  // the common case until a business turns the popup on and customers
  // start filling it in.
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  const businessName = bizRows[0]?.name || 'us';
  const message = customer.name
    ? `Hello ${customer.name}! Welcome to ${businessName}, what would you like to order?`
    : `Hello! Welcome to ${businessName}, what would you like to order?`;
  const specialsCategory = await findSpecialsCategory(customer.branch_id);
  return { message, businessName, specialsCategory };
}

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
async function needsStaffChatRedirect(customer) {
  const { rows } = await pool.query(
    `select created_at from message where customer_id = $1 and trigger = 'staff_reply_ping' order by created_at desc limit 1`,
    [customer.id]
  );
  const lastStaffPing = rows[0]?.created_at;
  if (!lastStaffPing) return true; // staff has never pinged this customer before
  const visitedSinceLastPing = customer.web_chat_active_at && new Date(customer.web_chat_active_at) > new Date(lastStaffPing);
  if (visitedSinceLastPing) return true;
  return new Date(lastStaffPing) < new Date(Date.now() - 24 * 60 * 60 * 1000);
}
async function markChatRedirectSent(customer) {
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
async function sendStartOrderLink(customer, { dineinTableLabel = null, dineinQrToken = null } = {}) {
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
  const tail = dineinTableLabel ? 'get started on your dine-in session.' : 'get started.';
  const shortGreeting = customer.name
    ? `Welcome to ${bizName}, ${customer.name}! Tap below to ${tail}`
    : `Welcome to ${bizName}! Tap below to ${tail}`;
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

// Chidera, 2026-09-23: "i need customer complaint and all those in the
// site as well... a site they are given where they can chat there too, to
// lay their complaints... i have to reduce billable text all round."
// Reuses the SAME /wa/:token page the ordering flow already uses -- no new
// page needed, the real free-text pipeline (routes/web-chat.js's
// /:token/message -> handleWebChatMessage -> handlePendingBatch) already
// classifies free text into 'complaint'/wantsHuman exactly like real
// WhatsApp text does, it just never had an entry point that DIDN'T assume
// ordering. Calling handover() straight from here (like this branch used
// to) would alert staff with nothing but "customer asked for a person" --
// no actual complaint yet, since they haven't said what's wrong -- and
// spend a real WhatsApp send doing it. One short link instead: once they
// actually type their complaint on the page, THAT free-text turn re-runs
// this exact classifyIntent branch and fires the real handover with their
// real words, landing as a free website bubble (customer.channel is
// 'website' by then) and a staff alert via push where available
// (notifyStaff). ?ctx=complaint tells the page's own first-bubble render
// (routes/web-chat.js) to greet them about their complaint, not the normal
// "what would you like to order?".
export async function sendComplaintLink(customer) {
  if (!process.env.PUBLIC_URL) {
    await reply(customer, `I'm sorry to hear that. Please tell me what happened and I'll get someone to help.`, 'complaint_redirect');
    return;
  }
  const token = await ensureMenuToken(customer);
  const chatUrl = `${process.env.PUBLIC_URL}/wa/${token}?ctx=complaint`;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  const shortMessage = `I'm sorry to hear that. Tap below to tell us what happened.`;
  await sendWhatsAppCtaUrl(recipientFor(customer), shortMessage, 'Tell us more', chatUrl, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: shortMessage, trigger: 'complaint_redirect', processed: true });
}

// Chidera, 2026-09-24: "if they want to reply, let reply not come to the
// bare chat let the customer be pinged with a you have a message from our
// manager, with tap here to chat button." routes/api.js's own complaint
// reply endpoint calls this: the manager's actual reply text is logged as
// a free website bubble (so it's there once they open the chat, same
// near-zero-cost shape as everything else on this page), but a customer
// who's genuinely left has no way to know it's waiting -- a manager
// replying is unscheduled, unlike a payment confirmation the customer is
// actively expecting, so this always sends a real, short WhatsApp ping
// pointing them back, never conditional on whether they're still on the
// page right now.
export async function notifyComplaintReply(customer, replyText) {
  // The manager's real reply lives as a free website bubble -- the ping
  // below stays generic on purpose, never the reply content itself,
  // matching this whole feature's own near-zero-message-cost shape (the
  // real content is free once they're on the page, only the nudge to get
  // them there is a billable send).
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: 'website', sender: 'bot', body: replyText, trigger: 'complaint_reply' });
  if (!process.env.PUBLIC_URL) return;
  await sendChatRedirectPing(customer, `You have a message from our manager.`, { trigger: 'complaint_reply_ping' });
}

export async function handleGreeting(customer, text) {
  // Chidera, 2026-09-21: "look at my instagram flow... how does instagram
  // catch up to our current state" -- found live: an Instagram customer
  // got this bare greeting with NO menu link at all, ever, anywhere in
  // the flow (WhatsApp's own CTA-URL button type doesn't exist there) --
  // they could only order by typing item names and hoping the AI parsed
  // them right. voice genuinely can't use a link at all (spoken, not
  // visual), so it keeps the bare greeting -- Instagram gets the same
  // real menu URL WhatsApp does, just as a plain text line instead of a
  // button (auto-linkified by Instagram's own client), same fallback
  // shape sendPaymentLinkButton/sendPosPaymentChoice already use.
  if (customer.channel === 'voice' || !process.env.PUBLIC_URL) {
    const { message } = await buildGreetingContent(customer);
    await reply(customer, message, 'greeting');
    return;
  }
  if (customer.channel === 'instagram') {
    const { message, specialsCategory } = await buildGreetingContent(customer);
    const token = await ensureMenuToken(customer);
    const menuUrl = `${process.env.PUBLIC_URL}/m/${token}`;
    const body = specialsCategory
      ? `${message}\n\nMenu: ${menuUrl}\nToday's specials: ${menuUrl}?cat=${encodeURIComponent(specialsCategory)}`
      : `${message}\n\nMenu: ${menuUrl}`;
    await reply(customer, body, 'greeting');
    return;
  }
  if (customer.channel === 'website') {
    // Chidera, 2026-09-25, real report: "i texted hi and it replied me
    // welcome what would you like to order? in just text it didnt send
    // the menu attached to it." This branch WAS reachable -- typing free
    // text like "hi" directly into an already-open web chat (not tapping
    // a button) goes through dispatch()'s normal intent classification,
    // which lands here -- the old comment's "shouldn't normally be
    // reached" was wrong. Used to send buildGreetingContent's bare
    // message with no menu link at all; now a real bubble with a "See
    // menu" button, same shape sendOrderGreeting (routes/web-chat.js's
    // own first-visit greeting) and the Instagram branch above already use.
    const { message, specialsCategory } = await buildGreetingContent(customer);
    const token = await ensureMenuToken(customer);
    const menuUrl = `${process.env.PUBLIC_URL}/m/${token}`;
    const body = specialsCategory
      ? `${message}\n\nToday's specials: ${menuUrl}?cat=${encodeURIComponent(specialsCategory)}`
      : message;
    await logMessage({
      customerId: customer.id,
      tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: 'website',
      sender: 'bot',
      body,
      trigger: 'greeting',
      interactive: { type: 'cta_url', buttonText: 'See menu', url: menuUrl },
    });
    return;
  }
  await sendStartOrderLink(customer);
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

// A confident, deterministic shortcut around classifyIntent's own AI call
// -- Chidera 2026-09-11: "i need that first what would you like to order
// with menu to go out instantly no typing again." Reuses the exact same
// patterns greetingAckFor already matches: strips every greeting phrase
// out of the message, and if literally nothing else is left (just
// whitespace/punctuation), this is confidently "just saying hi" with no
// question or order riding along -- classifyIntent's own definition of
// 'greeting' -- so there's nothing an AI call could add by looking at it.
// Anything with real content left over ("hi, do you have jollof?") still
// goes through classifyIntent as normal, unaffected.
function isPureGreeting(text) {
  const stripped = text
    .replace(/good\s*(morning|afternoon|evening)/gi, '')
    .replace(/\b(hi+|hello+|hey+|yo|greetings)\b/gi, '')
    .replace(/how\s*(far|you\s*(dey|de)|are\s*you|is\s*(your\s*day|it\s*going))\b/gi, '')
    .replace(/[\s!.,?]+/g, '');
  return stripped.length === 0;
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

// A bare re-ask ("What would you like to order today?") on a second try
// isn't actually helpful -- the customer already tried to answer that and
// it didn't match. For the two fields with a real, short options list
// (item, branch), naming the actual choices turns a repeated question into
// something they can act on ("we didn't have a match, here's what we do
// have" instead of the same sentence verbatim).
async function fieldPrompt(fieldKey, fallbackQuestion, branchId) {
  if (fieldKey === 'items') {
    // Chidera 2026-09-10: "let bot no longer send menu photos itself" --
    // the real web menu page (sendWebMenuLink) is the intended way to show
    // the menu now; this text listing is just the last-resort fallback
    // when that isn't available, same as it always was for a catalogue
    // small enough to actually read as text.
    const products = await resolveMenu(branchId);
    if (products.length) return `${fallbackQuestion || 'What would you like to order?'} We have: ${products.map((p) => p.name).join(', ')}.`;
  }
  if (fieldKey === 'branch') {
    const branches = await branchOptions();
    if (branches.length) return `${fallbackQuestion || 'Which branch?'} We have: ${branches.map((b) => b.name).join(', ')}.`;
  }
  return fallbackQuestion || `Sorry, can you tell me the ${fieldKey}?`;
}

export async function handleCollectInfo(customer, order, text, greetingPrefix = '') {
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
      // Chidera, 2026-09-17: "a customer texted she wanted to order alfredo
      // pasta and the bot attended to her with text which is good but at
      // the begining he would have also sent the menu text... some
      // customers may not know thats available" -- this "already shown"
      // check used to only be computed inside the !matched.length branch
      // below, so a message that named a real item successfully on the
      // very first try (skipping that branch entirely) never triggered the
      // menu send at all -- the customer who names one dish they already
      // know about never finds out what else is on offer. Computed once,
      // shared by both branches, so "first items interaction on this
      // order" means the same thing whether or not the message matched.
      const { rows: menuAlreadyShown } = await pool.query(
        `select 1 from message where customer_id = $1 and trigger = 'items_menu_shown' and created_at >= $2 limit 1`,
        [customer.id, order.created_at]
      );
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
        if (menuAlreadyShown.length) {
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
          // the text fallback below unchanged.
          //
          // No menu-photo forward anymore either way -- Chidera 2026-09-10:
          // "let bot no longer send menu photos itself". The real web menu
          // (or, failing that, fieldPrompt's own text listing) is the only
          // fallback now.
          let catalogShown = false;
          if (customer.channel !== 'instagram') {
            catalogShown = await sendWebMenuLink(customer, await menuGreetingBody()).catch((err) => {
              console.error('sendWebMenuLink failed:', err.message);
              return false;
            });
          }
          // Found live, 2026-09-16: "why is bot sending me 2 text? the text
          // with menu is meant to contain the whole text" -- the fix above
          // (only 2026-09-10's note) stopped the full text ITEM LIST from
          // duplicating the button, but still sent a second, shorter
          // message ("What would you like to order?") right after every
          // time the button itself succeeded -- genuinely redundant, since
          // sendWebMenuLink's own body text ("Here's our menu, take a look
          // and let me know what you'd like.") already asks exactly that.
          // Only send anything more when the button DIDN'T go out --
          // Instagram (no CTA-URL button type) or a real send failure --
          // where fieldPrompt's text listing is the only way the customer
          // gets to see the menu at all.
          if (!catalogShown) {
            await send(await fieldPrompt('items', 'What would you like to order?', order.branch_id), 'items_menu_shown');
          } else {
            await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: '[covered by menu button above, no separate text sent]', trigger: 'items_menu_shown', processed: true });
          }
        }
        return;
      }
      for (const m of matched) {
        await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, m.productId, m.quantity, m.price, customer.id]);
      }
      // Named a real item straight away, first try -- still worth showing
      // the full menu once (see the comment on menuAlreadyShown above):
      // they only told us about the one dish they already had in mind, not
      // everything else on offer. Sent ahead of the normal text reply
      // below, not instead of it -- "attended to her with text... at the
      // beginning he would have also sent the menu."
      if (!menuAlreadyShown.length && customer.channel !== 'instagram') {
        const sent = await sendWebMenuLink(customer, await menuGreetingBody()).catch((err) => {
          console.error('sendWebMenuLink failed:', err.message);
          return false;
        });
        // sendWebMenuLink's own logMessage tags itself 'menu_shown', not
        // 'items_menu_shown' -- that second, specific trigger is what
        // menuAlreadyShown's own query above looks for, so it has to be
        // logged here too or every later message in this same order would
        // think the menu was never shown and keep re-sending it.
        if (sent) {
          await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: '[covered by menu button above, no separate text sent]', trigger: 'items_menu_shown', processed: true });
        }
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
        await applyOrderModifications(order, mods, { allowRemovals: true }, customer);
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

  return finishItemsCollection(customer, order, prefix, { preferTextForQuestions: true });
}

// Finds the earliest catalogue-question still unanswered across every item
// on this order, in item-then-question order -- null once every item's
// questions (if it has any at all) are all answered. Kept as its own query
// (not parsed out of order_item.modification's free text) so "has this
// specific question been asked yet" is a real fact, not a guess.
async function askNextItemQuestion(orderId) {
  const { rows } = await pool.query(
    `select oi.id as order_item_id, pq.id as question_id, pq.question, pq.options, p.name as product_name
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
// Exported so routes/api.js's upsell-success-rate stat can tell whether an
// offered category actually landed in the final order using the exact same
// keyword matching nextUpsellGroup itself uses to decide a category's
// already satisfied -- one source of truth for what counts as a match,
// not a second guess at the same keywords.
// Chidera, 2026-09-25: "let upsell only be protein and drink or side and
// drink now no more snack" -- snack dropped from the priority tracks below
// (nextUpsellGroup), so it's never actively offered going forward. Kept
// HERE though, not deleted -- routes/api.js's computeUpsellStats and this
// file's own logMetric('upsell_accepted') both look up a past order's
// upsell_offered entries against this exact array to tell whether an
// already-recorded offer (snack entries from before today, on real live
// orders) actually landed; deleting the group here would silently zero
// out accepted-count accuracy for that real historical data, not just stop
// new snack offers.
export const UPSELL_GROUPS = [
  { key: 'drink', keywords: ['drink', 'beverage', 'juice', 'water'], label: 'a drink' },
  { key: 'protein', keywords: ['protein', 'meat'], label: 'a protein' },
  { key: 'side', keywords: ['side', 'sides'], label: 'a side' },
  { key: 'snack', keywords: ['snack', 'small chop', 'appetiser', 'appetizer', 'starter'], label: 'a snack' },
];

// Chidera, 2026-09-25, same message: "and only 2 upsell" -- down from 3.
const MAX_UPSELL_PICKS = 2;

export function categoryMatchesGroup(category, keywords) {
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

// Chidera, 2026-09-25: "let upsell only be protein and drink or side and
// drink now no more snack, and only 2 upsell" -- simplified to exactly two
// tracks of two, picked by the same "does this order already have a side"
// check as before: missing one gets offered side then drink (get the side
// actually added, protein no longer asked about in this track at all);
// already has one gets protein then drink instead (side would never fire
// anyway -- orderHasIt below already excludes it).
const SIDE_KEYWORDS = UPSELL_GROUPS.find((g) => g.key === 'side').keywords;
const UPSELL_PRIORITY_WITH_SIDE = ['side', 'drink'];
const UPSELL_PRIORITY_WITHOUT_SIDE = ['protein', 'drink'];

// Next upsell offer worth making, if any -- one whole category at a time
// (every real product in it, not just a representative one), already-
// ordered categories and already-offered-this-order categories both
// excluded, capped at MAX_UPSELL_PICKS sequential offers total. Naturally
// returns null once every real cross-sell opportunity is either satisfied,
// already declined, or the cap's been reached.
async function nextUpsellGroup(order, orderItems) {
  if (!orderItems.length) return null;
  const offered = order.upsell_offered || [];
  if (offered.length >= MAX_UPSELL_PICKS) return null;
  const menu = await resolveMenu(order.branch_id);
  const orderedCategories = orderItems.map((oi) => menu.find((p) => p.id === oi.product_id)?.category).filter(Boolean);
  const orderHasSide = orderedCategories.some((c) => categoryMatchesGroup(c, SIDE_KEYWORDS));
  const priorityKeys = orderHasSide ? UPSELL_PRIORITY_WITHOUT_SIDE : UPSELL_PRIORITY_WITH_SIDE;
  const priorityGroups = priorityKeys.map((key) => UPSELL_GROUPS.find((g) => g.key === key));
  for (const group of priorityGroups) {
    if (offered.includes(group.key)) continue; // already asked about this one this order
    const options = catalogueOptions(menu, group.keywords);
    if (!options.length) continue;
    const orderHasIt = orderedCategories.some((c) => categoryMatchesGroup(c, group.keywords));
    if (orderHasIt) continue;
    return { ...group, options };
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
// Exported for sandbox/test-web-chat-ordering.mjs -- exercises this
// function's website branch directly, since the real dispatch() path that
// would normally reach it needs a live Anthropic key this environment
// doesn't have (extractOrderModifications, called before any state-based
// routing for an order past collect_info).
function upsellSectionTitle(upsell) {
  return upsell.label.charAt(0).toUpperCase() + upsell.label.slice(1);
}

// Chidera, 2026-09-24: "can i have it as a dropdown they can choose, and
// an optional type extra note if they have extra, so they just only have
// to select." website-channel only -- WhatsApp has no dropdown UI to send
// this as, so it keeps asking in plain text there, same as it always did
// (finishItemsCollection's own caller falls through to that when this
// returns false). Real options only, same "never invent structure that
// isn't really there" rule as everywhere else in this file -- a question
// with none returns false too, falling through to the plain-text ask.
async function sendItemQuestionAsChoice(customer, nextQuestion, prefix, soFar) {
  if (customer.channel !== 'website') return false;
  if (!nextQuestion.options || !nextQuestion.options.length) return false;
  await logMessage({
    customerId: customer.id, tableSessionId: customer.tableSessionId,
    direction: 'outbound',
    channel: customer.channel,
    sender: 'bot',
    body: `${prefix}${soFar}For your ${nextQuestion.product_name}, ${nextQuestion.question}`.trim(),
    trigger: 'item_question_asked',
    interactive: { type: 'item_question', buttonText: 'Choose', options: nextQuestion.options },
  });
  return true;
}

export async function sendUpsellList(customer, upsell, prefix = '') {
  if (customer.channel !== 'whatsapp' && customer.channel !== 'website') return false;
  const rows = upsell.options.slice(0, 8).map((p) => ({
    id: `upsell::${p.id}`,
    title: p.name.slice(0, 24),
    description: `NGN ${Number(p.price).toLocaleString()}`,
  }));
  rows.push({ id: 'upsell::skip', title: 'No thanks', description: 'Skip' });
  // Chidera, 2026-09-24 (correction): "the former would you like to add a
  // drink is very okay just that it was to enable multi selesct and all."
  // Reverted to the plain single-category ask -- the earlier "combined
  // categories" wording was a solution to a problem this design no longer
  // has (each offer is one category again, sequential, not several
  // combined into one confusing list).
  const bodyText = `${prefix}Would you like to add ${upsell.label}?`.trim();
  // website: same row ids as WhatsApp's list message (upsell::<id>,
  // upsell::skip) -- a tap on the chat page posts the row id to
  // POST /:token/tap, which calls handleUpsellListTap exactly as the real
  // WhatsApp list_reply webhook event does today.
  if (customer.channel === 'website') {
    await logMessage({
      customerId: customer.id, tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: customer.channel,
      sender: 'bot',
      body: `${bodyText} We have: ${upsell.options.map((o) => o.name).join(', ')}.`,
      trigger: 'upsell_offered_list',
      interactive: { type: 'list', buttonText: 'Choose', sectionTitle: upsellSectionTitle(upsell), rows },
    });
    return true;
  }
  // Chidera, 2026-09-20: two real gaps found investigating a report of a
  // plain-text upsell on pomodoro -- (1) this never resolved the branch's
  // own credentials, only the raw shared env var (fixed by passing
  // getWhatsAppCredentials through, same as every other send in this
  // file); (2) a genuine Meta-side failure here had nothing catching it,
  // so it would have thrown all the way out of finishItemsCollection
  // instead of degrading to the plain-text fallback that already exists
  // right below this function's own call site. Couldn't actually confirm
  // which of the two explains that specific report (the success log and
  // the text fallback wrote the exact same body, so the dashboard
  // couldn't tell them apart either) -- trigger is now different for each
  // path specifically so that's answerable for real next time, not guessed.
  try {
    const credentials = await getWhatsAppCredentials(customer.branch_id);
    await sendListMessage(recipientFor(customer), {
      bodyText,
      buttonText: 'Choose',
      sectionTitle: upsellSectionTitle(upsell),
      rows,
    }, credentials);
  } catch (err) {
    console.error(`sendUpsellList: list send failed, falling back to text: ${err.message}`);
    return false;
  }
  // Logged as the real bodyText actually sent (including any order-so-far
  // readback), not a separate hand-written string -- was drifting from
  // what the customer actually saw, so the dashboard transcript read
  // differently than the real conversation did.
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `${bodyText} We have: ${upsell.options.map((o) => o.name).join(', ')}.`, trigger: 'upsell_offered_list' });
  return true;
}

// Chidera 2026-09-11: "reconfirm my order to me first before you ak me any
// add a drink or peppered or not question so you are sure of what im
// ordering." A quick itemized readback right before asking an item
// question or an upsell -- so a customer sees exactly what the bot thinks
// they ordered BEFORE getting asked to customize or add to it, not just
// once at the very end. Skipped when there's nothing on the order yet
// (shouldn't happen -- finishItemsCollection only ever runs after an
// item's already been added -- but never worth a blank "Your order so
// far:" line if it somehow did).
async function orderSoFarSummary(order) {
  const { itemLines } = await summariseOrder(order);
  return itemLines.length ? `Your order so far:\n${itemLines.join('\n')}\n\n` : '';
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
// autoConfirm: Chidera, 2026-09-17: "full review before submit... making
// the WhatsApp confirm yes/no unnecessary." Defaulted false everywhere --
// every existing caller (typed WhatsApp, handlePendingItemQuestion,
// handlePendingUpsell) keeps asking the real yes/no exactly as before.
// Only handleWebMenuOrder ever passes true, and only when the submission
// carried a real fulfilment choice -- meaning it came through the site's
// own review sheet (items + delivery/pickup + total, all already shown
// and confirmed there), not a stray/incomplete web hit. Item-question and
// missing-field checks below still run unconditionally either way -- a
// genuinely unanswered question still gets asked over WhatsApp rather
// than silently skipped; autoConfirm only ever replaces the FINAL
// yes/no ask, once nothing else was actually outstanding.
// deltaLines -- Chidera, 2026-09-20: "when they add on send them the yes
// to confirm button and place the ordr, let their total and items be
// compounding in the ready to pay stuff." An add-on round (order already
// confirmed once before) still gets the same real yes/no confirm gate
// every round does -- just scoped to what's NEW this round (deltaLines),
// not the whole running order restated again. The full, ever-growing
// total/item list is what the ready-to-pay page shows (routes/dinein-
// menu.js's payStatusPayload, already reading the one shared order's
// live total) -- that's where "compounding" belongs, not every chat
// message. null (the default) means the normal, first-round full summary.
export async function finishItemsCollection(customer, order, prefix = '', { autoConfirm = false, preferTextForQuestions = false, deltaLines = null } = {}) {
  const nextQuestion = await askNextItemQuestion(order.id);
  if (nextQuestion) {
    await pool.query('update "order" set pending_question_order_item_id = $1, pending_question_id = $2 where id = $3', [
      nextQuestion.order_item_id,
      nextQuestion.question_id,
      order.id,
    ]);
    // Chidera, 2026-09-20: "let ... details of food specification eg. cold
    // or room temp be processes in the flow on the website to save cost"
    // -- one web link (the general menu page, already pre-loaded with this
    // exact pending order -- see routes/menu-page.js's pendingOrderPayload
    // and menu-page-template.js's firstUnansweredKey) covers every
    // outstanding item-question in one visit instead of one Meta message
    // per question.
    //
    // preferTextForQuestions -- Chidera, 2026-09-20, real report (Emmanuel,
    // era-demo): "if they are already using text no need to send them back
    // to the menu to answer cold or not, just go text it." A customer who
    // placed THIS item by typing (not tapping through the web menu or a
    // button) is already mid-conversation in plain text -- redirecting
    // them to a web link for one short question is a worse experience
    // than just asking it, not a cheaper one. Set true by every
    // text-originated caller below; left false (web link first, same as
    // before) for every web/button-tap-originated caller, where a link is
    // the natural continuation of what they were already doing.
    // pending_question_order_item_id/_id above are still set regardless,
    // so a customer who ignores the link and just types an answer anyway
    // (handlePendingItemQuestion) still works exactly as before.
    const soFarForChoice = await orderSoFarSummary(order);
    // Chidera, 2026-09-24: "can i have it as a dropdown they can choose,
    // and an optional type extra note if they have extra, so they just
    // only have to select." Same real product_question.options the web
    // menu page's own qSheet already offers a select-plus-optional-note
    // UI for -- now available directly in the chat too, so a website
    // customer never has to leave it (or type a free-text answer by hand)
    // just to say "cold" or "no pepper". Only for a question that
    // genuinely HAS real options set in Catalogue -- one with none keeps
    // asking in plain text exactly as before, same "never invent
    // structure that isn't really there" rule as everywhere else.
    const shownChoice = await sendItemQuestionAsChoice(customer, nextQuestion, prefix, soFarForChoice);
    if (shownChoice) return;
    if (!preferTextForQuestions) {
      const shownLink = await sendWebMenuLink(customer, `${prefix}Just need a couple more details on your order -- tap below to finish up.`, 'Finish my order', null, null, order);
      if (shownLink) return;
    }
    // Chidera, 2026-09-24: first tried naming the quantity + a split-answer
    // hint here for a multi-unit line ("for things like drink just asks
    // for your drinks cold or room temperature, the customer can type 1
    // cold and 1 room temperature") -- then corrected: "no need to ask
    // that extra 'you have 2, feel free to split it'...blah blah...the
    // first cold or room temperature is fine." Back to the plain question,
    // every time. handlePendingItemQuestion already stores whatever's
    // typed here verbatim (no forced single answer), so a real split
    // answer still works fine without the bot spelling out the option.
    await reply(customer, `${prefix}${soFarForChoice}For your ${nextQuestion.product_name}, ${nextQuestion.question}`.trim(), 'item_question_asked');
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
    const soFar = await orderSoFarSummary(order);
    const sent = await sendUpsellList(customer, upsell, `${prefix}${soFar}`);
    if (!sent) {
      await reply(customer, `${prefix}${soFar}Would you like to add ${upsell.label}? We have: ${upsell.options.map((o) => o.name).join(', ')}.`.trim(), 'upsell_offered_text');
    }
    return;
  }

  // Chidera, 2026-09-24: "after i said no thanks and later on i wanted to
  // add, the bot was not acknowledging my new selection." handleUpsellListTap/
  // handleUpsellMultiTap can now add an item via a tap on an OLDER,
  // already-answered upsell bubble even after the order's moved past
  // collect_info (confirm_order, confirm_payment, ...) -- the forward
  // transition chain below only has one real starting point
  // (collect_info -> check_availability -> calculate_price -> confirm_order,
  // per the state machine's own allowed moves), so attempting it from any
  // later state throws. Recompute and acknowledge instead, same
  // "modification at a later stage" shape applyOrderModifications already
  // uses elsewhere -- no transition needed, the order was already past
  // this point.
  if (order.engine_state !== 'collect_info') {
    const { total } = await summariseOrder(order);
    await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
    // Chidera, 2026-09-25, real live incident: a plain "New total: NGN X"
    // text here left two real problems for an order already past
    // collect_info -- (1) any order_confirm_asked bubble already sent
    // silently stops responding: handleOrderConfirmYesTap's own guard
    // requires engine_state === 'confirm_order', which this late add never
    // touches, so a tap on an OLDER confirm_order-stage bubble's buttons
    // (or, worse, one from BEFORE this add, now showing a stale total)
    // does nothing; (2) if payment instructions/an invoice were already
    // sent once (confirm_payment), that link is now for the WRONG, stale
    // amount. "whenever the new total is updated, instead of just typing
    // new total resend me the invoice and paynow thing." Same reset-then-
    // resend shape applyOrderModifications' own wasAlreadyConfirmed branch
    // already uses for a typed "add X" -- this is the same fix for a
    // TAPPED add (an older upsell bubble) instead.
    if (order.engine_state === 'confirm_payment') {
      await pool.query('update "order" set confirmed_at = null where id = $1', [order.id]);
      order.confirmed_at = null;
      await sendPaymentInstructions(customer, order);
      return;
    }
    if (order.engine_state === 'confirm_order') {
      await pool.query('update "order" set confirmed_at = null where id = $1', [order.id]);
      order.confirmed_at = null;
      const { itemLines: freshLines, total: freshTotal } = await summariseOrder(order);
      await sendConfirmButtons(customer, `Got it, your order:\n${freshLines.join('\n')}\nNew total: NGN ${freshTotal}.`, 'order_confirm_asked');
      return;
    }
    await reply(customer, `${prefix}New total: NGN ${total}.`.trim(), 'upsell_late_add');
    return;
  }

  await transitionOrder(order, 'check_availability');
  await transitionOrder(order, 'calculate_price');
  const { itemLines, total, deliveryFee } = await summariseOrder(order);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
  await transitionOrder(order, 'confirm_order');

  if (autoConfirm) {
    // Same confirmed_at + handleCollectFulfilment(customer, order, null)
    // pair handleConfirmOrder itself uses right after a real typed/tapped
    // "yes" -- handleCollectFulfilment does its own transitionOrder to
    // confirm_payment once fulfilment's resolved (already is here, see
    // applyWebFulfilment), so it goes straight to payment instructions
    // instead of a fresh yes/no ask for an order already reviewed and
    // confirmed on the site itself.
    await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);
    order.confirmed_at = new Date();
    await handleCollectFulfilment(customer, order, null);
    return;
  }

  // Chidera, 2026-09-23, live report on era-demo: "it gave me a bill of
  // food with total of 4700 my food way 1700 but it didnt state the
  // delivery there, one could easily misunderstand" -- deltaLines is a
  // repeat add-on round (wasAlreadyConfirmed), reached only after the
  // order's very first confirm -- by then fulfilment/delivery fee is
  // usually already known, so `total` here could silently include a real
  // delivery fee never shown. The non-deltaLines branch is the genuinely
  // first-ever confirm, before fulfilment's even asked -- deliveryFee is
  // always 0 there, so this line is a no-op for it, not a behavior change.
  const deliveryFeeLine = deliveryFee > 0 ? [`Delivery fee: NGN ${deliveryFee}`] : [];
  const summary = deltaLines
    ? [...deltaLines, ...deliveryFeeLine, `Table's total is now: NGN ${total}`].join('\n')
    : [...itemLines, ...deliveryFeeLine, `Total: NGN ${total}`].join('\n');
  const heading = deltaLines ? 'Add on:' : 'To confirm:';
  await sendConfirmButtons(customer, `${prefix}${heading}\n${summary}`.trim(), 'order_confirm_asked');
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
export async function handlePendingUpsell(customer, order, text) {
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
    await applyOrderModifications(order, mods, { allowRemovals: true }, customer);
    return finishItemsCollection(customer, order, 'Got it. ', { preferTextForQuestions: true });
  }

  const { matched } = await extractOrderItems(text, order.branch_id);
  if (matched.length) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
    // added_by_customer_id -- same fix as applyOrderModifications' own
    // insert (Chidera, 2026-09-20: "why are you seperating it" re a
    // chicken added via this exact upsell path). A second, parallel
    // insert this function has always had its own copy of, missed the
    // first time through.
    for (const m of matched) {
      await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, m.productId, m.quantity, m.price, customer.id]);
    }
    // Chidera, 2026-09-20: "when an item is added, why is stale amount on
    // ready to pay still there" -- same fix as applyOrderModifications'
    // own insert (this function's OTHER add path, just above), missed
    // here since this is a second, parallel insert that was never routed
    // through it. Any PENDING order_payment is now stale the moment a
    // real item gets added, regardless of which of this function's own
    // two paths did it.
    await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
    return finishItemsCollection(customer, order, `Added ${matched.map((m) => `${m.quantity}x ${m.name}`).join(', ')}. `, { preferTextForQuestions: true });
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
  return finishItemsCollection(customer, order, '', { preferTextForQuestions: true });
}

// A tap on sendUpsellList's List Message above -- the zero-AI-cost path,
// handled entirely separately from handlePendingUpsell (which only ever
// sees a TYPED reply now, since a list tap arrives as its own webhook
// event and never reaches dispatch()/the pending_upsell_category text
// check at all). Row ids are 'upsell::<productId>' or 'upsell::skip', set
// by sendUpsellList -- webhook-whatsapp.js routes here before its normal
// menu-list row handling, since this id space is deliberately separate
// from that one.
export async function handleUpsellListTap({ phoneNumber, channelId, rowId, channel = 'whatsapp', branchId, customer: presetCustomer }) {
  const customer = presetCustomer || (await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId }));
  const order = await resolveCustomerOrder(customer);
  // Chidera, 2026-09-24: "after i said no thanks and later on i wanted to
  // add, the bot was not acknowledging my new selection, a person can
  // alsways select and itll be added." Real bug: pending_upsell_category
  // gets cleared the instant ANY offer is answered (skip or pick), so
  // tapping an item on an OLDER, already-answered bubble later -- a
  // completely legitimate change of mind -- used to require it still be
  // set, and silently did nothing once it wasn't. A tap carries a real,
  // unambiguous product id regardless of whether it's still the CURRENT
  // offer -- only a genuinely gone order (none at all, or already
  // completed/cancelled) is a real no-op.
  if (!order || ['completed', 'cancelled'].includes(order.status)) return;

  if (order.pending_upsell_category) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
  }

  const picked = rowId.slice('upsell::'.length);
  if (picked === 'skip') {
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: '[tapped: No thanks]', processed: true });
    return finishItemsCollection(customer, order, '');
  }

  const product = await productForRowId(picked);
  if (!product) return finishItemsCollection(customer, order, '');
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: `[tapped: ${product.name}]`, processed: true });
  // added_by_customer_id -- Chidera, 2026-09-20, real report ("water is
  // still categorized as guest"): a THIRD parallel insert for an upsell-
  // added item, missed by the earlier "guest-chicken" fix -- that pass
  // covered applyOrderModifications' own insert and handlePendingUpsell's
  // typed-match insert, but this one (a tap on the upsell's own WhatsApp
  // LIST message -- the default, zero-AI-cost way most customers actually
  // accept an upsell) has always had its own separate insert that never
  // set it.
  await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, 1, $3, $4)', [order.id, product.id, product.price, customer.id]);
  // Chidera, 2026-09-20: "when an item is added, why is stale amount on
  // ready to pay still there... it should show new outstanding balance
  // na" -- same fix as applyOrderModifications' own insert; this is the
  // default, zero-AI-cost way most customers actually accept an upsell
  // (a tap on the list, not typing), and the most likely real path behind
  // this exact report. Any PENDING order_payment is now stale the moment
  // a real item gets added.
  await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  return finishItemsCollection(customer, order, `Added ${product.name}. `);
}

// Chidera, 2026-09-24: "let them be able to pick multiple and also when
// they pick one let the + and - thing show so they can buy more than 1
// ... since upsells are more than 1 dont take them back to the menu to
// ask all those finish your order questions, just ask them in webchat
// the peppered or not and all." Web-chat only -- WhatsApp's native List
// Message has no multi-select or quantity control, so real WhatsApp
// customers stay on handleUpsellListTap above (one tap, one item,
// quantity 1, still redirects to the menu for its own questions -- that
// stays unchanged, a real cost tradeoff for real WhatsApp specifically).
// picks: [{ productId, quantity }], already deduplicated and non-empty by
// the time the route calls this.
export async function handleUpsellMultiTap({ customer, picks }) {
  const order = await resolveCustomerOrder(customer);
  // Same fix as handleUpsellListTap above -- a real product pick must not
  // silently no-op just because this isn't the CURRENT pending offer
  // anymore (e.g. picking from an older bubble after already declining a
  // later one).
  if (!order || ['completed', 'cancelled'].includes(order.status)) return;

  if (order.pending_upsell_category) {
    order.pending_upsell_category = null;
    await pool.query('update "order" set pending_upsell_category = null where id = $1', [order.id]);
  }

  const added = [];
  for (const pick of picks) {
    const product = await productForRowId(pick.productId);
    if (!product) continue;
    const quantity = Math.max(1, Math.min(20, Math.trunc(Number(pick.quantity)) || 1));
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel: 'website', sender: 'customer', body: `[tapped: ${quantity}x ${product.name}]`, processed: true });
    await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, product.id, quantity, product.price, customer.id]);
    added.push(`${quantity}x ${product.name}`);
  }
  // preferTextForQuestions: true -- "dont take them back to the menu...
  // just ask them in webchat." Already on the free web chat page; a
  // redirect out to /m/:token for one short question is a worse
  // experience here than just asking it, same reasoning
  // handlePendingItemQuestion's own text-originated callers already use.
  if (!added.length) return finishItemsCollection(customer, order, '', { preferTextForQuestions: true });
  await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  return finishItemsCollection(customer, order, `Added ${added.join(', ')}. `, { preferTextForQuestions: true });
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
  const pendingQuestionId = order.pending_question_id;
  const pendingItemId = order.pending_question_order_item_id;
  // Chidera, 2026-09-25, real live report: "while placing my order after
  // the bot upsold me a drink and i chose cold it sent me double reply."
  // A genuine race, not a UI bug: this question can be answered two ways
  // almost at once (a dropdown tap and typed text arriving together, or
  // two rapid taps before the client's own in-flight guard registers) --
  // both requests read the SAME pending_question_id before either one
  // cleared it (the clear used to happen at the very END, after all the
  // real work), so both ran the full apply-and-reply path, each sending
  // its own "Got it..." message. Claiming the question atomically FIRST
  // (only clearing it if it's still what was just read) means the
  // second, losing request finds nothing left to claim and does nothing
  // more, instead of running the whole flow twice.
  const { rows: claimed } = await pool.query(
    `update "order" set pending_question_order_item_id = null, pending_question_id = null
     where id = $1 and pending_question_id = $2 returning id`,
    [order.id, pendingQuestionId]
  );
  if (!claimed.length) return; // someone else already answered this exact question
  order.pending_question_order_item_id = null;
  order.pending_question_id = null;

  const { rows: qRows } = await pool.query('select question from product_question where id = $1', [pendingQuestionId]);
  const questionText = qRows[0]?.question || '';

  await pool.query(
    `insert into order_item_answer (order_item_id, question_id, answer) values ($1, $2, $3)
     on conflict (order_item_id, question_id) do update set answer = excluded.answer`,
    [pendingItemId, pendingQuestionId, answer]
  );
  const { rows: itemRows } = await pool.query('select modification from order_item where id = $1', [pendingItemId]);
  const existingMod = itemRows[0]?.modification;
  const newMod = existingMod ? `${existingMod}; ${questionText}: ${answer}` : `${questionText}: ${answer}`;
  await pool.query('update order_item set modification = $1 where id = $2', [newMod, pendingItemId]);

  // finishItemsCollection's own item-question check (its very first thing)
  // picks up the next unanswered question itself if there is one -- no
  // need to duplicate that lookup here too. preferTextForQuestions --
  // they just answered this one by typing, so a second outstanding
  // question stays in text too, not a web-link detour.
  return finishItemsCollection(customer, order, 'Got it. ', { preferTextForQuestions: true });
}

// Chidera, 2026-09-24: "can i have it as a dropdown they can choose, and
// an optional type extra note if they have extra." routes/web-chat.js's
// own POST /:token/tap door for the select-plus-optional-note sheet
// (sendItemQuestionAsChoice's own interactive bubble) -- composes the
// exact same "Option (note)" shape the web menu page's own qSheet already
// stores (order_item_answer.answer is still just one plain string either
// way), then reuses handlePendingItemQuestion verbatim, same as a typed
// answer would. Deterministic, zero AI call, same shape as
// handleUpsellListTap/handleOrderConfirmYesTap.
export async function handleItemQuestionChoiceTap({ customer, option, note }) {
  const order = await resolveCustomerOrder(customer);
  // A stale tap (the order's moved on, or this question's already been
  // answered another way) -- nothing to do, same "stale tap = no-op"
  // reasoning as handleUpsellListTap's own guard.
  if (!order || !order.pending_question_id || ['completed', 'cancelled'].includes(order.status)) return;
  const trimmedOption = String(option || '').trim();
  if (!trimmedOption) return;
  const trimmedNote = String(note || '').trim();
  const answer = trimmedNote ? `${trimmedOption} (${trimmedNote})` : trimmedOption;
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel: 'website', sender: 'customer', body: `[selected: ${answer}]`, processed: true });
  return handlePendingItemQuestion(customer, order, answer);
}

// "Confirmed" (order.status) and "engine_state = confirm_order" are not the
// same fact -- engine_state stays confirm_order for both the yes/no ask AND
// the fulfilment questions that follow a yes, since delivery-vs-pickup
// still isn't decided yet either way. status flips to 'confirmed' the
// moment they say yes, which is what dispatch() below uses to tell "still
// deciding whether to order this" from "ordering it, now working out how it
// gets to them" -- asking for an address is not the same step as agreeing
// to buy.
export async function handleConfirmOrder(customer, order, text) {
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

  await markOrderConfirmed(customer, order);
}

// Chidera, 2026-09-20: "when they add on send them the yes to confirm
// button and place the ordr" -- the staff "table added more" alert
// (resetServedForAddOn) fires HERE, on the real yes, not the moment the
// item was inserted -- same two-step "shown, then confirmed" shape the
// very first round of an order already has. order.served_at still holds
// whatever it was before this round started (nothing resets it earlier
// anymore), so this is a genuine no-op for a first-ever order (never
// served yet) and the real, intended alert for a repeat add-on round on a
// table that had already been served. Shared by handleConfirmOrder (a
// genuine typed "yes") and handleOrderConfirmYesTap below (a tap on the
// button itself) so both converge on the exact same confirmation.
async function markOrderConfirmed(customer, order) {
  await pool.query(`update "order" set confirmed_at = now() where id = $1`, [order.id]);
  order.confirmed_at = new Date();
  await resetServedForAddOn(order);
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

// Buttons instead of plain text for the one field with a real small,
// fixed set of options worth tapping -- Chidera 2026-09-11: "make
// delivery or pickup clickable buttons." Every other field (branch,
// delivery address, ...) still goes through the plain-text fieldPrompt
// unchanged; this only intercepts fulfilment_type specifically. A tap
// sends its own title ("Delivery"/"Pickup") back through the normal text
// pipeline (webhook-whatsapp.js), so extractAndApply/applyField handle it
// exactly the same way a typed answer already does -- no new parsing.
export async function sendFieldPrompt(customer, fieldKey, promptText, trigger) {
  if (fieldKey === 'fulfilment_type' && (customer.channel === 'whatsapp' || customer.channel === 'website')) {
    const buttons = [
      { id: 'fulfilment_delivery', title: 'Delivery' },
      { id: 'fulfilment_pickup', title: 'Pickup' },
    ];
    if (customer.channel === 'website') {
      await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: promptText, trigger: trigger || 'bot_flow_step', interactive: { type: 'buttons', buttons } });
      return;
    }
    const credentials = await getWhatsAppCredentials(customer.branch_id);
    await sendWhatsAppButtons(recipientFor(customer), promptText, buttons, credentials);
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: promptText, trigger: trigger || 'bot_flow_step' });
    return;
  }
  await reply(customer, promptText, trigger);
}

// Buttons for the delivery-area yes/no confirmation -- same reasoning and
// same "tap sends its title back through the normal text pipeline, no new
// parsing" shape as sendFieldPrompt's fulfilment_type buttons just above
// (Chidera, 2026-09-16: "when bot is confirming a delivery address...let
// it use button clicks of yes and no"). A tap arrives as plain text
// ("Yes"/"No"), so handleCollectFulfilment's existing
// botEngine.extractField boolean classification below needs no changes at
// all -- it already understands "Yes"/"No" as well as any typed answer.
async function sendYesNoConfirm(customer, promptText) {
  if (customer.channel === 'whatsapp' || customer.channel === 'website') {
    const buttons = [
      { id: 'confirm_yes', title: 'Yes' },
      { id: 'confirm_no', title: 'No' },
    ];
    if (customer.channel === 'website') {
      await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: promptText, trigger: 'bot_flow_step', interactive: { type: 'buttons', buttons } });
      return;
    }
    const credentials = await getWhatsAppCredentials(customer.branch_id);
    await sendWhatsAppButtons(recipientFor(customer), promptText, buttons, credentials);
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: promptText, trigger: 'bot_flow_step' });
    return;
  }
  await reply(customer, promptText);
}

async function handleCollectFulfilment(customer, order, text) {
  // Dine-in (payment_mode = 'at_table') never asks for delivery/pickup or
  // takes payment through the bot -- spec 5.4: "settled at the table...
  // the order completes without a payment confirmation step." Still walks
  // the real state machine (confirm_payment -> payment_acceptance ->
  // fulfilment are the only legal next steps from confirm_order, see
  // bot_state's seed data), just with no message or wait at any of them --
  // same status handling completePayment gives every other order, minus
  // the delivery/pickup-specific messaging that makes no sense for someone
  // already sitting at the table.
  if (order.payment_mode === 'at_table') {
    await transitionOrder(order, 'confirm_payment');
    await transitionOrder(order, 'payment_acceptance');
    await pool.query(`update "order" set status = 'preparation' where id = $1`, [order.id]);
    await transitionOrder(order, 'fulfilment');
    await reply(customer, 'Your order has been placed. Thank you 🙏\n\nIt will be with you shortly.', 'dinein_order_placed');
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
        await sendFieldPrompt(customer, outstanding[0], `${answer} ${await fieldPrompt(outstanding[0], field?.question, order.branch_id)}`);
      } else {
        await sendFieldPrompt(customer, outstanding[0], await fieldPrompt(outstanding[0], field?.question, order.branch_id), 'field_reprompt');
      }
      return;
    }
    const { rows: reloaded } = await pool.query('select * from "order" where id = $1', [order.id]);
    Object.assign(order, reloaded[0]);
  }

  const stillOutstanding = await missingFulfilmentFields(order);
  if (stillOutstanding.length) {
    // Chidera, 2026-09-20: "let delivery/pickup details processing ... be
    // processes in the flow on the website to save cost" -- one web link
    // covers delivery-vs-pickup, the real address, AND (own_riders) a real
    // zone dropdown in a single visit, instead of the multi-message
    // text chain this used to be (delivery or pickup? -> address? ->
    // "is that X area?" -> confirm/retry ...). A customer who ignores the
    // link and just types an answer anyway still works exactly as before
    // (the `text !== null` block above this one is untouched) -- this is
    // the cheaper default, never the only path.
    const shownLink = await sendWebMenuLink(customer, 'Just need your delivery/pickup details -- tap below to finish up.', 'Finish my order', null, null, order);
    if (shownLink) return;
    const fields = await loadBotFields();
    const nextField = fields.find((f) => f.key === stillOutstanding[0]);
    await sendFieldPrompt(customer, stillOutstanding[0], await fieldPrompt(stillOutstanding[0], nextField?.question, order.branch_id));
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
            await sendYesNoConfirm(customer, `Got it, just to confirm, is that delivery to ${retry.name}?`);
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
          await sendYesNoConfirm(customer, `Just to confirm, is that delivery to ${zoneRows[0]?.name}?`);
          return;
        }
      } else if (!order.delivery_area_prompted_at) {
        const zone = await resolveZoneForAddress(customer.address, order.branch_id);
        if (zone) {
          await pool.query(`update "order" set delivery_zone_candidate_id = $1 where id = $2`, [zone.id, order.id]);
          order.delivery_zone_candidate_id = zone.id;
          await sendYesNoConfirm(customer, `Just to confirm, is that delivery to ${zone.name}?`);
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
          await sendYesNoConfirm(customer, `Just to confirm, is that delivery to ${zone.name}?`);
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
// Real Paystack integration, re-attached 2026-09-16 for a client who
// specifically wants auto-confirmation -- webhook-paystack.js's own
// auto-confirm only ever fires for a transaction that was actually
// initialized through Paystack, and nothing called
// initializePaystackTransaction anywhere until now. Deliberately per-
// business, not a return to a global "Pay now" link for everyone: the
// comment this replaced recorded why it was pulled in the first place
// (customers preferred plain bank details), and that's still true for
// every business that hasn't configured Paystack -- only
// PAYMENT_PROVIDER=paystack gets this path, everyone else keeps the exact
// bank-transfer flow unchanged. Falls back to bank details if the Paystack
// call itself fails (a network hiccup, a bad key) rather than leaving the
// customer stuck with neither.
// Shared by sendPaymentInstructions and its repeat-reminder counterpart --
// same real send, same reasoning (see buildPayLine's own comment on why
// the URL travels as a button, not embedded text) either time it's needed.
//
// Chidera, 2026-09-17: "cutting from ~15 to ~10 messages per order... but
// be careful let the current quality not drop" -- `bodyText` used to be a
// separate plain-text reply sent right before this (e.g. "Please pay NGN
// X using the button below."), immediately followed by this exact button
// with a near-empty body ("Tap below to pay securely."). WhatsApp's own
// CTA-URL body field already holds up to 1024 characters, so that lead-in
// text now travels AS the button's own body instead of its own separate
// message -- same information, same button, one send instead of two. Only
// on Instagram (no CTA-URL button type) does bodyText still need its own
// plain-text line ahead of the raw link.
async function sendPaymentLinkButton(customer, paymentUrl, bodyText) {
  if (customer.channel === 'instagram') {
    await reply(customer, `${bodyText}\n\nPay here: ${paymentUrl}`);
    return;
  }
  if (customer.channel === 'website') {
    await logMessage({
      customerId: customer.id, tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: customer.channel,
      sender: 'bot',
      body: `${bodyText}\n[payment link sent: ${paymentUrl}]`,
      trigger: 'payment_link',
      processed: true,
      // Chidera, 2026-09-24: "when i tap pay now and enter that paystack
      // stuff there is no back button to go back to web chat only the one
      // that goes back to the main chat." Paystack's checkout is a real
      // third-party page we don't control -- no button we add there can
      // get a customer "back to web chat" while they're on it, and a
      // WhatsApp in-app browser's own back chevron always returns to the
      // WhatsApp thread, not page history. Opening it in a NEW tab (unlike
      // "See menu"/"View invoice", which deliberately stay same-tab for
      // their own intentional round-trip back to this page) keeps THIS
      // chat tab genuinely still open behind it -- switching tabs (or just
      // closing the Paystack one once done) gets them back, something a
      // same-tab navigation into another domain can never guarantee.
      interactive: { type: 'cta_url', buttonText: 'Pay now', url: paymentUrl, newTab: true },
    });
    return;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), bodyText, 'Pay now', paymentUrl, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `${bodyText}\n[payment link sent: ${paymentUrl}]`, trigger: 'payment_link', processed: true });
}

// Chidera, 2026-09-20: "i want them to be able to pick transfer or card,
// transfer will give them number on pos while card the bot just waits to
// auto confirm payment... i need pos to work now for both online and in
// house." Dine-in's own Stage 3 (order_payment + matchPosTransactionToPayment,
// both real and already tested -- sandbox/test-dinein-pos-payment.mjs)
// already auto-confirms EITHER a transfer-to-the-terminal or a card tap
// the exact same way (both land as a real Moniepoint POS_TRANSACTION,
// matched by amount) -- so Transfer vs Card is purely which instructions
// the customer sees, never a different backend path. This reuses that
// same mechanism for a single online order instead of a table's split/
// joint one (covers_item_ids always null here -- one customer, one
// payment, the whole order).
async function createSingleOrderPayment(order, customerId) {
  const { rows: existing } = await pool.query(
    `select * from order_payment where order_id = $1 and status = 'pending' and covers_item_ids is null`,
    [order.id]
  );
  if (existing.length) return existing[0];
  const reference = `${order.reference}-P${randomBytes(3).toString('hex').toUpperCase()}`;
  const { rows } = await pool.query(
    `insert into order_payment (order_id, provider, reference, amount, covers_item_ids, paid_by_customer_id)
     values ($1, 'pos', $2, $3, null, $4) returning *`,
    [order.id, reference, order.total, customerId]
  );
  return rows[0];
}

// Chidera, 2026-09-20 (a second pass on the same feature): "when pos is
// selected the whole thing will still be inside the web na, for dine in
// it can be where the shared order ready to pay lives... make it 'ready
// to pay? click here'." The Transfer/Card choice itself lives on a real
// web page now (routes/menu-page.js's own /:token/pay, same shape as
// dine-in's own pay page), not WhatsApp quick-reply buttons -- this just
// sends the link into it, same CTA-URL pattern dine-in's own
// notifyGuestsReadyToPay already uses for its own "Ready to pay" button.
async function sendPosPaymentChoice(customer, order) {
  await createSingleOrderPayment(order, customer.id);
  if (!process.env.PUBLIC_URL) {
    await reply(customer, `Your order is ready to pay. Please ask a staff member for payment details.`, 'pos_pay_choice');
    return;
  }
  const token = await ensureMenuToken(customer);
  const url = `${process.env.PUBLIC_URL}/m/${token}/pay`;
  // Chidera, 2026-09-21: "look at my instagram flow... how does instagram
  // catch up" -- found live, this was built WhatsApp-only (no CTA-URL
  // button type on Instagram) with no fallback at all, unlike
  // sendPaymentLinkButton right above, which already has the correct
  // pattern -- an Instagram customer on POS would have hit this and
  // gotten nothing. Same fallback now: a plain text line with the real
  // link, auto-linkified by Instagram's own client.
  if (customer.channel === 'instagram') {
    await reply(customer, `Ready to pay?\n\n${url}`, 'pos_pay_choice');
    return;
  }
  // website: same /m/:token/pay page every channel already uses (Transfer/
  // Card choice, live payment-status polling) -- a bubble linking out to
  // it, not a real WhatsApp send. Full on-page POS parity (claim-tap etc.)
  // is Phase 2; this just closes the "falls through to a real send" gap.
  if (customer.channel === 'website') {
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[pay link sent: ${url}]`, trigger: 'pos_pay_choice', interactive: { type: 'cta_url', buttonText: 'Ready to pay?', url } });
    return;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), 'Ready to pay?', 'Click here', url, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[pay link sent: ${url}]`, trigger: 'pos_pay_choice' });
}

// Chidera, 2026-09-26: "instagram doesnt need the web chat, after linking
// monify, the back to merchant site button on instagram is taking customer
// back to web chat instead of the normal instagram chat" -- Monnify/
// Paystack's own "back to merchant" redirect was hardcoded to /wa/:token
// (the real web-chat page) for every channel, copied from the 2026-09-25
// fix that gave WEBSITE customers a real thread to return to. That's only
// ever right for the website channel -- WhatsApp/Instagram customers were
// never in that page to begin with. Same root cause, and same fix, as the
// 2026-09-21 "after i closed web from instagram it took me on whatsapp"
// bug already solved for the web menu page (engine/menu-page-template.js):
// wa.me/<digits> and ig.me/m/<handle> are each platform's own equivalent,
// intercepted by that app's own in-app browser to jump back into the real
// chat. Returns null (no redirect) rather than guessing wrong when neither
// number/handle is configured -- same fallback the menu page already uses.
export async function resolveBackToChatUrl(customer, menuToken) {
  if (customer.channel === 'website') {
    return process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}/wa/${menuToken}` : null;
  }
  if (customer.channel === 'instagram') {
    const { rows } = await pool.query(
      `select instagram_handle from branch
       where instagram_handle is not null and instagram_handle != ''
       order by (id = $1) desc
       limit 1`,
      [customer.branch_id]
    );
    const handle = rows[0]?.instagram_handle || null;
    return handle ? `https://ig.me/m/${handle}` : null;
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  const waNumber = await getWaDisplayNumber(credentials);
  const digits = String(waNumber || '').replace(/\D/g, '');
  return digits ? `https://wa.me/${digits}` : null;
}

async function buildPayLine(order, customer, { amount, amountLabel }) {
  const paymentConfig = await getPaymentConfig();
  // provider === 'pos' -- Settings' own explicit choice, always wins.
  // No configured row (or a row with no provider set) falls through to the
  // exact same PAYMENT_PROVIDER env-var check every existing client
  // already runs on today -- see payment_config's own schema comment for
  // why this must never change behavior on its own.
  if (paymentConfig?.provider === 'pos') {
    return { payLine: null, needsHandover: false, paymentUrl: null, posChoice: true };
  }
  // Chidera, 2026-09-23: "monify first" -- Monnify's dynamic bank-transfer
  // account. Unlike Paystack, there's no legacy env-var fallback to
  // consider here (this provider never existed before payment_config did),
  // so it only ever activates on an explicit Settings choice.
  if (paymentConfig?.provider === 'monnify') {
    try {
      // Chidera, 2026-09-24: "the monnify account that was sent is
      // unavailable and invalid and cant it be a link like paystack? so the
      // auto confirm can be obvious." A real hosted checkout link now
      // (initializeMonnifyTransaction returns the URL string directly,
      // same contract as initializePaystackTransaction below), not account
      // details rendered into the text -- same "using the button below"
      // wording Paystack's own branch uses, same paymentUrl handling in
      // sendPaymentInstructions (sendPaymentLinkButton), no special-casing.
      // Chidera, 2026-09-25: "why isnt customer auto taken back to web
      // chat after payment with monify?" -- same callbackUrl fix
      // Paystack's own branch below already has. 2026-09-26: that fix was
      // web-chat-only and got applied to every channel -- resolveBackToChatUrl
      // (its own comment above) sends WhatsApp/Instagram customers back to
      // their real app instead.
      const monnifyMenuToken = await ensureMenuToken(customer);
      const monnifyCallbackUrl = (await resolveBackToChatUrl(customer, monnifyMenuToken)) || undefined;
      const url = await initializeMonnifyTransaction({ order, customer, amount, callbackUrl: monnifyCallbackUrl });
      if (url) {
        // Chidera, real live report right after the checkout-link switch:
        // "that dynamic monify account is showing me as invalid and
        // unavailable" -- confirmed live (opened the actual link Monnify
        // sent back): the checkout session itself had genuinely expired,
        // a real, expected time limit on Monnify's own end. Follow-up:
        // "i cant text you, it should be auto regenerated" -- also
        // confirmed live that Monnify's own "Try again" button on an
        // expired session doesn't work either, just loops back to the
        // same dead transaction. Fixed properly now:
        // refreshExpiringPaymentLinks (this file, called from server.js
        // every 2 minutes) proactively regenerates a fresh link before
        // the customer would ever see "expired" at all -- no reply from
        // them needed, so this text doesn't need to explain a manual
        // workaround that no longer exists.
        return {
          payLine: `Please pay NGN ${amountLabel} using the button below.\n\nYour order moves to preparation automatically the moment payment goes through -- no need to send proof.`,
          needsHandover: false,
          paymentUrl: url,
        };
      }
    } catch (err) {
      console.error(`Monnify checkout link failed for order ${order.id}, falling back to bank details: ${err.message}`);
    }
  }
  // Chidera, 2026-09-23: "so what of opay?" -- same shape as Monnify above,
  // OPay's own dynamic bank-transfer account. No "Account name" line --
  // OPay's own response never returns one (see opay-api.js's own comment).
  if (paymentConfig?.provider === 'opay') {
    try {
      const result = await initializeOpayTransaction({ order, customer, amount });
      if (result) {
        const validityLine = result.expiresAt
          ? ` (valid for the next ${Math.max(1, Math.round((new Date(result.expiresAt).getTime() - Date.now()) / 60000))} minutes)`
          : '';
        return {
          payLine: `Please pay NGN ${amountLabel} using the account below${validityLine}.\n\nBank: ${result.bankName}\nAccount number: ${result.accountNumber}\n\nYour order moves to preparation automatically the moment payment goes through -- no need to send proof.`,
          needsHandover: false,
          paymentUrl: null,
        };
      }
    } catch (err) {
      console.error(`OPay dynamic account failed for order ${order.id}, falling back to bank details: ${err.message}`);
    }
  }
  const useProviderPaystack = paymentConfig?.provider ? paymentConfig.provider === 'paystack' : process.env.PAYMENT_PROVIDER === 'paystack';
  if (useProviderPaystack && process.env.PAYMENT_SECRET_KEY) {
    try {
      // Chidera, 2026-09-23: "when i click pay now and go to pay stack i
      // cant see back to chat." Every customer already has (or gets, right
      // here) a persistent menu_token -- Paystack redirects back to this
      // exact chat page once payment finishes, same "Back to chat" idea
      // documents.js's invoice page already got. 2026-09-26: same fix as
      // Monnify's own branch above -- resolveBackToChatUrl instead of
      // always /wa/:token, so WhatsApp/Instagram customers land back in
      // their real app, not the web-chat page they never used.
      const menuToken = await ensureMenuToken(customer);
      const callbackUrl = (await resolveBackToChatUrl(customer, menuToken)) || undefined;
      const url = await initializePaystackTransaction({ order, customer, amount, callbackUrl });
      if (url) {
        // Chidera, 2026-09-16: "i actually got a payment link o, but it
        // opened out of whatsapp not in" -- the URL used to be embedded
        // straight into this plain-text line, so WhatsApp rendered it as
        // an ordinary tappable link (opens the phone's own browser, same
        // as any link in any text message). paymentUrl is now returned
        // separately so the caller can send it as a real CTA-URL button
        // instead, exactly like the menu link and the handover link
        // already do -- opens inside WhatsApp's own in-app browser.
        return {
          payLine: `Please pay NGN ${amountLabel} using the button below.\n\nYour order moves to preparation automatically the moment payment goes through -- no need to send proof.`,
          needsHandover: false,
          paymentUrl: url,
        };
      }
    } catch (err) {
      console.error(`Paystack initialize failed for order ${order.id}, falling back to bank details: ${err.message}`);
    }
  }
  const { rows: biz } = await pool.query('select bank_name, bank_account_number, bank_account_name from business limit 1');
  const b = biz[0] || {};
  const hasBankDetails = b.bank_name && b.bank_account_number && b.bank_account_name;
  return {
    payLine: hasBankDetails
      ? `Please pay NGN ${amountLabel}.\n\nBank: ${b.bank_name}\nAccount number: ${b.bank_account_number}\nAccount name: ${b.bank_account_name}\n\nThen send proof of payment here.`
      : `Your total is NGN ${amountLabel}. Let me get someone to confirm payment details with you.`,
    needsHandover: !hasBankDetails,
    paymentUrl: null,
  };
}

export async function sendPaymentInstructions(customer, order) {
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
  // Chidera, 2026-09-25: "the invoice and pay now should be one chat" --
  // website's own document bubble used to be logged here, separately,
  // then a SECOND bubble carrying the actual pay line (and, when an
  // online payment link exists, its own "Pay now" cta_url button) went
  // out right after. Only the URL is captured here now; the invoice HTML
  // page itself already embeds a "Pay now" button reading the same
  // order.payment_link_url (routes/documents.js's own documentPage), so
  // one combined bubble covers both without inventing a second
  // interactive type.
  let invoiceWebsiteUrl = null;
  if (process.env.PUBLIC_URL) {
    try {
      const invoicePdfUrl = `${process.env.PUBLIC_URL}${invoicePath}/pdf`;
      if (customer.channel === 'instagram') {
        // Chidera, 2026-09-26: "on instagram the invoice is taking me to
        // facebook, it should open in the web app" -- sending the raw PDF
        // as a file attachment (sendInstagramDocument) made Instagram open
        // it in its own Facebook-branded document viewer instead. Deliberately
        // not sending anything here -- invoiceSent stays false (not set below,
        // unlike the other two branches), so the same invoiceUrl text-link
        // fallback every OTHER failed-PDF case already falls back to (a few
        // lines below) fires here too, linking straight to the plain HTML
        // invoice page instead of a PDF.
      } else if (customer.channel === 'website') {
        // website: link to the plain HTML invoice page (routes/documents.js's
        // GET /invoice/:orderId), not the /pdf route -- the customer's
        // already in a browser, so there's no reason to round-trip through
        // Gotenberg (an internal docker-only service, unreachable outside
        // the compose network) just to hand them back a page they could've
        // viewed directly. Found live, 2026-09-23: linking to /pdf here
        // marked invoiceSent=true unconditionally, without this try/catch
        // ever actually rendering anything -- the button looked fine but
        // failed the moment a customer tapped it ("the invoice link keeps
        // not opening, an invalid link").
        invoiceWebsiteUrl = `${process.env.PUBLIC_URL}${invoicePath}`;
        invoiceSent = true;
      } else {
        await sendWhatsAppDocument(recipientFor(customer), invoicePdfUrl, `invoice-${order.reference}.pdf`, `Invoice for order ${order.reference}`);
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[invoice PDF] ${invoicePdfUrl}`, trigger: 'invoice_pdf' });
        invoiceSent = true;
      }
    } catch (err) {
      console.error(`Failed to send invoice PDF, falling back to a text link: ${err.message}`);
    }
  }
  // Invoice always comes first, on its own -- it's the compulsory receipt of
  // what's being bought, not a footnote on the payment line. Always followed
  // by bank details now -- see the note above the function.
  const invoiceUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${invoicePath}` : null;
  // "attached above" is only true for WhatsApp/Instagram (a genuinely
  // separate, earlier real document send there) -- on website it's the
  // SAME bubble, and the document/interactive part always renders BELOW
  // the body text (renderMessage's own body-then-actions order). Same fix
  // as completePayment's own receiptLine, see its comment.
  const invoiceLine = invoiceSent
    ? customer.channel === 'website'
      ? `Your invoice is attached below.`
      : `Your invoice is attached above.`
    : invoiceUrl
      ? `Here's your invoice: ${invoiceUrl}`
      : `Your invoice for this order is ready.`;
  // Silent up until now -- the customer only agreed to the items total
  // earlier in "confirm order" (delivery fee wasn't known yet then). Stated
  // here so the amount they're about to pay never comes as a surprise.
  const deliveryFeeLine = deliveryFee > 0 ? ` (includes NGN ${deliveryFee} delivery fee)` : '';
  // Structured, one fact per line -- same reasoning as the item-by-item
  // price confirmation (Chidera's earlier call: "structured line by line
  // way not paragraph"), now for the bank details too. Chidera 2026-09-11:
  // "that message that comes before invoice should stop showing in a
  // paragraph form and show in a structured manner." A bank name, account
  // number, and account name run together in one comma sentence is
  // exactly the kind of thing that's easy to misread or fat-finger
  // copying out -- each on its own line reads the way a real transfer
  // slip would.
  const { payLine, needsHandover, paymentUrl, posChoice } = await buildPayLine(order, customer, { amount: total, amountLabel: `${total}${deliveryFeeLine}` });
  if (customer.channel === 'website' && invoiceWebsiteUrl) {
    // Chidera, 2026-09-25: "when i said invoice and pay now in same chat i
    // meant itll have 2 buttons not just the pay now in the invoice" --
    // a real, separate "Pay now" button right on this bubble (not only
    // the invoice page's own embedded one) whenever there's an actual
    // online payment link to pay with. POS (Transfer/Card) has no single
    // paymentUrl to attach here -- it keeps its own separate choice
    // message right after, same as before.
    await logMessage({
      customerId: customer.id,
      tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: customer.channel,
      sender: 'bot',
      body: posChoice ? invoiceLine : `${invoiceLine}\n\n${payLine}`,
      trigger: 'invoice_pdf',
      interactive: {
        type: 'document',
        filename: `invoice-${order.reference}`,
        url: invoiceWebsiteUrl,
        ...(paymentUrl && !posChoice ? { payUrl: paymentUrl, payLabel: 'Pay now' } : {}),
      },
    });
    if (posChoice) await sendPosPaymentChoice(customer, order);
  } else if (posChoice) {
    // A CTA-URL button (paymentUrl) or plain text can carry the invoice
    // line inline, but a Transfer/Card choice needs its own real WhatsApp
    // buttons message -- sent separately, same multi-message shape the
    // invoice PDF + payment link already use today.
    await reply(customer, invoiceLine);
    await sendPosPaymentChoice(customer, order);
  } else if (paymentUrl) {
    await sendPaymentLinkButton(customer, paymentUrl, `${invoiceLine}\n\n${payLine}`);
  } else {
    await reply(customer, `${invoiceLine}\n\n${payLine}`);
  }
  // ackText false -- payLine already told them someone will confirm payment
  // details (see above), same double-ack bug as the others fixed 2026-09-03.
  if (needsHandover) await handover(customer, 'Order ready for payment but no payment method is configured for this business yet', null, false);
}

// Chidera, 2026-09-24: "if a staff make paid with cash and put amount the
// bot would send a link for transfer of outstanding balance na" -- a real
// gap: cash_collected used to be purely a recorded number, nothing ever
// compared it against the order total or told the customer anything.
// Scoped to just the shortfall, not sendPaymentInstructions' whole flow --
// no second invoice send (the table's already been served and invoiced),
// just the amount still owed. Reuses buildPayLine, the same place every
// other payment link in this file goes through, so whichever provider
// this business has configured (Monnify/OPay/Paystack/bank-details/POS)
// just works here too, automatically.
export async function sendOutstandingBalanceLink(customer, order, amount) {
  const { payLine, needsHandover, paymentUrl, posChoice } = await buildPayLine(order, customer, { amount, amountLabel: `${amount}` });
  const intro = `You paid NGN ${Number(order.cash_collected || 0).toLocaleString()} in cash for order ${order.reference} -- there's still NGN ${amount} left to pay.`;
  if (posChoice) {
    await reply(customer, intro);
    await sendPosPaymentChoice(customer, order);
    return;
  }
  if (paymentUrl) {
    await sendPaymentLinkButton(customer, paymentUrl, `${intro}\n\n${payLine}`);
  } else {
    await reply(customer, `${intro}\n\n${payLine}`);
  }
  if (needsHandover) await handover(customer, 'Dine-in table has an outstanding cash balance but no payment method is configured for this business yet', null, false);
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
async function resolveGeneralAvailability(customer, isGeneralAvailability, answer, rawText, branchId) {
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

  // Proof already sent -- Chidera 2026-09-11: "why did bot tell me to pay
  // again after i sent okay, when ive already send receipt of payment."
  // engine_state stays 'confirm_payment' the whole time proof is under
  // review (only handleInboundMedia's own insert moves payment_status to
  // 'proof_submitted', see flow.js's payment-proof handler), so a plain ack
  // ("okay", "alright") landing here before staff confirm it used to fall
  // straight into the reminder below and re-quote the bank details -- reads
  // as ignoring the receipt they just sent. Checked ahead of the reminder
  // logic below, not folded into it, since this should say the same thing
  // every single time, not just once.
  if (order.payment_status === 'proof_submitted') {
    await reply(customer, `Still confirming your payment, I'll let you know shortly.`, 'payment_wait_ack');
    return;
  }

  if (order.payment_reminder_sent_at) {
    await reply(customer, `Still waiting on your payment, I'll confirm as soon as it comes through.`, 'payment_wait_ack');
    return;
  }
  await sendPaymentReminder(customer, order);
}

// Extracted from handleWaitingOnPayment above -- the actual "here's how to
// pay, again" send, shared with sweepAbandonedWebChatOrders below (the
// abandonment nudge, Phase 2 of the web-chat feature). Caller's job to
// check order.payment_reminder_sent_at first: handleWaitingOnPayment only
// gets here once, right after its own check; the sweep's own SQL query
// already filters to payment_reminder_sent_at is null, so it's never
// re-checked here -- one source of truth for "has this order's ONE
// reminder already gone out," never two competing guards.
async function sendPaymentReminder(customer, order) {
  await pool.query(`update "order" set payment_reminder_sent_at = now() where id = $1`, [order.id]);

  // Same buildPayLine as sendPaymentInstructions -- this is the same
  // underlying fact (how to pay), just on a repeat reminder, so it must
  // never say something different (a stale bank-transfer reminder after
  // the business switched to Paystack would be a real lie).
  const { payLine, needsHandover, paymentUrl } = await buildPayLine(order, customer, { amount: order.total, amountLabel: order.total });
  if (paymentUrl) {
    await sendPaymentLinkButton(customer, paymentUrl, payLine);
  } else {
    await reply(customer, payLine, 'payment_reminder');
  }
  if (needsHandover) await handover(customer, 'Customer waiting on payment but no payment link/bank details are available', null, false);
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
const PAYMENT_NUDGE_MINUTES = 20;
const WEB_CHAT_ACTIVE_WINDOW_MINUTES = 30;

export async function sweepAbandonedWebChatOrders() {
  const { rows: candidates } = await pool.query(
    `select o.* from "order" o
     join customers c on c.id = o.customer_id
     where o.engine_state = 'confirm_payment'
       and o.payment_status = 'pending'
       and o.payment_reminder_sent_at is null
       and o.channel in ('whatsapp', 'instagram')
       and o.updated_at < now() - make_interval(mins => $1)
       and (c.web_chat_active_at is null or c.web_chat_active_at < now() - make_interval(mins => $2))`,
    [PAYMENT_NUDGE_MINUTES, WEB_CHAT_ACTIVE_WINDOW_MINUTES]
  );
  for (const order of candidates) {
    const { rows: customerRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
    const customer = customerRows[0];
    if (!customer) continue;
    try {
      await sendPaymentReminder(customer, order);
    } catch (err) {
      console.error(`Abandonment nudge failed for order ${order.id}:`, err);
    }
  }
  if (candidates.length) console.log(`Sent ${candidates.length} abandonment nudge(s).`);
}

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
const ORDER_ABANDONMENT_NUDGE_MINUTES = 10;

export async function sweepAbandonedChatCustomers() {
  const { rows: candidates } = await pool.query(
    `select c.* from customers c
     where c.last_message_at is not null
       and c.last_message_at < now() - make_interval(mins => $1)
       and c.channel in ('whatsapp', 'instagram')
       and (c.web_chat_active_at is null or c.web_chat_active_at < now() - make_interval(mins => $1))
       -- Chidera, 2026-09-25, real live incident: two customers whose
       -- 24h WhatsApp session window was closed got the same nudge
       -- resent every ~2 minutes, chat_redirect_count climbing forever.
       -- Root cause: logMessage touches last_message_at for EVERY
       -- message, including the system's OWN outbound sends -- when a
       -- send failed and engine/flow.js's retryFailedSendAsTemplate
       -- retried it (webhook-whatsapp.js's status handler, error 131047),
       -- THAT retry's own logMessage call pushed last_message_at past
       -- chat_redirect_sent_at, which this guard misread as "the
       -- customer engaged again" -- rearming itself using a signal the
       -- system's own retry had just touched, not anything the customer
       -- did. web_chat_active_at is the only signal here that's NEVER
       -- touched by an outbound send (only a genuine page visit) --
       -- needsChatRedirect's own, already-correct guard only ever used
       -- this one signal too, never last_message_at.
       and (c.chat_redirect_sent_at is null or c.web_chat_active_at > c.chat_redirect_sent_at)
       and not exists (
         select 1 from "order" o where o.customer_id = c.id and o.engine_state in ('confirm_payment', 'fulfilment', 'completed')
       )
       and not exists (
         select 1 from table_session ts where ts.closed_at is null
           and (ts.customer_id = c.id or exists (select 1 from table_session_guest g where g.session_id = ts.id and g.customer_id = c.id))
       )`,
    [ORDER_ABANDONMENT_NUDGE_MINUTES]
  );
  for (const customer of candidates) {
    try {
      await sendChatRedirectPing(
        customer,
        "Hey, we noticed you didn't go on with your order. Tap below to continue with your order.",
        { trigger: 'order_abandonment_nudge' }
      );
    } catch (err) {
      console.error(`Order abandonment nudge failed for customer ${customer.id}:`, err);
    }
  }
  if (candidates.length) console.log(`Sent ${candidates.length} order abandonment nudge(s).`);
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
// Removing an order_item that still has an item-customization question
// pending on it (order.pending_question_order_item_id -- "peppered or
// not?", asked per-item, see line ~1136) hit the row's own foreign key
// live, 2026-09-11: deleting it while that column still pointed at it
// threw order_pending_question_order_item_id_fkey, a 500 on both the AI
// "remove X" path and the web menu's "Review order" (a removed item that
// happened to still be mid-question). Clearing the pointer first -- same
// as a normal answer would once it's actually answered -- is the fix,
// not skipping the delete or working around the constraint.
async function clearPendingQuestionIfOnItem(order, orderItemId) {
  if (order.pending_question_order_item_id !== orderItemId) return;
  order.pending_question_order_item_id = null;
  order.pending_question_id = null;
  await pool.query('update "order" set pending_question_order_item_id = null, pending_question_id = null where id = $1', [order.id]);
}

// customer -- Chidera, 2026-09-20, real report: "what do you mean by a
// guest-chicken... was it not the same number that ordered chicken
// through an upsell? why are you seperating it?" Root cause: this insert
// never set added_by_customer_id at all, unlike the web-menu review
// route's own item insert (which always does) -- so any item added
// through a typed-chat path, upsell acceptance included
// (handlePendingUpsell below), landed with added_by_customer_id null,
// and pendingOrderPayload's labelFor falls back to "a guest" for a null
// id no matter whose real number it actually was. Now attributed to
// whichever customer is actually in this conversation, same as every
// other item-adding path already does.
export async function applyOrderModifications(order, mods, { allowRemovals }, customer) {
  const { rows: existingItems } = await pool.query('select id, product_id, quantity from order_item where order_id = $1', [order.id]);
  let addedValue = 0;

  for (const item of mods.adds) {
    const existing = existingItems.find((e) => e.product_id === item.productId);
    if (existing) {
      await pool.query('update order_item set quantity = quantity + $1 where id = $2', [item.quantity, existing.id]);
    } else {
      await pool.query('insert into order_item (order_id, product_id, quantity, price, added_by_customer_id) values ($1, $2, $3, $4, $5)', [order.id, item.productId, item.quantity, item.price, customer?.id || null]);
    }
    addedValue += item.quantity * Number(item.price);
  }

  if (allowRemovals) {
    for (const item of mods.removes) {
      const existing = existingItems.find((e) => e.product_id === item.productId);
      if (existing) await clearPendingQuestionIfOnItem(order, existing.id);
      await pool.query('delete from order_item where order_id = $1 and product_id = $2', [order.id, item.productId]);
    }
    for (const item of mods.sets) {
      await pool.query('update order_item set quantity = $1 where order_id = $2 and product_id = $3', [item.quantity, order.id, item.productId]);
    }
  }

  const { itemLines, total, deliveryFee } = await summariseOrder(order);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
  // Chidera, 2026-09-20, real report: "after requesting payment and its
  // pending i added another water... it kept showing me old stale
  // amount" -- same fix as routes/dinein-menu.js's own /review route, for
  // this (typed-chat) add-on path. Any PENDING order_payment is frozen at
  // whatever the order totalled when it was requested; a real item change
  // makes that stale regardless of which channel added it. Confirmed
  // payments are real money already received and untouched here.
  if (mods.adds.length || (allowRemovals && (mods.removes.length || mods.sets.length))) {
    await pool.query(`delete from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  }
  // A dine-in order already marked served that gets something added to it
  // needs serving again -- back to In House's first pipeline, not sitting
  // in the second (awaiting payment) still showing the old items. Chidera
  // 2026-09-11: "even if staff marks served and it goes to the next
  // pipeline and they still add it should go back to first pipeline."
  //
  // Deliberately NOT fired here anymore -- Chidera, 2026-09-20: "when they
  // add on send them the yes to confirm button and place the ordr." This
  // used to fire the moment an item was inserted, before the customer had
  // even confirmed the add-on -- staff could see "back to Serving" before
  // the guest had actually decided to go through with it. handleConfirmOrder
  // now calls resetServedForAddOn itself, on the real yes tap, same two-
  // step "shown, then confirmed" shape the very first round already has.
  return { itemLines, total, deliveryFee, addedValue };
}

// Adding items to an already-paid order gets its own, smaller invoice --
// only what's newly owed, not the whole order total again (the rest is
// already paid). Chidera 2026-09-11: "calculate only their new add on and
// send them an invoice for top up, no need for hsndvover just take the
// order normally" -- no escalation to a human here, staff instead see it
// land in the order's own page (OrderDetail.jsx's Top-ups card), the same
// way the payment-proof gallery replaces a handover ping for a repeat
// proof image.
async function sendTopupInvoice(customer, order, addedItems, addedValue) {
  const snapshot = addedItems.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price }));
  const { rows: topupRows } = await pool.query(
    `insert into order_topup (order_id, items, amount) values ($1, $2, $3) returning id`,
    [order.id, JSON.stringify(snapshot), addedValue]
  );
  const topupId = topupRows[0].id;
  const itemLines = snapshot.map((i) => `${i.quantity}x ${i.name} -- NGN ${i.quantity * Number(i.price)}`).join('\n');

  const invoicePath = `/documents/topup/${topupId}`;
  let invoiceSent = false;
  if (process.env.PUBLIC_URL) {
    try {
      const invoicePdfUrl = `${process.env.PUBLIC_URL}${invoicePath}/pdf`;
      if (customer.channel === 'instagram') {
        // Same fix as sendPaymentInstructions' own 2026-09-26 comment above --
        // no PDF file attachment for Instagram (opens via its own Facebook-
        // branded viewer); invoiceSent stays false so the invoiceUrl
        // text-link fallback below links to the plain HTML page instead.
      } else if (customer.channel === 'website') {
        // Same fix as sendPaymentInstructions' website branch above -- link
        // to the plain HTML topup invoice page, not /pdf (Gotenberg-backed,
        // internal-only, and never actually rendered before this bubble was
        // marked "sent").
        const invoiceHtmlUrl = `${process.env.PUBLIC_URL}${invoicePath}`;
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[topup invoice] ${invoiceHtmlUrl}`, trigger: 'topup_invoice_pdf', interactive: { type: 'document', filename: `topup-${order.reference}`, url: invoiceHtmlUrl } });
        invoiceSent = true;
      } else {
        await sendWhatsAppDocument(recipientFor(customer), invoicePdfUrl, `topup-${order.reference}.pdf`, `Top-up invoice for order ${order.reference}`);
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[topup invoice PDF] ${invoicePdfUrl}`, trigger: 'topup_invoice_pdf' });
        invoiceSent = true;
      }
    } catch (err) {
      console.error(`Failed to send top-up invoice PDF, falling back to a text link: ${err.message}`);
    }
  }
  const invoiceUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${invoicePath}` : null;
  const invoiceLine = invoiceSent
    ? `Your top-up invoice is attached above.`
    : invoiceUrl
      ? `Here's your top-up invoice: ${invoiceUrl}`
      : `Your top-up invoice is ready.`;

  // Chidera, 2026-09-20: "totally stop sending account number for era
  // demo and use just paystack" -- used to be deliberately bank-transfer-
  // only (own comment here said reusing order.reference would collide
  // with the original payment's own Paystack transaction). Now that every
  // reference is unique per attempt (payment.js's callPaystackInitialize),
  // that blocker's gone -- try Paystack first, same as buildPayLine
  // already does for the main order, falling back to bank details only
  // when Paystack genuinely isn't configured or the call itself fails.
  let paymentUrl = null;
  if (process.env.PAYMENT_PROVIDER === 'paystack' && process.env.PAYMENT_SECRET_KEY) {
    try {
      // 2026-09-26: same fix as sendPaymentInstructions' own Paystack/Monnify
      // branches -- resolveBackToChatUrl instead of always /wa/:token.
      const menuToken = await ensureMenuToken(customer);
      const callbackUrl = (await resolveBackToChatUrl(customer, menuToken)) || undefined;
      paymentUrl = await initializePaystackTopupTransaction({ topupId, order, customer, amount: addedValue, callbackUrl });
    } catch (err) {
      console.error(`Paystack initialize failed for topup ${topupId}, falling back to bank details: ${err.message}`);
    }
  }
  if (paymentUrl) {
    const payLine = `Please pay NGN ${addedValue} for the extra item(s) using the button below.`;
    await sendPaymentLinkButton(customer, paymentUrl, `Got it, added on:\n${itemLines}\n\n${invoiceLine}\n\n${payLine}`);
    return;
  }
  const { rows: biz } = await pool.query('select bank_name, bank_account_number, bank_account_name from business limit 1');
  const b = biz[0] || {};
  const hasBankDetails = b.bank_name && b.bank_account_number && b.bank_account_name;
  const payLine = hasBankDetails
    ? `Please pay NGN ${addedValue} for the extra item(s).\n\nBank: ${b.bank_name}\nAccount number: ${b.bank_account_number}\nAccount name: ${b.bank_account_name}\n\nThen send proof of payment here.`
    : `You owe an extra NGN ${addedValue} for this. Let me get someone to confirm payment details with you.`;

  await reply(customer, `Got it, added on:\n${itemLines}\n\n${invoiceLine}\n\n${payLine}`);
  if (!hasBankDetails) await handover(customer, 'Top-up order ready for payment but no payment method is configured for this business yet', null, false);
}

async function handleOrderModification(customer, order, mods) {
  const paid = order.payment_status === 'confirmed' || order.payment_status === 'accepted';
  // Captured before applyOrderModifications -- Chidera, 2026-09-20: "when
  // they add on send them the yes to confirm button and place the ordr."
  // Dine-in never sets payment_status to confirmed/accepted until it's
  // actually marked paid post-serving (payment happens AFTER eating), so
  // `paid` above is always false for a served-but-unpaid table -- an
  // add-on there used to fall all the way through to the same full "Got
  // it, your order: [the WHOLE running bill] New total... confirm?"
  // re-ask every other pre-payment edit gets. wasAlreadyConfirmed (this
  // order already went through its own real yes once before) is what
  // actually distinguishes a repeat add-on from the genuinely first-ever
  // order -- a repeat round still gets its own real yes/no confirm gate,
  // just scoped to what's new (deltaLines below), not the whole order
  // restated again.
  const wasAlreadyConfirmed = Boolean(order.confirmed_at);
  // Chidera, 2026-09-25: "if a customer places an order in dine in and
  // changes it in a form of reduction... kitchen would have already
  // started preparing order and theyll get a price reduction for what
  // has been placed?" A real gap the `paid` check above never covers --
  // dine-in's own payment_status stays 'pending' the whole meal (settled
  // at the end, not up front, see this function's own comment above), so
  // a round already confirmed and sent to the kitchen (confirming a round
  // IS what dispatches it -- markOrderConfirmed's "place the ordr") could
  // still have items silently removed and the price quietly dropped, with
  // no one on staff any the wiser that food already being cooked just got
  // taken off the bill. Same escalate-to-a-human treatment as an
  // already-paid order gets below, just gated on "already sent to the
  // kitchen" instead of "already paid" for this one channel.
  const alreadySentToKitchen = order.payment_mode === 'at_table' && wasAlreadyConfirmed;

  if ((paid || alreadySentToKitchen) && (mods.removes.length || mods.sets.length)) {
    // A change/removal after payment needs a real person -- Chidera
    // 2026-09-11: "after payment is made if they want to add take it and
    // add it, but if they want to change, hand it over to a human."
    // Adding more still goes straight through below unchanged (falls
    // through to the adds-only branch when mods.adds is also non-empty);
    // it's only removing or changing what's already paid for (or, for
    // dine-in, already sent to the kitchen) that gets escalated instead
    // of just being declined.
    await reply(
      customer,
      paid
        ? `Your order's already paid for, so I can't remove or change what's in it myself -- let me get someone to help with that.`
        : `That order is already gone to the kitchen, so I can't remove or change what's in it myself -- let me get someone to help with that.`
    );
    // Chidera, 2026-09-25: "then tell staff in handover text what is the
    // table name, what they also want to remove" -- same reasoning as
    // routes/dinein-menu.js's own web-basket-resubmit version of this
    // exact escalation (its own comment has the full story); this is the
    // typed-chat path (a dine-in guest typing "remove the rice" instead of
    // using the menu page), table_id is null for a paid online order so
    // that line is simply omitted there, not shown blank.
    const removedLines = [...mods.removes.map((i) => `${i.quantity}x ${i.name}`), ...mods.sets.map((i) => `${i.name} to ${i.quantity}`)];
    const { rows: tableRowsForHandover } = order.table_id
      ? await pool.query('select label from restaurant_table where id = $1', [order.table_id])
      : { rows: [] };
    await handover(
      customer,
      paid ? 'Customer wants to remove or change items on an already-paid order' : 'Customer wants to remove or change items already sent to the kitchen',
      {
        table: tableRowsForHandover[0] ? `Table: ${tableRowsForHandover[0].label}` : null,
        wants: removedLines.length ? `Wants to remove/change: ${removedLines.join(', ')}` : null,
      },
      false
    );
    if (!mods.adds.length) return;
  }

  const { itemLines, total, deliveryFee, addedValue } = await applyOrderModifications(order, mods, { allowRemovals: !(paid || alreadySentToKitchen) }, customer);
  // Chidera, 2026-09-23, live report on era-demo: "it gave me a bill of
  // food with total of 4700 my food way 1700 but it didnt state the
  // delivery there, one could easily misunderstand" -- summariseOrder's
  // own `total` has always silently included delivery_fee, this message
  // only ever listed the items. Same fix as handleWebMenuOrder's own
  // confirm message.
  const summary = deliveryFee > 0 ? `${itemLines.join('\n')}\nDelivery fee: NGN ${deliveryFee}` : itemLines.join('\n');

  if (paid) {
    await sendTopupInvoice(customer, order, mods.adds, addedValue);
    return;
  }

  // Pure addition only -- a removal or change alongside it is a rarer,
  // more substantial edit that still deserves the fuller read-back below,
  // not folded into a quick "add on" confirm that would silently skip
  // over what was taken off. preferTextForQuestions -- this whole path
  // only runs from a TYPED reply (dispatch's own mods-detection), so any
  // item question the new line needs stays in text too (Chidera,
  // 2026-09-20, real report re Emmanuel: "if they are already using text
  // no need to send them back to the menu... just go text it").
  if (wasAlreadyConfirmed && mods.adds.length && !mods.removes.length && !mods.sets.length) {
    await pool.query(`update "order" set confirmed_at = null where id = $1`, [order.id]);
    order.confirmed_at = null;
    const deltaLines = mods.adds.map((i) => `${i.quantity}x ${i.name}`);
    await restartItemsCollection(order);
    return finishItemsCollection(customer, order, '', { preferTextForQuestions: true, deltaLines });
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
  //
  // Chidera, 2026-09-16: "when i switch to delivery why did it send me 2
  // messages of what is your delivery address" -- this used to ask for the
  // address itself right here, then immediately call handleCollectFulfilment
  // below, which asks for it AGAIN on its own (same as the confirm_order
  // branch above already relies on it doing). One plain "switching"
  // acknowledgement, same shape as that branch, and let
  // handleCollectFulfilment ask exactly once.
  if (newType === 'delivery' && !customer.address) {
    await reply(customer, `Got it, switching to delivery.`);
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
// Chidera, 2026-09-20: a second real bug, found from a real report -- this
// had no dine-in case at all, so a table order reaching this same code
// path (it does -- handleCollectFulfilment's at_table branch walks it
// through to engine_state 'fulfilment' same as any other order) always
// fell through to the delivery/pickup default and said "Paid and being
// prepared for pickup" -- wrong on both counts: dine-in never collects
// payment through the bot at all (settled at the table, after being
// served), and it was never pickup or delivery to begin with.
function fulfilmentStatusLine(order) {
  if (order.payment_mode === 'at_table') {
    return order.served_at
      ? `You've been served -- pay at the table whenever you're ready.`
      : `Your order's being prepared -- pay at the table once you've been served.`;
  }
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
  // Chidera, 2026-09-20: "if customer just says okay or alright or all
  // these reply that means okay or agreement, bot doesnt need to say
  // anything again, save my api" -- this comment used to claim pure ack/
  // thanks was already filtered out upstream (handlePendingBatch), but
  // that filter only stays silent when there's NO open order at all --
  // deliberately, so a plain "okay" while payment is still outstanding
  // still gets the payment nudge (see its own comment). An order sitting
  // here, already paid and just being prepared, always HAS an open order,
  // so a plain "okay" always fell through to this function anyway, which
  // never actually checked for one itself -- burning a delay-complaint AI
  // call, an answerOrThenShowMenu AI call, and a repeated "already being
  // prepared" message on every single acknowledgment. This is the one
  // place that comment's own claim needed to actually be true.
  const ackType = classifyPureAck(text);
  if (ackType === 'ack') return;
  if (ackType === 'thanks') {
    await reply(customer, `You're welcome!`, 'thanks_ack');
    return;
  }
  if (ackType === 'decline') {
    await reply(customer, `Okay!`, 'decline_ack');
    return;
  }

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
export async function handlePostPaymentFulfilmentChange(customer, order, newType) {
  const previousType = order.fulfilment_type;
  await pool.query(`update "order" set fulfilment_type = $1 where id = $2`, [newType, order.id]);
  order.fulfilment_type = newType;

  // Switching TO pickup needs nothing a human has to arrange -- no rider,
  // no fee, just where to go -- so the bot answers it directly with the
  // real address instead of handing it to staff, same info/wording as the
  // pickup line completePayment already sends. Switching the other way
  // (to delivery) still genuinely needs a person (a rider to book, a real
  // delivery fee to work out), so that keeps the handover below.
  //
  // Chidera, 2026-09-20: real report -- "i changed to pick up why wasnt
  // the order recalculated to take out delivery fee." Root cause: this
  // used to only update fulfilment_type, never delivery_fee/total, unlike
  // the pre-payment version of this same switch (handleFulfilmentChange
  // above). Since the order's ALREADY paid, silently shrinking total
  // would misrepresent what actually got collected -- the real fact is a
  // refund is owed. delivery_fee/total are still corrected here (so the
  // dashboard/invoice reflect what the order is genuinely worth now, not
  // a stale delivery-inclusive figure), and the handover below names the
  // exact refund amount instead of a vague "sort that out."
  if (newType === 'pickup') {
    const oldFee = Number(order.delivery_fee || 0);
    if (oldFee > 0) {
      const newTotal = Number(order.total) - oldFee;
      await pool.query(`update "order" set delivery_fee = 0, total = $1 where id = $2`, [newTotal, order.id]);
      order.delivery_fee = 0;
      order.total = newTotal;
    }
    const { rows: bizRows } = await pool.query('select address, phone_number from business limit 1');
    const biz = bizRows[0] || {};
    const branchRows = order.branch_id ? (await pool.query('select address, phone_number from branch where id = $1', [order.branch_id])).rows : [];
    const b = branchRows[0] || {};
    const refundLine = oldFee > 0 ? ` Since you'd already paid the delivery fee, we'll refund you NGN ${oldFee} for that.` : '';
    await reply(
      customer,
      `Okay, this is the pickup address: ${b.address || biz.address || 'our location'}. When your order is ready I'll let you know so you can pick it up.${refundLine}`
    );
    if (oldFee > 0) {
      await handover(customer, `Customer switched an already-paid order from delivery to pickup -- they're owed a NGN ${oldFee} delivery fee refund`, null, false);
    }
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

// Called from the Paystack webhook once a TOP-UP is verified (see
// completePayment just below for the main-order equivalent) -- Chidera,
// 2026-09-20: "totally stop sending account number... use just paystack."
// Deliberately does NOT touch the order's own status/engine_state -- the
// order itself is already fully paid and moving through its own
// lifecycle; a topup is just extra money for items already added
// (applyOrderModifications already inserted them regardless of payment).
export async function completeTopupPayment(topupId) {
  const { rows } = await pool.query('select * from order_topup where id = $1', [topupId]);
  const topup = rows[0];
  if (!topup || topup.payment_status === 'confirmed') return;
  await pool.query(`update order_topup set payment_status = 'confirmed' where id = $1`, [topupId]);

  const { rows: orderRows } = await pool.query('select * from "order" where id = $1', [topup.order_id]);
  const order = orderRows[0];
  if (!order) return;
  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];
  if (customer) await reply(customer, `Payment received for your top-up on order ${order.reference} -- thank you!`);

  const orderRecipients = await orderAlertRecipients();
  if (orderRecipients.length) {
    const itemLines = (topup.items || []).map((i) => `${i.quantity}x ${i.name}`).join(', ');
    const alertText = `Top-up payment confirmed on order ${order.reference}: ${itemLines} (NGN ${topup.amount}).`;
    for (const { phoneNumber: to, staffId } of orderRecipients) await notifyStaff({ staffId, phoneNumber: to, title: 'Top-up paid', body: alertText });
  }
}

// Chidera, 2026-09-25: "after payment is confirmed instead of the bare
// payment received, send customer a receipt, but receipt shouldnt look
// like invoice it is a receipt" -- a real RECEIPT (routes/documents.js's
// own receiptPage, deliberately not the invoice template with a different
// title -- see its own comment) sent as a WhatsApp document, same
// resilient send-then-fallback-to-a-link shape sendPaymentInstructions
// already uses for the invoice. Extracted out of completePayment
// (2026-09-25, "hope dine in has receipt too and the receipt has back to
// chat") so routes/api.js's own dine-in "Mark paid" route can send the
// exact same real receipt -- dine-in settles in person, so its own
// payment never went through completePayment at all (payment_status never
// reaches 'confirmed'/'accepted' there -- see completePayment's own
// comment on this), and had no receipt of any kind until now.
// followUpText -- whatever operational info belongs right after the
// receipt line, in the SAME message/bubble (delivery status, pickup
// instructions, or dine-in's own thank-you) -- always starts with its own
// leading space, so callers with nothing to add can just pass ''.
export async function sendReceiptMessage(customer, order, followUpText = '') {
  const receiptPath = await createReceipt(order);
  let receiptSent = false;
  // Chidera, 2026-09-25: "the receipt and the your receipt is attached
  // should be in one chat" -- website's own document bubble used to be
  // logged separately, then a SECOND bubble with the actual follow-up
  // text went out right after. Only the URL is captured here now; the
  // real combined send (text + document, one bubble) happens below once
  // the full body text is known.
  let receiptWebsiteUrl = null;
  if (process.env.PUBLIC_URL) {
    try {
      // Found live, 2026-09-25: this whole block predates the website
      // channel (main-only, never touched by the web-chat merge) and had
      // no website branch at all -- customer.channel === 'website' fell
      // straight into the `else` below, sending a REAL WhatsApp document
      // to a customer who should have gotten a free chat bubble.
      if (customer.channel === 'website') {
        // website: same fix as sendPaymentInstructions' own invoice branch
        // -- link to the plain HTML receipt page, not /pdf (Gotenberg-
        // backed, internal-only).
        receiptWebsiteUrl = `${process.env.PUBLIC_URL}${receiptPath}`;
        receiptSent = true;
      } else if (customer.channel === 'instagram') {
        // Chidera, 2026-09-26: "receipt too is taking me to facebook" --
        // same root cause and fix as sendPaymentInstructions' own invoice
        // branch above: sendInstagramDocument opened the PDF through
        // Instagram's own Facebook-branded document viewer. Deliberately
        // not sending anything here -- receiptSent stays false, so the
        // receiptUrl text-link fallback below links to the plain HTML
        // receipt page instead of a PDF.
      } else {
        const receiptPdfUrl = `${process.env.PUBLIC_URL}${receiptPath}/pdf`;
        await sendWhatsAppDocument(recipientFor(customer), receiptPdfUrl, `receipt-${order.reference}.pdf`, `Receipt for order ${order.reference}`);
        await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: customer.channel, sender: 'bot', body: `[receipt PDF] ${receiptPdfUrl}`, trigger: 'receipt_pdf' });
        receiptSent = true;
      }
    } catch (err) {
      console.error(`Failed to send receipt PDF, falling back to a text link: ${err.message}`);
    }
  }
  const receiptUrl = process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${receiptPath}` : null;
  // Chidera, 2026-09-25: "the receipt text also didnt have the your
  // payment has been received, your receipt is attached here it just
  // went straight to your receipt is attached above, the receipt is
  // below sef." Two real gaps: (1) the explicit "payment received"
  // confirmation was dropped entirely once the receipt document itself
  // became the opener; (2) "attached above" was only ever true for
  // WhatsApp/Instagram (the document is a genuinely separate, earlier
  // real send there) -- on website it's the SAME bubble, and the
  // document/interactive part of a bubble always renders BELOW the body
  // text (renderMessage's own body-then-actions order), so "above" was
  // just wrong there.
  const receiptLine = receiptSent
    ? customer.channel === 'website'
      ? 'Your payment has been received. Your receipt is attached below.'
      : 'Your payment has been received. Your receipt is attached above.'
    : receiptUrl
      ? `Your payment has been received. Here's your receipt: ${receiptUrl}`
      : 'Your payment has been received.';
  const bodyText = `${receiptLine}${followUpText}`;

  // One bubble, not two -- see this function's own comment above. Every
  // other website reply already goes through reply() (real WhatsApp send
  // for every other channel, a no-op websocket-free bubble for website),
  // which has no `interactive` param; this bypasses it only for website,
  // straight to logMessage, so the document reference and the real
  // follow-up text land in the SAME row.
  if (customer.channel === 'website' && receiptWebsiteUrl) {
    await logMessage({
      customerId: customer.id,
      tableSessionId: customer.tableSessionId,
      direction: 'outbound',
      channel: customer.channel,
      sender: 'bot',
      body: bodyText,
      trigger: 'payment_confirmed',
      interactive: { type: 'document', filename: `receipt-${order.reference}`, url: receiptWebsiteUrl },
    });
    return;
  }
  await reply(customer, bodyText, 'payment_confirmed');
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
  // No live request/customer object to flip here -- this fires from
  // Paystack's webhook, staff's "Confirm payment" click, or Moniepoint's
  // auto-match, none of which have one. web_chat_active_at (touched on
  // every request into routes/web-chat.js) is the persisted breadcrumb: if
  // this customer's most recent turn was on the web-chat page recently,
  // the payment-confirmed message becomes a bubble there instead of a real
  // WhatsApp send. customers.channel itself is never touched -- a fresh
  // WhatsApp text days later must still start the normal WhatsApp flow.
  if (customer && customer.web_chat_active_at && new Date(customer.web_chat_active_at) > new Date(Date.now() - 30 * 60 * 1000)) {
    customer.channel = 'website';
  }

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
  // Chidera, 2026-09-24: "the today dashboard is not really calculating
  // collected" -- real bug, found tracing it: this function (every
  // AUTOMATED payment webhook -- Paystack, Monnify, OPay, Moniepoint POS --
  // routes here) has been "the moment payment is confirmed" since it was
  // written (see this function's own comment above), but never actually
  // set payment_status on the order itself. Only the STAFF-facing manual
  // "Confirm payment received" click (routes/api.js) ever did. Every real,
  // automated payment was moving the order forward correctly (kanban,
  // delivery, customer message) while silently leaving payment_status at
  // its original pending value -- so /orders/stats/today's own "collected"
  // sum (which filters on payment_status in ('confirmed','accepted'))
  // never counted a single automated payment, only manually-confirmed
  // proof-of-payment orders. Same value ('confirmed') the manual path uses.
  await pool.query(`update "order" set status = 'preparation', payment_status = 'confirmed' where id = $1`, [order.id]);
  await transitionOrder(order, 'fulfilment');

  // Chidera, 2026-09-25: "after payment is confirmed instead of the bare
  // payment received, send customer a receipt, but receipt shouldnt look
  // like invoice it is a receipt" -- see sendReceiptMessage's own comment
  // for the real send/one-bubble/wording details, extracted out so
  // routes/api.js's own dine-in "Mark paid" route (which never went
  // through completePayment at all -- dine-in settles in person, its own
  // payment_status never reaches 'confirmed'/'accepted') can send the
  // exact same real receipt too.
  if (order.fulfilment_type === 'delivery') {
    const delivery = await createDelivery(order, customer);
    const riderLine = delivery.riderName ? ` Your rider is ${delivery.riderName}.` : '';
    // Chowdeck doesn't name a rider at booking time (one isn't assigned
    // yet) -- riderLine above will stay empty for a real Chowdeck delivery,
    // but the tracking link is available immediately and is the thing
    // actually worth sending.
    const trackingLine = delivery.trackingUrl ? ` Track it here: ${delivery.trackingUrl}` : '';
    // Chidera, 2026-09-24: "let the webchat notification of received pop
    // as a banner so customer can know their payment has been confirmed
    // cause sometimes paystack leaves it loading there." A distinct
    // trigger (not the generic bot_flow_step default) so the chat page's
    // own poll() can recognise THIS specific message and show a banner,
    // not just a bubble easy to miss while they're still tabbed over to
    // Paystack's own checkout.
    await sendReceiptMessage(customer, order, ` Your order is being prepared for delivery.${riderLine}${trackingLine}`);
  } else {
    const { rows: bizRows } = await pool.query('select address, phone_number from business limit 1');
    const biz = bizRows[0] || {};
    const branchRows = order.branch_id ? (await pool.query('select address, phone_number from branch where id = $1', [order.branch_id])).rows : [];
    const b = branchRows[0] || {};
    await sendReceiptMessage(
      customer,
      order,
      ` I'll let you know when to pick up your order. You'll pick up at ${b.address || biz.address || 'our location'} and call ${b.phone_number || biz.phone_number || 'us'} when you arrive.`
    );
  }

  // Deliberately NOT transitioning to 'completed' here -- payment clearing
  // is not the same fact as the order actually being done. Staying at
  // 'fulfilment' keeps the order open (see getOpenOrder) so a customer can
  // still message in to add something while it's being prepared/delivered.
  // Staff marking it completed on the dashboard (routes/api.js) is what
  // actually closes it.

  // Chidera, 2026-09-23: "after they name payment let feedback pop so they
  // remain on page" -- sendFeedbackRequest's own 3 completion sites
  // (dine-in payment, delivery release, pickup release) all fire well
  // after this moment, by which point an online customer has near-always
  // left the chat page (web_chat_active_at gone stale) and it goes out as
  // a real WhatsApp/Instagram send instead of a free bubble. Firing it
  // here too, right alongside the payment-confirmed message itself while
  // they're still looking at the page, catches it while free. Safe to
  // just add, not move -- sendFeedbackRequest's own order_feedback
  // (order_id) on-conflict-do-nothing guard means whichever call reaches
  // it first wins and every later one is a silent no-op, so this can
  // never double-send once fulfilment actually completes too.
  sendFeedbackRequest(order.id).catch((err) => console.error('sendFeedbackRequest failed:', err.message));

  // Chidera, 2026-09-16: "a staff number should be able to get a confirmed
  // order after paystack has automatically confirmed payment on their
  // whatsapp without accessing the back end... the open link will just
  // show the kanban so they can click the ready button."
  // Chidera, 2026-09-24: "turn handover messages to 1 text not 2 different,
  // but the button and text together and same with the ones stating what
  // the customer ordered" -- this was the alert text and the board-link
  // button as two separate WhatsApp sends (two billable messages), same
  // shape handover() itself had before its own 2026-09-24 merge just above.
  // Same fix here: one cta_url message carries the alert as its body AND
  // the button, when a link is even possible.
  const orderRecipients = await orderAlertRecipients();
  if (orderRecipients.length) {
    // Chidera, 2026-09-16: "when reporting to staff what to prepare, make
    // it structured not like a paragraph" -- was using summariseOrder's
    // `lines` (a single comma-run paragraph, its own comment says so
    // explicitly), not `itemLines` (one item per line), which the
    // customer-facing confirm message already switched to 2026-09-10 for
    // the exact same reason. Staff reading what to prepare deserves the
    // same structured format, not a regression back to the paragraph.
    const { itemLines, total } = await summariseOrder(order);
    // Chidera, 2026-09-25: "on the handover whatsapp text to inform on what
    // has been paid and placed, if its delivery let the delivery area and
    // address also be in the text" -- staff reading this to prep/dispatch
    // shouldn't have to open the dashboard just to find out where it's
    // going. Area only applies to own_riders (delivery_zone_id is null for
    // Chowdeck/manual -- see its own schema comment); address always comes
    // from customer.address, the same field createDelivery already reads.
    let deliveryLines = '';
    if (order.fulfilment_type === 'delivery') {
      const zoneRows = order.delivery_zone_id ? (await pool.query('select name from delivery_zone where id = $1', [order.delivery_zone_id])).rows : [];
      const zoneName = zoneRows[0]?.name;
      const lines = [];
      if (zoneName) lines.push(`Area: ${zoneName}`);
      if (customer.address) lines.push(`Address: ${customer.address}`);
      if (lines.length) deliveryLines = `\n${lines.join('\n')}`;
    }
    const alertText = `Payment confirmed, ready to prepare: ${displayNameFor(customer)} (${order.fulfilment_type || 'pickup'})${deliveryLines}\n${itemLines.join('\n')}\nTotal: NGN ${total}`;
    const credentials = await getWhatsAppCredentials(order.branch_id);
    for (const { phoneNumber: to, staffId } of orderRecipients) {
      // Chidera, 2026-09-17: "the link is meant to open the specific
      // kanban inside for that order not the pipeline surface" -- still
      // the board itself, not a detail page (her own earlier call: "the
      // kanban not the conversation... the ready button" lives on the
      // board's own card), just landing scrolled to and highlighting
      // THIS order's card instead of the customer having to hunt for it
      // among everything else in the pipeline. Orders.jsx reads ?order=.
      const link = process.env.PUBLIC_URL && staffId ? `${process.env.PUBLIC_URL}/api/auth/magic/${await createMagicLink(staffId, `/?order=${order.id}`)}` : null;
      await notifyStaff({ staffId, phoneNumber: to, title: 'Order ready to prepare', body: alertText, linkUrl: link, linkButtonText: 'Open Orders', credentials });
    }
  }
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
    const order = await resolveCustomerOrder(customer);
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
// always sends exactly "Menu Table {label}(send this to proceed)"
// (routes/dinein.js's qrDataUrlFor) -- deterministic, no AI call. Returns
// true when this handled the message (a real scan, or the answer to "which table"),
// false to let normal routing continue untouched. Off entirely when the
// add-on isn't enabled -- one cheap query, then nothing else runs.
async function getDineinConfig() {
  const { rows } = await pool.query('select * from dinein_config limit 1');
  return rows[0] || null;
}

// Joint dine-in, Stage 1 (fancy-whistling-pearl.md): records itself the
// first time each guest actually interacts with the table -- a scan, or
// the shared web page loading for them -- rather than a roster anyone has
// to explicitly join. Exported for routes/dinein-menu.js (the shared page
// itself) as well as this file's own scan handling below.
export async function upsertTableGuest(sessionId, customerId) {
  await pool.query(
    `insert into table_session_guest (session_id, customer_id) values ($1, $2) on conflict (session_id, customer_id) do nothing`,
    [sessionId, customerId]
  );
}

// The ONE shared order for a table's current sitting, regardless of which
// guest is asking -- replaces the old getOpenOrder(customerId) on the
// dine-in web routes, which always resolved back to whoever's customer
// row the caller happened to pass in, not "the table's order." Order
// ownership (order.customer_id) still stays the session's own original
// scanner -- every existing single-customer assumption elsewhere (
// receipts, feedback requests, the fulfilment status line) keeps working
// unchanged; only line-level attribution is per-guest (order_item.
// added_by_customer_id, set by the caller after this returns).
// status not in ('completed', 'cancelled'), not status = 'new' -- Stage 2
// (fancy-whistling-pearl.md): "they can also add to the order already
// served and the waiter will get add on order notification... the bill
// can pile up as conclusive," Chidera's own words for the joint dine-in
// concept. A table reopening the web menu after being served (or even
// after confirming, before serving) adds onto the SAME still-open bill,
// not a second separate kitchen ticket -- matches the broader definition
// getOpenOrder already uses for the chat-typed add path (engine_state not
// in completed/cancelled), which is how applyOrderModifications' own
// served_at reset could already reach a served order even before this
// existed; this brings the web path in line with it, not a new rule.
export async function getOrCreateTableOrder(session, table, customer) {
  await upsertTableGuest(session.id, customer.id);
  const { rows } = await pool.query(
    `select * from "order" where session_id = $1 and status not in ('completed', 'cancelled') order by created_at desc limit 1`,
    [session.id]
  );
  if (rows[0]) return rows[0];
  const ref = newReference('ORD');
  const { rows: created } = await pool.query(
    `insert into "order" (customer_id, reference, branch_id, channel, table_id, session_id, fulfilment_type, payment_mode, engine_state, status)
     values ($1, $2, $3, 'dinein', $4, $5, 'table', 'at_table', 'collect_info', 'new') returning *`,
    [session.customer_id, ref, table.branch_id, table.id, session.id]
  );
  return created[0];
}

// Chidera, 2026-09-24: "now we need dine in to go through web chat too."
// Content only (no send) -- routes/web-chat.js's own dine-in branch builds
// the actual bubble (menu link, specials line), same split
// buildGreetingContent/sendOrderGreeting already use for the online flow.
// joiningActiveTable -- Chidera, joint dine-in concept: "is it possible
// that when a persons scans a qr for a table let everyone on that table be
// able to join in and see each other". A guest joining a table that
// already has another guest's order open gets told there's something to
// join, not the same first-timer "what would you like to do".
export async function buildDineinGreetingContent(customer, session, { joiningActiveTable = false } = {}) {
  const { rows: bizRows } = await pool.query('select name from business limit 1');
  const biz = bizRows[0];
  const body = joiningActiveTable
    ? `Welcome to ${biz?.name || 'us'}! Table ${session.table_label} has an active order -- add to it, or see what's already been ordered.`
    : `Welcome to ${biz?.name || 'us'}! You're at Table ${session.table_label}. What would you like to do?`;
  // Chidera, 2026-09-20, real report: "there is no special currently on
  // menu so why is today specials button still showing" -- only surfaced
  // when a real special actually exists right now, same as the general
  // greeting's own logic already does.
  const specialsCategory = await findSpecialsCategory(customer.branch_id);
  return { body, specialsCategory };
}

async function handleDineinScan(customer, text) {
  const dinein = await getDineinConfig();
  if (!dinein?.enabled) return false;

  const scanMatch = /^menu\s+table\s+(.+)$/i.exec(text.trim());
  let label = scanMatch?.[1]?.trim();
  // Chidera, 2026-09-25: "menu table 1(send this to proceed)" -- the QR's
  // own prefilled text (routes/dinein.js's qrDataUrlFor) now carries this
  // parenthetical so it's obvious a tap on Send is still needed. Stripped
  // back off here, generically (any trailing "(...)"), so the real table
  // label match below still sees a bare "1", same as before this change.
  if (label) label = label.replace(/\s*\([^)]*\)\s*$/, '').trim();

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

  // trim(label) -- routes/dinein.js's POST /tables now trims on save, but
  // this stays defensive against any table saved before that fix (found
  // live, 2026-09-11: "it sint recognizinf the table" -- two of era-demo's
  // own tables had a stray leading space in their stored label, which
  // \s+ above strips out of the scanned text but never out of the stored
  // value, so an exact match against the untrimmed label failed forever).
  //
  // $1::uuid is null or branch_id = $1 -- Chidera, 2026-09-20, real
  // report: "why does it still ask me what table am i on" even scanning a
  // real, correctly-labelled QR. Root cause, confirmed against era-demo's
  // real data: this was a strict branch_id = $1 match, and
  // customer.branch_id is null for era-demo's real customers (no
  // branch_channel mapping to resolve one from -- the exact same class of
  // bug already fixed today in menuForBranch/resolveMenu). NULL never
  // equals anything in SQL, so this could never find ANY table for those
  // customers, no matter how correct their scan was -- every real "Menu
  // Table 1" landed here and fell straight to "Please, what table are you
  // at?" This was never a QR-stability problem; the qr_token (and the
  // label it encodes) were already fixed and correct the whole time.
  const { rows: tableRows } = await pool.query(
    `select * from restaurant_table where ($1::uuid is null or branch_id = $1) and lower(trim(label)) = lower($2) and status = 'active'`,
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
  let session = sessionRows[0];
  if (!session) {
    const { rows: created } = await pool.query(
      `insert into table_session (table_id, branch_id, customer_id) values ($1, $2, $3) returning *`,
      [table.id, table.branch_id, customer.id]
    );
    session = created[0];
  }
  // A second (or third...) guest scanning the same table's own code, not
  // the original opener, still needs table_session_guest -- joint dine-in,
  // Stage 1 -- so currentDineinSession/the shared chat page recognize them
  // from here on, same as the original scanner already could via
  // session.customer_id. routes/web-chat.js's own first-load render
  // re-derives "joining an active table" vs "the original scanner" the
  // same way (session.customer_id !== customer.id) when it renders the
  // actual welcome bubble -- no need to compute or pass it through here.
  await upsertTableGuest(session.id, customer.id);

  // Chidera, 2026-09-24: "now we need dine in to go through web chat too
  // ... study how it works and the best way it can go through web chat and
  // bare chat to reduce my cost." Used to be its own 2-step real send
  // (sendDineinWelcome's buttons message, THEN handleDineinButtonTap's
  // separate menu-link message once tapped) -- now the exact same single
  // real message every other first contact gets (sendStartOrderLink). The
  // real dine-in welcome (table label, "join an active order" wording,
  // the actual menu link) becomes the free first bubble on /wa/:token
  // instead (routes/web-chat.js's own dine-in branch).
  await sendStartOrderLink(customer, { dineinTableLabel: table.label, dineinQrToken: table.qr_token });
  return true;
}

// The 3 welcome-card buttons (see sendDineinWelcome) -- resolved by the
// customer's own most recent open table_session, not re-parsed from
// anything in the tap itself (a button tap carries no table info of its
// own, unlike the scan message).
//
// Also matches via table_session_guest, not just ts.customer_id -- Stage 1
// of the joint dine-in plan (fancy-whistling-pearl.md): a second guest at
// the same table never opens the session, they join one already open, so
// ts.customer_id alone (only ever the FIRST scanner) left every other
// guest's own button taps with "please scan your table's QR code to get
// started" even though they very much had.
// Chidera, 2026-09-24: "now we need dine in to go through web chat too."
// Exported for routes/web-chat.js's own first-load render -- same reason
// getOpenOrder/buildGreetingContent are exported, so it can tell a dine-in
// guest's first visit apart from a normal online one without a second,
// parallel way of answering "is this customer at a table right now".
export async function currentDineinSession(customer) {
  const { rows } = await pool.query(
    `select ts.*, rt.label as table_label, rt.qr_token
     from table_session ts join restaurant_table rt on rt.id = ts.table_id
     where ts.closed_at is null
       and (ts.customer_id = $1 or exists (select 1 from table_session_guest g where g.session_id = ts.id and g.customer_id = $1))
     order by ts.opened_at desc limit 1`,
    [customer.id]
  );
  return rows[0] || null;
}

export async function handleDineinButtonTap({ phoneNumber, channelId, buttonId, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel, sender: 'customer', body: `[tapped: ${buttonId}]` , processed: true });

  const session = await currentDineinSession(customer);
  if (!session) {
    await reply(customer, 'Please scan your table\'s QR code to get started.', 'dinein_no_session');
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
  // g=<menu_token> -- joint dine-in, Stage 1: every guest at the table
  // gets the SAME qrToken (it identifies the table, not them), so this is
  // the only thing that lets the shared page tell which guest is actually
  // looking at it right now -- reuses the existing per-customer menu_token
  // (ensureMenuToken) rather than inventing a second kind of token.
  const guestToken = await ensureMenuToken(customer);
  const params = new URLSearchParams();
  if (specialsCategory) params.set('cat', specialsCategory);
  params.set('g', guestToken);
  const url = `${process.env.PUBLIC_URL}/t/${session.qr_token}?${params.toString()}`;
  const bodyText = buttonId === 'dinein_specials' ? `Here's today's specials for Table ${session.table_label}.` : `Here's our menu for Table ${session.table_label}.`;
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  await sendWhatsAppCtaUrl(recipientFor(customer), bodyText, buttonId === 'dinein_specials' ? 'See specials' : 'View menu', url, credentials);
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel, sender: 'bot', body: `[menu link sent: ${url}]`, trigger: 'dinein_menu_sent' });
}

// Whether every order in a table_session is settled -- the single source
// of truth for "can this table close", shared between the manual
// Close-table button (routes/dinein.js) and closeTableSessionIfSettled's
// automatic trigger below (both the manual "Mark paid" path in
// routes/api.js and, joint dine-in Stage 3, a POS transaction
// auto-confirming an order_payment).
async function sessionIsSettled(sessionId) {
  const { rows } = await pool.query(
    `select count(*) from "order" where session_id = $1 and status not in ('completed', 'cancelled')`,
    [sessionId]
  );
  return Number(rows[0].count) === 0;
}

// Closes an open table_session if -- and only if -- every order in it is
// settled; a no-op (returns null) otherwise. closedBy distinguishes who
// actually closed it ('staff' for the manual button, 'auto' for an
// automatic trigger -- either the last order being marked paid, or Stage
// 3's own POS auto-confirm) -- both valid per schema.sql's check
// constraint on table_session.closed_by. Moved here from routes/dinein.js
// (Stage 3) so engine/webhook-moniepoint.js -- which has no HTTP request/
// staff session of its own to route through -- can call it directly,
// same layer completePayment/completeTopupPayment already live in.
export async function closeTableSessionIfSettled(sessionId, { closedBy, staffId = null } = {}) {
  if (!(await sessionIsSettled(sessionId))) return null;
  const { rows } = await pool.query(
    `update table_session set closed_at = now(), closed_by = $1, closed_by_staff = $2
     where id = $3 and closed_at is null returning *`,
    [closedBy, staffId, sessionId]
  );
  return rows[0] || null;
}

// Joint dine-in, Stage 3: "they can choose pay together or split payment
// so each pay their own but its like a table open order, and they can
// pick whose bill too can be joint." guestIds is who this particular
// group is paying for (always includes the tapping guest themselves,
// validated by the caller against table_session_guest same as every
// other guest-claim in this file) -- covers_item_ids is every order_item
// any of those guests added. null (not an array) specifically means
// "every guest who has anything on the order is included," matching
// schema.sql's own "null = whole order" convention, so a single
// confirmed payment with covers_item_ids null is recognized as full
// settlement without needing every item id spelled out.
//
// Reuses an existing PENDING payment for the exact same guest set instead
// of creating a new one each time the pay page reloads -- a guest
// refreshing (or two guests on the same phone somehow both landing here)
// must not spawn duplicate POS amounts waiting to be matched.
export async function createOrderPayment(order, guestIds, actingCustomerId) {
  const { rows: allItems } = await pool.query('select id, product_id, quantity, price, added_by_customer_id from order_item where order_id = $1', [order.id]);
  const { rows: allGuestRows } = await pool.query(
    `select customer_id from table_session_guest where session_id = $1
     union select customer_id from table_session where id = $1`,
    [order.session_id]
  );
  const allGuestIds = allGuestRows.map((g) => g.customer_id);
  const wholeOrder = allGuestIds.length > 0 && allGuestIds.every((id) => guestIds.includes(id));

  const coveredItems = wholeOrder ? allItems : allItems.filter((i) => guestIds.includes(i.added_by_customer_id));
  const amount = coveredItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
  const coversItemIds = wholeOrder ? null : coveredItems.map((i) => i.id);

  // Same-shape existing pending payment -- exact same coverage, still
  // pending -- gets reused rather than duplicated. Array comparison via a
  // sorted-JSON string is enough here (small arrays, no real risk of a
  // false match) -- null vs null (whole order) also matches correctly
  // since both stringify the same way.
  const key = JSON.stringify((coversItemIds || []).slice().sort());
  const { rows: pendingRows } = await pool.query(`select * from order_payment where order_id = $1 and status = 'pending'`, [order.id]);
  const existing = pendingRows.find((p) => {
    const pKey = JSON.stringify((p.covers_item_ids || []).slice().sort());
    return (p.covers_item_ids === null) === (coversItemIds === null) && pKey === key;
  });
  if (existing) return existing;

  // Our own bookkeeping id, never sent to Moniepoint (schema.sql's own
  // comment on this table) -- confirmation is matched by amount/time
  // against real pos_transaction rows, not by reference.
  const reference = `${order.reference}-P${randomBytes(3).toString('hex').toUpperCase()}`;
  const { rows: created } = await pool.query(
    `insert into order_payment (order_id, provider, reference, amount, covers_item_ids, paid_by_customer_id)
     values ($1, 'pos', $2, $3, $4, $5) returning *`,
    [order.id, reference, amount, coversItemIds, actingCustomerId]
  );
  return created[0];
}

// Confirms one order_payment (POS auto-match below, or a future staff
// tie-break resolution) -- then checks whether the ORDER itself is now
// fully covered by every confirmed payment together (a single whole-order
// one, or the union of split/joint groups covering every real item),
// completing it exactly the same way the manual "Mark paid" dashboard
// button already does (routes/api.js's POST /orders/:id/status) so
// nothing downstream (feedback, table auto-close) has to know which path
// got it there. Partial settlement -- some groups paid, one hasn't --
// leaves the order open, still visibly "awaiting payment" for the rest.
export async function confirmOrderPayment(orderPaymentId) {
  const { rows } = await pool.query(
    `update order_payment set status = 'confirmed', confirmed_at = now() where id = $1 and status = 'pending' returning *`,
    [orderPaymentId]
  );
  const payment = rows[0];
  if (!payment) return null;

  const { rows: allItems } = await pool.query('select id from order_item where order_id = $1', [payment.order_id]);
  const { rows: confirmedPayments } = await pool.query(
    `select covers_item_ids from order_payment where order_id = $1 and status = 'confirmed'`,
    [payment.order_id]
  );
  const wholeOrderPaid = confirmedPayments.some((p) => p.covers_item_ids === null);
  const covered = new Set();
  for (const p of confirmedPayments) for (const id of p.covers_item_ids || []) covered.add(id);
  const fullyCovered = wholeOrderPaid || (allItems.length > 0 && allItems.every((i) => covered.has(i.id)));
  if (!fullyCovered) return payment;

  // Chidera, 2026-09-20: "i need pos to work now for both online and in
  // house" -- dine-in payment closes the order straight to 'completed'
  // (the table's already eaten; paying is the LAST step). An online order
  // paying via POS is the OPPOSITE order -- payment is what kicks off
  // preparation, not what ends the order -- same distinction
  // completePayment (Paystack/proof-image confirm) already draws. Reusing
  // that exact function here instead of duplicating its
  // transitionOrder/createDelivery/staff-alert logic.
  const { rows: preRows } = await pool.query('select * from "order" where id = $1', [payment.order_id]);
  const preOrder = preRows[0];
  if (preOrder?.channel === 'dinein') {
    const { rows: orderRows } = await pool.query(
      `update "order" set status = 'completed', engine_state = 'completed', completed_at = now() where id = $1 returning *`,
      [payment.order_id]
    );
    const order = orderRows[0];
    if (order) {
      sendFeedbackRequest(order.id).catch((err) => console.error('sendFeedbackRequest failed:', err.message));
      if (order.session_id) {
        closeTableSessionIfSettled(order.session_id, { closedBy: 'auto' }).catch((err) => console.error('closeTableSessionIfSettled failed:', err.message));
      }
    }
  } else if (preOrder) {
    await completePayment(preOrder.id);
  }
  return payment;
}

// Joint dine-in, Stage 3: "if there is an exact amount sent at same time
// then staff should be asked which table" -- Chidera's own call, confirmed
// as the right approach. Called right after engine/webhook-moniepoint.js
// inserts a new pos_transaction -- matches it against every PENDING
// order_payment with the same amount inside a short recent window (a few
// minutes: long enough for someone to actually walk up and tap the
// terminal after requesting payment, short enough that two genuinely
// unrelated transactions at the same amount rarely land in it together).
// Zero matches -- nothing to reconcile automatically, the transaction
// stays logged as-is (a non-order sale, or paid a way not expected here).
// Exactly one -- auto-confirm it, no staff involved, which is the entire
// point (closes the staff-fraud gap this whole plan started from). Two
// or more -- a genuine tie, never guessed at with real money: staff gets
// asked which one instead.
export async function matchPosTransactionToPayment(transaction) {
  const { rows: candidates } = await pool.query(
    `select op.*, o.table_id, o.reference as order_reference, rt.label as table_label
     from order_payment op
       join "order" o on o.id = op.order_id
       left join restaurant_table rt on rt.id = o.table_id
     where op.status = 'pending' and op.amount = $1
       and op.created_at > now() - interval '15 minutes'`,
    [transaction.amount]
  );
  if (candidates.length === 1) {
    await confirmOrderPayment(candidates[0].id);
    return;
  }
  if (candidates.length > 1) {
    const orderRecipients = await orderAlertRecipients();
    if (orderRecipients.length) {
      // No " -- " / standalone dash -- bot-engine/send.js's sanitizeText
      // rejects that as banned formatting (found live, via this exact
      // alert, not assumed). Line breaks + "label: value" instead, same
      // convention every other structured staff alert in this file uses.
      // table_label is null for an online order (no table_id) -- 2026-09-20,
      // "i need pos to work now for both online and in house" -- labelled
      // by its own order reference instead, same as every other place in
      // this file already falls back when a dine-in-only field is absent.
      const list = candidates.map((c) => (c.table_label ? `Table ${c.table_label}: NGN ${c.amount}` : `Order ${c.order_reference}: NGN ${c.amount}`)).join('\n');
      const alertText = `A POS payment of NGN ${transaction.amount} matched more than one order waiting to pay:\n${list}\n\nNot auto-confirmed, to avoid crediting the wrong one. Please confirm the right one from the dashboard.`;
      for (const { phoneNumber: to, staffId } of orderRecipients) await notifyStaff({ staffId, phoneNumber: to, title: 'POS payment tie', body: alertText });
    }
  }
}

// Joint dine-in, Stage 2: "food comes first before payment unlike normal
// ordering... they can pay when ever they are ready." Called from
// routes/dinein.js's POST /orders/:id/served the moment staff taps
// "Served" -- every guest who's actually been part of this table's
// sitting (table_session_guest, plus the original scanner as a defensive
// fallback) gets their OWN "Ready to pay" link, same ?g=<menu_token>
// per-guest identity mechanism as every other dine-in link (see
// handleDineinButtonTap above). Stage 3 builds out the real split/joint
// payment page this links to.
export async function notifyGuestsReadyToPay(order) {
  if (!process.env.PUBLIC_URL || order.channel !== 'dinein' || !order.table_id || !order.session_id) return;
  const { rows: tableRows } = await pool.query('select label, qr_token, branch_id from restaurant_table where id = $1', [order.table_id]);
  const table = tableRows[0];
  if (!table) return;
  const { rows: guests } = await pool.query(
    `select c.* from customers c where c.id in (
       select customer_id from table_session_guest where session_id = $1
       union select customer_id from table_session where id = $1
     )`,
    [order.session_id]
  );
  if (!guests.length) return;
  const { total } = await summariseOrder(order);
  for (const guest of guests) {
    try {
      const token = await ensureMenuToken(guest);
      const url = `${process.env.PUBLIC_URL}/t/${table.qr_token}/pay?g=${token}`;
      // Chidera, 2026-09-25: "in dine in where bot sends the pay now, let
      // them add a menu button since it was suggested that they can still
      // order more so 2 buttons in that text" -- same /t/:qrToken shop
      // page every other dine-in menu link already points at
      // (sendDineinGreeting's own menuUrl, same shape).
      const menuUrl = `${process.env.PUBLIC_URL}/t/${table.qr_token}?g=${token}`;
      // Chidera, 2026-09-24: "now we need dine in to go through web chat
      // too... reduce my cost." Used to be a real send to every single
      // guest at the table, every time -- the real "ready to pay" content
      // (and its own real button, same "Ready to pay? Click here" wording)
      // now lands as a free website bubble per guest; a real WhatsApp send
      // only happens for the short redirect ping, and only once per guest
      // until each one has genuinely come back to the chat since the last
      // one.
      // Chidera, 2026-09-25, real report: "why is one number having 2
      // seperate table 1 conversation? ... one number has two chat space,
      // that doesnt delete their previous conversation." Root cause,
      // confirmed against era-demo's real data: this logMessage never set
      // tableSessionId at all (guest.id, not customer.id -- the earlier
      // bulk pass that threaded tableSessionId through every OTHER direct
      // logMessage call site matched the literal string "customerId:
      // customer.id," and silently missed this one, the only call site in
      // the whole file using `guest`). The bubble landed with
      // table_session_id null -- the generic online thread -- instead of
      // this table's own separate one, which is exactly what looked like a
      // second, stray "Table 1" conversation bleeding into the wrong
      // thread. order.session_id IS the real table_session id (the guard
      // above already requires it).
      // Chidera, 2026-09-25: "when you receive your order and you are
      // ready to pay just come back here and tap this button to pay with
      // the pay now button, then also let them know you can still add to
      // your order before making final payment."
      await logMessage({
        customerId: guest.id,
        tableSessionId: order.session_id,
        direction: 'outbound',
        channel: 'website',
        sender: 'bot',
        body: `Your order has been served! When you're ready to pay, come back here and tap the button below to pay. You can still add to your order before making your final payment.`,
        trigger: 'dinein_ready_to_pay',
        interactive: { type: 'cta_url', buttonText: 'Pay now', url, secondaryUrl: menuUrl, secondaryLabel: 'Menu' },
      });
      if (await needsChatRedirect(guest)) {
        await sendChatRedirectPing(guest, `Your table is ready to pay.`, { trigger: 'dinein_ready_to_pay_ping' });
      }
    } catch (err) {
      // Best-effort, per guest -- one guest's send failing (a stale
      // number, WhatsApp's 24h window) must never stop the others from
      // getting told the table's ready.
      console.error(`Failed to notify guest ${guest.id} the table is ready to pay:`, err.message);
    }
  }
}

// Joint dine-in, Stage 2: "even if staff marks served and it goes to the
// next pipeline and they still add it should go back to first pipeline"
// (the original chat-only version of this rule, applyOrderModifications
// below) now also alerts staff -- "Table X added more after being
// served" -- reusing orderAlertRecipients/sendStaffAlert exactly as
// completePayment's own ready-to-prepare ping already does, not new
// plumbing. Exported and shared between applyOrderModifications (typed-
// chat adds) and routes/dinein-menu.js's web review route (which
// replaces the whole basket rather than diffing adds/removes, so it
// can't reuse applyOrderModifications itself) -- one place decides what
// "served, then added to" means and what it does about it.
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

export async function resetServedForAddOn(order) {
  if (!(order.channel === 'dinein' && order.served_at)) return false;
  await pool.query(`update "order" set served_at = null where id = $1`, [order.id]);
  order.served_at = null;
  const orderRecipients = await orderAlertRecipients();
  if (orderRecipients.length && order.table_id) {
    const { rows: tableRows } = await pool.query('select label from restaurant_table where id = $1', [order.table_id]);
    // Chidera, 2026-09-25: "let the add on only state the add on items not
    // all the items" -- was summariseOrder's full itemLines (the WHOLE
    // running bill). order_item has no stable row identity across a
    // resubmit (the web review route deletes and reinserts every line
    // each time -- see served_item_snapshot's own schema comment), so a
    // timestamp-based diff can't tell new from old here. Reuses the exact
    // same {product_id: quantity} snapshot + diff routes/dinein.js's own
    // itemsWithServedDiff already computes for the InHouse kanban card's
    // "NEW" badge -- one source of truth for what "just added on" means,
    // correct regardless of whether the add-on came from the web menu or
    // typed chat.
    const { rows: currentItems } = await pool.query(
      `select p.name, p.id as product_id, oi.quantity, oi.price,
         coalesce(
           (select string_agg(oa.answer, ', ' order by oa.created_at)
            from order_item_answer oa where oa.order_item_id = oi.id),
           ''
         ) as answer_summary
       from order_item oi join product p on p.id = oi.product_id where oi.order_id = $1`,
      [order.id]
    );
    const snapshot = order.served_item_snapshot || {};
    const itemLines = currentItems
      .map((r) => ({ ...r, newQty: Math.max(0, r.quantity - Number(snapshot[r.product_id] || 0)) }))
      .filter((r) => r.newQty > 0)
      .map((r) => `${r.newQty}x ${r.name}${r.answer_summary ? ` (${r.answer_summary})` : ''}: NGN ${r.price}`);
    if (itemLines.length) {
      const alertText = `Table ${tableRows[0]?.label || '?'} added more after being served:\n${itemLines.join('\n')}`;
      for (const { phoneNumber: to, staffId } of orderRecipients) {
        await notifyStaff({ staffId, phoneNumber: to, title: 'Added after serving', body: alertText });
      }
    }
  }
  return true;
}

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
async function menuGreetingBody() {
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
async function sendWebMenuLink(customer, bodyText, buttonTitle = 'View menu', category = null, headerImageUrl = null, order = null) {
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

// Run on an interval from server.js, same "cheap when nothing's waiting,
// genuinely inert for a business that's never set opening_hours" shape as
// every other sweep in this codebase. Per branch (not globally) since two
// branches can keep different hours -- only a branch that's actually open
// right now, with rows actually waiting, does any work.
export async function sweepOpeningNotifications() {
  const { rows: branches } = await pool.query(
    `select distinct b.id, b.opening_hours from branch b
     join hours_notify_request r on r.branch_id = b.id and r.notified_at is null
     where b.opening_hours is not null`
  );
  for (const branch of branches) {
    const { open } = checkOperatingHours(branch.opening_hours);
    if (!open) continue;
    const { rows: pending } = await pool.query(`select * from hours_notify_request where branch_id = $1 and notified_at is null`, [branch.id]);
    for (const request of pending) {
      const { rows: customerRows } = await pool.query('select * from customers where id = $1', [request.customer_id]);
      const customer = customerRows[0];
      await pool.query('update hours_notify_request set notified_at = now() where id = $1', [request.id]);
      if (!customer) continue;
      try {
        await reply(customer, `We're open now! Reply to place an order.`, 'opening_notify');
      } catch (err) {
        console.error(`Failed to send opening notification to customer ${customer.id}:`, err);
      }
    }
  }
}

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
  await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'inbound', channel: 'voice', sender: 'customer', body: spokenText , processed: true });

  voiceReplyBuffers.set(customer.id, []);
  await handlePendingBatch(customer, spokenText);
  const buffered = voiceReplyBuffers.get(customer.id) || [];
  voiceReplyBuffers.delete(customer.id);
  let replyText = buffered.join(' ').trim();

  if (isFirstTurn && hasCalledBefore && customer.preferred_name) {
    const greeting = `Welcome back, ${customer.preferred_name}!`;
    await logMessage({ customerId: customer.id, tableSessionId: customer.tableSessionId, direction: 'outbound', channel: 'voice', sender: 'bot', body: greeting, trigger: 'voice_welcome_back' });
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

// Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
// PAYSTACK DOES" -- checks Moniepoint directly, right now, using this
// exact payment's own reference (the same one pushPaymentRequest
// registered it under). Confirmed live: actualAmount stays null the
// whole time a request is pending or expired, and only gets a real value
// once a matching transfer has actually cleared -- checking for that,
// not a specific status string, since the exact "it's paid" wording was
// never actually observed live (the one real test transfer arrived after
// its request had already expired).
export async function checkMoniepointPaymentPaid(payment) {
  if (!payment?.reference) return false;
  const tx = await lookupTransactionByReference(payment.reference).catch((err) => {
    console.error('Moniepoint payment status check failed:', err.message);
    return null;
  });
  if (!tx || tx.actualAmount == null) return false;
  // A non-null actualAmount only means SOME transfer cleared against this
  // reference, not that it covers what's owed -- a short transfer (bank
  // fee, mistyped amount) must not be reported as paid. Compare in kobo,
  // same minor-unit convention as pushPaymentRequest's own amountKobo and
  // webhook-moniepoint.js's amount handling. >= rather than strict
  // equality so a genuine overpayment still counts as paid.
  const expectedKobo = Math.round(Number(payment.amount) * 100);
  return Number(tx.actualAmount) >= expectedKobo;
}

// Chidera, 2026-09-21: "THE IDEA IS FOR IT TO APROVE AUTO CONFIRME HOW
// PAYSTACK DOES" -- a real, ONE-TIME Moniepoint account generated just for
// this one payment (pushPaymentRequest, POST /v1/transactions, keyed by
// this row's own `reference`), confirmed live -- and, since confirmed
// live, the ONLY account Moniepoint will ever actually track against our
// reference (an ordinary transfer straight to the business's regular
// static account is never even seen as a "POS transaction" on their
// side, so it can never be auto-confirmed by any mechanism, webhook or
// lookup -- tried quoting the static account here for exactly one real
// session, confirmed dead end). Also still fixes the original "tie"
// problem (two pending payments at the same amount, same static account)
// for good, since every payment now gets its own real account.
//
// Reused for DYNAMIC_ACCOUNT_TTL_MS (4 minutes -- a little short of
// Moniepoint's own confirmed ~5-minute expiry) rather than pushed fresh
// on every page load -- a fresh push also re-flashes the physical
// terminal's own screen (confirmed live, unavoidable -- Chidera: "dont
// worry build it"), no reason to do that more than once per payment.
//
// dynamic_account_ready_at (READY_DELAY_MS, 60s): real live report,
// 2026-09-21 -- paying a freshly generated account IMMEDIATELY failed
// with "Recipient KYC registration is incomplete" (a real bank-side
// rejection); a separate account, paid several minutes after being
// generated, went through fine. Consistent with the short NIBSS
// propagation delay new virtual accounts commonly need before every
// bank's own Name Enquiry recognizes them -- the pay page now hides the
// account number behind a short "preparing" countdown until this
// timestamp, instead of ever letting a customer try to pay it too soon.
//
// Returns null when no terminal_serial is configured (pos_sync_config)
// or the push fails for any reason -- callers fall straight back to the
// existing static-account behaviour unchanged, never a broken pay page.
const DYNAMIC_ACCOUNT_TTL_MS = 4 * 60 * 1000;
const READY_DELAY_MS = 60 * 1000;

export async function ensureDynamicPosAccount(payment) {
  if (payment.dynamic_account_number && payment.dynamic_account_expires_at && new Date(payment.dynamic_account_expires_at) > new Date()) {
    return {
      accountNumber: payment.dynamic_account_number,
      accountName: payment.dynamic_account_name,
      expiresAt: payment.dynamic_account_expires_at,
      readyAt: payment.dynamic_account_ready_at,
    };
  }
  try {
    const { rows } = await pool.query(`select terminal_serial from pos_sync_config where enabled = true and terminal_serial is not null limit 1`);
    const terminalSerial = rows[0]?.terminal_serial;
    if (!terminalSerial) return null;

    const amountKobo = Math.round(Number(payment.amount) * 100);
    await pushPaymentRequest({ terminalSerial, amountKobo, merchantReference: payment.reference });
    const tx = await lookupTransactionByReference(payment.reference);
    if (!tx?.accountNumber) return null;

    const expiresAt = new Date(Date.now() + DYNAMIC_ACCOUNT_TTL_MS);
    const readyAt = new Date(Date.now() + READY_DELAY_MS);
    await pool.query(
      `update order_payment set dynamic_account_number = $1, dynamic_account_name = $2, dynamic_account_expires_at = $3, dynamic_account_ready_at = $4 where id = $5`,
      [tx.accountNumber, tx.accountName, expiresAt, readyAt, payment.id]
    );
    payment.dynamic_account_number = tx.accountNumber;
    payment.dynamic_account_name = tx.accountName;
    payment.dynamic_account_expires_at = expiresAt;
    payment.dynamic_account_ready_at = readyAt;
    return { accountNumber: tx.accountNumber, accountName: tx.accountName, expiresAt, readyAt };
  } catch (err) {
    console.error('ensureDynamicPosAccount failed, falling back to the static account:', err.message);
    return null;
  }
}

// Chidera, 2026-09-21: "I SENT MONEY NO PLACE FOR CUSTOMER TO TAP I SENT
// THE MONEY FOR BOT TO AUTO CONFIRM" -- the pay page's own "I've sent it"
// button. Checks Moniepoint directly first (checkMoniepointPaymentPaid) --
// if it already shows paid, confirms instantly (confirmOrderPayment's own
// existing customer-facing messaging, e.g. completePayment's "Payment
// received...", handles telling them, same as a real webhook match
// would). Only falls back to alerting staff when Moniepoint doesn't show
// it yet -- a real transfer can still land after this (a request expires
// ~5 minutes after creation, confirmed live, and a late transfer still
// reaches the real account safely, also confirmed live with real money --
// see order_payment's own schema comment) -- so this NEVER tells a
// customer their payment failed, only "not yet" for a person to check.
export async function notifyCustomerClaimedPosPayment(payment, order, customer) {
  if (payment && payment.status === 'pending' && (await checkMoniepointPaymentPaid(payment))) {
    await confirmOrderPayment(payment.id);
    return;
  }

  const amount = payment ? Number(payment.amount) : Number(order.total);
  const reason = `Customer says they've sent a POS transfer (NGN ${amount.toLocaleString()}) but it hasn't auto-confirmed yet`;
  await pool.query(`update customers set handled_by = 'staff', handover_at = now(), handover_reason = $1 where id = $2`, [reason, customer.id]);
  await reply(customer, `Noted, I'll confirm your transfer and get back to you here shortly.`, 'handover_ack');

  const recipients = await handoverRecipients();
  if (!recipients.length) return;

  // Chidera, 2026-09-21: "WHY IS DINE IN HANDOVER TAKING ME OUT OF
  // WHATSAPP TO SHOW ME INVOICE?" -- a plain-text URL in the alert body
  // is exactly the bug already fixed once for handover()'s own primary
  // link (2026-09-03 comment above) -- WhatsApp auto-linkifies it to open
  // the device's own external browser, not its in-app one. Dropped
  // entirely, not converted to a second CTA button (WhatsApp only allows
  // one per message) -- the "Confirm payment" button below already lands
  // staff on the order page, which shows the same invoice/items and any
  // payment-proof images inline (OrderDetail.jsx's own paymentProofs).
  //
  // "LET INVOICE HANDOVER FOR DINE IN GROUP PAYMENT BASED ON HOW PARTIES
  // AGREED TO MAKE THE PAYMENT...SO STAFF WONT SEE TO CHECK FOR A SMALL
  // AMOUNT IN A LARGE INVOICE AND BE WONDERING HOW" -- a split/joint
  // dine-in payment can genuinely be a small slice of a much bigger table
  // total (payStatusPayload's own coversLabel logic, dinein-menu.js) --
  // without saying what this specific amount actually covers, staff
  // seeing e.g. "NGN 1200" claimed against a "NGN 4700" order have no way
  // to tell if that's right or a mistake.
  let coverageNote = '';
  if (payment && order.channel === 'dinein') {
    if (payment.covers_item_ids === null) {
      coverageNote = ` This covers the whole table (order total NGN ${Number(order.total).toLocaleString()}).`;
    } else {
      const { rows: coveredItems } = await pool.query(
        `select p.name, oi.quantity from order_item oi join product p on p.id = oi.product_id where oi.id = any($1::uuid[])`,
        [payment.covers_item_ids]
      );
      const itemsLabel = coveredItems.map((i) => (i.quantity > 1 ? `${i.quantity}x ${i.name}` : i.name)).join(', ') || 'part of the order';
      coverageNote = ` This is just for their own share (${itemsLabel}), not the whole table. The table's full order comes to NGN ${Number(order.total).toLocaleString()}.`;
    }
  }
  const credentials = await getWhatsAppCredentials(customer.branch_id);
  for (const { phoneNumber: to, staffId } of recipients) {
    const alert = `${displayNameFor(customer)} says they sent a POS transfer of NGN ${amount.toLocaleString()} but it hasn't auto-confirmed yet.${coverageNote}`;
    const path = `/orders/${order.id}`;
    const link = !process.env.PUBLIC_URL
      ? null
      : staffId
        ? `${process.env.PUBLIC_URL}/api/auth/magic/${await createMagicLink(staffId, path)}`
        : `${process.env.PUBLIC_URL}${path}`;
    await notifyStaff({ staffId, phoneNumber: to, title: 'POS transfer claimed', body: alert, linkUrl: link, linkButtonText: 'Confirm payment', credentials });
  }
}
