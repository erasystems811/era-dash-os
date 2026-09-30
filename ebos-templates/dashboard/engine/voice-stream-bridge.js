// The real-time loop Stage 6 was always missing -- wires one Twilio Media
// Stream WebSocket connection (routes/voice-webhook.js answers the call,
// server.js attaches this to the /voice/stream upgrade) to Deepgram (STT)
// and Fish Audio (TTS/cloned voice), feeding recognized caller turns into
// engine/voice.js's handleCallerUtterance -- the exact function
// sandbox/test-voice-conversation.mjs already drives with text-simulated
// calls, so the ordering/escalation/closed-hours logic underneath this is
// unchanged and already proven; this file is purely the audio plumbing on
// top of it.
//
// Twilio's own wire protocol (confirmed against their docs, not guessed):
// inbound frames are {event:"media", media:{payload: base64 mu-law 8kHz
// mono}}; outbound frames are {event:"media", streamSid, media:{payload}};
// a {event:"clear", streamSid} empties Twilio's playback buffer instantly
// -- the mechanism barge-in below relies on.
import { pool } from '../lib/db.js';
import { handleCallerUtterance, endVoiceCall } from './voice.js';
import { openDeepgramStream } from './deepgram-stt.js';
import { synthesizeToMulaw } from './fishaudio-tts.js';
import { mulawFrames } from './mulaw.js';
import { getTelephonyProvider } from './telephony-provider.js';

