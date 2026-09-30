#!/usr/bin/env node
// Stage 6's own regression fixture: the real-time telephony plumbing
// (routes/voice-webhook.js, engine/voice-stream-bridge.js, engine/twilio-
// voice.js, engine/deepgram-stt.js, engine/fishaudio-tts.js, engine/
// mulaw.js) sitting on top of the already-proven order engine
// (sandbox/test-voice-conversation.mjs drives handleCallerUtterance
// directly and is unchanged by this file).
//
// Everything below runs against the REAL running Express app and a REAL
// WebSocket connection to it -- not unit-level mocks of this app's own
// code. The only things standing in for a real account are Deepgram and
// Fish Audio themselves (EBOS_SANDBOX, same convention as every other
// external provider in this codebase -- see engine/whatsapp-send.js), and
// a sandbox-only 'test_transcript' WS frame (voice-stream-bridge.js's own
// comment on it) standing in for a real Deepgram recognition result, since
// there is no way to make a real speech recognizer transcribe fake audio
// bytes. Twilio's own wire protocol (event names, field shapes) is
// real -- confirmed against Twilio's docs, not guessed -- so this proves
// the bridge actually speaks that protocol correctly.
process.env.EBOS_TEST_PGLITE = '1';
process.env.EBOS_SANDBOX = '1';
process.env.PORT = '3946';
process.env.SESSION_SECRET = 'testsecret';
process.env.PUBLIC_URL = 'http://localhost:3946';
process.env.EBOS_ADMIN_TOKEN = 'testadmin';

