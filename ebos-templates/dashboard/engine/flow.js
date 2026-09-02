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
import { sendWhatsApp, sendWhatsAppDocument, sendWhatsAppImage, markTypingIndicator, downloadWhatsAppMedia } from './whatsapp-send.js';
import { sendMenuList } from './menu-message.js';
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
async function logMessage({ customerId, direction, channel, sender, body, trigger, platformMessageId }) {
  await pool.query(
    `insert into message (customer_id, direction, channel, sender, body, trigger, platform_message_id) values ($1, $2, $3, $4, $5, $6, $7)`,
    [customerId, direction, channel, sender, body, trigger || null, platformMessageId || null]
  );
  await pool.query(`update customers set last_message = $1, last_message_at = now() where id = $2`, [body, customerId]);
}

// Instagram's send response carries the new message's own id (message_id)
// -- WhatsApp's response shape has no equivalent use here (coexistence
// already has its own, cleaner smb_message_echoes signal), so this only
// ever returns something for an Instagram send. See message.platform_
// message_id's schema comment for what this id gets used for.
function platformMessageIdFrom(customer, sendResult) {
  return customer.channel === 'instagram' ? sendResult?.message_id || null : null;
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

  const isFirstTakeover = staffId && customer.handled_by_staff_id !== staffId;

  const sendResult = await botEngine.sendMessage({ trigger: 'explicit_type_command', to: recipientFor(customer), text, whatsappSend: await senderFor(customer) });
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

  // Other staff who'd also get a handover alert should know someone's
  // already on it, the moment they actually reply -- not left to find out
  // by both answering the same customer.
  if (isFirstTakeover) {
    const { rows: staffRows } = await pool.query('select name, phone_number from staff where id = $1', [staffId]);
    const staffName = staffRows[0]?.name || 'A staff member';
    const actingStaffPhone = staffRows[0]?.phone_number;
    const others = (await handoverRecipients()).filter((phone) => phone !== actingStaffPhone);
    for (const to of others) {
      try {
        await botEngine.sendMessage({
          trigger: 'staff_handoff_intro',
          to,
          text: `${staffName} has taken over the chat with ${displayNameFor(customer)}.`,
          whatsappSend: sendWhatsApp,
        });
      } catch (err) {
        console.error(`Failed to notify ${to} of takeover:`, err);
      }
    }
  }
}

// Claims a conversation for staff WITHOUT sending anything -- the
// dashboard's "Take over from bot" button, clicked before staff has typed a
// word. Exists specifically to close a real race: sendStaffReply only
// marks handled_by='staff' once a reply actually goes out, but a human
// typing a reply can easily take longer than the bot's own debounce
// window, so the bot would still answer the customer in the meantime, both
// of them replying at once. Clicking this first closes that window
// immediately, before typing even starts.
export async function takeOverConversation(customerId, staffId) {
  const { rows } = await pool.query('select * from customers where id = $1', [customerId]);
  const customer = rows[0];
  if (!customer) throw new Error('Customer not found.');

  const isFirstTakeover = staffId && customer.handled_by_staff_id !== staffId;

  await pool.query(
    `update customers set handled_by = 'staff', handled_by_staff_id = coalesce($1, handled_by_staff_id), handover_at = coalesce(handover_at, now()) where id = $2`,
    [staffId || null, customer.id]
  );

  if (isFirstTakeover) {
    const { rows: staffRows } = await pool.query('select name, phone_number from staff where id = $1', [staffId]);
    const staffName = staffRows[0]?.name || 'A staff member';
    const actingStaffPhone = staffRows[0]?.phone_number;
    const others = (await handoverRecipients()).filter((phone) => phone !== actingStaffPhone);
    for (const to of others) {
      try {
        await botEngine.sendMessage({
          trigger: 'staff_handoff_intro',
          to,
          text: `${staffName} has taken over the chat with ${displayNameFor(customer)}.`,
          whatsappSend: sendWhatsApp,
        });
      } catch (err) {
        console.error(`Failed to notify ${to} of takeover:`, err);
      }
    }
  }
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
// conversation regardless of which side of coexistence it happened on.
export async function recordAppReply({ phoneNumber, text }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channel: 'whatsapp' });
  const wasAlreadyHandled = customer.handled_by === 'staff' && (customer.handled_by_staff_id || customer.app_handled_at);
  await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'staff', body: text, trigger: 'app_reply' });
  await pool.query(
    `update customers set handled_by = 'staff', app_handled_at = coalesce(app_handled_at, now()), handover_at = coalesce(handover_at, now()) where id = $1`,
    [customer.id]
  );

  // Same "someone has taken over" broadcast as sendStaffReply's first-
  // takeover case -- other handover-alert numbers should know the moment
  // anyone starts answering, whether that happened from the dashboard or
  // the app.
  if (!wasAlreadyHandled) {
    const others = (await handoverRecipients()).filter((phone) => phone !== phoneNumber);
    for (const to of others) {
      try {
        await botEngine.sendMessage({
          trigger: 'staff_handoff_intro',
          to,
          text: `Someone has taken over the chat with ${displayNameFor(customer)} from the WhatsApp app.`,
          whatsappSend: sendWhatsApp,
        });
      } catch (err) {
        console.error(`Failed to notify ${to} of app takeover:`, err);
      }
    }
  }
}

