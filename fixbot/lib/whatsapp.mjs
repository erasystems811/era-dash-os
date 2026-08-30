// Same bare Graph API call as scripts/check-bot-health.mjs's alert sender
// and ebos-templates/dashboard/engine/whatsapp-send.js -- deliberately not
// shared code across those three, each is a handful of lines and pulling
// them into one module isn't worth the indirection yet. Uses the same
// ALERT_WA_TOKEN/ALERT_WA_PHONE_NUMBER_ID/ALERT_RECIPIENT_PHONE secrets
// already set up for Bot Monitoring alerts (Bali's number, per Chidera's
// choice) -- this is the same WhatsApp thread, not a new channel.
export async function sendWhatsApp(secrets, text) {
  const { ALERT_WA_TOKEN, ALERT_WA_PHONE_NUMBER_ID, ALERT_RECIPIENT_PHONE } = secrets;
  if (!ALERT_WA_TOKEN || !ALERT_WA_PHONE_NUMBER_ID || !ALERT_RECIPIENT_PHONE) {
    console.error('sendWhatsApp: ALERT_WA_TOKEN/ALERT_WA_PHONE_NUMBER_ID/ALERT_RECIPIENT_PHONE not configured');
    return false;
  }
  const res = await fetch(`https://graph.facebook.com/v20.0/${ALERT_WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ALERT_WA_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: ALERT_RECIPIENT_PHONE, type: 'text', text: { body: text } }),
  });
  if (!res.ok) {
    console.error(`sendWhatsApp failed ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}

// A reply counts as "yes" fairly loosely on purpose -- this is a WhatsApp
// text conversation with one person (Chidera), not a form, so match the
// way she'd actually type it rather than requiring an exact keyword.
export function isAffirmative(text) {
  return /^\s*(yes|yeah|yep|go|go on|go ahead|do it|continue|ok|okay|proceed|sure)\b/i.test(text || '');
}

export function isNegative(text) {
  return /^\s*(no|nope|stop|cancel|don'?t|skip|abort)\b/i.test(text || '');
}
