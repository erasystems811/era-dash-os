// Twilio's own inbound-call webhook (spec A2, Phase 1/forwarding) --
// mounted publicly at /webhook/voice, same trust boundary as webhook/
// whatsapp and webhook/instagram (no session, verified by the provider's
// own request signature instead). Twilio POSTs here the moment the
// restaurant's forwarded call reaches the Twilio number ERA provisioned
// for this business (voice_config.inbound_number) -- this route's only job
// is to open a voice_call row and hand the call straight to the
// WebSocket stream (engine/voice-stream-bridge.js) where the real
// STT/engine/TTS loop lives; it never talks to Deepgram or Fish Audio
// itself.
import express from 'express';
import { pool } from '../lib/db.js';
import { startVoiceCall } from '../engine/voice.js';
import { getTelephonyProvider } from '../engine/telephony-provider.js';

export const router = express.Router();

function streamWsUrl(callId) {
  // wss:// from PUBLIC_URL's https:// -- Twilio refuses a plain ws:// Stream
  // url outright, so this only ever works once this deployment is served
  // over TLS, same requirement every other PUBLIC_URL-based link here
  // already assumes (see engine/payment.js's callbackUrl usage).
  const base = (process.env.PUBLIC_URL || '').replace(/^http/, 'ws');
  return `${base}/voice/stream?callId=${callId}`;
}

router.post('/incoming', async (req, res) => {
  const provider = getTelephonyProvider();
  const url = `${process.env.PUBLIC_URL}/webhook/voice/incoming`;
  const signature = req.header('x-twilio-signature');
  if (!provider.verifyTwilioSignature({ url, params: req.body, signature })) {
    return res.status(403).send('Invalid signature');
  }

  const { rows: cfgRows } = await pool.query('select greeting_override from voice_config limit 1');
  // Phase 1 is single-branch-first (spec scope) -- same is_primary
  // fallback flow.js already uses for an unresolved-channel inbound
  // message (line ~6143), not a new convention invented for this.
  const { rows: branchRows } = await pool.query('select id from branch where is_primary = true limit 1');
  const call = await startVoiceCall({
    branchId: branchRows[0]?.id || null,
    callerNumber: req.body.From,
    transport: 'forwarding',
  });

  const twiml = provider.answerTwiml({
    streamUrl: streamWsUrl(call.id),
    greeting: cfgRows[0]?.greeting_override || null,
  });
  res.type('text/xml').send(twiml);
});
