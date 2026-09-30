// Fish Audio -- cloned-voice text-to-speech (spec A3) and the one-time
// cloning call itself. Chosen over ElevenLabs specifically because cloning
// is a one-time $0.10 fee and generation bills per character/minute with no
// subscription tier to commit to -- the same "like using normal credit"
// requirement that picked Deepgram over Google Cloud STT. Real-time
// streaming (not record-the-whole-reply-then-send) is what makes barge-in
// possible at all: Twilio's <Connect><Stream> stays open for the whole
// call, so the bot's own reply has to arrive the same way.
import WebSocket from 'ws';
import { encode, decode } from '@msgpack/msgpack';
import { pcm16ToMulaw } from './mulaw.js';

const FISHAUDIO_WS_URL = 'wss://api.fish.audio/v1/tts/live';

// Streams `text` through Fish Audio, calling `onMulawChunk(Buffer)` for
// each resulting slice of 8kHz mu-law audio as it arrives (already
// transcoded from Fish Audio's linear PCM16 output -- see engine/
// mulaw.js), resolving once Fish Audio reports the generation finished.
export async function synthesizeToMulaw(text, voiceId, onMulawChunk) {
  if (process.env.EBOS_SANDBOX === '1') {
    console.log(`\n[sandbox Fish Audio TTS -> voice ${voiceId || 'default'}]: "${text}"`);
    // A short, deliberate delay before the one frame below -- a real
    // network-streamed reply takes long enough to arrive that a caller's
    // own barge-in can land mid-reply; an instant synchronous resolve here
    // would make voice-stream-bridge.js's barge-in window (the `speaking`
    // flag) too narrow for sandbox/test-voice-telephony-bridge.mjs to ever
    // hit reliably. Test-only pacing, not a production behavior change.
    await new Promise((resolve) => setTimeout(resolve, 150));
    // One short frame of silence so a sandbox-driven test exercises the
    // same send-frames-back code path a real call would, without a real
    // account -- same shape as every other EBOS_SANDBOX branch in this
    // codebase (see engine/whatsapp-send.js).
    onMulawChunk(Buffer.alloc(160, 0xff));
    return;
  }

  const apiKey = process.env.FISHAUDIO_API_KEY;
  if (!apiKey) throw new Error('FISHAUDIO_API_KEY not set -- Voice speech synthesis is not connected yet.');

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(FISHAUDIO_WS_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    ws.on('open', () => {
      const request = { text: '', format: 'pcm', sample_rate: 8000, latency: 'low' };
      if (voiceId) request.reference_id = voiceId;
      ws.send(encode({ event: 'start', request }));
      ws.send(encode({ event: 'text', text }));
      ws.send(encode({ event: 'flush' }));
      ws.send(encode({ event: 'stop' }));
    });
    ws.on('message', (data) => {
      let msg;
      try {
        msg = decode(data);
      } catch (err) {
        return fail(err);
      }
      if (msg.event === 'audio') {
        onMulawChunk(pcm16ToMulaw(Buffer.from(msg.audio)));
      } else if (msg.event === 'finish') {
        ws.close();
        if (msg.reason === 'error') fail(new Error('Fish Audio reported a generation error.'));
        else succeed();
      }
    });
    ws.on('error', fail);
    ws.on('close', () => succeed());
  });
}

// Clones a voice from Chidera's recording (spec A3) -- multipart per Fish
// Audio's own /model docs. Returns the full model row; the caller writes
// its `_id` into voice_config.voice_id (ERA-wide, one cloned voice at
// launch -- see schema.sql's own comment on that column).
export async function cloneVoice({ filePath, title = 'ERA Voice Ordering' }) {
  if (process.env.EBOS_SANDBOX === '1') return { _id: 'sandbox-voice-id', state: 'trained' };

  const apiKey = process.env.FISHAUDIO_API_KEY;
  if (!apiKey) throw new Error('FISHAUDIO_API_KEY not set -- Voice speech synthesis is not connected yet.');

  const { readFile } = await import('node:fs/promises');
  const fileBuffer = await readFile(filePath);
  const form = new FormData();
  form.append('type', 'tts');
  form.append('title', title);
  form.append('visibility', 'private');
  form.append('train_mode', 'fast');
  form.append('voices', new Blob([fileBuffer]), filePath.split(/[\\/]/).pop());

  const res = await fetch('https://api.fish.audio/model', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Fish Audio clone failed ${res.status}: ${await res.text()}`);
  return res.json();
}
