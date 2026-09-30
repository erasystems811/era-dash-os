// Twilio adapter for the TelephonyProvider interface (engine/telephony-
// provider.js). ERA-wide account (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN),
// same shape as OPENAI_API_KEY/ANTHROPIC_API_KEY in .env.template -- one
// Twilio account for every EBOS deployment, routing an inbound call to the
// right business via voice_config.inbound_number (each business gets its
// own purchased Twilio number to forward to, set by ERA, not the client --
// same "ERA switches these" rule routes/api.js's voice-config comment
// already states for the rest of this add-on).
//
// Phase 1 is call-forwarding (spec A2): the restaurant's own existing line
// forwards an unanswered/busy call to the Twilio number above. There is no
// real "transfer" in this phase -- transferCall here means dialing a real
// staff number INTO the live call (so the caller ends up talking to a
// person without hanging up), not handing the original caller's own line
// back to anyone, since Phase 1 never owned that line to begin with.
import crypto from 'node:crypto';

export const capabilityFlags = { realtimeAudio: true, bargeIn: true };

function auth() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set -- Voice is not connected yet.');
  }
  return { accountSid, authToken };
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// `streamUrl` must be wss:// (Twilio refuses plain ws:// for <Stream>).
// `greeting` is Twilio's own Text-to-Speech, used ONLY as an instant "we
// heard you" noise before the real cloned-voice greeting arrives over the
// stream a moment later -- spec A3's own cloned voice has to come from
// Fish Audio over the WebSocket (voice-stream-bridge.js), since <Say> can't
// use a cloned voice at all. Optional: a silent <Connect> is a valid (if
// slightly abrupt) answer too.
export function answerTwiml({ streamUrl, greeting }) {
  const say = greeting ? `<Say>${escapeXml(greeting)}</Say>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Connect><Stream url="${escapeXml(streamUrl)}" /></Connect></Response>`;
}

async function callsApi(callSid, body) {
  if (process.env.EBOS_SANDBOX === '1') {
    console.log(`\n[sandbox Twilio Calls API -> ${callSid}]:`, body);
    return { sandbox: true };
  }
  const { accountSid, authToken } = auth();
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Twilio Calls API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Redirects the live call to a new TwiML document that dials `toNumber`
// into it -- the closest Phase 1 (forwarding) equivalent of "transfer".
export async function transferCall(providerCallId, toNumber, twimlAppUrl) {
  return callsApi(providerCallId, { Url: twimlAppUrl, Method: 'POST' }).then(() => {
    // The actual <Dial>toNumber</Dial> TwiML is served by whatever
    // `twimlAppUrl` points at (routes/voice-webhook.js's /transfer) --
    // kept as a second small webhook rather than inlining TwiML here, same
    // reasoning as answerTwiml: Twilio always fetches TwiML from a URL it
    // calls back into, never accepts it inline on this REST call.
  });
}

export async function hangupCall(providerCallId) {
  return callsApi(providerCallId, { Status: 'completed' });
}

// Twilio signs every webhook request with HMAC-SHA1 over (the exact URL
// Twilio requested) + (sorted form-field key+value pairs concatenated with
// no separator), base64-encoded, in the X-Twilio-Signature header -- the
// published algorithm, not guessed. `url` must be rebuilt from PUBLIC_URL
// (this codebase's own convention for every outbound link, see engine/
// payment.js etc.) rather than req.protocol/req.get('host'), since nothing
// here sets `trust proxy` and this app sits behind Caddy -- req.protocol
// would report 'http' and silently fail every real signature check.
export function verifyTwilioSignature({ url, params, signature }) {
  if (process.env.EBOS_SANDBOX === '1') return true;
  const { authToken } = auth();
  const sortedKeys = Object.keys(params || {}).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  if (!signature || expected.length !== signature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
