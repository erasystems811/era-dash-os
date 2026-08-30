// The real Instagram Messaging API send call -- mirrors whatsapp-send.js's
// shape exactly (same pattern of functions) so flow.js can pick either
// sender by channel without caring which one it's calling. Confirmed
// against Meta's actual docs (developers.facebook.com/docs/instagram-
// platform/instagram-api-with-instagram-login/messaging-api/): host is
// graph.instagram.com (not graph.facebook.com -- that's the WhatsApp/
// Messenger host), auth is a bearer Instagram User access token, and file
// attachments are sent by public URL the same way WhatsApp documents are --
// no separate upload step needed for the common case.
const GRAPH_VERSION = 'v23.0';

export async function sendInstagram(to, text) {
  // Sandbox mode: no real Instagram account connected yet, print instead of
  // calling Meta -- same purpose as whatsapp-send.js's sandbox mode.
  if (process.env.EBOS_SANDBOX === '1') {
    console.log(`\n[sandbox ig -> ${to}]: ${text}`);
    return { sandbox: true };
  }
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!igUserId || !accessToken) {
    throw new Error('INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN not set -- Instagram is not connected yet.');
  }
  const res = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${igUserId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: to },
      message: { text },
    }),
  });
  if (!res.ok) throw new Error(`Instagram send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

// Sends a real file (the invoice PDF) the same way WhatsApp documents are
// sent -- by public URL, Instagram fetches it itself. No filename/caption
// field in Instagram's attachment shape (unlike WhatsApp's), so the
// invoice-line text that already precedes this call in flow.js carries
// that context instead -- same structure already used there regardless of
// channel.
export async function sendInstagramDocument(to, link) {
  if (process.env.EBOS_SANDBOX === '1') {
    console.log(`\n[sandbox ig -> ${to}]: [document: ${link}]`);
    return { sandbox: true };
  }
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!igUserId || !accessToken) {
    throw new Error('INSTAGRAM_USER_ID / INSTAGRAM_ACCESS_TOKEN not set -- Instagram is not connected yet.');
  }
  const res = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${igUserId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: to },
      message: { attachment: { type: 'file', payload: { url: link } } },
    }),
  });
  if (!res.ok) throw new Error(`Instagram document send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

// Meta's Sender Actions doc (developers.facebook.com/docs/instagram-
// platform/instagram-api-with-instagram-login/messaging-api/sender-
// actions/) documents typing_on/typing_off, but its own example oddly
// shows graph.facebook.com/{version}/me/messages -- inconsistent with the
// send-message doc for this exact product, which is graph.instagram.com/
// {ig-user-id}/messages (the host/auth already proven for sendInstagram
// above). Using that proven pattern here instead of the inconsistent one,
// wrapped in the same best-effort try/catch philosophy as WhatsApp's
// markTypingIndicator -- a failure here should never delay or break the
// actual reply, and this hasn't been exercised against a real account yet.
export async function markInstagramTypingIndicator(to) {
  if (process.env.EBOS_SANDBOX === '1') return;
  const igUserId = process.env.INSTAGRAM_USER_ID;
  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!igUserId || !accessToken) return;
  const res = await fetch(`https://graph.instagram.com/${GRAPH_VERSION}/${igUserId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: to },
      sender_action: 'typing_on',
    }),
  });
  if (!res.ok) throw new Error(`Instagram typing indicator failed ${res.status}: ${await res.text()}`);
}

// Instagram's inbound webhook gives a direct, pre-signed CDN URL for a
// received image/file attachment (message.attachments[].payload.url) --
// no media-ID lookup step like WhatsApp requires. Still converted to a
// data: URI here so callers (payment_proof_url) don't need to know the
// difference between channels.
export async function downloadInstagramMedia(url) {
  const fileRes = await fetch(url);
  if (!fileRes.ok) throw new Error(`Instagram media download failed ${fileRes.status}`);
  const contentType = fileRes.headers.get('content-type') || 'application/octet-stream';
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}
