// The real WhatsApp Cloud API send call -- this is the whatsappSend
// dependency injected into bot-engine/send.js's sendMessage. Nothing else
// in the engine talks to Meta's API directly. Trimmed down from
// ebos-templates/dashboard/engine/whatsapp-send.js (no document/image send
// -- ESF has no invoice/menu to forward) but keeps its retry and sandbox
// conventions, since those aren't EBOS-specific.
const GRAPH_VERSION = 'v20.0';

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

// Sandbox mode: no real WhatsApp number connected yet, print instead of
// calling Meta -- same purpose as EBOS's EBOS_SANDBOX, lets the whole
// engine be exercised before add-whatsapp.mjs has been run.
export async function sendWhatsApp(to, text) {
  if (process.env.ESF_SANDBOX === '1') {
    console.log(`\n[sandbox -> ${to}]: ${text}`);
    return { sandbox: true };
  }
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  }
  return postMessage(phoneNumberId, accessToken, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
}

// The 24-hour-session template send, for waking a stale conversation before
// a scheduled task prompt goes out -- injected into
// bot-engine/wake-template.js's sendWakeTemplateIfNeeded.
export async function sendWhatsAppTemplate(to, templateName, languageCode = 'en_US') {
  if (process.env.ESF_SANDBOX === '1') {
    console.log(`\n[sandbox -> ${to}]: [template: ${templateName}]`);
    return { sandbox: true };
  }
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
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
      template: { name: templateName, language: { code: languageCode } },
    }),
  });
  if (!res.ok) throw new Error(`WhatsApp template send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

// WhatsApp never sends media bytes directly, only a media ID -- look up
// that ID for a short-lived URL, then fetch the actual file from there
// (same bearer token authorizes both). Returned as a data: URI so it can be
// stored directly in entry.media_url with no file storage/static serving
// needed for what's realistically always a small photo.
export async function downloadWhatsAppMedia(mediaId) {
  if (process.env.ESF_SANDBOX === '1') return `data:image/jpeg;base64,sandbox-${mediaId}`;
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
