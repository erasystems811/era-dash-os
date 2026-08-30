// The customer-facing WhatsApp Business Profile (About, description, email,
// address, websites, category) -- what a customer sees when they tap this
// business's name/photo in a chat. Completely separate from the `business`
// table, which only drives the bot's own behaviour. Same env-var/sandbox
// pattern as whatsapp-send.js since it's the same per-business Meta
// credentials.
const GRAPH_VERSION = 'v20.0';
const PROFILE_FIELDS = 'about,address,description,email,profile_picture_url,websites,vertical';

export async function getWhatsappBusinessProfile() {
  if (process.env.EBOS_SANDBOX === '1') {
    return { about: '', address: '', description: '', email: '', websites: [], vertical: 'UNDEFINED', profile_picture_url: null, sandbox: true };
  }
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/whatsapp_business_profile?fields=${PROFILE_FIELDS}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`WhatsApp profile fetch failed ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.data?.[0] || {};
}

// Meta only touches the fields present in the payload -- omitted fields are
// left exactly as they are, not cleared, so a partial save (e.g. just
// `about`) never wipes the rest of the profile.
export async function updateWhatsappBusinessProfile(fields) {
  if (process.env.EBOS_SANDBOX === '1') return { sandbox: true };
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) throw new Error('META_PHONE_NUMBER_ID / META_ACCESS_TOKEN not set -- WhatsApp is not connected yet.');
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/whatsapp_business_profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...fields }),
  });
  if (!res.ok) throw new Error(`WhatsApp profile update failed ${res.status}: ${await res.text()}`);
  return res.json();
}
