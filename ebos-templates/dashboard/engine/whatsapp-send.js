// The real WhatsApp Cloud API send call -- this is the whatsappSend
// dependency injected into bot-engine/send.js's sendMessage. Nothing else
// in the engine talks to Meta's API directly.
const GRAPH_VERSION = 'v20.0';

// Retries a transient network blip or a Meta-side 5xx (2 short retries) so
// one hiccup doesn't silently drop a customer's reply. Deliberately NOT
// retrying 429 -- that's Meta's own per-tier daily send cap, an
// account-level ceiling to raise with Meta, not something to route around
// here.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 1500];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postMessage(phoneNumberId, accessToken, payload) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    if (res.ok) return res.json();
    const errorText = await res.text();
    if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      continue;
    }
    throw new Error(`WhatsApp send failed ${res.status}: ${errorText}`);
  }
}

// `credentials` is optional -- {phoneNumberId, accessToken} for a specific
// branch's own WhatsApp number (see engine/branch-channel.js). Every
// existing caller passes nothing and keeps using the single shared env-var
// pair, exactly as before this parameter existed.
export async function sendWhatsApp(to, text, credentials) {
  // Sandbox mode: no real WhatsApp number connected yet, print instead of
  // calling Meta -- same purpose as gold-seller-bot's terminal transport,
  // lets the whole engine be exercised before a real number is wired up.
  if (process.env.EBOS_SANDBOX === '1') {
    console.log(`\n[sandbox -> ${to}]: ${text}`);
    return { sandbox: true };
  }
  const phoneNumberId = credentials?.phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  const accessToken = credentials?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  }
  return postMessage(phoneNumberId, accessToken, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
}

// Sends a real file (the invoice PDF), not a text link a customer has to
// tap out to a browser -- WhatsApp fetches the file itself from `link`
// (must be a real public URL, PUBLIC_URL-based), no separate upload step
// needed.
export async function sendWhatsAppDocument(to, link, filename, caption, credentials) {
  if (process.env.EBOS_SANDBOX === '1') {
    console.log(`\n[sandbox -> ${to}]: [document: ${filename} -- ${link}]${caption ? ` ${caption}` : ''}`);
    return { sandbox: true };
  }
  const phoneNumberId = credentials?.phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  const accessToken = credentials?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  }
  return postMessage(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: { link, filename, ...(caption ? { caption } : {}) },
  });
}

// Forwards a real photo (e.g. the business's own menu photo) -- same
// fetch-by-link mechanism as sendWhatsAppDocument above, just WhatsApp's
// 'image' message type instead of 'document'.
export async function sendWhatsAppImage(to, link, caption, credentials) {
  if (process.env.EBOS_SANDBOX === '1') {
    console.log(`\n[sandbox -> ${to}]: [image: ${link}]${caption ? ` ${caption}` : ''}`);
    return { sandbox: true };
  }
  const phoneNumberId = credentials?.phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  const accessToken = credentials?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  }
  return postMessage(phoneNumberId, accessToken, {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link, ...(caption ? { caption } : {}) },
  });
}

// Shows WhatsApp's native "typing..." indicator (and marks the message
// read) for up to 25 seconds or until the next real reply, whichever comes
// first -- Meta's own documented combined call, not a hack. Called on every
// inbound message so a customer sees something happening during the
// debounce wait instead of silence. Best-effort: a failure here is not
// worth losing the actual reply over, so callers should not let this throw
// stop anything else.
export async function markTypingIndicator(messageId) {
  if (process.env.EBOS_SANDBOX === '1') return;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken || !messageId) return;
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
    }),
  });
  if (!res.ok) throw new Error(`Typing indicator failed ${res.status}: ${await res.text()}`);
}

// The 24-hour-session template send, for waking a stale conversation --
// injected into bot-engine/wake-template.js's sendWakeTemplateIfNeeded (not
// wired up yet, a known gap -- see flow.js's handover() comment) -- and, as
// of the delivery add-on, for a rider's own sign-in OTP (engine/rider-
// auth.js), which needs a real component (the code itself) to fill into the
// template body -- optional here since a plain wake template needs none.
// `credentials` is optional, same {phoneNumberId, accessToken} pattern as
// every other send function in this file (see engine/branch-channel.js) --
// a rider tied to a branch with its own connected number sends from that
// number, not always the business's shared one.
export async function sendWhatsAppTemplate(to, templateName, languageCode = 'en_US', components, credentials) {
  if (process.env.EBOS_SANDBOX === '1') {
    console.log(`\n[sandbox -> ${to}]: [template: ${templateName}]${components ? ` ${JSON.stringify(components)}` : ''}`);
    return { sandbox: true };
  }
  const phoneNumberId = credentials?.phoneNumberId || process.env.META_PHONE_NUMBER_ID;
  const accessToken = credentials?.accessToken || process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: { name: templateName, language: { code: languageCode }, ...(components ? { components } : {}) },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp template send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

// WhatsApp never sends media bytes directly, only a media ID -- this is the
// two-step Meta requires: look up that ID to get a short-lived URL, then
// fetch the actual file from there (same bearer token authorizes both).
// Returned as a data: URI so it can be stored directly in a text column
// (payment_proof_url), same pattern as logo_data_url -- no file storage/
// static serving needed for what's realistically always a small image.
export async function downloadWhatsAppMedia(mediaId) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) throw new Error('META_ACCESS_TOKEN not set -- cannot download media.');
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!metaRes.ok) throw new Error(`Media lookup failed ${metaRes.status}: ${await metaRes.text()}`);
  const meta = await metaRes.json();
  const fileRes = await fetch(meta.url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!fileRes.ok) throw new Error(`Media download failed ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return `data:${meta.mime_type};base64,${buffer.toString('base64')}`;
}
