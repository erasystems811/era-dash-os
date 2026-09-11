// Shared WhatsApp alert sender -- extracted from check-bot-health.mjs so
// backup-all-clients.mjs (and anything else that needs to page the
// operator) reuses the same send path instead of a second copy of the
// same fetch call. Uses the dedicated ALERT_WA_* secrets.env keys (copied
// once from an already Meta-verified number, Bali's, per Chidera's choice)
// rather than any one client's own WhatsApp token, so ops alerting isn't
// coupled to a client's own deploys/token rotation.
export async function sendWhatsAppAlert(secrets, text) {
  const { ALERT_WA_TOKEN, ALERT_WA_PHONE_NUMBER_ID, ALERT_RECIPIENT_PHONE } = secrets;
  if (!ALERT_WA_TOKEN || !ALERT_WA_PHONE_NUMBER_ID || !ALERT_RECIPIENT_PHONE) {
    console.log('  (WhatsApp alerting not configured -- set ALERT_WA_TOKEN, ALERT_WA_PHONE_NUMBER_ID, ALERT_RECIPIENT_PHONE in secrets.env)');
    return false;
  }
  const res = await fetch(`https://graph.facebook.com/v20.0/${ALERT_WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ALERT_WA_TOKEN}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: ALERT_RECIPIENT_PHONE,
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) {
    console.error(`  WhatsApp send failed ${res.status}: ${await res.text()}`);
    return false;
  }
  return true;
}