// Instagram's version of recordAppReply above -- a real human reply typed
// directly in the business's own Instagram app, not this dashboard. Unlike
// WhatsApp, Meta gives no separate field for this (see message.platform_
// message_id's schema comment) -- webhook-instagram.js is the one that
// tells "our own echo" apart from "a genuine human reply" before ever
// calling this, so by the time this runs, that check has already happened.
export async function recordAppReplyInstagram({ channelId, text }) {
  const customer = await findOrCreateCustomer({ channelId, channel: 'instagram' });
  const wasAlreadyHandled = customer.handled_by === 'staff' && (customer.handled_by_staff_id || customer.app_handled_at);
  await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'staff', body: text, trigger: 'app_reply' });
  await pool.query(
    `update customers set handled_by = 'staff', app_handled_at = coalesce(app_handled_at, now()), handover_at = coalesce(handover_at, now()) where id = $1`,
    [customer.id]
  );

  if (!wasAlreadyHandled) {
    const others = await handoverRecipients();
    for (const to of others) {
      try {
        await botEngine.sendMessage({
          trigger: 'staff_handoff_intro',
          to,
          text: `Someone has taken over the chat with ${displayNameFor(customer)} from the Instagram app.`,
          whatsappSend: sendWhatsApp,
        });
      } catch (err) {
        console.error(`Failed to notify ${to} of Instagram app takeover:`, err);
      }
    }
  }
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
async function getOpenOrder(customerId) {
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

// `extra` is for context a plain conversation summary can't produce itself
// -- specifically the invoice and payment-proof links on a payment-related
// handover, so whoever's confirming payment has both right there instead of
// having to go look them up on the dashboard first.
async function handover(customer, reason, extra) {
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
  // to receive the internal staff alert below.
  await reply(customer, `Let me confirm this properly for you, I'll get back to you here shortly.`, 'handover_ack');

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

async function handleGreeting(customer, text) {
  const message = await askText(GREETING_SYSTEM, text);
  await reply(customer, message, 'greeting');
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
  const itemsTotal = rows.reduce((sum, r) => sum + Number(r.price) * r.quantity, 0);
  // delivery_fee is 0 until handleCollectFulfilment sets it (only known once
  // fulfilment_type/address are collected, and only for real Chowdeck
  // delivery) -- reading it straight off the order row here means callers
  // before and after that point both get the right total automatically.
  const deliveryFee = Number(order.delivery_fee || 0);
  return { lines, itemsTotal, deliveryFee, total: itemsTotal + deliveryFee };
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
          // The "View menu" button beats even a photo once it's available --
          // built and sent entirely by this backend (engine/menu-message.js),
          // not dependent on Meta's own catalogue indexing, so it can't fail
          // the way that did. WhatsApp only (Instagram has no equivalent
          // interactive list type). Returns false only when the catalogue is
          // genuinely empty, so the photo/text fallback below still covers
          // that real gap.
          let catalogShown = false;
          if (customer.channel !== 'instagram' && process.env.EBOS_SANDBOX !== '1') {
            catalogShown = await sendMenuList(
              recipientFor(customer),
              "Here's our menu, tap below to see everything we have.",
              order.branch_id
            ).catch((err) => {
              console.error('sendMenuList failed:', err.message);
              return false;
            });
            // sendMenuList sends straight via the Graph API, not through
            // reply() -- logged here so it actually shows up in the
            // conversation history instead of leaving a gap that makes a
            // real "did it send twice" question impossible to answer from
            // the transcript alone.
            if (catalogShown) await logMessage({ customerId: customer.id, direction: 'outbound', channel: customer.channel, sender: 'bot', body: '[interactive menu button sent]', trigger: 'menu_shown' });
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
        const { lines } = await applyOrderModifications(order, mods, { allowRemovals: true });
        prefix = `${prefix}Got it, added that on, your order's now ${lines}. `;
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

  const { rows: itemsAfter } = await pool.query('select * from order_item where order_id = $1', [order.id]);
  const stillOutstanding = await missingFieldsForOrder(order, itemsAfter);
  if (stillOutstanding.length) {
    const fields = await loadBotFields();
    const nextField = fields.find((f) => f.key === stillOutstanding[0]);
    await send(await fieldPrompt(stillOutstanding[0], nextField?.question, order.branch_id));
    return;
  }

  await transitionOrder(order, 'check_availability');
  await transitionOrder(order, 'calculate_price');
  const { lines, total } = await summariseOrder(order);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
  await transitionOrder(order, 'confirm_order');
  await send(`To confirm: ${lines}, total NGN ${total}. Reply yes to confirm, or let me know if you would like to change anything.`);
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
    await reply(customer, answer ? `${answer} Just let me know, yes to confirm, or what you would like to change.` : 'No problem, just let me know what you would like to change, or reply yes to confirm as is.');
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
      // Persisted the moment it's resolved (not re-resolved at dispatch
      // time) so the price the customer is about to pay and the amount the
      // rider is eventually owed both come from the exact same zone row --
      // see schema.sql's own comment on order.delivery_zone_id.
      const zone = await resolveZoneForAddress(customer.address, order.branch_id);
      if (!zone) {
        // Never guess a zone (spec B5) -- a wrong one means a wrong price
        // charged to the customer and a wrong amount owed to a rider, both
        // real money. Same handover primitive sendPaymentInstructions
        // already uses when bank details aren't configured.
        await handover(customer, 'Delivery address could not be matched to a delivery zone');
        return;
      }
      await pool.query(`update "order" set delivery_zone_id = $1, delivery_fee = $2 where id = $3`, [zone.id, zone.customer_fee, order.id]);
      order.delivery_zone_id = zone.id;
      order.delivery_fee = Number(zone.customer_fee);
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
  if (!hasBankDetails) await handover(customer, 'Order ready for payment but no payment method is configured for this business yet');
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
  return {
    answer: typeof result?.answer === 'string' && result.answer.trim() ? result.answer.trim() : null,
    isGeneralAvailability: Boolean(result?.isGeneralAvailability),
  };
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
// mid-order (answerOrderQuestion) and pre-order (answerFromKnowledgeBase)
// alike. Prefers the real, always-current interactive menu button (built
// and sent by this backend, re-sent every time it's asked, not just once)
// over the plain-text item list; falls back to the text answer whenever
// the catalogue is genuinely empty or the send itself fails, so a customer
// is never left with silence just because of a transient WhatsApp error.
async function resolveGeneralAvailability(customer, isGeneralAvailability, answer, rawText, branchId) {
  const shouldShowMenu = isGeneralAvailability || looksLikeBrowseQuestion(rawText);
  if (!shouldShowMenu || customer.channel === 'instagram' || process.env.EBOS_SANDBOX === '1') return answer;

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
  await handover(customer, 'Customer waiting on payment but no payment link/bank details are available');
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

  const { lines, total } = await summariseOrder(order);
  await pool.query('update "order" set total = $1 where id = $2', [total, order.id]);
  return { lines, total, addedValue };
}

async function handleOrderModification(customer, order, mods) {
  const paid = order.payment_status === 'confirmed' || order.payment_status === 'accepted';

  if (paid && (mods.removes.length || mods.sets.length)) {
    await reply(customer, `Your order's already paid for, so I can't remove or change what's in it now, but I can add more if you'd like.`);
    if (!mods.adds.length) return;
  }

  const { lines, total, addedValue } = await applyOrderModifications(order, mods, { allowRemovals: !paid });

  if (paid) {
    await reply(customer, `Got it, added that on. Your order's now ${lines}, new total NGN ${total} (NGN ${addedValue} more than what's already paid). Our team will confirm the extra payment with you.`);
    await handover(customer, 'Customer added items to an already-paid order, extra payment needs confirming');
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
  await reply(customer, `Got it, your order's now ${lines}, new total NGN ${total}. Reply yes to confirm, or let me know if you would like to change anything else.`);
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

// null = not applicable (some part of the message needs a real answer),
// 'ack' = every line was a pure acknowledgment, reply with nothing,
// 'thanks' = at least one line was a thank-you (and the rest, if any, were
// pure acks too) -- a plain "you're welcome" back, not silence.
function classifyPureAck(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  let sawThanks = false;
  for (const line of lines) {
    if (PURE_THANKS.test(line)) {
      sawThanks = true;
      continue;
    }
    if (!PURE_ACK.test(line)) return null;
  }
  return sawThanks ? 'thanks' : 'ack';
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
    await handover(customer, 'Customer complained about order delay/wait time');
    return;
  }

  const statusLine =
    order.fulfilment_type === 'delivery'
      ? `Paid and being prepared for delivery.`
      : `Paid and being prepared for pickup.`;
  const answer = await answerOrThenShowMenu(customer, order, text, statusLine);
  if (answer) {
    await reply(customer, answer, 'order_question_answer');
    return;
  }
  await reply(customer, `Your order is already paid and being prepared. Let me know if you'd like to add anything else.`);
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
  await handover(customer, `Customer wants to switch an already-paid order from ${previousType} to ${newType}`);
}

async function dispatch(customer, order, text) {
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
export async function notifyDeliveryAssigned(orderId, { riderName, trackingUrl, deliveryCode }) {
  const { rows } = await pool.query('select * from "order" where id = $1', [orderId]);
  const order = rows[0];
  if (!order) throw new Error('Order not found.');
  const { rows: custRows } = await pool.query('select * from customers where id = $1', [order.customer_id]);
  const customer = custRows[0];
  if (!customer) throw new Error('Customer not found.');
  const trackingLine = trackingUrl ? ` Track your delivery here: ${trackingUrl}.` : '';
  await reply(
    customer,
    `Your order is on its way with ${riderName}.${trackingLine} Give them this code when they arrive: ${deliveryCode}`,
    'delivery_assigned'
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
  // The kanban `status` staff actually watch only reaches 'confirmation'
  // here, once money is really in -- never at the customer's "yes" (see
  // handleConfirmOrder, which sets confirmed_at instead, an internal marker
  // only). Fulfilment progress past this (preparation, ready, delivery,
  // in_transit, completed) is staff's own call as they physically
  // prepare/dispatch it, not something the bot decides -- payment
  // succeeding is not the same fact as food being ready.
  await pool.query(`update "order" set status = 'confirmation' where id = $1`, [order.id]);
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
export const DEBOUNCE_MS = 15_000;
const pendingTimers = new Map();

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
        await reply(customer, `Sorry, having some trouble on my end. Let me get someone to help you.`, 'error_recovery');
        await handover(customer, 'Unexpected error while processing customer message');
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
  if (!pending.length) return; // already answered by the time this fired
  const text = pending.map((m) => m.body).join('\n');

  await handlePendingBatch(customer, text);

  // Only marked once actually handled -- if handlePendingBatch throws, these
  // stay unprocessed and get picked up (and re-included) the next time
  // anything schedules processing for this customer, instead of being
  // written off by a batch that never actually replied to them.
  await pool.query(
    `update message set processed_at = now() where id = any($1)`,
    [pending.map((m) => m.id)]
  );
}

// Hands control back to the bot -- either a staff member explicitly clicked
// "Return to bot" (routes/api.js) or 30 minutes have passed with no further
// staff reply (handlePendingBatch below). Either way, the customer may have
// told the human real order information (what they want, delivery vs
// pickup, confirming yes) purely in conversation, with nothing reflected in
// the order record itself -- so this doesn't just flip a flag and wait for
// the NEXT message, it replays everything the customer said since the
// handover through the exact same extraction pipeline a live message
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

  const boundary = customer.handover_at || customer.created_at;
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

async function handlePendingBatch(customer, text) {
  // Checked first, before ANY other routing -- deterministic, free, and
  // applies everywhere (mid-order, post-order, no order at all, even while
  // staff nominally still has the thread) so a plain "ok"/"thanks"/"sounds
  // good" never triggers a reply, a restart, or an unwanted "still
  // checking" filler. This is the actual answer to "how does the bot know
  // when to keep quiet": one deterministic rule, checked before any other
  // decision, not scattered per state -- including inside
  // resumeBotControl's catch-up replay, so staff leaving a conversation at
  // a plain "ok" doesn't get treated as something to act on.
  const ackType = classifyPureAck(text);
  if (ackType === 'ack') return;
  if (ackType === 'thanks') {
    await reply(customer, `You're welcome!`, 'thanks_ack');
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
export async function acknowledgeMenuTap({ phoneNumber, channelId, itemName, channel = 'whatsapp', branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: `[tapped menu: ${itemName}]` });
  await reply(customer, `${itemName} is available. Please let me know how many and anything else you would like, and I will take your order.`, 'menu_tap_ack');
}

export async function handleInboundMessage({ phoneNumber, channelId, text, channel = 'whatsapp', messageId, branchId }) {
  const customer = await findOrCreateCustomer({ phoneNumber, channelId, channel, branchId });
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: text });
  // Best-effort -- shows "typing..." for the debounce wait so the customer
  // sees something happening instead of silence. Never let this delay or
  // break the actual reply. Only sent for the message that STARTS a
  // debounce cycle, not every message in a burst -- Meta's API rejects
  // (#131009) a typing indicator sent while one from an earlier message in
  // the same still-open cycle is already active, and it stays visible for
  // up to 25s anyway, longer than the whole debounce window, so re-sending
  // mid-burst has no benefit even when it doesn't error. WhatsApp's call
  // needs the inbound messageId (its typing indicator is a mark-as-read+
  // typing combo tied to that specific message); Instagram's sender_action
  // just needs who to show it to.
  if (!pendingTimers.has(customer.id)) {
    if (channel === 'whatsapp') {
      markTypingIndicator(messageId).catch((err) => console.error('Typing indicator failed:', err));
    } else if (channel === 'instagram') {
      markInstagramTypingIndicator(channelId).catch((err) => console.error('Instagram typing indicator failed:', err));
    }
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
  await logMessage({ customerId: customer.id, direction: 'inbound', channel: 'voice', sender: 'customer', body: spokenText });

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
  await logMessage({ customerId: customer.id, direction: 'inbound', channel, sender: 'customer', body: `[${kind}]` });

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
    await handover(customer, `Customer sent a ${kind} with no order currently awaiting payment`);
    return;
  }

  try {
    const dataUrl = channel === 'instagram' ? await downloadInstagramMedia(mediaId) : await downloadWhatsAppMedia(mediaId);
    await pool.query(`update "order" set payment_proof_url = $1, payment_status = 'proof_submitted' where id = $2`, [dataUrl, order.id]);
    await reply(customer, `Noted, I will confirm the payment and get back to you shortly.`, 'payment_proof_received');
    // Staff confirming payment needs both documents in front of them at
    // once -- the invoice (what was ordered/owed) and the receipt they just
    // sent (proof it was paid) -- not a bare "check the dashboard" alert.
    const { rows: docs } = await pool.query(`select url from generated_document where order_id = $1 and type = 'invoice' order by created_at desc limit 1`, [order.id]);
    const invoicePath = docs[0]?.url;
    const invoiceUrl = invoicePath && process.env.PUBLIC_URL ? `${process.env.PUBLIC_URL}${invoicePath}` : null;
    await handover(customer, `Customer submitted payment proof, needs manual confirmation`, {
      invoice: invoiceUrl ? `Invoice: ${invoiceUrl}` : null,
      receipt: process.env.PUBLIC_URL ? `Payment proof: ${process.env.PUBLIC_URL}/documents/payment-proof/${order.id}` : null,
    });
  } catch (err) {
    console.error(`Failed to download payment proof ${kind}:`, err);
    await reply(customer, `Got your ${kind} but had trouble saving it. Let me get someone to help confirm your payment.`, 'payment_proof_received');
    await handover(customer, `Customer submitted payment proof but the ${kind} failed to save`);
  }
}
