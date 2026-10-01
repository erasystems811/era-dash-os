// The voice add-on's own front door onto flow.js's SAME shared order
// engine (spec 0.6: "voice is a new way of talking to the same engine, not
// a second engine") -- split out of flow.js 2026-10-01 as the second phase
// of breaking up that file's 6800+ lines into focused pieces (see
// sweeps.js's own header for the first phase and the reasoning behind all
// of these splits). Sits BELOW engine/voice.js, which is the call-lifecycle
// layer (call_turn rows, confidence tracking) above these one-utterance-in,
// one-reply-out functions -- voice.js imports handleVoiceTurn/
// escalateVoiceCall/handleClosedHoursCall from flow.js's own re-export
// below, unchanged by this split.
//
// voiceReplyBuffers lives here, not in flow.js, even though flow.js's own
// senderFor (shared across every channel) reads/writes it -- flow.js
// imports it back from here. A phone call has nowhere to "push" a reply to
// -- there is no API to call the way sendWhatsApp/sendInstagram do, only a
// caller waiting on the line. So a voice customer's replies are collected
// here instead, keyed by customer.id (a customer is never on two calls at
// once), and handleVoiceTurn below reads them back out once the shared
// engine (dispatch/handlePendingBatch, completely unchanged for voice)
// finishes reacting to one utterance.
import { pool } from '../lib/db.js';
import { reply, findOrCreateCustomer, handlePendingBatch, handover, logMessage } from './flow.js';

export const voiceReplyBuffers = new Map();

// Deliberately does NOT go through handleInboundMessage/
// scheduleDebouncedProcessing -- that 15-second debounce exists to batch a
// WhatsApp customer's rapid-fire messages into one reply, which is the
// wrong shape for a live call that must answer every utterance
// immediately. This calls straight into handlePendingBatch, the exact same
// routing handleInboundMessage's timer eventually reaches -- pure ack
// detection, existing-order dispatch, intent classification, handover,
// everything -- completely unchanged.
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
