// Staff communication and takeover -- split out of flow.js 2026-10-01 as
// the fourth phase of breaking up that file's 6800+ lines into focused
// pieces (see sweeps.js, voice-turn.js, dinein.js for the first three).
// Everything here is about reaching staff (handover/order alerts, the
// WhatsApp-dashboard-link trigger) or staff reaching back in (a dashboard
// reply, a coexistence app reply, taking over or returning a conversation)
// -- NOT handover() itself, which stays in flow.js: it's called from 24+
// places deep inside the order/payment/media state machine, not just from
// the edges the way everything here is, so moving it would add a lot of
// import-back surface for little real benefit. flow.js re-exports every
// name below so no existing import site (routes/api.js, webhook-
// whatsapp.js, webhook-instagram.js, this file's own test coverage) had
// to change, and imports resumeBotControl back for its own internal use
// (handlePendingBatch/handleInboundMedia's own "did staff go quiet"
// check).
import { pool } from '../lib/db.js';
import * as botEngine from '../bot-engine/index.js';
import { sendWhatsApp, sendWhatsAppTemplate, sendWhatsAppCtaUrl } from './whatsapp-send.js';
import { getWhatsAppCredentials } from './branch-channel.js';
import { createMagicLink, findStaffByPhoneNumber, toWhatsAppDigits } from '../lib/auth.js';
import { pushToStaff } from './push-notify.js';
import {
  logMessage,
  needsStaffChatRedirect,
  sendChatRedirectPing,
  recipientFor,
  senderFor,
  platformMessageIdFrom,
  findOrCreateCustomer,
  resolveCustomerOrder,
  handlePendingBatch,
} from './flow.js';

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

  // handover_at is established BEFORE the ping check below (not after, as
  // this used to do) -- needsStaffChatRedirect now compares a ping's own
  // timestamp against handover_at to tell "already pinged this session"
  // from "a stale ping from a prior one," so handover_at has to already
  // be fixed at this point: on a brand-new session's very first ping,
  // setting it afterward would make that ping's own created_at land
  // BEFORE handover_at, reading as if it predated this session and wrongly
  // allowing a second ping on the very next reply.
  const { rows: updated } = await pool.query(
    `update customers set handled_by = 'staff', handled_by_staff_id = coalesce($1, handled_by_staff_id), handover_at = coalesce(handover_at, now()) where id = $2 returning handover_at`,
    [staffId || null, customer.id]
  );
  customer.handover_at = updated[0].handover_at;

  if (await needsStaffChatRedirect(customer)) {
    await sendChatRedirectPing(customer, `We're trying to reach out to you.`, { trigger: 'staff_reply_ping', sender: 'staff' });
  }
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