const BASE = 'http://localhost:3946';
const WS_BASE = 'ws://localhost:3946';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok: ${name}`);
}

function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  // `await predicate()` deliberately -- predicate can be async (several
  // call sites below poll the DB), and an un-awaited async function call
  // is always a truthy Promise object, which would make this resolve on
  // its very first tick regardless of what the predicate actually checks.
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      if (await predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

async function main() {
  await import('../server.js');
  const { pool } = await import('../lib/db.js');
  const { default: WebSocket } = await import('ws');

  for (let i = 0; i < 50; i++) {
    try {
      await fetch(BASE + '/healthz');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  await pool.query(
    `insert into voice_config (business_id, enabled) values ((select id from business limit 1), true) on conflict (business_id) do nothing`
  );

  console.log('=== Fixture 1: POST /webhook/voice/incoming opens a call and returns TwiML pointing at the stream ===');
  const callerNumber = '2348050000001';
  const incomingRes = await fetch(`${BASE}/webhook/voice/incoming`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: callerNumber, To: '+15550001111', CallSid: 'CAtest1' }),
  });
  const twiml = await incomingRes.text();
  let callId;
  await check('response is TwiML (200, xml content-type)', async () => {
    if (incomingRes.status !== 200) throw new Error(`expected 200, got ${incomingRes.status}: ${twiml}`);
    if (!incomingRes.headers.get('content-type')?.includes('xml')) throw new Error(`expected xml content-type, got ${incomingRes.headers.get('content-type')}`);
  });
  await check('TwiML connects to a /voice/stream URL carrying a callId', async () => {
    const match = twiml.match(/<Stream url="ws:\/\/localhost:3946\/voice\/stream\?callId=([a-f0-9-]+)"/);
    if (!match) throw new Error(`could not find a matching <Stream> url in: ${twiml}`);
    callId = match[1];
  });
  await check('a voice_call row was opened for the right caller number', async () => {
    const { rows } = await pool.query('select caller_number, transport from voice_call where id = $1', [callId]);
    if (!rows[0]) throw new Error('no voice_call row found for the callId in the TwiML');
    if (rows[0].caller_number !== callerNumber) throw new Error(`caller_number mismatch: ${rows[0].caller_number}`);
    if (rows[0].transport !== 'forwarding') throw new Error(`expected transport 'forwarding', got ${rows[0].transport}`);
  });

  console.log('\n=== Fixture 2: connecting the stream and sending a caller turn drives a real reply back over the wire ===');
  const ws = new WebSocket(`${WS_BASE}/voice/stream?callId=${callId}`);
  const inbound = [];
  ws.on('message', (data) => {
    try {
      inbound.push(JSON.parse(data.toString()));
    } catch {
      /* ignore */
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZtest1' }, streamSid: 'MZtest1' }));
  ws.send(JSON.stringify({ event: 'test_transcript', transcript: 'thanks' }));

  await check('the bridge sent at least one media frame back, base64 mu-law payload', async () => {
    await waitFor(() => inbound.some((m) => m.event === 'media'));
    const mediaMsg = inbound.find((m) => m.event === 'media');
    if (mediaMsg.streamSid !== 'MZtest1') throw new Error(`media frame has wrong streamSid: ${mediaMsg.streamSid}`);
    if (!mediaMsg.media?.payload || typeof mediaMsg.media.payload !== 'string') throw new Error('media frame missing a base64 payload');
  });
  await check('a "reply-done" mark followed the audio, signalling the reply finished', async () => {
    await waitFor(() => inbound.some((m) => m.event === 'mark' && m.mark?.name === 'reply-done'));
  });
  await check('the turn was logged to call_turn exactly as a real call would', async () => {
    const { rows } = await pool.query(`select speaker, transcript from call_turn where call_id = $1 order by seq`, [callId]);
    if (rows.length !== 2) throw new Error(`expected 2 call_turn rows, got ${rows.length}: ${JSON.stringify(rows)}`);
    if (rows[0].speaker !== 'caller' || rows[0].transcript !== 'thanks') throw new Error(`bad caller turn: ${JSON.stringify(rows[0])}`);
    if (rows[1].speaker !== 'system' || rows[1].transcript !== "You're welcome!") throw new Error(`bad system turn: ${JSON.stringify(rows[1])}`);
  });

  console.log('\n=== Fixture 3: barge-in -- an interim transcript while the bot is mid-reply clears playback ===');
  inbound.length = 0;
  ws.send(JSON.stringify({ event: 'test_transcript', transcript: 'thanks', isFinal: false, speechFinal: false }));
  // "thanks" again, deliberately -- a deterministic ack/thanks reply (see
  // test-voice-conversation.mjs's own comment on why: this sandbox has no
  // ANTHROPIC_API_KEY, so a freeform phrase would need Claude and never
  // reach TTS at all, defeating the point of this fixture). Fires a real
  // turn whose sandbox TTS deliberately takes ~150ms (fishaudio-tts.js's
  // own comment) so there is a real window to land an interrupting interim
  // transcript inside it, below.
  ws.send(JSON.stringify({ event: 'test_transcript', transcript: 'thanks' }));
  await new Promise((r) => setTimeout(r, 40));
  ws.send(JSON.stringify({ event: 'test_transcript', transcript: 'wait wait', isFinal: false, speechFinal: false }));
  await check('a "clear" frame was sent to Twilio to stop the bot mid-reply', async () => {
    await waitFor(() => inbound.some((m) => m.event === 'clear' && m.streamSid === 'MZtest1'));
  });

  console.log('\n=== Fixture 4: low-confidence escalation still works over the real wire ===');
  const call2Res = await fetch(`${BASE}/webhook/voice/incoming`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: '2348050000002', To: '+15550001111', CallSid: 'CAtest2' }),
  });
  const call2Id = (await call2Res.text()).match(/callId=([a-f0-9-]+)/)[1];
  const ws2 = new WebSocket(`${WS_BASE}/voice/stream?callId=${call2Id}`);
  const inbound2 = [];
  ws2.on('message', (data) => {
    try {
      inbound2.push(JSON.parse(data.toString()));
    } catch {
      /* ignore */
    }
  });
  await new Promise((resolve, reject) => {
    ws2.once('open', resolve);
    ws2.once('error', reject);
  });
  ws2.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZtest2' }, streamSid: 'MZtest2' }));
  // 'thanks' again -- a single low-confidence turn does NOT escalate yet
  // (engine/voice.js only trips on two consecutive ones), so this first
  // turn still reaches handleVoiceTurn same as any other, and has to be a
  // deterministic ack for the same no-ANTHROPIC_API_KEY reason as Fixture 3.
  ws2.send(JSON.stringify({ event: 'test_transcript', transcript: 'thanks', confidence: 0.3 }));
  await waitFor(() => inbound2.some((m) => m.event === 'mark' && m.mark?.name === 'reply-done'));
  inbound2.length = 0;
  // The second consecutive low-confidence turn escalates BEFORE reaching
  // handleVoiceTurn at all (engine/voice.js short-circuits straight to
  // escalateVoiceCall), so this one can be any freeform text -- it never
  // needs Claude either.
  ws2.send(JSON.stringify({ event: 'test_transcript', transcript: 'garbled two', confidence: 0.2 }));
  await check('two consecutive low-confidence turns escalate to a callback_task', async () => {
    await waitFor(async () => {
      const { rows } = await pool.query('select status from callback_task where call_id = $1', [call2Id]);
      return rows.length === 1 && rows[0].status === 'open';
    });
  });

  console.log('\n=== Fixture 5: a "stop" event ends the call and records the outcome ===');
  ws.send(JSON.stringify({ event: 'stop', stop: {} }));
  await check('voice_call got ended_at + outcome recorded after stop', async () => {
    await waitFor(async () => {
      const { rows } = await pool.query('select ended_at, outcome from voice_call where id = $1', [callId]);
      return Boolean(rows[0]?.ended_at);
    });
    const { rows } = await pool.query('select ended_at, outcome from voice_call where id = $1', [callId]);
    if (rows[0].outcome !== 'abandoned') throw new Error(`expected outcome 'abandoned' (no order placed), got ${rows[0].outcome}`);
  });

  ws.close();
  ws2.close();

  console.log(`\n${passed} checks passed.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
