// Call-lifecycle bookkeeping for the voice ordering add-on -- sits ABOVE
// engine/flow.js's handleVoiceTurn (one utterance in, one reply out) the
// same way routes/rider.js/engine/delivery-dispatch.js sit above flow.js's
// exported notify* functions for the Delivery add-on, rather than folding
// call-row plumbing into flow.js itself. Whatever eventually answers a real
// phone call (Stage 6+) calls these; sandbox/test-voice-conversation.mjs
// calls the exact same functions today, standing in for a real
// TelephonyProvider + streaming STT.
import { pool } from '../lib/db.js';
import { handleVoiceTurn, escalateVoiceCall, handleClosedHoursCall } from './flow.js';
import { checkOperatingHours } from './voice-hours.js';

// Starting point only -- spec A7's own words: "two weeks of confidence
// scores from a real restaurant is worth more than any amount of testing
// in an office." Tune this once a real client's real call data exists,
// not before.
const LOW_CONFIDENCE_THRESHOLD = 0.5;

export async function startVoiceCall({ branchId, callerNumber, transport = 'forwarding' }) {
  const { rows } = await pool.query(
    `insert into voice_call (branch_id, caller_number, direction, transport, answered_at)
     values ($1, $2, 'inbound', $3, now()) returning *`,
    [branchId || null, callerNumber, transport]
  );
  return rows[0];
}

async function nextSeq(callId) {
  const { rows } = await pool.query('select coalesce(max(seq), 0) + 1 as seq from call_turn where call_id = $1', [callId]);
  return rows[0].seq;
}

// `call` is mutated in place (customer_id gets filled in on the first turn)
// so the same object can be threaded through every subsequent utterance in
// the call without a re-fetch. `confidence` is the recogniser's own score
// for THIS utterance (null from a text-simulated call, since there's no
// real recognition happening) -- stored per spec A7, drives handover
// trigger 3 once Stage 3 builds it.
export async function handleCallerUtterance(call, spokenText, confidence = null) {
  const isFirstTurn = !call.customer_id;

  const callerSeq = await nextSeq(call.id);
  await pool.query(
    `insert into call_turn (call_id, seq, speaker, transcript, confidence) values ($1, $2, 'caller', $3, $4)`,
    [call.id, callerSeq, spokenText, confidence]
  );

  // A8 trigger 3: two consecutive low-confidence turns hand over
  // immediately, BEFORE this (possibly garbled) transcript ever reaches the
  // shared order engine -- the spec's own words, the AI must never say it
  // didn't understand three times, and feeding noise into extraction risks
  // exactly that, one bad guess at a time. Deliberately checked against the
  // real rows just inserted, not a running counter, so it can't drift out
  // of sync with what's actually in call_turn.
  let escalated = false;
  let customer;
  let replyText;
  if (confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD) {
    const { rows: lastTwo } = await pool.query(
      `select confidence from call_turn where call_id = $1 and speaker = 'caller' order by seq desc limit 2`,
      [call.id]
    );
    if (lastTwo.length === 2 && lastTwo.every((r) => r.confidence !== null && r.confidence < LOW_CONFIDENCE_THRESHOLD)) {
      escalated = true;
      ({ customer, replyText } = await escalateVoiceCall({
        callerNumber: call.caller_number,
        branchId: call.branch_id,
        reason: 'Two consecutive low-confidence recognition turns',
      }));
    }
  }

  // A9: checked every turn, not just the first -- "now" barely changes
  // within one call, but this way a call that happens to straddle the
  // closing boundary never slips a real order through on a later turn just
  // because the first one happened to land a minute before closing.
  const { rows: configRows } = await pool.query('select operating_hours, recording_enabled from voice_config limit 1');
  const voiceConfig = configRows[0] || {};
  let closedHours = false;
  if (!escalated) {
    const hours = checkOperatingHours(voiceConfig.operating_hours);
    if (!hours.open) {
      closedHours = true;
      ({ customer, replyText } = await handleClosedHoursCall({
        callerNumber: call.caller_number,
        branchId: call.branch_id,
        opensAt: hours.opensAt,
      }));
    }
  }

  if (!escalated && !closedHours) {
    ({ customer, replyText } = await handleVoiceTurn({
      callerNumber: call.caller_number,
      branchId: call.branch_id,
      spokenText,
      isFirstTurn,
    }));
  }

  if (isFirstTurn) {
    await pool.query('update voice_call set customer_id = $1 where id = $2', [customer.id, call.id]);
    call.customer_id = customer.id;
    // A11: off by default, stated once at the start of the call, never
    // mid-call -- the Nigeria Data Protection Act makes the restaurant the
    // controller, so this is their opt-in being honoured, not ERA's.
    if (voiceConfig.recording_enabled) {
      replyText = `This call may be recorded for quality purposes. ${replyText}`.trim();
    }
  }

  const systemSeq = await nextSeq(call.id);
  await pool.query(
    `insert into call_turn (call_id, seq, speaker, transcript) values ($1, $2, 'system', $3)`,
    [call.id, systemSeq, replyText]
  );

  return replyText;
}

export async function endVoiceCall(call, outcome, orderId = null) {
  const { rows } = await pool.query(
    `update voice_call set ended_at = now(), outcome = $1, order_id = $2,
       duration_seconds = extract(epoch from (now() - coalesce(answered_at, started_at)))::int
     where id = $3 returning *`,
    [outcome, orderId, call.id]
  );
  return rows[0];
}
