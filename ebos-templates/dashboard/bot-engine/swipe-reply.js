// Every message that represents "a specific person's own words, relayed"
// gets logged here by its outbound WhatsApp message id, so a swipe-reply to
// it always routes straight back to that exact person. This is a permanent
// log, never a one-time/consumed flag -- the same message can be swiped
// more than once.
//
// `db` is injected ({ insert, select }) so this stays storage-agnostic and
// testable against fixtures without a live database.

export async function recordRelayTarget(db, { whatsappMessageId, targetContactId, targetPhoneNumber }) {
  if (!whatsappMessageId) return; // nothing to route back to without a real message id
  await db.insert('relay_targets', {
    whatsapp_message_id: whatsappMessageId,
    target_contact_id: targetContactId ?? null,
    target_phone_number: targetPhoneNumber,
    created_at: new Date().toISOString(),
  });
}

export async function resolveSwipeReply(db, repliedToMessageId) {
  if (!repliedToMessageId) return null;
  const rows = await db.select('relay_targets', { whatsapp_message_id: repliedToMessageId });
  return rows[0] || null; // never marked used -- available for a repeat swipe later
}

export async function resolveByNamePrefix(text, findContactByNameFragment) {
  // Fallback for when there's nothing to swipe: "reply to Sarah: message"
  // or just "Sarah: message".
  const match = text.match(/^reply to ([^:]+):\s*(.+)$/i) || text.match(/^([^:]+):\s*(.+)$/i);
  if (!match) return null;
  const [, nameFragment, message] = match;
  const contact = await findContactByNameFragment(nameFragment.trim());
  if (!contact) return null;
  return { contact, message: message.trim() };
}