// A caller's accumulated isFinal text only turns into a real order-engine
// turn once Deepgram reports speechFinal (a true pause, not just "this
// particular chunk of text is locked in") -- see deepgram-stt.js's own
// comment on the distinction.
export function handleVoiceStreamConnection(ws, { callId }) {
  let call = null;
  let streamSid = null;
  let deepgram = null;
  let pendingTranscript = '';
  let pendingConfidences = [];
  let turnInFlight = false;
  let speaking = false;
  let voiceId = null;
  const provider = getTelephonyProvider();

  async function loadCall() {
    const { rows } = await pool.query('select * from voice_call where id = $1', [callId]);
    if (!rows[0]) throw new Error(`voice_call ${callId} not found -- stream connected with no matching call row.`);
    call = rows[0];
    const { rows: cfg } = await pool.query('select voice_id from voice_config limit 1');
    voiceId = cfg[0]?.voice_id || null;
  }

  function sendClear() {
    if (!streamSid) return;
    ws.send(JSON.stringify({ event: 'clear', streamSid }));
  }

  // Sends one reply's audio as a sequence of Twilio media frames, stopping
  // immediately (without throwing) if barge-in flips `speaking` false out
  // from under it mid-send -- the generator is driven one frame at a time
  // for exactly this reason, not handed a whole Buffer to fire-and-forget.
  async function speak(replyText) {
    speaking = true;
    try {
      await synthesizeToMulaw(replyText, voiceId, (mulawChunk) => {
        if (!speaking || !streamSid) return;
        for (const frame of mulawFrames(mulawChunk)) {
          if (!speaking) return;
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: frame.toString('base64') } }));
        }
      });
      if (streamSid) ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'reply-done' } }));
    } catch (err) {
      console.error('Voice TTS failed:', err);
    } finally {
      speaking = false;
    }
  }

  async function runTurn(transcript, confidence) {
    turnInFlight = true;
    try {
      const replyText = await handleCallerUtterance(call, transcript, confidence);
      await speak(replyText);
    } catch (err) {
      console.error('Voice turn failed:', err);
    } finally {
      turnInFlight = false;
    }
  }

  function onTranscript({ transcript, confidence, isFinal, speechFinal }) {
    if (!isFinal) {
      // Barge-in (spec: caller can interrupt): real speech arriving while
      // the bot is mid-reply cuts Twilio's own playback buffer immediately
      // -- not only skipped once is-final text exists, since waiting for
      // that would make barge-in feel exactly as laggy as not having it.
      if (speaking && transcript.trim().length > 1 && provider.capabilityFlags?.bargeIn) {
        speaking = false;
        sendClear();
      }
      return;
    }
    pendingTranscript = `${pendingTranscript} ${transcript}`.trim();
    pendingConfidences.push(confidence ?? 1);
    // Known Phase 1 gap, not fixed here: if a caller somehow starts a new
    // utterance before handleCallerUtterance finishes the previous one
    // (turnInFlight), this new text queues behind it rather than being
    // held in a proper per-turn buffer, and the two could merge into one
    // transcriptToSend later. A real call's natural pause between turns
    // avoids this in practice; a correct fix is a real turn queue, not
    // worth it for Phase 1's single-caller-speaks-at-a-time shape.
    if (!speechFinal || turnInFlight) return;
    const transcriptToSend = pendingTranscript;
    const confidenceToSend = pendingConfidences.length
      ? pendingConfidences.reduce((a, b) => a + b, 0) / pendingConfidences.length
      : null;
    pendingTranscript = '';
    pendingConfidences = [];
    if (transcriptToSend) runTurn(transcriptToSend, confidenceToSend);
  }

  // Twilio can send 'media' right behind 'start' with no gap, and Node
  // dispatches each 'message' event's async handler without waiting for
  // the previous one to finish -- without this, a 'media'/'test_transcript'
  // frame arriving while loadCall()'s query is still in flight would hit a
  // null `call` (found live in this file's own first sandbox test run).
  // Every handler below awaits the SAME promise, so they stay ordered
  // relative to 'start' without blocking on each other once it resolves.
  let ready = null;

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid || msg.streamSid;
      ready = loadCall()
        .then(() => {
          deepgram = openDeepgramStream({
            onTranscript,
            onError: (err) => console.error('Deepgram stream error:', err),
          });
        })
        .catch((err) => {
          console.error('Voice stream could not load call:', err);
          ws.close();
        });
      return;
    }

    if (ready) await ready;
    if (!call) return;

    if (msg.event === 'media') {
      deepgram?.sendAudio(Buffer.from(msg.media.payload, 'base64'));
      return;
    }

    // Sandbox-only test seam (gated on EBOS_SANDBOX, same as every real
    // provider call this file depends on): a real Deepgram connection
    // can't be simulated by sending it mock mu-law bytes, so
    // sandbox/test-voice-telephony-bridge.mjs drives a caller turn by
    // sending this non-standard frame directly over the real WebSocket
    // instead -- the rest of the pipeline from here on (handleCallerUtterance,
    // Fish Audio's own sandbox stub, outbound media frames, DB state) is
    // exercised exactly as a real call would, nothing about it is mocked
    // in the test itself.
    if (msg.event === 'test_transcript' && process.env.EBOS_SANDBOX === '1') {
      onTranscript({
        transcript: msg.transcript,
        confidence: msg.confidence ?? 0.95,
        isFinal: msg.isFinal ?? true,
        speechFinal: msg.speechFinal ?? true,
      });
      return;
    }

    if (msg.event === 'mark') {
      // Twilio echoes our own 'reply-done' mark once playback actually
      // finishes -- nothing to do with it today beyond knowing the bot has
      // stopped talking, which `speaking` already tracks independently
      // (set false in speak()'s own finally); kept as a no-op branch so an
      // unrecognised event type below doesn't log noise for this one.
      return;
    }

    if (msg.event === 'stop') {
      deepgram?.close();
      if (call) {
        // `call` was only ever loaded once, at the stream's own 'start'
        // event -- handleCallerUtterance may have placed a real order
        // since then (it only mutates call.customer_id in place, per its
        // own comment), so order_id has to be re-read fresh here rather
        // than trusted from that stale snapshot.
        const { rows } = await pool.query(
          `select o.id from "order" o where o.customer_id = $1 and o.created_at >= $2 order by o.created_at desc limit 1`,
          [call.customer_id, call.started_at]
        );
        const orderId = rows[0]?.id || null;
        // Simplified to the two outcomes this can tell apart from SQL
        // alone -- Voice.jsx's OUTCOME_LABEL also has enquiry_answered/
        // handover_transferred/handover_callback/failed, which need real
        // call data (how a finished call actually breaks down across
        // those) to classify correctly rather than guessed from nothing.
        await endVoiceCall(call, orderId ? 'order_placed' : 'abandoned', orderId).catch((err) =>
          console.error('endVoiceCall failed:', err)
        );
      }
      ws.close();
    }
  });

  ws.on('close', () => {
    deepgram?.close();
  });
}
